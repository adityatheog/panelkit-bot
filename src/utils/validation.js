// Coded by Aditya | GitHub- @adityatheog

/**
 * Input validation for every value that crosses a trust boundary.
 *
 * Two principles govern this module:
 *
 * 1. Allowlist, never blocklist. Every validator states the exact shape it
 *    accepts and rejects everything else, so a novel injection payload fails by
 *    default rather than needing a new rule.
 *
 * 2. Slash-command data is untrusted. Discord enforces option types and lengths
 *    client-side and in its own API, but the bot still re-validates: a bug in a
 *    command definition, a stale registered command, or a crafted request must
 *    not reach the panel or the database unchecked.
 *
 * Validators throw ValidationError (a user-safe AppError) and return the
 * normalised value, so callers can use the return value directly:
 *
 *   const id = assertValidIdentifier(ctx.args.server);
 */

import { ValidationError } from './errors.js';

/**
 * Pterodactyl short identifiers are exactly 8 lowercase alphanumeric characters.
 * Anchored, so path traversal (`../../etc`) and query injection cannot pass.
 */
const IDENTIFIER_RE = /^[a-z0-9]{8}$/;

/**
 * Server names are rendered in Discord embeds and sent to the panel.
 *
 * The first and last characters must be alphanumeric, which rejects leading or
 * trailing punctuation used for impersonation, and the inner set excludes every
 * markdown control character (`*_~|`\``), every mention character (`<@&#>`),
 * and all control codepoints.
 */
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,30}[A-Za-z0-9]$/;

/** Egg keys are operator-defined config.json object keys. */
const EGG_KEY_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * Conservative email shape. This is deliberately stricter than RFC 5322: the
 * address must be a deliverable panel login, not every technically legal form.
 */
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;

/** Discord snowflakes are 17-20 digit integers. */
const SNOWFLAKE_RE = /^\d{17,20}$/;

/** Mention forms Discord may send for a user option on the prefix surface. */
const USER_MENTION_RE = /^<@!?(\d{17,20})>$/;

/** Pterodactyl sub-user references are UUID v4 strings. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Panel permission strings, e.g. control.console, file.read-content. */
const PERMISSION_RE = /^[a-z]+\.[a-z-]+$/;

/** Absolute POSIX paths used for log files and archives. */
const ABSOLUTE_PATH_RE = /^\/[^\0]*$/;

/** The only power signals the Pterodactyl client API accepts. */
const POWER_SIGNALS = Object.freeze(['start', 'stop', 'restart', 'kill']);

/**
 * Codepoints that must never survive into an embed or a panel payload.
 *
 * Beyond the C0 and C1 control ranges, this covers four invisible groups that are used for
 * display spoofing rather than for text:
 *
 *   U+200B–200F  zero-width space, joiners, and the LRM/RLM marks
 *   U+202A–202E  bidi embeddings and overrides — RLO reverses rendered text
 *   U+2060–2064  word joiner and the invisible mathematical operators
 *   U+2066–2069  bidi isolates
 *
 * Defined as a source string because two regexes are needed from it. A global regex is
 * stateful across .test() calls through lastIndex, so the presence check and the stripping
 * replace cannot share one instance.
 */
const CONTROL_CHARS_SOURCE =
  '[\\u0000-\\u001F\\u007F-\\u009F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u2028\\u2029\\uFEFF]';

/** Non-global, for presence tests. Sharing a global instance here would be stateful. */
const CONTROL_CHARS_RE = new RegExp(CONTROL_CHARS_SOURCE);

/** Global, for stripping. Without the g flag, .replace removes only the first match. */
const CONTROL_CHARS_GLOBAL_RE = new RegExp(CONTROL_CHARS_SOURCE, 'g');

const SERVER_NAME_MIN = 3;
const SERVER_NAME_MAX = 32;
const EMAIL_MAX = 191;

/**
 * Coerces an unknown value to a trimmed string without invoking user-supplied
 * `toString`. Objects become the empty string, so `{}` cannot smuggle a value
 * past a length check.
 *
 * @param {unknown} raw
 * @returns {string}
 */
function toSafeString(raw) {
  if (raw === null || raw === undefined) return '';
  const type = typeof raw;
  if (type === 'string') return raw.trim();
  if (type === 'number' || type === 'boolean' || type === 'bigint') return String(raw).trim();
  return '';
}

/**
 * Validates a Pterodactyl server identifier.
 *
 * @param {unknown} raw
 * @returns {string} the lowercased 8-character identifier
 * @throws {ValidationError}
 */
export function assertValidIdentifier(raw) {
  const value = toSafeString(raw).toLowerCase();
  if (!IDENTIFIER_RE.test(value)) {
    throw new ValidationError(
      'That is not a valid server identifier. Use the 8-character ID shown in the panel URL, for example `a1b2c3d4`.',
    );
  }
  return value;
}

