// Coded by Aditya | GitHub- @adityatheog

/**
 * Environment loading and validation.
 *
 * This module runs first, before the database opens or the Discord client is
 * constructed. Its job is to turn `process.env` — an untyped bag of strings that
 * may be missing, malformed or half-filled — into one frozen, fully typed object,
 * and to fail loudly if it cannot.
 *
 * Three principles:
 *
 * 1. Fail once, with everything. A user who has just copied `.env.example` is
 *    usually missing several values. Reporting them one restart at a time is
 *    hostile, so every missing required variable and every invalid value is
 *    collected and reported in a single error.
 *
 * 2. Never echo a secret. Validation messages name the offending variable and
 *    describe the expected shape; they never include the value. That rule holds
 *    even for values that failed validation, because a mistyped token is still a
 *    token.
 *
 * 3. Normalise at the boundary. `PANEL_URL` is canonicalised here so no other
 *    module has to wonder whether it ends in a slash or carries an `/api` suffix.
 *
 * Loading `.env` is best-effort by design: in Docker, systemd and most PaaS
 * deployments the variables arrive from the environment and no file exists.
 */

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { ConfigError } from '../utils/errors.js';
import { parseSnowflakeList } from '../utils/validation.js';

/** Variables without which the bot cannot function at all. */
const REQUIRED_KEYS = Object.freeze(['DISCORD_TOKEN', 'CLIENT_ID', 'PANEL_URL', 'PANEL_APP_KEY', 'PANEL_CLIENT_KEY']);

const VALID_LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);
const VALID_NODE_ENVS = Object.freeze(['production', 'development', 'test']);

const SNOWFLAKE_RE = /^\d{17,20}$/;

/** Bounds that keep a typo from producing pathological behaviour. */
const BOUNDS = Object.freeze({
  prefixLength: { min: 1, max: 8 },
  accountAgeDays: { min: 0, max: 3650 },
  freeServerLimit: { min: 0, max: 100 },
  startingCredits: { min: 0, max: 1_000_000 },
  panelTimeoutMs: { min: 1000, max: 120_000 },
  panelMaxRetries: { min: 1, max: 10 },
});

/**
 * Reads the .env file into process.env when one exists.
 *
 * Existing environment variables always win, matching dotenv's default and the
 * expectation that an explicit `docker run -e` or a systemd `Environment=` line
 * overrides a file left on disk.
 *
 * @param {string} [cwd]
 * @returns {{ loaded: boolean, file: string|null }}
 */
export function loadDotEnv(cwd = process.cwd()) {
  const file = path.resolve(cwd, '.env');

  if (!fs.existsSync(file)) return { loaded: false, file: null };

  const result = dotenv.config({ path: file, override: false });
  if (result.error) {
    throw new ConfigError(`Found .env at ${file} but could not read it. Check file permissions.`, {
      cause: result.error.message,
    });
  }

  return { loaded: true, file };
}

/**
 * Canonicalises the panel URL.
 *
 * Accepts everything an operator plausibly pastes — a trailing slash, an `/api`
 * suffix copied from API docs, a full `/api/application` path — and reduces it to
 * scheme, host and any genuine base path. Every panel request is then built by
 * appending `/api/application` or `/api/client` exactly once.
 *
 * @param {unknown} raw
 * @returns {string} the normalised origin, without a trailing slash
 * @throws {ConfigError}
 */
export function normalizePanelUrl(raw) {
  const input = String(raw ?? '').trim();
  if (input === '') throw new ConfigError('PANEL_URL is empty. Set it to your panel root, e.g. https://panel.example.com');

  // A bare hostname is a common mistake and produces a confusing URL parse error.
  if (!/^https?:\/\//i.test(input)) {
    throw new ConfigError(
      'PANEL_URL must include the scheme. Use https://panel.example.com rather than panel.example.com',
    );
  }

  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new ConfigError('PANEL_URL is not a valid URL. Use the panel root, e.g. https://panel.example.com');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ConfigError('PANEL_URL must use http or https.');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError('PANEL_URL must not contain credentials. Use PANEL_APP_KEY and PANEL_CLIENT_KEY instead.');
  }
  if (parsed.hostname === '') {
    throw new ConfigError('PANEL_URL is missing a hostname.');
  }

  // Strip an /api, /api/application or /api/client suffix, then any trailing slash.
  const basePath = parsed.pathname.replace(/\/+$/, '').replace(/\/api(\/(application|client))?$/i, '');

  const normalised = `${parsed.protocol}//${parsed.host}${basePath}`;

  if (parsed.protocol === 'http:' && !/^(localhost|127\.|\[::1\])/i.test(parsed.hostname)) {
    // Not fatal — some deployments terminate TLS at a proxy — but the operator
    // should know API keys are crossing the network in cleartext.
    process.emitWarning(
      'PANEL_URL uses http:// for a non-local host. API keys will be sent unencrypted. Use https:// in production.',
      'SecurityWarning',
    );
  }

  return normalised;
}

