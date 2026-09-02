// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/config/env.js.
 *
 * This module runs before anything else: before the database opens, before the Discord client is
 * constructed, before a single log line has a level. Its job is to turn `process.env` — an untyped
 * bag of strings that may be missing, malformed or half-filled — into one frozen typed object, and
 * to fail loudly if it cannot.
 *
 * Three properties are asserted throughout, matching the module's three stated principles:
 *
 *   Fail once, with everything. A user who has just copied `.env.example` is usually missing several
 *   values, and reporting them one restart at a time is hostile. Every missing required variable is
 *   named in a single error.
 *
 *   Never echo a secret. Validation messages name the offending variable and describe the expected
 *   shape, never the value — even for a value that failed validation, because a mistyped token is
 *   still a token. `describeEnv` gets its own block for this reason.
 *
 *   Normalise at the boundary. `PANEL_URL` is canonicalised here so no other module has to wonder
 *   whether it ends in a slash or carries an `/api` suffix.
 *
 * `loadEnv` accepts an explicit source object, so nothing here mutates `process.env`. The one test
 * that touches the filesystem uses a temporary directory rather than the project root, since loading
 * a developer's real `.env` into the test process would leak configuration between test files.
 *
 * No credentials, no network.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  BOUNDS,
  describeEnv,
  loadDotEnv,
  loadEnv,
  normalizePanelUrl,
  REQUIRED_KEYS,
  VALID_LOG_LEVELS,
} from '../src/config/env.js';
import { ConfigError } from '../src/utils/errors.js';

/**
 * A bot token shaped like the real thing: three dot-separated base64url segments.
 *
 * Not a real token, and deliberately not one that could be mistaken for one — the shape is what the
 * validator inspects.
 */
const TOKEN = 'MTExMTExMTExMTExMTExMTEx.GaBcDe.fGhIjKlMnOpQrStUvWxYz1234567890';

const CLIENT_ID = '111111111111111111';
const GUILD_ID = '222222222222222222';

/**
 * A minimal set of environment variables that satisfies validation.
 *
 * @param {Record<string, string>} [overrides]
 * @returns {Record<string, string>}
 */
function baseEnv(overrides = {}) {
  return {
    DISCORD_TOKEN: TOKEN,
    CLIENT_ID,
    PANEL_URL: 'https://panel.example.com',
    PANEL_APP_KEY: 'ptla_abcdefghijklmnopqrstuvwxyz0123456789',
    PANEL_CLIENT_KEY: 'ptlc_zyxwvutsrqponmlkjihgfedcba9876543210',
    ...overrides,
  };
}

describe('required variables', () => {
  test('names every missing variable in one error', () => {
    /**
     * The behaviour that matters for a first run. Reporting one missing value per restart would mean
     * five restarts to configure a fresh clone.
     */
    let caught;

    try {
      loadEnv({});
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ConfigError, 'an empty environment must be refused');

    for (const key of REQUIRED_KEYS) {
      assert.ok(caught.message.includes(key), `${key} should be named in the error`);
    }
  });

  test('points at the file to copy', () => {
    // The message is the only thing an operator sees before the process exits.
    assert.throws(
      () => loadEnv({}),
      (err) => err.message.includes('.env.example'),
    );
  });

  test('treats an empty value as missing', () => {
    /**
     * A variable present but blank is the most common half-configured state: the line was copied from
     * the template and never filled in.
     */
    for (const key of REQUIRED_KEYS) {
      assert.throws(
        () => loadEnv(baseEnv({ [key]: '' })),
        (err) => err instanceof ConfigError && err.message.includes(key),
        `an empty ${key} should be refused`,
      );

      assert.throws(
        () => loadEnv(baseEnv({ [key]: '   ' })),
        (err) => err instanceof ConfigError && err.message.includes(key),
        `a whitespace-only ${key} should be refused`,
      );
    }
  });

  test('accepts a complete minimal environment', () => {
    assert.doesNotThrow(() => loadEnv(baseEnv()));
  });

  test('trims surrounding whitespace from values', () => {
    // Copy-pasting from a browser routinely picks up a trailing space or newline.
    const env = loadEnv(baseEnv({ CLIENT_ID: `  ${CLIENT_ID}  `, PANEL_URL: '  https://panel.example.com  ' }));

    assert.equal(env.clientId, CLIENT_ID);
    assert.equal(env.panelUrl, 'https://panel.example.com');
  });
});

