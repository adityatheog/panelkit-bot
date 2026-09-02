// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/utils/errors.js.
 *
 * This module decides what a user sees when something fails, which makes it a security
 * boundary as much as a usability one. Two properties are asserted throughout:
 *
 *   Nothing technical leaks. A panel validation message naming an egg variable, an axios
 *   stack trace, SQL text — none of it may reach a Discord embed. Every test that exercises
 *   an error path checks the user-facing message for absence as well as presence.
 *
 *   Every failure is classified. normalizeApiError is the only place in the project that
 *   inspects an axios error shape, so it must produce a usable verdict for a status code it
 *   has never seen, a socket error, a TLS failure and a thrown non-Error alike.
 *
 * The retryable flag gets particular attention. It is what src/services/retry.js consults to
 * decide whether replaying a request is safe, and a wrong answer there means either duplicate
 * servers or a needlessly failed command.
 *
 * No credentials, no network, no filesystem.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AppError,
  AuthorizationError,
  ConfigError,
  DatabaseError,
  isUserError,
  NETWORK_CODES,
  NotFoundError,
  normalizeApiError,
  normalizeDatabaseError,
  parseRetryAfterMs,
  RateLimitError,
  STATUS_MESSAGES,
  toLogMeta,
  toUserMessage,
  ValidationError,
} from '../src/utils/errors.js';

/**
 * Builds an object shaped like an axios error.
 *
 * Constructed by hand rather than by making a real request, so the tests stay offline and
 * can produce shapes axios would only emit under conditions that are hard to reproduce.
 *
 * @param {{ status?: number, data?: unknown, code?: string, headers?: Record<string, string>, message?: string }} options
 * @returns {Error}
 */
function axiosError({ status, data, code, headers, message = 'Request failed' } = {}) {
  const err = new Error(message);

  if (status !== undefined) {
    err.response = { status, data, headers: headers ?? {} };
  }
  if (code !== undefined) {
    err.code = code;
  }

  err.isAxiosError = true;
  // The real thing carries the full request config, including the Authorization header.
  err.config = { url: '/servers', method: 'get', headers: { Authorization: 'Bearer ptla_secret_value' } };

  return err;
}

describe('AppError', () => {
  test('carries a user-safe message and diagnostic detail separately', () => {
    const cause = new Error('socket hang up');
    const err = new AppError('Something went wrong.', {
      code: 'TEST_CODE',
      status: 503,
      details: { label: 'createServer', panelDetail: 'internal' },
      cause,
    });

    assert.equal(err.userMessage, 'Something went wrong.');
    assert.equal(err.message, 'Something went wrong.');
    assert.equal(err.code, 'TEST_CODE');
    assert.equal(err.status, 503);
    assert.deepEqual(err.details, { label: 'createServer', panelDetail: 'internal' });
    assert.equal(err.cause, cause);
    assert.equal(err.name, 'AppError');
    assert.ok(err instanceof Error);
  });

  test('applies defaults for the optional fields', () => {
    const err = new AppError('Plain failure.');

    assert.equal(err.code, 'APP_ERROR');
    assert.equal(err.status, null);
    assert.equal(err.details, null);
    assert.equal(err.retryAfterMs, null);
    assert.equal('cause' in err, false, 'an absent cause should not be assigned');
  });

  test('toLogObject excludes the stack and the cause', () => {
    /**
     * The projection is what gets logged. A cause chain can carry an axios config with the
     * Authorization header, so it is deliberately not included.
     */
    const err = new AppError('Safe message.', {
      code: 'TEST',
      status: 400,
      details: { label: 'x' },
      cause: axiosError({ status: 400 }),
    });

    const logged = err.toLogObject();

    assert.deepEqual(Object.keys(logged).sort(), ['code', 'details', 'message', 'name', 'status']);
    assert.equal(logged.message, 'Safe message.');
    assert.equal('cause' in logged, false);
    assert.equal('stack' in logged, false);
  });

  test('captures a stack trace', () => {
    const err = new AppError('x');
    assert.ok(typeof err.stack === 'string' && err.stack.length > 0);
  });
});