/**
 * Collects a required, non-empty string.
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {string[]} problems
 * @returns {string}
 */
function requireString(source, key, problems) {
  const value = source[key];
  if (value === undefined || value === null || String(value).trim() === '') {
    problems.push(`${key} is required but missing or empty.`);
    return '';
  }
  return String(value).trim();
}

/**
 * Parses an integer within bounds, falling back to a default when unset.
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {number} fallback
 * @param {{ min: number, max: number }} bounds
 * @param {string[]} problems
 * @returns {number}
 */
function parseBoundedInt(source, key, fallback, bounds, problems) {
  const raw = source[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;

  const value = Number(String(raw).trim());
  if (!Number.isInteger(value)) {
    problems.push(`${key} must be a whole number.`);
    return fallback;
  }
  if (value < bounds.min || value > bounds.max) {
    problems.push(`${key} must be between ${bounds.min} and ${bounds.max}.`);
    return fallback;
  }
  return value;
}

/**
 * Parses a boolean, accepting the spellings that appear in real .env files.
 *
 * @param {Record<string, unknown>} source
 * @param {string} key
 * @param {boolean} fallback
 * @param {string[]} problems
 * @returns {boolean}
 */
function parseBoolean(source, key, fallback, problems) {
  const raw = source[key];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;

  const value = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) return true;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) return false;

  problems.push(`${key} must be true or false.`);
  return fallback;
}

/**
 * Validates a Discord snowflake.
 *
 * @param {string} value
 * @param {string} key
 * @param {string[]} problems
 * @param {boolean} required
 * @returns {string|null}
 */
function parseSnowflake(value, key, problems, required) {
  if (value === '') {
    if (required) problems.push(`${key} is required but missing.`);
    return null;
  }
  if (!SNOWFLAKE_RE.test(value)) {
    problems.push(`${key} must be a Discord snowflake: 17 to 20 digits, no other characters.`);
    return null;
  }
  return value;
}

/**
 * Sanity-checks the shape of the Discord bot token.
 *
 * The token is never logged and its exact format is not contractual, so this only
 * catches the two mistakes that actually happen: pasting the client secret, and
 * pasting the token wrapped in `Bot ` or quotes.
 *
 * @param {string} token
 * @param {string[]} problems
 */