/**
 * Non-throwing form of assertValidIdentifier, for filtering lists.
 *
 * @param {unknown} raw
 * @returns {boolean}
 */
export function isValidIdentifier(raw) {
  return IDENTIFIER_RE.test(toSafeString(raw).toLowerCase());
}

/**
 * Validates and normalises a server name.
 *
 * Internal whitespace runs collapse to single spaces before validation, so
 * `"My    Server"` is accepted and stored as `"My Server"` rather than rejected.
 *
 * @param {unknown} raw
 * @returns {string} the normalised name
 * @throws {ValidationError}
 */
export function assertValidServerName(raw) {
  const initial = toSafeString(raw);

  if (CONTROL_CHARS_RE.test(initial)) {
    throw new ValidationError('The server name contains characters that are not allowed.');
  }

  const value = initial.replace(/\s+/g, ' ').trim();

  if (value.length === 0) throw new ValidationError('The server name cannot be empty.');
  if (value.length < SERVER_NAME_MIN) {
    throw new ValidationError(`The server name must be at least ${SERVER_NAME_MIN} characters long.`);
  }
  if (value.length > SERVER_NAME_MAX) {
    throw new ValidationError(`The server name must be ${SERVER_NAME_MAX} characters or fewer.`);
  }
  if (!SERVER_NAME_RE.test(value)) {
    throw new ValidationError(
      'The server name may only contain letters, numbers, spaces, dots, underscores and hyphens, and must begin and end with a letter or number.',
    );
  }

  return value;
}

/**
 * Validates an egg key against the keys that are actually configured.
 *
 * Membership in `allowedKeys` is the real check; the regex only rejects
 * obviously malformed input before the lookup.
 *
 * @param {unknown} raw
 * @param {string[]} allowedKeys keys from config.json that are fully configured
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertValidEggKey(raw, allowedKeys) {
  const value = toSafeString(raw).toLowerCase();
  const allowed = Array.isArray(allowedKeys) ? allowedKeys : [];

  if (!EGG_KEY_RE.test(value) || !allowed.includes(value)) {
    const hint = allowed.length > 0 ? ` Available types: ${allowed.join(', ')}.` : '';
    throw new ValidationError(`That server type is not available.${hint}`);
  }
  return value;
}

/**
 * Validates a power signal.
 *
 * @param {unknown} raw
 * @returns {'start'|'stop'|'restart'|'kill'}
 * @throws {ValidationError}
 */
export function assertValidPowerSignal(raw) {
  const value = toSafeString(raw).toLowerCase();
  if (!POWER_SIGNALS.includes(value)) {
    throw new ValidationError(`Invalid power action. Allowed actions: ${POWER_SIGNALS.join(', ')}.`);
  }
  return value;
}

/**
 * Validates a Discord snowflake.
 *
 * @param {unknown} raw
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertValidDiscordId(raw) {
  const value = toSafeString(raw);
  if (!SNOWFLAKE_RE.test(value)) throw new ValidationError('Invalid Discord user id.');
  return value;
}

/**
 * Accepts either a raw snowflake or a `<@id>` / `<@!id>` mention and returns the
 * bare id. Channel and role mentions are rejected rather than silently accepted.
 *
 * @param {unknown} raw
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertValidUserReference(raw) {
  const value = toSafeString(raw);
  const match = USER_MENTION_RE.exec(value);
  const id = match ? match[1] : value;

  if (!SNOWFLAKE_RE.test(id)) {
    throw new ValidationError('That is not a valid user. Mention the user or paste their Discord user id.');
  }
  return id;
}

/**
 * Validates and normalises an email address.
 *
 * @param {unknown} raw
 * @returns {string} the lowercased address
 * @throws {ValidationError}
 */
export function assertValidEmail(raw) {
  const value = toSafeString(raw).toLowerCase();

  if (value.length === 0) throw new ValidationError('An email address is required.');
  if (value.length > EMAIL_MAX) throw new ValidationError(`The email address must be ${EMAIL_MAX} characters or fewer.`);
  if (!EMAIL_RE.test(value)) throw new ValidationError('That is not a valid email address.');

  return value;
}

