// Coded by Aditya | GitHub- @adityatheog

/**
 * Centralised error model.
 *
 * The single rule this module enforces: users see curated prose, operators see
 * technical detail. AppError carries a `userMessage` that is safe to render in a
 * Discord embed, while everything diagnostic (HTTP status, axios internals, panel
 * payloads, SQL text, stack traces) stays in `details` and `cause` for the logger.
 *
 * Every panel failure is funnelled through normalizeApiError() so the rest of the
 * codebase never inspects an axios error shape, and every user-facing surface
 * calls toUserMessage() so an unexpected exception degrades to a generic message
 * rather than leaking internals.
 */

/**
 * Base application error with a user-safe message.
 *
 * @property {string} userMessage text safe to show a Discord user
 * @property {string} code stable machine-readable identifier for logs and tests
 * @property {number|null} status HTTP status when the error originated upstream
 * @property {unknown} details diagnostic context; never rendered to users
 * @property {number|null} retryAfterMs hint for rate-limited operations
 */
export class AppError extends Error {
  constructor(
    userMessage,
    { code = 'APP_ERROR', status = null, details = null, cause = null, retryAfterMs = null } = {},
  ) {
    super(userMessage);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
    this.userMessage = userMessage;
    this.details = details;
    this.retryAfterMs = retryAfterMs;
    if (cause !== null && cause !== undefined) this.cause = cause;
    if (typeof Error.captureStackTrace === 'function') Error.captureStackTrace(this, this.constructor);
  }

  /** Log-friendly projection. Excludes the stack, which the logger adds separately. */
  toLogObject() {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.userMessage,
      details: this.details,
    };
  }
}

/** Invalid or missing configuration. Fatal at startup, reported plainly at runtime. */
export class ConfigError extends AppError {
  constructor(message, details = null) {
    super(message, { code: 'CONFIG_ERROR', details });
    this.name = 'ConfigError';
  }
}

/** Bad user input. Expected in normal operation, so never logged as an error. */
export class ValidationError extends AppError {
  constructor(message, details = null) {
    super(message, { code: 'VALIDATION_ERROR', details });
    this.name = 'ValidationError';
  }
}

/** A referenced resource does not exist. */
export class NotFoundError extends AppError {
  constructor(message = 'The requested resource could not be found.', details = null) {
    super(message, { code: 'NOT_FOUND', status: 404, details });
    this.name = 'NotFoundError';
  }
}

/**
 * The caller is not permitted to perform the action.
 *
 * Used for both "this is not yours" and "you are not an admin". The message is
 * deliberately identical for missing and foreign resources so identifiers cannot
 * be enumerated by probing.
 */
export class AuthorizationError extends AppError {
  constructor(message = 'You are not allowed to do that.', details = null) {
    super(message, { code: 'FORBIDDEN', status: 403, details });
    this.name = 'AuthorizationError';
  }
}

/** A per-user cooldown or upstream rate limit was hit. */
export class RateLimitError extends AppError {
  constructor(message, retryAfterMs = null, details = null) {
    super(message, { code: 'RATE_LIMITED', status: 429, details, retryAfterMs });
    this.name = 'RateLimitError';
  }
}

/** Local persistence failed. */
export class DatabaseError extends AppError {
  constructor(message = 'A database error occurred. Please try again later.', details = null, cause = null) {
    super(message, { code: 'DB_ERROR', details, cause });
    this.name = 'DatabaseError';
  }
}

/**
 * User-facing text per HTTP status.
 *
 * Each message says what happened and what the user or operator can do about it,
 * without revealing panel internals. 401 and 403 point at configuration because
 * they are almost always an API key problem rather than a user mistake.
 */