describe('normalizePanelUrl', () => {
  test('strips a trailing slash', () => {
    assert.equal(normalizePanelUrl('https://panel.example.com/'), 'https://panel.example.com');
    assert.equal(normalizePanelUrl('https://panel.example.com///'), 'https://panel.example.com');
  });

  test('strips an /api suffix copied from the documentation', () => {
    /**
     * Every one of these is something an operator plausibly pastes, because the panel's API docs show
     * the full path. Each must reduce to the origin, since the service layer appends
     * /api/application or /api/client itself.
     */
    for (const input of [
      'https://panel.example.com/api',
      'https://panel.example.com/api/',
      'https://panel.example.com/api/application',
      'https://panel.example.com/api/application/',
      'https://panel.example.com/api/client',
    ]) {
      assert.equal(normalizePanelUrl(input), 'https://panel.example.com', `should normalise ${input}`);
    }
  });

  test('preserves a genuine base path', () => {
    // A panel behind a reverse proxy at /panel is a real deployment.
    assert.equal(normalizePanelUrl('https://example.com/panel'), 'https://example.com/panel');
    assert.equal(normalizePanelUrl('https://example.com/panel/'), 'https://example.com/panel');
    assert.equal(normalizePanelUrl('https://example.com/panel/api'), 'https://example.com/panel');
  });

  test('preserves a non-default port', () => {
    assert.equal(normalizePanelUrl('https://panel.example.com:8443'), 'https://panel.example.com:8443');
    assert.equal(normalizePanelUrl('http://localhost:8080/'), 'http://localhost:8080');
  });

  test('requires a scheme, and says so', () => {
    /**
     * A bare hostname is the single most common mistake here, and `new URL()` fails on it with an
     * opaque parse error rather than an actionable one.
     */
    for (const input of ['panel.example.com', 'panel.example.com/api', 'www.panel.example.com']) {
      assert.throws(
        () => normalizePanelUrl(input),
        (err) => err instanceof ConfigError && /scheme/i.test(err.message),
        `should reject ${input} with a message about the scheme`,
      );
    }
  });

  test('rejects a non-HTTP scheme', () => {
    for (const input of ['ftp://panel.example.com', 'file:///etc/passwd', 'ws://panel.example.com']) {
      assert.throws(() => normalizePanelUrl(input), ConfigError, `should reject ${input}`);
    }
  });

  test('rejects credentials embedded in the URL', () => {
    /**
     * Credentials in a URL would be sent on every request and would appear in any log that recorded
     * the base URL. The API keys are the supported mechanism.
     */
    assert.throws(
      () => normalizePanelUrl('https://user:password@panel.example.com'),
      (err) => err instanceof ConfigError && /PANEL_APP_KEY/.test(err.message),
    );
    assert.throws(() => normalizePanelUrl('https://user@panel.example.com'), ConfigError);
  });

  test('rejects an empty or unparseable value', () => {
    for (const input of ['', '   ', 'https://', 'not a url', null, undefined]) {
      assert.throws(() => normalizePanelUrl(input), ConfigError, `should reject ${JSON.stringify(input)}`);
    }
  });

  test('accepts http for a local host without complaint', () => {
    // A local panel over http is normal in development.
    for (const input of ['http://localhost:8080', 'http://127.0.0.1', 'http://[::1]:8080']) {
      assert.doesNotThrow(() => normalizePanelUrl(input), `should accept ${input}`);
    }
  });

  test('accepts http for a remote host but does not throw', () => {
    /**
     * Some deployments terminate TLS at a proxy, so this is a warning rather than a failure — the
     * module emits a process warning and continues.
     */
    assert.doesNotThrow(() => normalizePanelUrl('http://panel.example.com'));
    assert.equal(normalizePanelUrl('http://panel.example.com'), 'http://panel.example.com');
  });
});

