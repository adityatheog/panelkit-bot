// Coded by Aditya | GitHub- @adityatheog

/**
 * Server-side store for interactive component sessions.
 *
 * Discord custom ids are client-controlled: any user who can see a message can
 * send its component interactions with an arbitrary custom id, and the id itself
 * carries no authenticity. This store is what makes components safe.
 *
 * The design has three properties:
 *
 * 1. Custom ids carry no state. A custom id is `namespace:action[:extra]:sessionId`
 *    and the session id is an unguessable 72-bit token. Everything that identifies
 *    the target resource (server identifier, page number, selected egg) lives here,
 *    in process memory, keyed by that token. A user cannot edit a button to act on
 *    a server they do not own, because the server is not named in the button.
 *
 * 2. Sessions expire, and expiry is enforced on read. A stale button therefore
 *    resolves to no session at all, which the interaction router answers with the
 *    "Timed Out" embed instead of executing anything.
 *
 * 3. Sessions are owner-bound. Every session records the Discord id that created
 *    it, and handlers compare against it before acting.
 *
 * State is intentionally in-memory: it is short-lived UI state, not durable data.
 * A restart invalidates open menus, which is correct — the message's collector is
 * gone too, so the components would be inert regardless. This also means the bot
 * must run as a single process; see README for why horizontal scaling would
 * require moving this store to Redis.
 */

import { createSessionDescriptor, DEFAULT_SESSION_TTL_MS, isSessionOwner } from './security.js';
import { logger } from './logger.js';

/** @type {Map<string, { id: string, ownerId: string, data: Record<string, unknown>, createdAt: number, expiresAt: number }>} */
const sessions = new Map();

/** Separator between custom id segments. Absent from base64url, so ids are unambiguous. */
const SEPARATOR = ':';

/** Discord rejects a custom id longer than this. */
const MAX_CUSTOM_ID_LENGTH = 100;

/**
 * Upper bound on concurrent sessions.
 *
 * A public bot cannot let an unbounded map grow from component spam. When the cap
 * is reached the oldest session is evicted, which at worst expires one user's menu
 * early — strictly better than exhausting memory.
 */
const MAX_SESSIONS = 10_000;

export { DEFAULT_SESSION_TTL_MS };
export const SESSION_TTL_MS = DEFAULT_SESSION_TTL_MS;

/**
 * Evicts the single oldest session. Called only when the cap is hit.
 *
 * @returns {boolean} whether something was evicted
 */
function evictOldest() {
  let oldestId = null;
  let oldestAt = Infinity;

  for (const [id, session] of sessions) {
    if (session.createdAt < oldestAt) {
      oldestAt = session.createdAt;
      oldestId = id;
    }
  }

  if (oldestId === null) return false;
  sessions.delete(oldestId);
  logger.warn('Session cap reached; evicted the oldest session', { cap: MAX_SESSIONS });
  return true;
}

/**
 * Creates and stores a session.
 *
 * @param {string} ownerId the Discord id permitted to use the components
 * @param {Record<string, unknown>} [data] server-side state for this session
 * @param {number} [ttlMs] lifetime; defaults to two minutes
 * @returns {{ id: string, ownerId: string, data: Record<string, unknown>, createdAt: number, expiresAt: number }}
 */
export function createSession(ownerId, data = {}, ttlMs = DEFAULT_SESSION_TTL_MS) {
  if (sessions.size >= MAX_SESSIONS) {
    sweepSessions();
    if (sessions.size >= MAX_SESSIONS) evictOldest();
  }

  const session = createSessionDescriptor(ownerId, data, ttlMs);
  sessions.set(session.id, session);

  logger.debug('Session created', { sessionId: session.id, ownerId: session.ownerId, ttlMs, active: sessions.size });
  return session;
}

/**
 * Retrieves a live session.
 *
 * Expiry is checked here rather than only by the sweeper, so a component pressed
 * between sweeps still cannot act. An expired entry is deleted on read.
 *
 * @param {string|null|undefined} id
 * @returns {{ id: string, ownerId: string, data: Record<string, unknown>, createdAt: number, expiresAt: number }|null}
 */
export function getSession(id) {
  if (typeof id !== 'string' || id === '') return null;

  const session = sessions.get(id);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(id);
    logger.debug('Session expired on read', { sessionId: id });
    return null;
  }

  return session;
}

/**
 * Retrieves a session only if the given user owns it.
 *
 * Combines lookup and the ownership check so a handler cannot accidentally act on
 * a session it fetched but never authorised.
 *
 * @param {string|null|undefined} id
 * @param {string} userId
 * @returns {object|null} the session, or null when missing, expired or foreign
 */
export function getOwnedSession(id, userId) {
  const session = getSession(id);
  if (!session) return null;
  return isSessionOwner(session, userId) ? session : null;
}

