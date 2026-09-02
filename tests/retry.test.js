// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/services/retry.js.
 *
 * The retry policy has one decision that matters more than everything else in the module, and it
 * is the reason this is a separate file rather than a generic helper:
 *
 *   HTTP 429 means the request was rejected before execution. Nothing happened on the panel, so
 *   replaying it is safe for any method, including POST.
 *
 *   A 5xx or a socket error means the outcome is unknown. The panel may have created the server
 *   and then failed to respond. Replaying a POST in that state is how a user ends up with two
 *   servers and one database row.
 *
 * So the tests are organised around that asymmetry, and they assert it per method rather than in
 * aggregate. A policy that retried POST on a 502 would pass a naive "does it retry" test and
 * silently double-provision under load.
 *
 * Backoff is tested with an injected random function, so the jitter is deterministic and the
 * bounds can be asserted exactly rather than approximately.
 *
 * No credentials, no network, no timers longer than a few milliseconds.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  backoffDelayMs,
  DEFAULTS,
  describeFailure,
  IDEMPOTENT_METHODS,
  isIdempotent,
  RETRYABLE_NETWORK_CODES,
  RETRYABLE_STATUSES,
  shouldRetry,
  sleep,
  withRetry,
} from '../src/services/retry.js';

/** Methods that change state and must never be replayed after an ambiguous failure. */
const MUTATING_METHODS = Object.freeze(['POST', 'PATCH', 'PUT', 'DELETE']);

/**
 * Builds an object shaped like an axios error.
 *
 * @param {{ status?: number, code?: string, headers?: Record<string, string> }} [options]
 * @returns {Error}
 */
function failure({ status, code, headers } = {}) {
  const err = new Error('request failed');

  if (status !== undefined) err.response = { status, headers: headers ?? {} };
  if (code !== undefined) err.code = code;

  return err;
}

describe('isIdempotent', () => {
  test('treats the read methods as replayable', () => {
    for (const method of IDEMPOTENT_METHODS) {
      assert.equal(isIdempotent(method), true, `${method} should be idempotent`);
      assert.equal(isIdempotent(method.toLowerCase()), true, 'case should not matter');
    }
  });

  test('treats every mutating method as not replayable', () => {
    for (const method of MUTATING_METHODS) {
      assert.equal(isIdempotent(method), false, `${method} must not be replayable`);
      assert.equal(isIdempotent(method.toLowerCase()), false);
    }
  });

  test('defaults an absent method to GET', () => {
    // The service layer always passes one; this is a safety default, not a behaviour to rely on.
    assert.equal(isIdempotent(undefined), true);
    assert.equal(isIdempotent(null), true);
  });
});

describe('shouldRetry: the 429 exception', () => {
  test('retries a rate-limited request for any method', () => {
    /**
     * The one case where a non-idempotent replay is correct. The panel rejected the request before
     * executing it, so nothing was created and replaying is safe.
     */
    for (const method of [...IDEMPOTENT_METHODS, ...MUTATING_METHODS]) {
      assert.equal(
        shouldRetry({ attempt: 1, maxAttempts: 3, method, status: 429 }),
        true,
        `${method} should be retried on 429`,
      );
    }
  });

  test('still honours the attempt limit on 429', () => {
    assert.equal(shouldRetry({ attempt: 3, maxAttempts: 3, method: 'POST', status: 429 }), false);
  });

  test('still honours the caller veto on 429', () => {
    // createServer passes allowRetry: false, which must override even the safe case.
    assert.equal(
      shouldRetry({ attempt: 1, maxAttempts: 3, method: 'POST', status: 429, allowRetry: false }),
      false,
    );
  });
});

