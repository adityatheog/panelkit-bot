// Coded by Aditya | GitHub- @adityatheog

/**
 * Credential generation, safe URL construction and interaction ownership checks.
 *
 * Everything in this module protects one of three assets:
 *
 * 1. Generated panel credentials. Usernames and passwords are produced with
 *    node:crypto using rejection sampling, never Math.random, and are returned to
 *    the caller exactly once for DM delivery. Nothing here stores or logs them.
 *
 * 2. Outbound links. Panel URLs are assembled from a configured origin plus a
 *    re-validated identifier, so a crafted identifier can never redirect a user
 *    to an attacker-controlled host.
 *
 * 3. Interactive components. Every button, select menu and modal belongs to the
 *    Discord user who opened it. Ownership is verified in the bot, because
 *    Discord's UI visibility is not an authorisation boundary: any user who can
 *    see a message can send its component interactions.
 */

import crypto from 'node:crypto';
import { AuthorizationError } from './errors.js';
import { assertValidIdentifier } from './validation.js';

/**
 * Lowercase alphanumerics only. Pterodactyl rejects usernames containing most
 * punctuation, and keeping the set narrow avoids surprises across panel versions.
 */
const USERNAME_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Panel usernames must begin with a letter. */
const USERNAME_FIRST_ALPHABET = 'abcdefghijklmnopqrstuvwxyz';

/**
 * Password alphabet with visually ambiguous characters removed (I, l, 1, O, 0)
 * because these credentials are read out of a Discord DM and retyped by hand.
 * The symbol set excludes quotes, backslashes and backticks so the password is
 * safe to paste into a shell or a Discord code span without escaping.
 */
const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*()-_=+';

const USERNAME_MIN = 3;
const USERNAME_MAX = 48;
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 64;

/** Sessions default to two minutes; the dashboard and help menu override this. */
const DEFAULT_SESSION_TTL_MS = 120_000;

/**
 * Picks one character uniformly at random from an alphabet.
 *
 * Uses rejection sampling: bytes at or above the largest multiple of the
 * alphabet length are discarded and redrawn. A plain `byte % length` would bias
 * the first `256 % length` characters, measurably reducing entropy.
 *
 * @param {string} alphabet
 * @returns {string} a single character
 */
function randomChar(alphabet) {
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  for (;;) {
    const byte = crypto.randomBytes(1)[0];
    if (byte < limit) return alphabet[byte % alphabet.length];
  }
}

/**
 * @param {number} length
 * @param {string} alphabet
 * @returns {string}
 */
function randomString(length, alphabet) {
  let out = '';
  for (let index = 0; index < length; index += 1) out += randomChar(alphabet);
  return out;
}

/**
 * Generates a panel username.
 *
 * The first character is always a letter, satisfying Pterodactyl's validation
 * rules. Length is clamped rather than rejected so a bad config value degrades
 * to a safe default instead of blocking account creation.
 *
 * @param {number} [length=10]
 * @returns {string}
 */
export function generateUsername(length = 10) {
  const requested = Number(length);
  const size = Math.max(USERNAME_MIN, Math.min(USERNAME_MAX, Number.isFinite(requested) ? Math.trunc(requested) : 10));
  return randomChar(USERNAME_FIRST_ALPHABET) + randomString(size - 1, USERNAME_ALPHABET);
}

/**
 * Generates a panel password.
 *
 * Regenerates until the candidate contains at least one lowercase letter, one
 * uppercase letter and one digit, so the panel's password policy always passes
 * on the first submission. Rejection preserves uniformity over the subset of
 * compliant strings; it does not bias individual positions.
 *
 * @param {number} [length=16]
 * @returns {string}
 */