describe('the Discord token', () => {
  test('rejects a token carrying the Bot prefix', () => {
    /**
     * Pasting `Bot <token>` from an Authorization header example produces a login failure with no
     * useful message, so it is caught here by shape.
     */
    assert.throws(
      () => loadEnv(baseEnv({ DISCORD_TOKEN: `Bot ${TOKEN}` })),
      (err) => err instanceof ConfigError && /Bot/.test(err.message),
    );
  });

  test('rejects a quoted token', () => {
    // Quoting is habitual in shell files and dotenv does not always strip it.
    assert.throws(
      () => loadEnv(baseEnv({ DISCORD_TOKEN: `"${TOKEN}"` })),
      (err) => err instanceof ConfigError && /quotes/i.test(err.message),
    );
    assert.throws(() => loadEnv(baseEnv({ DISCORD_TOKEN: `'${TOKEN}'` })), ConfigError);
  });

  test('rejects what looks like the client secret', () => {
    /**
     * The most consequential mix-up in the file. A bot token is three dot-separated segments; the
     * OAuth2 client secret is a single opaque string, and using it produces an opaque TokenInvalid at
     * login with nothing pointing at the cause.
     */
    assert.throws(
      () => loadEnv(baseEnv({ DISCORD_TOKEN: 'aBcDeFgHiJkLmNoPqRsTuVwXyZ012345' })),
      (err) => err instanceof ConfigError && /Reset Token|client secret/i.test(err.message),
    );
  });

  test('never includes the token in an error message', () => {
    /**
     * The rule that holds even for a value that failed validation. A mistyped token is still a token,
     * and an error message ends up in logs and issue reports.
     */
    const secret = 'ThisIsASecretValueThatMustNotLeak';

    let caught;
    try {
      loadEnv(baseEnv({ DISCORD_TOKEN: `Bot ${secret}` }));
    } catch (err) {
      caught = err;
    }

    assert.ok(caught, 'the value should have been refused');
    assert.ok(!caught.message.includes(secret), 'the token must not appear in the error');
  });

  test('accepts a well-shaped token', () => {
    assert.equal(loadEnv(baseEnv()).discordToken, TOKEN);
  });
});

describe('the panel API keys', () => {
  test('refuses two identical keys', () => {
    /**
     * A hard error rather than a warning. Pasting the same key twice is easy, and the result is a 403
     * from whichever API the key does not belong to — with no hint that the two are the same.
     */
    const same = 'ptla_abcdefghijklmnopqrstuvwxyz0123456789';

    assert.throws(
      () => loadEnv(baseEnv({ PANEL_APP_KEY: same, PANEL_CLIENT_KEY: same })),
      (err) => err instanceof ConfigError && /identical/i.test(err.message),
    );
  });

  test('notes when the keys appear to be swapped', () => {
    /**
     * A note rather than a failure, because older panels issue unprefixed keys and a strict check
     * would refuse a working configuration. The startup sequence logs these.
     */
    const env = loadEnv(
      baseEnv({
        PANEL_APP_KEY: 'ptlc_zyxwvutsrqponmlkjihgfedcba9876543210',
        PANEL_CLIENT_KEY: 'ptla_abcdefghijklmnopqrstuvwxyz0123456789',
      }),
    );

    assert.ok(env.notes.length >= 2, 'both keys should be noted');
    assert.ok(
      env.notes.some((note) => note.includes('PANEL_APP_KEY') && /swapped/i.test(note)),
      'the swap should be named',
    );
  });

  test('notes an unprefixed key without refusing it', () => {
    const env = loadEnv(baseEnv({ PANEL_APP_KEY: 'legacy_key_without_a_prefix_000000000000' }));

    assert.ok(env.notes.some((note) => note.includes('PANEL_APP_KEY')));
    assert.equal(env.panelAppKey, 'legacy_key_without_a_prefix_000000000000');
  });

  test('produces no notes for correctly prefixed keys', () => {
    const env = loadEnv(baseEnv());

    assert.ok(!env.notes.some((note) => note.includes('PANEL_APP_KEY')));
    assert.ok(!env.notes.some((note) => note.includes('PANEL_CLIENT_KEY')));
  });

  test('never includes a key in a note', () => {
    // Notes are logged verbatim at startup.
    const secret = 'ptlc_SecretClientKeyValueThatMustNotLeak0000';
    const env = loadEnv(baseEnv({ PANEL_APP_KEY: secret }));

    for (const note of env.notes) {
      assert.ok(!note.includes(secret), `a note leaked the key: ${note}`);
    }
  });
});