describe('error subclasses', () => {
  test('each carries its own name, code and status', () => {
    const cases = [
      [new ConfigError('bad config'), 'ConfigError', 'CONFIG_ERROR', null],
      [new ValidationError('bad input'), 'ValidationError', 'VALIDATION_ERROR', null],
      [new NotFoundError(), 'NotFoundError', 'NOT_FOUND', 404],
      [new AuthorizationError(), 'AuthorizationError', 'FORBIDDEN', 403],
      [new DatabaseError(), 'DatabaseError', 'DB_ERROR', null],
    ];

    for (const [err, name, code, status] of cases) {
      assert.equal(err.name, name);
      assert.equal(err.code, code);
      assert.equal(err.status, status);
      assert.ok(err instanceof AppError, `${name} should extend AppError`);
    }
  });

  test('NotFoundError and AuthorizationError have safe defaults', () => {
    /**
     * The AuthorizationError default is deliberately vague. serverService returns the same
     * message for a missing server and a foreign one, so identifiers cannot be enumerated by
     * comparing responses.
     */
    assert.equal(new NotFoundError().userMessage, 'The requested resource could not be found.');
    assert.equal(new AuthorizationError().userMessage, 'You are not allowed to do that.');
  });

  test('RateLimitError carries a retry hint', () => {
    const err = new RateLimitError('Slow down.', 5000);

    assert.equal(err.status, 429);
    assert.equal(err.code, 'RATE_LIMITED');
    assert.equal(err.retryAfterMs, 5000);
  });
});

describe('isUserError', () => {
  test('classifies expected user mistakes', () => {
    /**
     * This is what keeps the error log usable. A public bot receives a constant stream of
     * mistyped identifiers and attempts on servers people do not own; logging those at error
     * level would bury a real panel outage.
     */
    assert.equal(isUserError(new ValidationError('bad input')), true);
    assert.equal(isUserError(new AuthorizationError()), true);
    assert.equal(isUserError(new NotFoundError()), true);
  });

  test('does not classify genuine faults as user errors', () => {
    assert.equal(isUserError(new AppError('panel exploded', { code: 'PANEL_HTTP_500', status: 500 })), false);
    assert.equal(isUserError(new ConfigError('bad config')), false);
    assert.equal(isUserError(new DatabaseError()), false);
    assert.equal(isUserError(new Error('boom')), false);
    assert.equal(isUserError(null), false);
    assert.equal(isUserError(undefined), false);
  });
});

describe('parseRetryAfterMs', () => {
  test('parses the delay-seconds form', () => {
    assert.equal(parseRetryAfterMs({ 'retry-after': '5' }), 5000);
    assert.equal(parseRetryAfterMs({ 'retry-after': '0' }), 0);
    assert.equal(parseRetryAfterMs({ 'retry-after': '1.5' }), 1500);
  });

  test('accepts the canonical header casing', () => {
    assert.equal(parseRetryAfterMs({ 'Retry-After': '3' }), 3000);
  });

  test('parses the HTTP-date form', () => {
    const future = new Date(Date.now() + 4000).toUTCString();
    const parsed = parseRetryAfterMs({ 'retry-after': future });

    assert.ok(parsed !== null && parsed > 2000 && parsed <= 5000, `unexpected value: ${parsed}`);
  });

  test('clamps to a one-minute ceiling', () => {
    /**
     * A hostile or misconfigured proxy could advertise an hour. Waiting that long inside a
     * Discord interaction is pointless, so the value is bounded.
     */
    assert.equal(parseRetryAfterMs({ 'retry-after': '3600' }), 60_000);
  });

  test('never returns a negative value for a past date', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    assert.equal(parseRetryAfterMs({ 'retry-after': past }), 0);
  });

  test('returns null when the header is absent or unusable', () => {
    assert.equal(parseRetryAfterMs(undefined), null);
    assert.equal(parseRetryAfterMs({}), null);
    assert.equal(parseRetryAfterMs({ 'retry-after': '' }), null);
    assert.equal(parseRetryAfterMs({ 'retry-after': 'soon' }), null);
  });

  test('reads the Discord rate limit header as a fallback', () => {
    assert.equal(parseRetryAfterMs({ 'x-ratelimit-reset-after': '2' }), 2000);
  });
});