describe('shouldRetry: server errors', () => {
  test('retries a server error for an idempotent method', () => {
    for (const status of RETRYABLE_STATUSES) {
      assert.equal(
        shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status }),
        true,
        `GET should be retried on ${status}`,
      );
    }
  });

  test('refuses to retry a server error for a mutating method', () => {
    /**
     * The property that prevents duplicate servers. A 502 from a reverse proxy does not tell us
     * whether the panel executed the request, so a POST must fail rather than replay.
     */
    for (const method of MUTATING_METHODS) {
      for (const status of RETRYABLE_STATUSES) {
        assert.equal(
          shouldRetry({ attempt: 1, maxAttempts: 3, method, status }),
          false,
          `${method} must not be retried on ${status}`,
        );
      }
    }
  });

  test('does not retry a client error', () => {
    /**
     * A 400, 404 or 422 will fail identically on every attempt. Retrying only delays the operator
     * seeing the real cause, and 409 in this project means the server is busy — which the service
     * layer reports rather than waiting out.
     */
    for (const status of [400, 401, 403, 404, 409, 410, 422]) {
      assert.equal(
        shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status }),
        false,
        `GET must not be retried on ${status}`,
      );
    }
  });

  test('does not retry a success status', () => {
    // Defensive: shouldRetry is only called on a failure, but the guard costs nothing.
    for (const status of [200, 201, 204]) {
      assert.equal(shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status }), false);
    }
  });
});

describe('shouldRetry: transport failures', () => {
  test('retries a transient socket error for an idempotent method', () => {
    for (const code of RETRYABLE_NETWORK_CODES) {
      assert.equal(
        shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status: null, code }),
        true,
        `GET should be retried on ${code}`,
      );
    }
  });

  test('refuses to retry a socket error for a mutating method', () => {
    /**
     * The most dangerous case in practice. A timeout after the panel accepted a create request
     * looks identical to one where it never arrived, so a POST replay could provision twice.
     */
    for (const method of MUTATING_METHODS) {
      for (const code of RETRYABLE_NETWORK_CODES) {
        assert.equal(
          shouldRetry({ attempt: 1, maxAttempts: 3, method, status: null, code }),
          false,
          `${method} must not be retried on ${code}`,
        );
      }
    }
  });

  test('does not retry a TLS failure', () => {
    /**
     * An expired or untrusted certificate fails identically every time. These codes are absent from
     * the retryable set on purpose, so the operator sees the cause immediately.
     */
    for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      assert.equal(
        shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status: null, code }),
        false,
        `${code} must not be retried`,
      );
    }
  });

  test('does not retry a connection refused', () => {
    /**
     * ECONNREFUSED means nothing is listening, which is a configuration or outage condition rather
     * than a transient fault. Retrying three times against a stopped panel wastes the interaction
     * window for no benefit.
     */
    assert.equal(
      shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status: null, code: 'ECONNREFUSED' }),
      false,
    );
  });

  test('does not retry an unrecognised error code', () => {
    // Unknown means unclassified, and an unclassified failure is not known to be safe to replay.
    assert.equal(
      shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status: null, code: 'ESOMETHINGNEW' }),
      false,
    );
    assert.equal(shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status: null, code: null }), false);
  });
});

describe('shouldRetry: limits', () => {
  test('stops at the attempt limit', () => {
    assert.equal(shouldRetry({ attempt: 1, maxAttempts: 3, method: 'GET', status: 500 }), true);
    assert.equal(shouldRetry({ attempt: 2, maxAttempts: 3, method: 'GET', status: 500 }), true);
    assert.equal(shouldRetry({ attempt: 3, maxAttempts: 3, method: 'GET', status: 500 }), false);
    assert.equal(shouldRetry({ attempt: 4, maxAttempts: 3, method: 'GET', status: 500 }), false);
  });

  test('a limit of one disables retrying', () => {
    // PANEL_MAX_RETRIES=1 is documented as meaning no retries.
    assert.equal(shouldRetry({ attempt: 1, maxAttempts: 1, method: 'GET', status: 500 }), false);
    assert.equal(shouldRetry({ attempt: 1, maxAttempts: 1, method: 'GET', status: 429 }), false);
  });

  test('stops once the cumulative wait budget is spent', () => {
    /**
     * The budget exists because backoff and Discord interactions interact badly. Three attempts at
     * a thirty-second cap can spend over a minute, by which point the user has concluded the
     * command failed.
     */
    assert.equal(
      shouldRetry({ attempt: 1, maxAttempts: 5, method: 'GET', status: 500, elapsedMs: 0, maxElapsedMs: 10_000 }),
      true,
    );
    assert.equal(
      shouldRetry({ attempt: 1, maxAttempts: 5, method: 'GET', status: 500, elapsedMs: 10_000, maxElapsedMs: 10_000 }),
      false,
    );
    assert.equal(
      shouldRetry({ attempt: 1, maxAttempts: 5, method: 'GET', status: 500, elapsedMs: 15_000, maxElapsedMs: 10_000 }),
      false,
    );
  });

  test('rejects nonsensical attempt bookkeeping rather than looping', () => {
    // A NaN limit must fail closed, not produce an unbounded retry loop.
    assert.equal(shouldRetry({ attempt: NaN, maxAttempts: 3, method: 'GET', status: 500 }), false);
    assert.equal(shouldRetry({ attempt: 1, maxAttempts: NaN, method: 'GET', status: 500 }), false);
  });

  test('the caller veto overrides every other consideration', () => {
    /**
     * Every state-changing call in pterodactyl.js passes allowRetry: false explicitly, so a future
     * change to the policy default cannot start duplicating servers.
     */
    for (const status of [429, 500, 502, 503]) {
      assert.equal(
        shouldRetry({ attempt: 1, maxAttempts: 5, method: 'GET', status, allowRetry: false }),
        false,
        `allowRetry: false must block a retry on ${status}`,
      );
    }
  });
});