describe('Discord snowflakes', () => {
  test('accepts a valid CLIENT_ID', () => {
    for (const id of ['12345678901234567', '123456789012345678', '12345678901234567890']) {
      assert.equal(loadEnv(baseEnv({ CLIENT_ID: id })).clientId, id);
    }
  });

  test('rejects a malformed CLIENT_ID and describes the expected shape', () => {
    for (const id of ['1234567890123456', '123456789012345678901', 'not-a-snowflake', '1234567890123456a']) {
      assert.throws(
        () => loadEnv(baseEnv({ CLIENT_ID: id })),
        (err) => err instanceof ConfigError && /CLIENT_ID/.test(err.message) && /17/.test(err.message),
        `should reject ${id}`,
      );
    }
  });

  test('treats GUILD_ID as optional', () => {
    /**
     * An empty GUILD_ID selects global slash command registration, which is the documented production
     * default.
     */
    assert.equal(loadEnv(baseEnv()).guildId, null);
    assert.equal(loadEnv(baseEnv({ GUILD_ID: '' })).guildId, null);
    assert.equal(loadEnv(baseEnv({ GUILD_ID: '   ' })).guildId, null);
  });

  test('accepts a valid GUILD_ID', () => {
    assert.equal(loadEnv(baseEnv({ GUILD_ID })).guildId, GUILD_ID);
  });

  test('rejects a malformed GUILD_ID rather than ignoring it', () => {
    /**
     * Silently dropping a malformed value would register commands globally while the operator believed
     * they were scoped to one guild — and global registration takes an hour to propagate, so the
     * mistake would look like the deploy having failed.
     */
    assert.throws(
      () => loadEnv(baseEnv({ GUILD_ID: 'my-server' })),
      (err) => err instanceof ConfigError && /GUILD_ID/.test(err.message),
    );
  });
});

describe('the command prefix', () => {
  test('defaults to the documented prefix', () => {
    assert.equal(loadEnv(baseEnv()).prefix, 'kx!');
  });

  test('accepts a configured prefix', () => {
    for (const prefix of ['!', '?', 'kx!', 'bot.', '>>']) {
      assert.equal(loadEnv(baseEnv({ DEFAULT_PREFIX: prefix })).prefix, prefix);
    }
  });

  test('rejects an empty or over-long prefix', () => {
    assert.throws(() => loadEnv(baseEnv({ DEFAULT_PREFIX: '' })), ConfigError);
    assert.throws(() => loadEnv(baseEnv({ DEFAULT_PREFIX: 'x'.repeat(9) })), ConfigError);
  });

  test('rejects a prefix containing whitespace', () => {
    /**
     * The message router compares a fixed-length slice of the message content. A prefix with a space
     * would match unpredictably against ordinary sentences.
     */
    for (const prefix of ['kx !', ' kx!', 'kx! ']) {
      assert.throws(
        () => loadEnv(baseEnv({ DEFAULT_PREFIX: prefix })),
        (err) => err instanceof ConfigError && /whitespace/i.test(err.message),
        `should reject ${JSON.stringify(prefix)}`,
      );
    }
  });

  test('notes a purely alphanumeric prefix', () => {
    /**
     * A note, not a failure. A prefix like `kx` makes every message beginning with those letters a
     * candidate command, which produces confusing false matches — but an operator may want it.
     */
    const env = loadEnv(baseEnv({ DEFAULT_PREFIX: 'kx' }));

    assert.ok(env.notes.some((note) => /alphanumeric/i.test(note)));
    assert.equal(env.prefix, 'kx');
  });

  test('produces no note for a prefix ending in a symbol', () => {
    assert.ok(!loadEnv(baseEnv()).notes.some((note) => /alphanumeric/i.test(note)));
  });
});