describe('normalizeApiError with an HTTP status', () => {
  test('maps every documented status to its user message', () => {
    for (const [status, expected] of Object.entries(STATUS_MESSAGES)) {
      const { error, code } = normalizeApiError(axiosError({ status: Number(status) }), 'test');

      assert.equal(error.userMessage, expected, `status ${status}`);
      assert.equal(code, `PANEL_HTTP_${status}`);
      assert.equal(error.status, Number(status));
    }
  });

  test('falls back to the 5xx family message for an unmapped server error', () => {
    // 599 is not in the table; it must still produce something sensible.
    const { error } = normalizeApiError(axiosError({ status: 599 }), 'test');

    assert.equal(error.userMessage, STATUS_MESSAGES[500]);
    assert.equal(error.code, 'PANEL_HTTP_599');
  });

  test('falls back to a generic message for an unmapped 4xx', () => {
    const { error } = normalizeApiError(axiosError({ status: 418 }), 'test');

    assert.equal(error.userMessage, 'The panel returned an unexpected error.');
    assert.equal(error.code, 'PANEL_HTTP_418');
  });

  test('points 401 and 403 at the API key rather than blaming the user', () => {
    /**
     * These two are almost always a configuration problem. A message telling a user they
     * lack permission would send them to their server owner instead of the operator.
     */
    assert.match(normalizeApiError(axiosError({ status: 401 }), 'x').error.userMessage, /API credentials/i);
    assert.match(normalizeApiError(axiosError({ status: 403 }), 'x').error.userMessage, /permissions/i);
  });
});

describe('normalizeApiError and the panel error envelope', () => {
  test('captures the panel detail without exposing it to the user', () => {
    /**
     * The panel's detail names the offending field, which is valuable to an operator and
     * revealing to a user: it can disclose egg and node configuration.
     */
    const err = axiosError({
      status: 422,
      data: {
        errors: [
          { code: 'ValidationException', status: '422', detail: 'The egg field is required.' },
          { code: 'ValidationException', status: '422', detail: 'The allocation is invalid.' },
        ],
      },
    });

    const { error, detail } = normalizeApiError(err, 'createServer');

    assert.equal(detail, 'The egg field is required.; The allocation is invalid.');
    assert.equal(error.details.panelDetail, detail);
    assert.equal(error.details.label, 'createServer');

    assert.ok(!error.userMessage.includes('egg field'), 'panel internals must not reach the user');
    assert.ok(!error.userMessage.includes('allocation'), 'panel internals must not reach the user');
    assert.equal(error.userMessage, STATUS_MESSAGES[422]);
  });

  test('falls back to a bare message field', () => {
    // Some panel builds and reverse proxies answer with { message } rather than { errors }.
    const { detail } = normalizeApiError(
      axiosError({ status: 500, data: { message: 'Server Error' } }),
      'test',
    );

    assert.equal(detail, 'Server Error');
  });

  test('tolerates an envelope that is absent or malformed', () => {
    for (const data of [undefined, null, '', 'plain text', [], { errors: [] }, { errors: 'nope' }]) {
      const { detail, error } = normalizeApiError(axiosError({ status: 400, data }), 'test');

      assert.equal(detail, null, `detail should be null for ${JSON.stringify(data)}`);
      assert.equal(error.userMessage, STATUS_MESSAGES[400]);
    }
  });

  test('never places the request config in the user message', () => {
    /**
     * The axios error carries the Authorization header in err.config. This asserts it does
     * not survive into anything user-visible.
     */
    const { error } = normalizeApiError(axiosError({ status: 500 }), 'test');

    assert.ok(!error.userMessage.includes('ptla_'), 'the API key must not reach the user message');
    assert.ok(!JSON.stringify(error.details).includes('ptla_'), 'the API key must not reach the logged details');
  });
});

describe('normalizeApiError with a transport failure', () => {
  test('reports a reachability problem for a socket error', () => {
    for (const code of ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH']) {
      const { error, status, retryable } = normalizeApiError(axiosError({ code }), 'test');

      assert.match(error.userMessage, /could not reach the panel/i, `code ${code}`);
      assert.equal(error.code, `PANEL_NETWORK_${code}`);
      assert.equal(status, null);
      assert.equal(retryable, true, `${code} should be retryable`);
    }
  });

  test('reports a TLS failure distinctly and marks it non-retryable', () => {
    /**
     * The important distinction. An expired certificate fails identically on every attempt,
     * so retrying only delays the operator seeing the real cause — and the message names the
     * certificate rather than suggesting the panel is offline.
     */
    for (const code of ['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE']) {
      const { error, retryable } = normalizeApiError(axiosError({ code }), 'test');

      assert.match(error.userMessage, /TLS certificate/i, `code ${code}`);
      assert.equal(retryable, false, `${code} must not be retried`);
    }
  });

  test('recognises every documented network code', () => {
    for (const code of NETWORK_CODES) {
      const { code: normalised } = normalizeApiError(axiosError({ code }), 'test');
      assert.equal(normalised, `PANEL_NETWORK_${code}`);
    }
  });

  test('classifies an unrecognised failure as unknown and non-retryable', () => {
    const { error, code, retryable } = normalizeApiError(new Error('something odd'), 'test');

    assert.equal(code, 'PANEL_UNKNOWN');
    assert.equal(retryable, false);
    assert.equal(error.userMessage, 'An unexpected error occurred while talking to the panel.');
    assert.equal(error.details.cause, 'something odd');
  });

  test('tolerates a thrown non-Error value', () => {
    // Nothing guarantees a rejection carries an Error.
    for (const thrown of ['string failure', 42, null, undefined, {}]) {
      const { error, code } = normalizeApiError(thrown, 'test');

      assert.equal(code, 'PANEL_UNKNOWN');
      assert.ok(typeof error.userMessage === 'string' && error.userMessage.length > 0);
    }
  });
});

