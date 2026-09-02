// Coded by Aditya | GitHub- @adityatheog

/**
 * Retry policy for panel requests.
 *
 * Kept as a separate, dependency-free module so the policy can be unit tested
 * without a network, a panel or a clock. src/services/pterodactyl.js owns the
 * HTTP calls and consults this module to decide whether to try again.
 *
 * The rule that matters, and the reason this is not a generic "retry 3 times"
 * helper:
 *
 *   HTTP 429 means the request was rejected before execution. Nothing happened on
 *   the panel, so replaying it is safe for any method, including POST.
 *
 *   A 5xx or a socket error means the outcome is unknown. The panel may have
 *   created the server and then failed to respond. Replaying a POST in that state
 *   is how a user ends up with two servers and one database row, so only
 *   idempotent methods (GET, HEAD, OPTIONS) are retried on those failures.
 *
 * Callers may additionally mark an individual request as non-retryable regardless
 * of method, which src/services/pterodactyl.js does for every state-changing call
 * whose replay would be visible to the user.
 *
 * Backoff is exponential with full jitter. A panel behind a shared rate limiter
 * will reject many bot requests at once; retrying all of them on the same
 * schedule reproduces the thundering herd that caused the limit.
 */

import { parseRetryAfterMs } from '../utils/errors.js';

/** HTTP methods that may be replayed without changing panel state. */
const IDEMPOTENT_METHODS = Object.freeze(new Set(['GET', 'HEAD', 'OPTIONS']));

/** Server-side statuses worth a second attempt for an idempotent request. */
const RETRYABLE_STATUSES = Object.freeze(new Set([408, 500, 502, 503, 504, 522, 524]));

/**
 * Transport failures that may succeed on a retry.
 *
 * TLS validation codes are deliberately absent: an expired or untrusted panel
 * certificate fails identically every time, and retrying only delays the operator
 * seeing the real cause.
 */