function validateTokenShape(token, problems) {
  if (token === '') return;

  if (/^Bot\s+/i.test(token)) {
    problems.push('DISCORD_TOKEN must not include the "Bot " prefix. Paste only the token itself.');
    return;
  }
  if (/^["'].*["']$/.test(token)) {
    problems.push('DISCORD_TOKEN must not be wrapped in quotes.');
    return;
  }
  // A bot token is three dot-separated base64url segments. The client secret is a
  // single 32-character string, which is the usual mix-up.
  if (!token.includes('.')) {
    problems.push(
      'DISCORD_TOKEN does not look like a bot token. Copy it from Developer Portal -> Bot -> Reset Token, not the OAuth2 client secret.',
    );
  }
}

/**
 * Sanity-checks a Pterodactyl API key.
 *
 * Panel keys are conventionally prefixed `ptla_` (application) or `ptlc_`
 * (client). Older panels issue unprefixed keys, so a mismatch is a warning
 * routed through `notes` rather than a hard failure — but swapping the two keys is
 * a frequent mistake worth surfacing.
 *
 * @param {string} value
 * @param {'application'|'client'} kind
 * @param {string} key
 * @param {string[]} notes
 */
function inspectPanelKey(value, kind, key, notes) {
  if (value === '') return;

  const expected = kind === 'application' ? 'ptla_' : 'ptlc_';
  const opposite = kind === 'application' ? 'ptlc_' : 'ptla_';

  if (value.startsWith(opposite)) {
    notes.push(
      `${key} looks like a ${kind === 'application' ? 'client' : 'application'} key (it starts with ${opposite}). PANEL_APP_KEY and PANEL_CLIENT_KEY may be swapped.`,
    );
    return;
  }
  if (!value.startsWith(expected)) {
    notes.push(`${key} does not start with ${expected}. This is fine on older panels, but verify it is the correct key type.`);
  }
}

/**
 * Reads, validates and freezes the environment configuration.
 *
 * @param {Record<string, unknown>} [source=process.env]
 * @returns {Readonly<{
 *   discordToken: string, clientId: string, guildId: string|null, prefix: string,
 *   panelUrl: string, panelAppKey: string, panelClientKey: string,
 *   adminUserIds: readonly string[], adminRoleIds: readonly string[],
 *   accountAgeDays: number, freeServerLimit: number, startingCredits: number,
 *   databasePath: string, heartbeatPath: string,
 *   panelTimeoutMs: number, panelMaxRetries: number, verifyPanelOnStartup: boolean,
 *   logLevel: string, nodeEnv: string, isProduction: boolean, notes: readonly string[]
 * }>}
 * @throws {ConfigError} listing every problem found
 */
export function loadEnv(source = process.env) {
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  const notes = [];

  const discordToken = requireString(source, 'DISCORD_TOKEN', problems);
  const clientIdRaw = requireString(source, 'CLIENT_ID', problems);
  const panelUrlRaw = requireString(source, 'PANEL_URL', problems);
  const panelAppKey = requireString(source, 'PANEL_APP_KEY', problems);
  const panelClientKey = requireString(source, 'PANEL_CLIENT_KEY', problems);

  // Report every missing required variable together before deeper validation,
  // which would otherwise produce noise about values that simply are not set.
  const missing = REQUIRED_KEYS.filter(
    (key) => source[key] === undefined || source[key] === null || String(source[key]).trim() === '',
  );
  if (missing.length > 0) {
    throw new ConfigError(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        'Copy .env.example to .env and fill in every value marked REQUIRED.',
    );
  }

  validateTokenShape(discordToken, problems);
  inspectPanelKey(panelAppKey, 'application', 'PANEL_APP_KEY', notes);
  inspectPanelKey(panelClientKey, 'client', 'PANEL_CLIENT_KEY', notes);

  if (panelAppKey === panelClientKey) {
    problems.push('PANEL_APP_KEY and PANEL_CLIENT_KEY are identical. They are different key types created in different places.');
  }

  const clientId = parseSnowflake(clientIdRaw, 'CLIENT_ID', problems, true);
  const guildId = parseSnowflake(String(source.GUILD_ID ?? '').trim(), 'GUILD_ID', problems, false);

  let panelUrl = '';
  try {
    panelUrl = normalizePanelUrl(panelUrlRaw);
  } catch (err) {
    problems.push(err instanceof ConfigError ? err.message : 'PANEL_URL is invalid.');
  }

  const prefix = String(source.DEFAULT_PREFIX ?? 'kx!').trim();
  if (prefix.length < BOUNDS.prefixLength.min || prefix.length > BOUNDS.prefixLength.max) {
    problems.push(`DEFAULT_PREFIX must be ${BOUNDS.prefixLength.min} to ${BOUNDS.prefixLength.max} characters.`);
  }
  if (/\s/.test(prefix)) {
    problems.push('DEFAULT_PREFIX must not contain whitespace.');
  }
  if (/^[a-z0-9]+$/i.test(prefix)) {
    // A purely alphanumeric prefix makes every message starting with those letters
    // a candidate command, which produces confusing false matches.
    notes.push(`DEFAULT_PREFIX "${prefix}" is alphanumeric. A trailing symbol such as "!" avoids accidental matches.`);
  }

  /** @type {readonly string[]} */
  let adminUserIds = Object.freeze([]);
  /** @type {readonly string[]} */
  let adminRoleIds = Object.freeze([]);
  try {
    adminUserIds = parseSnowflakeList(source.ADMIN_USER_IDS, 'ADMIN_USER_IDS');
  } catch (err) {
    problems.push(err?.message ?? 'ADMIN_USER_IDS is invalid.');
  }
  try {
    adminRoleIds = parseSnowflakeList(source.ADMIN_ROLE_IDS, 'ADMIN_ROLE_IDS');
  } catch (err) {
    problems.push(err?.message ?? 'ADMIN_ROLE_IDS is invalid.');
  }

  const accountAgeDays = parseBoundedInt(source, 'ACCOUNT_AGE_DAYS', 90, BOUNDS.accountAgeDays, problems);
  const freeServerLimit = parseBoundedInt(source, 'FREE_SERVER_LIMIT', 1, BOUNDS.freeServerLimit, problems);
  const startingCredits = parseBoundedInt(source, 'STARTING_CREDITS', 0, BOUNDS.startingCredits, problems);
  const panelTimeoutMs = parseBoundedInt(source, 'PANEL_TIMEOUT_MS', 15_000, BOUNDS.panelTimeoutMs, problems);
  const panelMaxRetries = parseBoundedInt(source, 'PANEL_MAX_RETRIES', 3, BOUNDS.panelMaxRetries, problems);
  const verifyPanelOnStartup = parseBoolean(source, 'VERIFY_PANEL_ON_STARTUP', true, problems);

  const databasePath = String(source.DATABASE_PATH ?? './data/panelkit.sqlite').trim();
  if (databasePath === '') problems.push('DATABASE_PATH must not be empty.');

  const heartbeatPath = String(source.HEARTBEAT_PATH ?? './data/heartbeat').trim();
  if (heartbeatPath === '') problems.push('HEARTBEAT_PATH must not be empty.');

  const logLevel = String(source.LOG_LEVEL ?? 'info').trim().toLowerCase();
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    problems.push(`LOG_LEVEL must be one of: ${VALID_LOG_LEVELS.join(', ')}.`);
  }

  const nodeEnv = String(source.NODE_ENV ?? 'production').trim().toLowerCase();
  if (!VALID_NODE_ENVS.includes(nodeEnv)) {
    notes.push(`NODE_ENV "${nodeEnv}" is unrecognised; treating it as production.`);
  }

  if (accountAgeDays === 0) {
    notes.push('ACCOUNT_AGE_DAYS is 0, so the Discord account age check is disabled. Brand-new accounts can provision servers.');
  }
  if (freeServerLimit === 0) {
    notes.push('FREE_SERVER_LIMIT is 0, so no user can create a server through self-service commands.');
  }

  if (problems.length > 0) {
    throw new ConfigError(
      `Environment configuration is invalid:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`,
    );
  }

  return Object.freeze({
    discordToken,
    clientId: /** @type {string} */ (clientId),
    guildId,
    prefix,

    panelUrl,
    panelAppKey,
    panelClientKey,

    adminUserIds,
    adminRoleIds,

    accountAgeDays,
    freeServerLimit,
    startingCredits,

    databasePath,
    heartbeatPath,

    panelTimeoutMs,
    panelMaxRetries,
    verifyPanelOnStartup,

    logLevel,
    nodeEnv,
    isProduction: nodeEnv === 'production',

    notes: Object.freeze(notes),
  });
}