/**
 * Extends a session's lifetime, used when a user is actively navigating a menu.
 *
 * @param {string} id
 * @param {number} [ttlMs]
 * @returns {boolean} whether the session was found and extended
 */
export function touchSession(id, ttlMs = DEFAULT_SESSION_TTL_MS) {
  const session = getSession(id);
  if (!session) return false;

  session.expiresAt = Date.now() + (Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : DEFAULT_SESSION_TTL_MS);
  return true;
}

/**
 * Replaces a session's stored state.
 *
 * @param {string} id
 * @param {Record<string, unknown>} patch fields to merge into the session data
 * @returns {boolean} whether the session was found and updated
 */
export function updateSessionData(id, patch) {
  const session = getSession(id);
  if (!session) return false;

  session.data = { ...session.data, ...(patch ?? {}) };
  return true;
}

/**
 * Deletes a session immediately.
 *
 * Called as soon as a flow completes or is cancelled, so a confirmed destructive
 * action cannot be replayed by pressing the same button twice.
 *
 * @param {string|null|undefined} id
 * @returns {boolean} whether something was deleted
 */
export function deleteSession(id) {
  if (typeof id !== 'string' || id === '') return false;
  return sessions.delete(id);
}

/**
 * Deletes every session owned by a user. Used when an account is deleted, so no
 * open menu can still reference removed resources.
 *
 * @param {string} ownerId
 * @returns {number} how many sessions were removed
 */
export function deleteSessionsForOwner(ownerId) {
  const owner = String(ownerId);
  let removed = 0;

  for (const [id, session] of sessions) {
    if (session.ownerId === owner) {
      sessions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/** @returns {number} the number of stored sessions, including any not yet swept. */
export function sessionCount() {
  return sessions.size;
}

/**
 * Builds a custom id from segments.
 *
 * The session id is always the final segment, which is what
 * sessionIdFromCustomId() relies on. Over-long ids are rejected loudly rather
 * than silently truncated, because a truncated id would fail to resolve at
 * runtime in a way that is hard to trace.
 *
 * @param {...(string|number)} parts namespace, action, then optional extras, then the session id
 * @returns {string}
 * @throws {Error} when the result exceeds Discord's custom id limit
 */
export function buildCustomId(...parts) {
  const id = parts.map((part) => String(part)).join(SEPARATOR);

  if (id.length > MAX_CUSTOM_ID_LENGTH) {
    throw new Error(`Custom id exceeds Discord's ${MAX_CUSTOM_ID_LENGTH} character limit: ${id.length} characters`);
  }
  return id;
}

/**
 * Extracts the session id from a custom id.
 *
 * @param {unknown} customId
 * @returns {string|null} the final segment, or null when there is no separator
 */
export function sessionIdFromCustomId(customId) {
  if (typeof customId !== 'string' || customId === '') return null;

  const parts = customId.split(SEPARATOR);
  if (parts.length < 2) return null;

  const id = parts[parts.length - 1];
  return id === '' ? null : id;
}

/**
 * Extracts the action segment from a custom id.
 *
 * @param {unknown} customId
 * @returns {string|null}
 */
export function actionFromCustomId(customId) {
  if (typeof customId !== 'string') return null;

  const parts = customId.split(SEPARATOR);
  return parts.length >= 2 ? parts[1] : null;
}

/**
 * Extracts the namespace segment from a custom id.
 *
 * @param {unknown} customId
 * @returns {string|null}
 */
export function namespaceFromCustomId(customId) {
  if (typeof customId !== 'string') return null;

  const parts = customId.split(SEPARATOR);
  return parts.length >= 1 && parts[0] !== '' ? parts[0] : null;
}

/**
 * Removes every expired session.
 *
 * @param {number} [now]
 * @returns {number} how many sessions were removed
 */
export function sweepSessions(now = Date.now()) {
  let removed = 0;

  for (const [id, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(id);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Starts the periodic sweeper.
 *
 * Expiry is already enforced on read, so this only reclaims memory for sessions
 * nobody returns to. The timer is unref'd so it never keeps the process alive
 * during shutdown.
 *
 * @param {number} [intervalMs=60000]
 * @returns {NodeJS.Timeout}
 */
export function startSessionSweeper(intervalMs = 60_000) {
  const timer = setInterval(() => {
    const removed = sweepSessions();
    if (removed > 0) logger.debug('Sessions swept', { removed, active: sessions.size });
  }, intervalMs);

  timer.unref();
  return timer;
}

/**
 * Clears every session. Used by tests and during shutdown.
 *
 * @returns {number} how many sessions were removed
 */
export function clearAllSessions() {
  const size = sessions.size;
  sessions.clear();
  return size;
}

export { MAX_CUSTOM_ID_LENGTH, MAX_SESSIONS, SEPARATOR };