const STATUS_MESSAGES = Object.freeze({
  400: 'The panel rejected the request as invalid.',
  401: 'The panel rejected our API credentials. Ask an administrator to check the API keys.',
  403: 'The panel denied access to this resource. The API key may lack the required permissions.',
  404: 'The panel could not find that resource. It may have been deleted.',
  409: 'The server is busy with another operation (for example installing). Try again shortly.',
  422: 'The panel rejected the request data. Check the egg configuration.',
  429: 'The panel is rate limiting us. Please wait a moment and try again.',
  500: 'The panel reported an internal error. Try again later.',
  502: 'The panel is unreachable right now. Try again later.',
  503: 'The panel is temporarily unavailable. Try again later.',
  504: 'The panel took too long to respond. Try again later.',
});

/** Node/libuv error codes that mean the request never reached the panel. */
const NETWORK_CODES = Object.freeze(
  new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'EPROTO',
    'ETIMEDOUT',
    'ERR_CANCELED',
    'CERT_HAS_EXPIRED',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  ]),
);

/** SQLite constraint codes that indicate a duplicate rather than a fault. */
const SQLITE_CONFLICT_CODES = Object.freeze(
  new Set(['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_TRIGGER']),
);

/**
 * Extracts Pterodactyl's error envelope.
 *
 * The panel answers `{ errors: [{ code, status, detail }] }`. The detail is
 * valuable for operators (it names the offending field) but is not shown to
 * users, since it can reveal egg and node configuration.
 *
 * @param {unknown} body parsed response body
 * @returns {string|null}
 */
function extractPanelDetail(body) {
  if (!body || typeof body !== 'object') return null;

  const list = Array.isArray(body.errors) ? body.errors : null;
  if (list && list.length > 0) {
    const joined = list
      .map((entry) => entry?.detail || entry?.code)
      .filter(Boolean)
      .join('; ');
    if (joined) return joined;
  }

  // Some panel builds and reverse proxies answer with a bare message field.
  if (typeof body.message === 'string' && body.message.trim() !== '') return body.message.trim();

  return null;
}

/**
 * Reads a Retry-After header in either supported form.
 *
 * @param {Record<string, unknown>|undefined} headers
 * @returns {number|null} milliseconds to wait, capped at one minute
 */
export function parseRetryAfterMs(headers) {
  if (!headers) return null;

  const raw = headers['retry-after'] ?? headers['Retry-After'] ?? headers['x-ratelimit-reset-after'];
  if (raw === undefined || raw === null || raw === '') return null;

  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), 60_000);

  const timestamp = Date.parse(String(raw));
  if (!Number.isNaN(timestamp)) return Math.max(0, Math.min(timestamp - Date.now(), 60_000));

  return null;
}

/**
 * Converts any thrown value from an axios call into one normalized shape.
 *
 * This is the only place in the codebase that inspects `err.response`, so panel
 * HTTP semantics stay contained in the service layer.
 *
 * @param {unknown} err the caught value
 * @param {string} label operation name, used only in logs
 * @returns {{ error: AppError, status: number|null, code: string, detail: string|null, retryable: boolean, retryAfterMs: number|null }}
 */