/**
 * Redacted projection of the environment, safe to write to the startup log.
 *
 * Secrets are reduced to a boolean and a length: enough to confirm a value was
 * loaded and roughly the right size, with nothing recoverable.
 *
 * @param {ReturnType<typeof loadEnv>} env
 * @returns {Record<string, unknown>}
 */
export function describeEnv(env) {
  return {
    prefix: env.prefix,
    panelUrl: env.panelUrl,
    clientId: env.clientId,
    guildScoped: Boolean(env.guildId),
    adminUsers: env.adminUserIds.length,
    adminRoles: env.adminRoleIds.length,
    accountAgeDays: env.accountAgeDays,
    freeServerLimit: env.freeServerLimit,
    startingCredits: env.startingCredits,
    databasePath: env.databasePath,
    panelTimeoutMs: env.panelTimeoutMs,
    panelMaxRetries: env.panelMaxRetries,
    verifyPanelOnStartup: env.verifyPanelOnStartup,
    logLevel: env.logLevel,
    nodeEnv: env.nodeEnv,
    tokenPresent: env.discordToken !== '',
    appKeyPresent: env.panelAppKey !== '',
    clientKeyPresent: env.panelClientKey !== '',
  };
}

export { BOUNDS, REQUIRED_KEYS, VALID_LOG_LEVELS };
