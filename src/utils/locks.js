// Coded by Aditya | GitHub- @adityatheog

/**
 * Per-key async mutex.
 *
 * Discord delivers interactions concurrently. Nothing stops a user from pressing
 * a button twice in the same tick, running the prefix and slash form of a command
 * simultaneously, or scripting a client to fire ten identical requests. Node's
 * single thread does not help here: every one of those handlers awaits a panel
 * call, and control returns to the event loop at that point.
 *
 * The concrete bug this prevents:
 *
 *   handler A: read server count -> 0, passes the limit check, awaits the panel
 *   handler B: read server count -> 0, passes the limit check, awaits the panel
 *   both succeed, the user now owns two servers with FREE_SERVER_LIMIT=1
 *
 * A check-then-act sequence spanning an await is only safe if it is serialised.
 * Callers wrap the whole read-decide-write sequence:
 *
 *   await locks.withLock(`servers:${discordId}`, async () => {
 *     if (db.countUserServers(discordId) >= limit) throw new ValidationError(...);
 *     const created = await panel.createServer(...);
 *     return db.createServer(...);
 *   });
 *
 * Keys are namespaced strings. `servers:<discordId>` serialises provisioning and
 * deletion for one user while leaving other users unblocked; `backup:<identifier>`
 * serialises archiving one server. Unrelated keys never contend.
 *
 * Guarantees:
 *   - FIFO per key. Waiters run in the order they arrived.
 *   - Exception-safe. A thrown or rejected callback still releases the lock.
 *   - Self-cleaning. The internal map does not grow across requests.
 *   - Deadlock-resistant. Re-entering the same key from inside a held lock is
 *     detected and reported rather than hanging forever.
 */

import { AppError } from './errors.js';
import { logger } from './logger.js';

/** Guard against a stuck holder wedging a key permanently. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Warn when a key's queue grows past this, which suggests abuse or a stall. */
const QUEUE_WARN_THRESHOLD = 8;

/**
 * Creates an isolated lock manager.
 *
 * Each manager owns its own key space. The application creates one during startup
 * and shares it across services, so `servers:<id>` means the same lock everywhere.
 *
 * @param {object} [options]
 * @param {number} [options.timeoutMs] how long a waiter waits before giving up
 * @returns {{
 *   withLock: <T>(key: string, fn: () => Promise<T>|T, options?: { timeoutMs?: number }) => Promise<T>,
 *   isLocked: (key: string) => boolean,
 *   queueLength: (key: string) => number,
 *   activeKeys: () => string[],
 *   size: () => number,
 *   clear: () => void
 * }}
 */
export function createLockManager({ timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  /**
   * One entry per contended key.
   *
   * `tail` is the promise that resolves when the currently queued work finishes;
   * a new waiter chains onto it. `depth` counts holder plus waiters so the entry
   * can be deleted once the key falls idle.
   *
   * @type {Map<string, { tail: Promise<void>, depth: number, holderStartedAt: number|null }>}
   */
  const locks = new Map();

  /**
   * Keys held on the current async call path.
   *
   * Node has no thread-local storage available without AsyncLocalStorage, but a
   * plain Set is sufficient here: withLock adds the key before invoking the
   * callback and removes it after, so a nested acquisition of the same key inside
   * that callback is visible. This turns a silent permanent hang into a thrown
   * error naming the key.
   *
   * @type {Set<string>}
   */
  const held = new Set();

  /**
   * Runs `fn` with exclusive access to `key`.
   *
   * @template T
   * @param {string} key
   * @param {() => Promise<T>|T} fn
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<T>} whatever fn resolves to
   * @throws {AppError} on re-entrant acquisition or on wait timeout
   */
  async function withLock(key, fn, { timeoutMs = defaultTimeoutMs } = {}) {
    const name = String(key);

    if (held.has(name)) {
      // Recursive acquisition can never succeed: the outer hold is only released
      // after the callback returns, and the callback is what is waiting.
      throw new AppError('An internal locking error occurred. Please try again.', {
        code: 'LOCK_REENTRANT',
        details: { key: name },
      });
    }

    const existing = locks.get(name);
    const previous = existing?.tail ?? Promise.resolve();
    const depth = (existing?.depth ?? 0) + 1;

    if (depth > QUEUE_WARN_THRESHOLD) {
      logger.warn('Lock queue is unusually long', {
        key: name,
        queued: depth,
        heldForMs: existing?.holderStartedAt ? Date.now() - existing.holderStartedAt : null,
      });
    }

    /** Resolves when this waiter's turn is over, letting the next one proceed. */
    let release;
    const finished = new Promise((resolve) => {
      release = resolve;
    });

    locks.set(name, {
      tail: previous.then(() => finished),
      depth,
      holderStartedAt: existing?.holderStartedAt ?? null,
    });

    // Wait for the turn. A rejected predecessor must not prevent this waiter from
    // running, so the predecessor's failure is swallowed here; it was already
    // delivered to that caller.
    if (timeoutMs > 0) {
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(
            new AppError('That operation is taking too long because another request is still in progress. Please try again.', {
              code: 'LOCK_TIMEOUT',
              details: { key: name, timeoutMs },
            }),
          );
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });

      try {
        await Promise.race([previous.catch(() => {}), timeout]);
      } catch (err) {
        // Abandoning the queue slot: release immediately so successors are not
        // blocked by a waiter that gave up.
        release();
        settle(name);
        logger.error('Lock acquisition timed out', { key: name, timeoutMs });
        throw err;
      } finally {
        clearTimeout(timer);
      }
    } else {
      await previous.catch(() => {});
    }

    const entry = locks.get(name);
    if (entry) entry.holderStartedAt = Date.now();

    held.add(name);
    try {
      return await fn();
    } finally {
      held.delete(name);
      release();
      settle(name);
    }
  }

  /**
   * Decrements the key's depth and removes the entry once nothing is queued.
   *
   * Without this the map would retain one entry per key ever locked, which for a
   * public bot means one entry per user id — a slow leak.
   *
   * @param {string} name
   */
  function settle(name) {
    const entry = locks.get(name);
    if (!entry) return;

    entry.depth -= 1;
    if (entry.depth <= 0) {
      locks.delete(name);
      return;
    }
    entry.holderStartedAt = null;
  }

  return {
    withLock,

    /** @param {string} key @returns {boolean} whether the key is currently contended. */
    isLocked(key) {
      return locks.has(String(key));
    },

    /** @param {string} key @returns {number} holder plus waiters for the key. */
    queueLength(key) {
      return locks.get(String(key))?.depth ?? 0;
    },

    /** @returns {string[]} every contended key, for diagnostics. */
    activeKeys() {
      return [...locks.keys()];
    },

    /** @returns {number} how many keys are contended. */
    size() {
      return locks.size;
    },

    /**
     * Drops all bookkeeping without cancelling in-flight callbacks.
     * Used by tests between cases; unsafe while work is running.
     */
    clear() {
      locks.clear();
      held.clear();
    },
  };
}

/** Shared manager used by the services wired in src/index.js. */
export const locks = createLockManager();

export { DEFAULT_TIMEOUT_MS, QUEUE_WARN_THRESHOLD };