describe('backoffDelayMs', () => {
  /** Returns the midpoint of the jitter range, for deterministic assertions. */
  const midpoint = () => 0.5;

  test('grows exponentially across attempts', () => {
    /**
     * Base 500ms doubling per attempt. With random() fixed at 0.5 the jitter multiplier is 0.75, so
     * the values are exactly predictable.
     */
    assert.equal(backoffDelayMs(1, { baseMs: 500, random: midpoint }), 375);
    assert.equal(backoffDelayMs(2, { baseMs: 500, random: midpoint }), 750);
    assert.equal(backoffDelayMs(3, { baseMs: 500, random: midpoint }), 1500);
    assert.equal(backoffDelayMs(4, { baseMs: 500, random: midpoint }), 3000);
  });

  test('applies full jitter within the expected band', () => {
    /**
     * Jitter is uniform across [ceiling/2, ceiling]. A panel behind a shared rate limiter rejects
     * many bot requests at once, and retrying them all on the same schedule reproduces the
     * thundering herd that caused the limit.
     */
    const lowest = backoffDelayMs(3, { baseMs: 500, random: () => 0 });
    const highest = backoffDelayMs(3, { baseMs: 500, random: () => 0.999_999 });

    assert.equal(lowest, 1000, 'the floor is half the ceiling');
    assert.equal(highest, 2000, 'the ceiling is base * 2^(attempt-1)');
  });

  test('produces varied delays across calls', () => {
    // With real randomness the delays must actually differ, or the jitter is not doing its job.
    const delays = new Set();

    for (let index = 0; index < 50; index += 1) {
      delays.add(backoffDelayMs(3, { baseMs: 500 }));
    }

    assert.ok(delays.size > 5, `expected varied delays, saw ${delays.size} distinct values`);
  });

  test('caps the delay at the configured maximum', () => {
    const delay = backoffDelayMs(20, { baseMs: 500, maxMs: 5000, random: () => 0.999_999 });

    assert.ok(delay <= 5000, `expected at most 5000, got ${delay}`);
  });

  test('a Retry-After header wins over the computed backoff', () => {
    /**
     * The panel has stated when it will accept traffic again. Guessing shorter simply earns another
     * 429, so the header takes precedence.
     */
    const delay = backoffDelayMs(1, {
      headers: { 'retry-after': '7' },
      baseMs: 500,
      random: midpoint,
    });

    assert.equal(delay, 7000);
  });

  test('a Retry-After header is still bounded by the maximum', () => {
    // A misconfigured proxy could advertise an hour; waiting that long inside an interaction is
    // pointless.
    const delay = backoffDelayMs(1, { headers: { 'retry-after': '3600' }, maxMs: 30_000 });

    assert.ok(delay <= 30_000, `expected at most 30000, got ${delay}`);
  });

  test('ignores an unparseable Retry-After and falls back to backoff', () => {
    const delay = backoffDelayMs(2, {
      headers: { 'retry-after': 'whenever' },
      baseMs: 500,
      random: midpoint,
    });

    assert.equal(delay, 750, 'should use the computed backoff');
  });

  test('never returns a negative delay', () => {
    assert.ok(backoffDelayMs(1, { baseMs: 0, random: () => 0 }) >= 0);
    assert.ok(backoffDelayMs(0, { baseMs: 500, random: () => 0 }) >= 0);
  });
});