describe('normalizeApiError retry classification', () => {
  test('marks 429 retryable and carries the Retry-After hint', () => {
    /**
     * A 429 means the request was rejected before execution, so replaying it is safe for any
     * method — including POST. That is the one case where retry.js allows a non-idempotent
     * replay, and it depends on this flag.
     */
    const { retryable, retryAfterMs, error } = normalizeApiError(
      axiosError({ status: 429, headers: { 'retry-after': '3' } }),
      'test',
    );

    assert.equal(retryable, true);
    assert.equal(retryAfterMs, 3000);
    assert.equal(error.retryAfterMs, 3000);
  });

  test('defaults the 429 hint when the header is absent', () => {
    const { retryAfterMs } = normalizeApiError(axiosError({ status: 429 }), 'test');
    assert.equal(retryAfterMs, 5000);
  });

  test('marks 5xx retryable and 4xx not', () => {
    for (const status of [500, 502, 503, 504]) {
      assert.equal(normalizeApiError(axiosError({ status }), 'x').retryable, true, `status ${status}`);
    }

    for (const status of [400, 401, 403, 404, 409, 422]) {
      assert.equal(normalizeApiError(axiosError({ status }), 'x').retryable, false, `status ${status}`);
    }
  });

  test('passes an existing AppError through unchanged', () => {
    /**
     * Errors thrown deliberately by the service layer must not be reclassified, or a
     * NotFoundError would lose its status and message on the way out.
     */
    const original = new AppError('custom message', { code: 'CUSTOM', status: 418 });
    const { error, code, status } = normalizeApiError(original, 'test');

    assert.equal(error, original, 'the same instance should be returned');
    assert.equal(code, 'CUSTOM');
    assert.equal(status, 418);
  });

  test('preserves the retry verdict for a wrapped AppError', () => {
    const rateLimited = new AppError('slow down', { code: 'X', status: 429, retryAfterMs: 1000 });
    const serverError = new AppError('boom', { code: 'Y', status: 503 });
    const notFound = new NotFoundError();

    assert.equal(normalizeApiError(rateLimited, 'x').retryable, true);
    assert.equal(normalizeApiError(serverError, 'x').retryable, true);
    assert.equal(normalizeApiError(notFound, 'x').retryable, false);
  });
});

describe('normalizeDatabaseError', () => {
  test('classifies a uniqueness conflict as a conflict, not a fault', () => {
    /**
     * A duplicate insert is an expected outcome of a race, not a broken database, so it gets
     * its own code and a message the user can act on.
     */
    for (const code of ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_CONSTRAINT_PRIMARYKEY', 'SQLITE_CONSTRAINT_TRIGGER']) {
      const err = normalizeDatabaseError(Object.assign(new Error('constraint failed'), { code }), 'createUser');

      assert.equal(err.code, 'DB_CONFLICT');
      assert.equal(err.userMessage, 'That record already exists.');
      assert.equal(err.details.label, 'createUser');
      assert.equal(err.details.sqlite, code);
    }
  });

  test('classifies a lock contention as transient', () => {
    for (const code of ['SQLITE_BUSY', 'SQLITE_LOCKED']) {
      const err = normalizeDatabaseError(Object.assign(new Error('database is locked'), { code }), 'x');

      assert.match(err.userMessage, /busy right now/i);
      assert.ok(err instanceof DatabaseError);
    }
  });

  test('classifies a permissions problem as an operator problem', () => {
    for (const code of ['SQLITE_CANTOPEN', 'SQLITE_READONLY']) {
      const err = normalizeDatabaseError(Object.assign(new Error('unable to open'), { code }), 'x');

      assert.match(err.userMessage, /administrator/i);
    }
  });

  test('never exposes SQL text to the user', () => {
    /**
     * better-sqlite3 error messages include the statement, which can name tables and columns.
     * The user-facing message must be generic.
     */
    const err = normalizeDatabaseError(
      Object.assign(new Error('NOT NULL constraint failed: users.panel_id in "INSERT INTO users ..."'), {
        code: 'SQLITE_CONSTRAINT_NOTNULL',
      }),
      'createUser',
    );

    assert.ok(!err.userMessage.includes('INSERT'), 'SQL must not reach the user');
    assert.ok(!err.userMessage.includes('users.panel_id'), 'schema detail must not reach the user');
    assert.equal(err.userMessage, 'A database error occurred. Please try again later.');
  });

  test('passes an existing AppError through unchanged', () => {
    const original = new AppError('already normalised');
    assert.equal(normalizeDatabaseError(original, 'x'), original);
  });
});