describe('admin allowlists', () => {
  test('default to empty', () => {
    const env = loadEnv(baseEnv());

    assert.deepEqual([...env.adminUserIds], []);
    assert.deepEqual([...env.adminRoleIds], []);
  });

  test('parse a comma-separated list', () => {
    const env = loadEnv(
      baseEnv({
        ADMIN_USER_IDS: '111111111111111111,222222222222222222',
        ADMIN_ROLE_IDS: '333333333333333333',
      }),
    );

    assert.deepEqual([...env.adminUserIds], ['111111111111111111', '222222222222222222']);
    assert.deepEqual([...env.adminRoleIds], ['333333333333333333']);
  });

  test('tolerate whitespace and trailing separators', () => {
    // Hand-edited lists routinely acquire both.
    const env = loadEnv(baseEnv({ ADMIN_USER_IDS: ' 111111111111111111 , 222222222222222222 , ' }));

    assert.deepEqual([...env.adminUserIds], ['111111111111111111', '222222222222222222']);
  });

  test('deduplicate', () => {
    const env = loadEnv(baseEnv({ ADMIN_USER_IDS: '111111111111111111,111111111111111111' }));

    assert.deepEqual([...env.adminUserIds], ['111111111111111111']);
  });

  test('reject a malformed entry, naming both the variable and the value', () => {
    /**
     * A typo must fail at startup. Silently dropping the bad entry would grant admin access to nobody,
     * which presents later as a mysterious permission failure with no log line explaining it.
     */
    assert.throws(
      () => loadEnv(baseEnv({ ADMIN_USER_IDS: '111111111111111111,nope' })),
      (err) => err instanceof ConfigError && err.message.includes('ADMIN_USER_IDS') && err.message.includes('nope'),
    );

    assert.throws(
      () => loadEnv(baseEnv({ ADMIN_ROLE_IDS: 'everyone' })),
      (err) => err instanceof ConfigError && err.message.includes('ADMIN_ROLE_IDS'),
    );
  });

  test('are frozen', () => {
    // The permission check reads these on every admin command.
    const env = loadEnv(baseEnv({ ADMIN_USER_IDS: '111111111111111111' }));

    assert.equal(Object.isFrozen(env.adminUserIds), true);
    assert.equal(Object.isFrozen(env.adminRoleIds), true);
  });
});

describe('policy values', () => {
  test('apply documented defaults', () => {
    const env = loadEnv(baseEnv());

    assert.equal(env.accountAgeDays, 90);
    assert.equal(env.freeServerLimit, 1);
    assert.equal(env.startingCredits, 0);
  });

  test('accept configured values', () => {
    const env = loadEnv(
      baseEnv({ ACCOUNT_AGE_DAYS: '30', FREE_SERVER_LIMIT: '3', STARTING_CREDITS: '100' }),
    );

    assert.equal(env.accountAgeDays, 30);
    assert.equal(env.freeServerLimit, 3);
    assert.equal(env.startingCredits, 100);
  });

  test('reject a non-integer', () => {
    for (const key of ['ACCOUNT_AGE_DAYS', 'FREE_SERVER_LIMIT', 'STARTING_CREDITS']) {
      assert.throws(
        () => loadEnv(baseEnv({ [key]: 'ninety' })),
        (err) => err instanceof ConfigError && err.message.includes(key),
        `${key} should reject a non-numeric value`,
      );

      assert.throws(() => loadEnv(baseEnv({ [key]: '1.5' })), ConfigError, `${key} should reject a fraction`);
    }
  });

  test('reject a value outside its documented bounds', () => {
    /**
     * Bounds keep a typo from producing pathological behaviour. An extra zero on FREE_SERVER_LIMIT
     * would otherwise let one user provision a hundred servers.
     */
    assert.throws(
      () => loadEnv(baseEnv({ ACCOUNT_AGE_DAYS: String(BOUNDS.accountAgeDays.max + 1) })),
      ConfigError,
    );
    assert.throws(() => loadEnv(baseEnv({ ACCOUNT_AGE_DAYS: '-1' })), ConfigError);
    assert.throws(
      () => loadEnv(baseEnv({ FREE_SERVER_LIMIT: String(BOUNDS.freeServerLimit.max + 1) })),
      ConfigError,
    );
  });

  test('note that a zero account age disables the check', () => {
    /**
     * Not a failure — an operator may deliberately disable it — but it removes the project's main
     * throwaway-account defence, so it is surfaced rather than applied silently.
     */
    const env = loadEnv(baseEnv({ ACCOUNT_AGE_DAYS: '0' }));

    assert.equal(env.accountAgeDays, 0);
    assert.ok(env.notes.some((note) => /ACCOUNT_AGE_DAYS/.test(note) && /disabled/i.test(note)));
  });

  test('note that a zero server limit refuses everyone', () => {
    /**
     * The likely intent is to pause provisioning, but the symptom is `server create` refusing every
     * user with no obvious cause, so the note connects the two.
     */
    const env = loadEnv(baseEnv({ FREE_SERVER_LIMIT: '0' }));

    assert.equal(env.freeServerLimit, 0);
    assert.ok(env.notes.some((note) => /FREE_SERVER_LIMIT/.test(note)));
  });
});