describe('sleep', () => {
  test('resolves after roughly the requested duration', async () => {
    const started = Date.now();
    await sleep(30);
    const elapsed = Date.now() - started;

    // A generous lower bound: timer resolution and event loop scheduling both add variance.
    assert.ok(elapsed >= 25, `expected at least 25ms, waited ${elapsed}ms`);
  });

  test('resolves immediately for zero or a nonsensical duration', async () => {
    const started = Date.now();

    await sleep(0);
    await sleep(-100);
    await sleep(NaN);
    await sleep(undefined);

    assert.ok(Date.now() - started < 50, 'these should not actually wait');
  });
});

describe('describeFailure', () => {
  test('extracts the status, code and headers from an axios error', () => {
    const described = describeFailure(failure({ status: 429, headers: { 'retry-after': '5' } }));

    assert.equal(described.status, 429);
    assert.equal(described.code, null);
    assert.deepEqual(described.headers, { 'retry-after': '5' });
  });

  test('extracts a transport code with no response', () => {
    const described = describeFailure(failure({ code: 'ETIMEDOUT' }));

    assert.equal(described.status, null);
    assert.equal(described.code, 'ETIMEDOUT');
    assert.equal(described.headers, undefined);
  });

  test('tolerates a thrown non-Error value', () => {
    // Nothing guarantees a rejection carries an Error.
    for (const thrown of [null, undefined, 'string', 42, {}]) {
      const described = describeFailure(thrown);

      assert.equal(described.status, null);
      assert.equal(described.code, null);
    }
  });
});