export function generatePassword(length = 16) {
  const requested = Number(length);
  const size = Math.max(PASSWORD_MIN, Math.min(PASSWORD_MAX, Number.isFinite(requested) ? Math.trunc(requested) : 16));

  for (;;) {
    const candidate = randomString(size, PASSWORD_ALPHABET);
    if (/[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /\d/.test(candidate)) return candidate;
  }
}

/**
 * Builds the panel login email for a generated username.
 *
 * @param {string} username
 * @param {string} domain from config.json account.emailDomain
 * @returns {string}
 */
export function buildEmail(username, domain) {
  return `${username}@${domain}`;
}

/**
 * Generates an unguessable session identifier for an interactive component set.
 *
 * 72 bits of entropy, base64url encoded so it is safe inside a Discord customId
 * (which is limited to 100 characters and must not contain the separator used by
 * the component namespace).
 *
 * @returns {string}
 */
export function newSessionId() {
  return crypto.randomBytes(9).toString('base64url');
}

/**
 * Generates a random token for correlating a log line with a user-facing error
 * reference, so an operator can find the failure without the user seeing details.
 *
 * @returns {string}
 */
export function newErrorReference() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Builds a link to a server's page on the panel.
 *
 * The identifier is re-validated and percent-encoded, and the result is resolved
 * against the configured panel origin, so the host can never be replaced by
 * user-controlled input. The origin is asserted afterwards as a second check
 * against a malformed configured URL.
 *
 * @param {string} panelUrl the normalised panel root from the environment
 * @param {string} identifier an 8-character server identifier
 * @returns {string} an absolute https URL on the configured panel host
 * @throws {import('./errors.js').ValidationError} when the identifier is invalid
 * @throws {AuthorizationError} when the result would leave the panel origin
 */
export function buildPanelServerUrl(panelUrl, identifier) {
  const safeIdentifier = assertValidIdentifier(identifier);
  const base = new URL(panelUrl);
  const target = new URL(`/server/${encodeURIComponent(safeIdentifier)}`, base);

  if (target.origin !== base.origin) {
    throw new AuthorizationError('Refusing to build a link outside the configured panel.');
  }
  return target.toString();
}

/**
 * Builds a link to the panel account page, used in credential DMs.
 *
 * @param {string} panelUrl
 * @returns {string}
 */
export function buildPanelAccountUrl(panelUrl) {
  return new URL('/account', new URL(panelUrl)).toString();
}

/**
 * Creates an interaction session descriptor.
 *
 * Session state lives in the bot, keyed by an unguessable id, and the customId
 * carries only that id. Nothing about the target resource is encoded in the
 * component, so a component cannot be edited to act on a different server.
 *
 * @param {string} ownerId the Discord id permitted to use these components
 * @param {Record<string, unknown>} [data] server-side state for the session
 * @param {number} [ttlMs]
 * @returns {{ id: string, ownerId: string, data: Record<string, unknown>, createdAt: number, expiresAt: number }}
 */
export function createSessionDescriptor(ownerId, data = {}, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const now = Date.now();
  /**
   * A type check rather than Number(ttlMs), because Number(null) is 0 and 0 is finite — so a
   * null TTL would give the session an expiry equal to its creation time, expired on the
   * first read. An explicit 0 or a negative value is still honoured, which is how a test
   * produces an already-expired session.
   */
  const lifetime = typeof ttlMs === 'number' && Number.isFinite(ttlMs) ? ttlMs : DEFAULT_SESSION_TTL_MS;
  return {
    id: newSessionId(),
    ownerId: String(ownerId),
    data,
    createdAt: now,
    expiresAt: now + lifetime,
  };
}

/**
 * Throws unless the interacting user owns the session.
 *
 * A missing session is treated identically to a foreign one: both mean the
 * caller has no right to act, and distinguishing them would reveal whether a
 * given session id exists.
 *
 * @param {{ ownerId: string }|null|undefined} session
 * @param {string} userId
 * @returns {true}
 * @throws {AuthorizationError}
 */
export function assertSessionOwner(session, userId) {
  if (!session || session.ownerId !== String(userId)) {
    throw new AuthorizationError('This menu belongs to someone else.');
  }
  return true;
}

/**
 * Non-throwing ownership check, for handlers that reply ephemerally instead.
 *
 * @param {{ ownerId: string }|null|undefined} session
 * @param {string} userId
 * @returns {boolean}
 */
export function isSessionOwner(session, userId) {
  return Boolean(session) && session.ownerId === String(userId);
}

/**
 * Constant-time string comparison, for any future secret comparison such as a
 * webhook signature. Length is compared first because timingSafeEqual throws on
 * mismatched buffer lengths.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * Age of a Discord account in fractional days.
 *
 * @param {number} createdTimestamp milliseconds since epoch
 * @param {number} [now]
 * @returns {number}
 */
export function accountAgeInDays(createdTimestamp, now = Date.now()) {
  return (Number(now) - Number(createdTimestamp)) / 86_400_000;
}

/**
 * Whether an account satisfies the minimum age policy.
 *
 * A threshold of 0 disables the check. A non-finite creation timestamp fails
 * closed, since an unknown account age must not bypass the policy.
 *
 * @param {number} createdTimestamp
 * @param {number} requiredDays
 * @param {number} [now]
 * @returns {boolean}
 */
export function meetsAccountAge(createdTimestamp, requiredDays, now = Date.now()) {
  const required = Number(requiredDays);
  if (!Number.isFinite(required) || required <= 0) return true;

  const created = Number(createdTimestamp);
  if (!Number.isFinite(created) || created <= 0) return false;

  return accountAgeInDays(created, now) >= required;
}

/**
 * Formats a rounded account age for an error message, so a rejected user learns
 * how long they must wait rather than only that they were refused.
 *
 * @param {number} createdTimestamp
 * @param {number} requiredDays
 * @param {number} [now]
 * @returns {number} whole days remaining, never negative
 */
export function daysUntilEligible(createdTimestamp, requiredDays, now = Date.now()) {
  const remaining = Number(requiredDays) - accountAgeInDays(createdTimestamp, now);
  return remaining <= 0 ? 0 : Math.ceil(remaining);
}

export { DEFAULT_SESSION_TTL_MS, PASSWORD_MAX, PASSWORD_MIN, USERNAME_MAX, USERNAME_MIN };