describe('networking values', () => {
  test('apply documented defaults', () => {
    const env = loadEnv(baseEnv());

    assert.equal(env.panelTimeoutMs, 15_000);
    assert.equal(env.panelMaxRetries, 3);
    assert.equal(env.verifyPanelOnStartup, true);
  });

  test('accept configured values', () => {
    const env = loadEnv(baseEnv({ PANEL_TIMEOUT_MS: '30000', PANEL_MAX_RETRIES: '5' }));

    assert.equal(env.panelTimeoutMs, 30_000);
    assert.equal(env.panelMaxRetries, 5);
  });

  test('reject a timeout below the floor', () => {
    /**
     * A sub-second timeout would fail every panel request on a healthy panel, which presents as the
     * panel being unreachable.
     */
    assert.throws(() => loadEnv(baseEnv({ PANEL_TIMEOUT_MS: '100' })), ConfigError);
    assert.throws(() => loadEnv(baseEnv({ PANEL_TIMEOUT_MS: '0' })), ConfigError);
  });

  test('reject a timeout above the ceiling', () => {
    // Beyond this a request outlives any interaction it could answer.
    assert.throws(
      () => loadEnv(baseEnv({ PANEL_TIMEOUT_MS: String(BOUNDS.panelTimeoutMs.max + 1) })),
      ConfigError,
    );
  });

  test('clamp the retry count to at least one attempt', () => {
    /**
     * PANEL_MAX_RETRIES counts total attempts including the first, so one means no retries — and zero
     * would mean no attempts at all.
     */
    assert.throws(() => loadEnv(baseEnv({ PANEL_MAX_RETRIES: '0' })), ConfigError);
    assert.equal(loadEnv(baseEnv({ PANEL_MAX_RETRIES: '1' })).panelMaxRetries, 1);
  });

  test('reject an excessive retry count', () => {
    assert.throws(
      () => loadEnv(baseEnv({ PANEL_MAX_RETRIES: String(BOUNDS.panelMaxRetries.max + 1) })),
      ConfigError,
    );
  });
});

describe('boolean parsing', () => {
  test('accepts the spellings that appear in real .env files', () => {
    for (const value of ['true', 'TRUE', 'True', '1', 'yes', 'on', 'enabled']) {
      assert.equal(
        loadEnv(baseEnv({ VERIFY_PANEL_ON_STARTUP: value })).verifyPanelOnStartup,
        true,
        `${value} should parse as true`,
      );
    }

    for (const value of ['false', 'FALSE', '0', 'no', 'off', 'disabled']) {
      assert.equal(
        loadEnv(baseEnv({ VERIFY_PANEL_ON_STARTUP: value })).verifyPanelOnStartup,
        false,
        `${value} should parse as false`,
      );
    }
  });

  test('applies the default when unset', () => {
    assert.equal(loadEnv(baseEnv()).verifyPanelOnStartup, true);
    assert.equal(loadEnv(baseEnv({ VERIFY_PANEL_ON_STARTUP: '' })).verifyPanelOnStartup, true);
  });

  test('rejects an unrecognised value rather than guessing', () => {
    /**
     * Guessing would silently disable a startup check the operator believed was enabled.
     */
    assert.throws(
      () => loadEnv(baseEnv({ VERIFY_PANEL_ON_STARTUP: 'maybe' })),
      (err) => err instanceof ConfigError && err.message.includes('VERIFY_PANEL_ON_STARTUP'),
    );
  });
});

describe('storage paths', () => {
  test('apply documented defaults', () => {
    const env = loadEnv(baseEnv());

    assert.equal(env.databasePath, './data/panelkit.sqlite');
    assert.equal(env.heartbeatPath, './data/heartbeat');
  });

  test('accept configured paths', () => {
    const env = loadEnv(
      baseEnv({ DATABASE_PATH: '/var/lib/panelkit/db.sqlite', HEARTBEAT_PATH: '/run/panelkit/heartbeat' }),
    );

    assert.equal(env.databasePath, '/var/lib/panelkit/db.sqlite');
    assert.equal(env.heartbeatPath, '/run/panelkit/heartbeat');
  });

  test('reject an empty path', () => {
    // An empty DATABASE_PATH would resolve to the working directory and fail on open.
    assert.throws(() => loadEnv(baseEnv({ DATABASE_PATH: '   ' })), ConfigError);
    assert.throws(() => loadEnv(baseEnv({ HEARTBEAT_PATH: '   ' })), ConfigError);
  });
});