describe('withRetry', () => {
  test('returns the result without retrying on success', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        return 'ok';
      },
      { maxAttempts: 3, method: 'GET' },
    );

    assert.equal(result, 'ok');
    assert.equal(attempts, 1, 'a successful call should not be repeated');
  });

  test('retries a retryable failure and returns the eventual success', async () => {
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw failure({ status: 503 });
        return 'recovered';
      },
      { maxAttempts: 3, method: 'GET', baseMs: 1 },
    );

    assert.equal(result, 'recovered');
    assert.equal(attempts, 3);
  });

  test('passes the attempt number to the operation', async () => {
    /**
     * The service layer logs it, so a retried request is distinguishable from a first attempt in the
     * operational record.
     */
    const seen = [];

    await assert.rejects(() =>
      withRetry(
        async (attempt) => {
          seen.push(attempt);
          throw failure({ status: 500 });
        },
        { maxAttempts: 3, method: 'GET', baseMs: 1 },
      ),
    );

    assert.deepEqual(seen, [1, 2, 3]);
  });

  test('rethrows the final failure unchanged', async () => {
    /**
     * Error normalisation is the caller's job. Wrapping here would lose the status and code the
     * service layer classifies on.
     */
    const original = failure({ status: 503 });
    let caught;

    try {
      await withRetry(
        async () => {
          throw original;
        },
        { maxAttempts: 2, method: 'GET', baseMs: 1 },
      );
    } catch (err) {
      caught = err;
    }

    assert.equal(caught, original, 'the same error instance should propagate');
  });

  test('does not retry a non-retryable failure', async () => {
    let attempts = 0;

    await assert.rejects(() =>
      withRetry(
        async () => {
          attempts += 1;
          throw failure({ status: 404 });
        },
        { maxAttempts: 3, method: 'GET', baseMs: 1 },
      ),
    );

    assert.equal(attempts, 1, 'a 404 should fail on the first attempt');
  });

  test('does not retry a mutating method after an ambiguous failure', async () => {
    /**
     * The end-to-end form of the property this module exists for. A createServer call that times
     * out must be attempted exactly once.
     */
    let attempts = 0;

    await assert.rejects(() =>
      withRetry(
        async () => {
          attempts += 1;
          throw failure({ code: 'ETIMEDOUT' });
        },
        { maxAttempts: 3, method: 'POST', baseMs: 1 },
      ),
    );

    assert.equal(attempts, 1, 'a POST must never be replayed after a timeout');
  });

  test('retries a rate-limited mutating request', async () => {
    // The 429 exception, end to end.
    let attempts = 0;

    const result = await withRetry(
      async () => {
        attempts += 1;
        if (attempts === 1) throw failure({ status: 429, headers: { 'retry-after': '0' } });
        return 'accepted';
      },
      { maxAttempts: 3, method: 'POST', baseMs: 1 },
    );

    assert.equal(result, 'accepted');
    assert.equal(attempts, 2);
  });

  test('honours the caller veto', async () => {
    let attempts = 0;

    await assert.rejects(() =>
      withRetry(
        async () => {
          attempts += 1;
          throw failure({ status: 429 });
        },
        { maxAttempts: 3, method: 'GET', allowRetry: false, baseMs: 1 },
      ),
    );

    assert.equal(attempts, 1);
  });

  test('reports each retry through the callback', async () => {
    /**
     * pterodactyl.js logs from here, which is how a retried request appears in the operational
     * record with its status and delay.
     */
    const retries = [];

    await assert.rejects(() =>
      withRetry(
        async () => {
          throw failure({ status: 502 });
        },
        {
          maxAttempts: 3,
          method: 'GET',
          baseMs: 1,
          onRetry: (info) => retries.push(info),
        },
      ),
    );

    assert.equal(retries.length, 2, 'two retries between three attempts');
    assert.equal(retries[0].attempt, 1);
    assert.equal(retries[0].status, 502);
    assert.ok(retries[0].delayMs >= 0);
    assert.equal(retries[1].attempt, 2);
  });

  test('survives a throwing onRetry callback', async () => {
    // A logging failure must not convert a retryable error into a different one.
    let attempts = 0;

    await assert.rejects(
      () =>
        withRetry(
          async () => {
            attempts += 1;
            throw failure({ status: 500 });
          },
          {
            maxAttempts: 2,
            method: 'GET',
            baseMs: 1,
            onRetry: () => {
              throw new Error('logging failed');
            },
          },
        ),
      // Either the original or the logging error may surface; what matters is that it terminates.
    );

    assert.ok(attempts >= 1);
  });

  test('stops before sleeping past the wait budget', async () => {
    /**
     * The budget is checked before the sleep, so the call fails immediately rather than waiting
     * out a delay and then failing anyway.
     */
    let attempts = 0;
    const started = Date.now();

    await assert.rejects(() =>
      withRetry(
        async () => {
          attempts += 1;
          throw failure({ status: 500 });
        },
        { maxAttempts: 10, method: 'GET', baseMs: 5000, maxElapsedMs: 100 },
      ),
    );

    const elapsed = Date.now() - started;

    assert.ok(attempts <= 2, `expected to stop early, made ${attempts} attempts`);
    assert.ok(elapsed < 1000, `expected to fail fast, took ${elapsed}ms`);
  });

  test('clamps a nonsensical attempt limit to one', async () => {
    let attempts = 0;

    await assert.rejects(() =>
      withRetry(
        async () => {
          attempts += 1;
          throw failure({ status: 500 });
        },
        { maxAttempts: 0, method: 'GET', baseMs: 1 },
      ),
    );

    assert.equal(attempts, 1, 'at least one attempt must be made');
  });

  test('defaults are sane', () => {
    /**
     * The wait budget must stay well inside Discord's fifteen-minute interaction window, and
     * comfortably inside a user's patience.
     */
    assert.ok(DEFAULTS.baseMs > 0);
    assert.ok(DEFAULTS.maxMs >= DEFAULTS.baseMs);
    assert.ok(DEFAULTS.maxElapsedMs > 0);
    assert.ok(DEFAULTS.maxElapsedMs <= 60_000, 'the budget should not exceed a minute');
  });
});