/**
 * Validates a container image against the operator-defined allowlist.
 *
 * Docker images are never taken from free-form input. The dashboard sends an
 * index into this list rather than an image string, and this check is the second
 * line of defence.
 *
 * @param {unknown} raw
 * @param {string[]} allowedImages images from `eggs.<key>.images` in config.json
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertAllowedDockerImage(raw, allowedImages) {
  const value = toSafeString(raw);
  const allowed = Array.isArray(allowedImages) ? allowedImages : [];

  if (allowed.length === 0) {
    throw new ValidationError('No alternative container images are configured for this server type.');
  }
  if (!allowed.includes(value)) {
    throw new ValidationError('That container image is not on the allowed list.');
  }
  return value;
}

/**
 * Validates a Pterodactyl sub-user UUID.
 *
 * @param {unknown} raw
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertValidUuid(raw) {
  const value = toSafeString(raw);
  if (!UUID_RE.test(value)) throw new ValidationError('Invalid sub-user reference.');
  return value;
}

/**
 * Validates a panel permission string.
 *
 * @param {unknown} raw
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertValidPermission(raw) {
  const value = toSafeString(raw).toLowerCase();
  if (!PERMISSION_RE.test(value)) {
    throw new ValidationError(`Invalid panel permission: ${value || '(empty)'}`);
  }
  return value;
}

/**
 * Validates an absolute file path used against the panel file manager.
 *
 * Relative paths and `..` segments are rejected so a configured log path cannot
 * be used to read outside the server root.
 *
 * @param {unknown} raw
 * @returns {string}
 * @throws {ValidationError}
 */
export function assertAbsolutePath(raw) {
  const value = toSafeString(raw);

  if (!ABSOLUTE_PATH_RE.test(value)) {
    throw new ValidationError('File paths must be absolute and start with "/".');
  }
  if (value.split('/').includes('..')) {
    throw new ValidationError('File paths may not contain ".." segments.');
  }
  return value;
}

/**
 * Validates a bounded integer, accepting the string forms that arrive from the
 * prefix surface.
 *
 * @param {unknown} raw
 * @param {{ name?: string, min?: number, max?: number }} options
 * @returns {number}
 * @throws {ValidationError}
 */
export function assertValidInteger(raw, { name = 'value', min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = toSafeString(raw);
  if (text === '') throw new ValidationError(`\`${name}\` is required.`);

  /**
   * Plain decimal digits only.
   *
   * Number('1e3') is 1000 and Number('0x10') is 16, so a bare Number.isInteger check accepts
   * scientific and hexadecimal notation for a page number. That is surprising rather than
   * lenient. The slash surface sends a real Number, whose string form always matches.
   */
  if (!/^-?\d+$/.test(text)) throw new ValidationError(`\`${name}\` must be a whole number.`);

  const value = Number(text);
  if (!Number.isInteger(value)) throw new ValidationError(`\`${name}\` must be a whole number.`);
  if (value < min) throw new ValidationError(`\`${name}\` must be at least ${min}.`);
  if (value > max) throw new ValidationError(`\`${name}\` must be at most ${max}.`);

  return value;
}

/**
 * Validates a value against a fixed choice list, case-insensitively.
 *
 * @param {unknown} raw
 * @param {string[]} choices
 * @param {{ name?: string }} options
 * @returns {string} the canonical choice value
 * @throws {ValidationError}
 */
export function assertOneOf(raw, choices, { name = 'value' } = {}) {
  const value = toSafeString(raw).toLowerCase();
  const list = Array.isArray(choices) ? choices : [];
  const found = list.find((choice) => String(choice).toLowerCase() === value);

  if (found === undefined) {
    throw new ValidationError(`\`${name}\` must be one of: ${list.join(', ')}.`);
  }
  return found;
}

/**
 * Neutralises Discord markdown and mention syntax in text that originates from
 * the panel or from another user, for safe interpolation into an embed.
 *
 * Used for display only. Values sent to the panel go through the strict
 * validators above instead.
 *
 * @param {unknown} raw
 * @param {number} maxLength
 * @returns {string}
 */
export function sanitiseForDisplay(raw, maxLength = 256) {
  const value = toSafeString(raw)
    // The global pattern: the non-global one would strip only the first control character.
    .replace(CONTROL_CHARS_GLOBAL_RE, '')
    .replace(/[`*_~|\\]/g, '')
    .replace(/@(everyone|here)/gi, '@\u200bthe$1')
    .replace(/<@(&?\d+)>/g, '<@\u200b$1>');

  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Parses a comma-separated list of Discord snowflakes from an environment
 * variable. Empty entries are ignored; malformed entries throw so a typo in
 * ADMIN_USER_IDS is caught at startup rather than silently granting nobody access.
 *
 * @param {unknown} raw
 * @param {string} name the variable name, used in the error message
 * @returns {readonly string[]}
 * @throws {ValidationError}
 */
export function parseSnowflakeList(raw, name = 'list') {
  const values = toSafeString(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  for (const value of values) {
    if (!SNOWFLAKE_RE.test(value)) {
      throw new ValidationError(`${name} contains an invalid Discord snowflake: ${value}`);
    }
  }
  return Object.freeze([...new Set(values)]);
}

export {
  ABSOLUTE_PATH_RE,
  EGG_KEY_RE,
  EMAIL_RE,
  IDENTIFIER_RE,
  PERMISSION_RE,
  POWER_SIGNALS,
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
  SERVER_NAME_RE,
  SNOWFLAKE_RE,
  UUID_RE,
};