describe('observability', () => {
  test('defaults the log level to info', () => {
    assert.equal(loadEnv(baseEnv()).logLevel, 'info');
  });

  test('accepts every documented level, case-insensitively', () => {
    for (const level of VALID_LOG_LEVELS) {
      assert.equal(loadEnv(baseEnv({ LOG_LEVEL: level })).logLevel, level);
      assert.equal(loadEnv(baseEnv({ LOG_LEVEL: level.toUpperCase() })).logLevel, level);
    }
  });

  test('rejects an unrecognised level', () => {
    /**
     * Falling back silently would leave an operator who set LOG_LEVEL=verbose wondering why debug
     * output never appeared.
     */
    for (const level of ['verbose', 'trace', 'silent', 'critical']) {
      assert.throws(
        () => loadEnv(baseEnv({ LOG_LEVEL: level })),
        (err) => err instanceof ConfigError && err.message.includes('LOG_LEVEL'),
        `should reject ${level}`,
      );
    }
  });

  test('defaults NODE_ENV to production', () => {
    /**
     * Production is the safe default: a deployment that forgot to set it should not silently run in a
     * development mode.
     */
    const env = loadEnv(baseEnv());

    assert.equal(env.nodeEnv, 'production');
    assert.equal(env.isProduction, true);
  });

  test('recognises development and test', () => {
    assert.equal(loadEnv(baseEnv({ NODE_ENV: 'development' })).isProduction, false);
    assert.equal(loadEnv(baseEnv({ NODE_ENV: 'test' })).isProduction, false);
  });

  test('notes an unrecognised NODE_ENV without refusing it', () => {
    // Some platforms set values like "staging"; refusing would break those deployments.
    const env = loadEnv(baseEnv({ NODE_ENV: 'staging' }));

    assert.equal(env.nodeEnv, 'staging');
    assert.ok(env.notes.some((note) => /NODE_ENV/.test(note)));
  });
});

describe('the returned object', () => {
  test('is frozen', () => {
    /**
     * Every command reads this. Freezing means a handler cannot mutate it and change behaviour for
     * every subsequent request.
     */
    const env = loadEnv(baseEnv());

    assert.equal(Object.isFrozen(env), true);
    assert.equal(Object.isFrozen(env.notes), true);
  });

  test('exposes every field the application consumes', () => {
    /**
     * A missing field would surface as `undefined` deep inside a service — this pins the contract that
     * src/index.js and the services depend on.
     */
    const env = loadEnv(baseEnv({ GUILD_ID }));

    for (const key of [
      'discordToken',
      'clientId',
      'guildId',
      'prefix',
      'panelUrl',
      'panelAppKey',
      'panelClientKey',
      'adminUserIds',
      'adminRoleIds',
      'accountAgeDays',
      'freeServerLimit',
      'startingCredits',
      'databasePath',
      'heartbeatPath',
      'panelTimeoutMs',
      'panelMaxRetries',
      'verifyPanelOnStartup',
      'logLevel',
      'nodeEnv',
      'isProduction',
      'notes',
    ]) {
      assert.ok(key in env, `${key} should be present`);
      assert.notEqual(env[key], undefined, `${key} should not be undefined`);
    }
  });

  test('reports several problems together', () => {
    /**
     * Validation collects problems rather than throwing on the first, so one restart surfaces every
     * mistake in the file.
     */
    let caught;

    try {
      loadEnv(baseEnv({ DEFAULT_PREFIX: 'way too long prefix', LOG_LEVEL: 'verbose', ACCOUNT_AGE_DAYS: 'ninety' }));
    } catch (err) {
      caught = err;
    }

    assert.ok(caught instanceof ConfigError);
    assert.ok(caught.message.includes('DEFAULT_PREFIX'));
    assert.ok(caught.message.includes('LOG_LEVEL'));
    assert.ok(caught.message.includes('ACCOUNT_AGE_DAYS'));
  });
});