export function normalizeApiError(err, label = 'panel request') {
  // Already normalized, or thrown deliberately by our own service layer.
  if (err instanceof AppError) {
    return {
      error: err,
      status: err.status,
      code: err.code,
      detail: err.userMessage,
      retryable: err.status === 429 || (typeof err.status === 'number' && err.status >= 500),
      retryAfterMs: err.retryAfterMs,
    };
  }

  const status = err?.response?.status ?? null;
  const panelDetail = extractPanelDetail(err?.response?.data);

  if (status !== null) {
    const family = status >= 500 ? 500 : status;
    const userMessage =
      STATUS_MESSAGES[status] || STATUS_MESSAGES[family] || 'The panel returned an unexpected error.';
    const retryAfterMs = status === 429 ? (parseRetryAfterMs(err?.response?.headers) ?? 5000) : null;

    return {
      error: new AppError(userMessage, {
        code: `PANEL_HTTP_${status}`,
        status,
        details: { label, panelDetail },
        cause: err,
        retryAfterMs,
      }),
      status,
      code: `PANEL_HTTP_${status}`,
      detail: panelDetail,
      retryable: status === 429 || status >= 500,
      retryAfterMs,
    };
  }

  const networkCode = err?.code ?? null;
  if (networkCode !== null && NETWORK_CODES.has(networkCode)) {
    const tlsProblem = networkCode.includes('CERT') || networkCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
    const userMessage = tlsProblem
      ? 'The panel presented an invalid TLS certificate. An administrator must fix the panel certificate or the PANEL_URL.'
      : 'Could not reach the panel. It may be offline or the panel URL may be wrong.';

    return {
      error: new AppError(userMessage, {
        code: `PANEL_NETWORK_${networkCode}`,
        details: { label, cause: networkCode },
        cause: err,
      }),
      status: null,
      code: `PANEL_NETWORK_${networkCode}`,
      detail: networkCode,
      // A TLS failure will not fix itself on retry; a transient socket error may.
      retryable: !tlsProblem,
      retryAfterMs: null,
    };
  }

  return {
    error: new AppError('An unexpected error occurred while talking to the panel.', {
      code: 'PANEL_UNKNOWN',
      details: { label, cause: err?.message ?? String(err) },
      cause: err,
    }),
    status: null,
    code: 'PANEL_UNKNOWN',
    detail: err?.message ?? null,
    retryable: false,
    retryAfterMs: null,
  };
}

/**
 * Wraps a better-sqlite3 failure in a user-safe error.
 *
 * @param {unknown} err
 * @param {string} label operation name for logs
 * @returns {AppError}
 */
export function normalizeDatabaseError(err, label = 'database operation') {
  if (err instanceof AppError) return err;

  const code = err?.code ?? null;

  if (code !== null && SQLITE_CONFLICT_CODES.has(code)) {
    return new AppError('That record already exists.', {
      code: 'DB_CONFLICT',
      details: { label, sqlite: code },
      cause: err,
    });
  }

  if (code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED') {
    return new DatabaseError(
      'The database is busy right now. Please try again in a moment.',
      { label, sqlite: code },
      err,
    );
  }

  if (code === 'SQLITE_CANTOPEN' || code === 'SQLITE_READONLY') {
    return new DatabaseError(
      'The database could not be written to. An administrator must check the storage path and permissions.',
      { label, sqlite: code },
      err,
    );
  }

  return new DatabaseError(undefined, { label, sqlite: code }, err);
}

/**
 * Maps any thrown value to text safe to render in a Discord embed.
 *
 * The default is intentionally vague: an unrecognised exception is, by
 * definition, one whose message has not been reviewed for safety.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function toUserMessage(err) {
  if (err instanceof AppError) return err.userMessage;

  if (err?.name === 'SqliteError' || String(err?.code ?? '').startsWith('SQLITE_')) {
    return 'A database error occurred. Please try again later.';
  }

  // discord.js throws this when an interaction token expires (3 seconds unacknowledged).
  if (err?.code === 'InteractionAlreadyReplied' || err?.code === 10062) {
    return 'That interaction expired before it could be processed. Please run the command again.';
  }

  if (err?.code === 50007) {
    return 'I could not send you a direct message. Enable direct messages from server members and try again.';
  }

  return 'Something went wrong. Please try again later.';
}

/**
 * Builds the metadata object attached to a log line for a failed operation.
 * Keeps every call site consistent and avoids logging raw error objects.
 *
 * @param {unknown} err
 * @param {Record<string, unknown>} context
 */
export function toLogMeta(err, context = {}) {
  return {
    ...context,
    name: err?.name ?? 'Error',
    code: err?.code ?? null,
    status: err?.status ?? err?.response?.status ?? null,
    message: err?.message ?? String(err),
    details: err?.details ?? null,
  };
}

/** True when the value is an expected user error rather than a fault worth alerting on. */
export function isUserError(err) {
  return err instanceof ValidationError || err instanceof AuthorizationError || err instanceof NotFoundError;
}

export { NETWORK_CODES, STATUS_MESSAGES };