describe('toUserMessage', () => {
  test('returns the curated message from an AppError', () => {
    assert.equal(toUserMessage(new AppError('Safe and specific.')), 'Safe and specific.');
    assert.equal(toUserMessage(new ValidationError('That is not a valid identifier.')), 'That is not a valid identifier.');
  });

  test('returns a generic message for anything unrecognised', () => {
    /**
     * The default is deliberately vague: an unrecognised exception is by definition one whose
     * message has not been reviewed for safety.
     */
    const leaky = new Error('SELECT * FROM users WHERE token = "ptla_secret" failed at db.js:412');

    assert.equal(toUserMessage(leaky), 'Something went wrong. Please try again later.');
    assert.ok(!toUserMessage(leaky).includes('ptla_'));
    assert.ok(!toUserMessage(leaky).includes('SELECT'));
  });

  test('recognises a raw SQLite error', () => {
    assert.match(toUserMessage(Object.assign(new Error('boom'), { code: 'SQLITE_BUSY' })), /database error/i);
    assert.match(toUserMessage(Object.assign(new Error('boom'), { name: 'SqliteError' })), /database error/i);
  });

  test('explains an expired interaction', () => {
    /**
     * discord.js throws this when the three-second acknowledgement window closes. Telling the
     * user to run the command again is actionable; "something went wrong" is not.
     */
    assert.match(toUserMessage({ code: 10062 }), /expired/i);
    assert.match(toUserMessage({ code: 'InteractionAlreadyReplied' }), /expired/i);
  });

  test('explains a blocked direct message', () => {
    // 50007 is the code behind every credential delivery failure in this project.
    assert.match(toUserMessage({ code: 50007 }), /direct message/i);
  });

  test('tolerates a thrown non-Error value', () => {
    for (const thrown of [null, undefined, 'string', 42, {}, []]) {
      const message = toUserMessage(thrown);
      assert.ok(typeof message === 'string' && message.length > 0, `should return a string for ${JSON.stringify(thrown)}`);
    }
  });
});

describe('toLogMeta', () => {
  test('builds a consistent log projection', () => {
    const err = new AppError('failed', { code: 'X', status: 500, details: { label: 'createServer' } });
    const meta = toLogMeta(err, { command: 'server create', userId: '123456789012345678' });

    assert.equal(meta.command, 'server create');
    assert.equal(meta.userId, '123456789012345678');
    assert.equal(meta.name, 'AppError');
    assert.equal(meta.code, 'X');
    assert.equal(meta.status, 500);
    assert.equal(meta.message, 'failed');
    assert.deepEqual(meta.details, { label: 'createServer' });
  });

  test('reads the status from an axios error shape', () => {
    const meta = toLogMeta(axiosError({ status: 503 }), {});
    assert.equal(meta.status, 503);
  });

  test('tolerates a thrown non-Error value', () => {
    const meta = toLogMeta('just a string', { command: 'ping' });

    assert.equal(meta.command, 'ping');
    assert.equal(meta.name, 'Error');
    assert.equal(meta.message, 'just a string');
    assert.equal(meta.code, null);
  });

  test('does not include the raw error object', () => {
    /**
     * Passing the error itself would put err.config, and therefore the Authorization header,
     * into the log. The logger redacts by key name, but not including it at all is stronger.
     */
    const meta = toLogMeta(axiosError({ status: 500 }), {});

    assert.equal('config' in meta, false);
    assert.equal('response' in meta, false);
    assert.ok(!JSON.stringify(meta).includes('ptla_'));
  });
});