describe('describeEnv', () => {
  test('reduces every secret to a boolean', () => {
    /**
     * The security property of this function. src/index.js logs its output at startup, so it must
     * confirm configuration loaded without any value reaching the log — not a prefix, not a length
     * that narrows a search, nothing recoverable.
     */
    const env = loadEnv(baseEnv({ GUILD_ID }));
    const described = describeEnv(env);
    const serialised = JSON.stringify(described);

    assert.ok(!serialised.includes(TOKEN), 'the Discord token must not appear');
    assert.ok(!serialised.includes(env.panelAppKey), 'the application key must not appear');
    assert.ok(!serialised.includes(env.panelClientKey), 'the client key must not appear');

    assert.equal(described.tokenPresent, true);
    assert.equal(described.appKeyPresent, true);
    assert.equal(described.clientKeyPresent, true);
  });

  test('does not leak even a fragment of a secret', () => {
    /**
     * A prefix or suffix would narrow a brute-force search, so the projection carries no substring of
     * any credential at all.
     */
    const env = loadEnv(baseEnv());
    const serialised = JSON.stringify(describeEnv(env));

    for (const secret of [env.discordToken, env.panelAppKey, env.panelClientKey]) {
      for (const length of [8, 12, 16]) {
        assert.ok(
          !serialised.includes(secret.slice(0, length)),
          `a ${length}-character prefix of a secret appeared in the projection`,
        );
        assert.ok(
          !serialised.includes(secret.slice(-length)),
          `a ${length}-character suffix of a secret appeared in the projection`,
        );
      }
    }
  });

  test('reports the non-secret configuration an operator needs', () => {
    /**
     * The startup line has to be useful, or nobody reads it. These are the values that explain the
     * bot's behaviour without revealing anything.
     */
    const env = loadEnv(
      baseEnv({ GUILD_ID, ADMIN_USER_IDS: '111111111111111111', DEFAULT_PREFIX: 'kx!', LOG_LEVEL: 'debug' }),
    );
    const described = describeEnv(env);

    assert.equal(described.prefix, 'kx!');
    assert.equal(described.panelUrl, 'https://panel.example.com');
    assert.equal(described.clientId, CLIENT_ID);
    assert.equal(described.guildScoped, true, 'a set GUILD_ID means guild-scoped registration');
    assert.equal(described.adminUsers, 1);
    assert.equal(described.adminRoles, 0);
    assert.equal(described.accountAgeDays, 90);
    assert.equal(described.freeServerLimit, 1);
    assert.equal(described.logLevel, 'debug');
    assert.equal(described.nodeEnv, 'production');
  });

  test('reports the guild id as a boolean rather than a value', () => {
    /**
     * Not a secret, but the useful fact at startup is whether registration is guild-scoped — a guild
     * id in a shared log adds nothing and identifies the deployment.
     */
    assert.equal(describeEnv(loadEnv(baseEnv())).guildScoped, false);
    assert.equal(describeEnv(loadEnv(baseEnv({ GUILD_ID }))).guildScoped, true);
    assert.ok(!('guildId' in describeEnv(loadEnv(baseEnv({ GUILD_ID })))));
  });

  test('reports admin allowlists as counts rather than ids', () => {
    // The count answers "is this configured"; the ids would identify individuals in a log.
    const described = describeEnv(
      loadEnv(baseEnv({ ADMIN_USER_IDS: '111111111111111111,222222222222222222', ADMIN_ROLE_IDS: '333333333333333333' })),
    );

    assert.equal(described.adminUsers, 2);
    assert.equal(described.adminRoles, 1);
    assert.ok(!JSON.stringify(described).includes('111111111111111111'));
  });
});

describe('loadDotEnv', () => {
  test('reports no file when none exists', () => {
    /**
     * The normal case in Docker, systemd and most managed platforms, where variables arrive from the
     * environment and no file is present. Loading is best-effort by design.
     *
     * A temporary directory is used rather than the project root: loading a developer's real .env into
     * the test process would leak configuration into every other test file.
     */
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'panelkit-env-'));

    try {
      const result = loadDotEnv(empty);

      assert.equal(result.loaded, false);
      assert.equal(result.file, null);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test('does not throw when the directory itself is absent', () => {
    assert.doesNotThrow(() => loadDotEnv(path.join(os.tmpdir(), 'panelkit-does-not-exist-0000')));
  });
});