const RETRYABLE_NETWORK_CODES = Object.freeze(
  new Set(['ECONNABORTED', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH']),
);

const DEFAULTS = Object.freeze({
  baseMs: 500,
  maxMs: 30_000,
  /**
   * Ceiling on total time spent waiting across all attempts. A deferred Discord
   * interaction token is valid for fifteen minutes, but a user staring at a
   * "thinking" indicator for a minute has already concluded the bot is broken.
   */
  maxElapsedMs: 45_000,
});

/**
 * Whether a method may be replayed safely.
 *
 * @param {unknown} method
 * @returns {boolean}
 */
export function isIdempotent(method) {
  return IDEMPOTENT_METHODS.has(String(method ?? 'GET').toUpperCase());
}

/**
 * Decides whether to attempt a failed request again.
 *
 * @param {object} options
 * @param {number} options.attempt the attempt that just failed, 1-based
 * @param {number} options.maxAttempts total attempts allowed, including the first
 * @param {string} [options.method] the HTTP method of the failed request
 * @param {number|null} [options.status] the HTTP status, or null for a transport failure
 * @param {string|null} [options.code] the Node error code for a transport failure
 * @param {boolean} [options.allowRetry] caller veto; false disables retrying outright
 * @param {number} [options.elapsedMs] time already spent waiting on this operation
 * @param {number} [options.maxElapsedMs] ceiling on cumulative wait time
 * @returns {boolean}
 */
export function shouldRetry({
  attempt,
  maxAttempts,
  method = 'GET',
  status = null,
  code = null,
  allowRetry = true,
  elapsedMs = 0,
  maxElapsedMs = DEFAULTS.maxElapsedMs,
}) {
  if (allowRetry === false) return false;

  const currentAttempt = Number(attempt);
  const limit = Number(maxAttempts);
  if (!Number.isFinite(currentAttempt) || !Number.isFinite(limit)) return false;
  if (currentAttempt >= limit) return false;

  if (Number(elapsedMs) >= Number(maxElapsedMs)) return false;

  // Rate limiting: the request never ran, so any method is safe to replay.
  if (status === 429) return true;

  // Everything below may have partially executed.
  if (!isIdempotent(method)) return false;

  if (status !== null && status !== undefined) return RETRYABLE_STATUSES.has(Number(status));

  return code !== null && RETRYABLE_NETWORK_CODES.has(String(code));
}

/**
 * Computes how long to wait before the next attempt.
 *
 * A Retry-After header always wins: the panel has stated when it will accept
 * traffic again, and guessing shorter simply earns another 429. Otherwise the
 * delay is exponential with full jitter, uniformly distributed across
 * [ceiling/2, ceiling] so concurrent retries spread out.
 *
 * @param {number} attempt the attempt that just failed, 1-based
 * @param {object} [options]
 * @param {Record<string, unknown>} [options.headers] response headers, for Retry-After
 * @param {number} [options.baseMs]
 * @param {number} [options.maxMs]
 * @param {() => number} [options.random] injectable for deterministic tests
 * @returns {number} milliseconds to wait, never negative
 */
export function backoffDelayMs(
  attempt,
  { headers = undefined, baseMs = DEFAULTS.baseMs, maxMs = DEFAULTS.maxMs, random = Math.random } = {},
) {
  const retryAfter = parseRetryAfterMs(headers);
  if (retryAfter !== null) return Math.min(Math.max(0, retryAfter), maxMs);

  const exponent = Math.max(0, Number(attempt) - 1);
  const ceiling = Math.min(baseMs * 2 ** exponent, maxMs);
  const jittered = ceiling * (0.5 + random() * 0.5);

  return Math.max(0, Math.round(jittered));
}

/**
 * Sleeps without holding the process open.
 *
 * The timer is unref'd so a pending backoff cannot delay shutdown: SIGTERM
 * proceeds immediately rather than waiting out a thirty-second wait.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  const duration = Math.max(0, Number(ms) || 0);
  if (duration === 0) return Promise.resolve();

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, duration);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Extracts the status and error code from a thrown axios error.
 *
 * @param {unknown} err
 * @returns {{ status: number|null, code: string|null, headers: Record<string, unknown>|undefined }}
 */
export function describeFailure(err) {
  return {
    status: err?.response?.status ?? null,
    code: err?.code ?? null,
    headers: err?.response?.headers,
  };
}

/**
 * Runs an operation with the retry policy applied.
 *
 * The operation receives the 1-based attempt number, so a caller can log or
 * annotate the request. Anything the policy declines to retry is rethrown
 * unchanged, leaving error normalisation to the caller.
 *
 * @template T
 * @param {(attempt: number) => Promise<T>} operation
 * @param {object} [options]
 * @param {number} [options.maxAttempts] total attempts including the first
 * @param {string} [options.method] HTTP method, used for the idempotency decision
 * @param {boolean} [options.allowRetry] false disables retrying for this call
 * @param {number} [options.baseMs]
 * @param {number} [options.maxMs]
 * @param {number} [options.maxElapsedMs]
 * @param {() => number} [options.random]
 * @param {(info: { attempt: number, status: number|null, code: string|null, delayMs: number }) => void} [options.onRetry]
 * @returns {Promise<T>}
 */
export async function withRetry(
  operation,
  {
    maxAttempts = 3,
    method = 'GET',
    allowRetry = true,
    baseMs = DEFAULTS.baseMs,
    maxMs = DEFAULTS.maxMs,
    maxElapsedMs = DEFAULTS.maxElapsedMs,
    random = Math.random,
    onRetry = undefined,
  } = {},
) {
  const limit = Math.max(1, Math.trunc(Number(maxAttempts) || 1));
  let elapsedMs = 0;

  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (err) {
      const { status, code, headers } = describeFailure(err);

      const retry = shouldRetry({
        attempt,
        maxAttempts: limit,
        method,
        status,
        code,
        allowRetry,
        elapsedMs,
        maxElapsedMs,
      });
      if (!retry) throw err;

      const delayMs = backoffDelayMs(attempt, { headers, baseMs, maxMs, random });

      // Waiting would exceed the budget, so fail now rather than sleeping and
      // then failing anyway.
      if (elapsedMs + delayMs > maxElapsedMs) throw err;

      if (typeof onRetry === 'function') {
        onRetry({ attempt, status, code, delayMs });
      }

      await sleep(delayMs);
      elapsedMs += delayMs;
    }
  }
}

export { DEFAULTS, IDEMPOTENT_METHODS, RETRYABLE_NETWORK_CODES, RETRYABLE_STATUSES };
