// Coded by Aditya | GitHub- @adityatheog

/**
 * Per-user, per-command cooldowns.
 *
 * Discord's own rate limits protect Discord's API. They do nothing to protect the
 * Pterodactyl panel, which is the resource that actually matters here: a user
 * looping `files backup` makes the node compress a filesystem repeatedly, and a user
 * looping `account create` generates panel accounts as fast as the network allows.
 * Neither is throttled by anything upstream of this module.
 *
 * The policy is per user and per command, not global. One person spamming
 * `server logs` should not prevent everyone else from running it, and a cheap
 * command should not inherit an expensive command's cooldown. Costs are declared in
 * config.json under `cooldowns.perCommand`, with `defaultSeconds` for everything
 * else.
 *
 * Two design points worth stating:
 *
 * The cooldown is recorded only when the command is *allowed* to proceed. Recording
 * on every attempt would let a user extend their own cooldown indefinitely by
 * hammering the command, which turns a throttle into a self-inflicted lockout.
 *
 * Administrators bypass cooldowns. An operator diagnosing a problem should not be
 * throttled by an anti-abuse control aimed at users, and admin actions are already
 * audited in the log.
 *
 * State is in-memory and deliberately so: a cooldown is transient, and losing them
 * on restart is a smaller problem than the complexity of persisting them. The store
 * is bounded and swept so it cannot grow without limit on a public bot.
 */

import { formatDuration } from '../utils/format.js';
import { logger } from '../utils/logger.js';

/**
 * Upper bound on tracked entries.
 *
 * One entry per user per command. Ten thousand covers a large deployment; beyond
 * that the oldest expiring entries are dropped, which at worst lets one user run a
 * command slightly sooner than intended.
 */
const MAX_ENTRIES = 10_000;

/** How often expired entries are reclaimed. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Creates a cooldown manager.
 *
 * @param {object} deps
 * @param {Readonly<object>} deps.config validated config.json
 * @returns {{
 *   check: (userId: string, commandName: string, options?: { bypass?: boolean }) => { limited: boolean, remainingMs: number },
 *   peek: (userId: string, commandName: string) => number,
 *   clear: (userId: string, commandName?: string) => number,
 *   secondsFor: (commandName: string) => number,
 *   sweep: (now?: number) => number,
 *   startSweeper: (intervalMs?: number) => NodeJS.Timeout,
 *   size: () => number,
 *   clearAll: () => number
 * }}
 */
export function createCooldownManager({ config }) {
  const defaultSeconds = Math.max(0, Number(config?.cooldowns?.defaultSeconds ?? 3));
  const perCommand = config?.cooldowns?.perCommand ?? {};

  /**
   * Expiry timestamps keyed by `${userId}:${commandName}`.
   *
   * A plain Map holding numbers rather than timers: ten thousand setTimeout handles
   * would be far more expensive than one periodic sweep, and expiry is checked on
   * read anyway.
   *
   * @type {Map<string, number>}
   */
  const entries = new Map();

  /**
   * The cooldown for a command, in seconds.
   *
   * @param {string} commandName canonical name, for example "server create"
   * @returns {number} zero when the command has no cooldown
   */
  function secondsFor(commandName) {
    const key = String(commandName ?? '').trim().toLowerCase();
    const specific = perCommand[key];
    return specific === undefined ? defaultSeconds : Math.max(0, Number(specific));
  }

  /**
   * Drops the entry expiring soonest.
   *
   * Called only when the cap is reached. Evicting the nearest expiry costs the least
   * enforcement time, since that entry was about to lapse regardless.
   *
   * @returns {boolean}
   */
  function evictSoonest() {
    let soonestKey = null;
    let soonestAt = Infinity;

    for (const [key, expiresAt] of entries) {
      if (expiresAt < soonestAt) {
        soonestAt = expiresAt;
        soonestKey = key;
      }
    }

    if (soonestKey === null) return false;
    entries.delete(soonestKey);
    return true;
  }

  /**
   * Tests and records a cooldown.
   *
   * This both reads and writes: when the call is allowed, the next expiry is set
   * before returning. Callers must therefore invoke it exactly once per attempt, and
   * only after permission checks have passed.
   *
   * @param {string} userId
   * @param {string} commandName
   * @param {{ bypass?: boolean }} [options] bypass skips the check entirely, for administrators
   * @returns {{ limited: boolean, remainingMs: number }}
   */
  function check(userId, commandName, { bypass = false } = {}) {
    if (bypass) return { limited: false, remainingMs: 0 };

    const seconds = secondsFor(commandName);
    if (seconds <= 0) return { limited: false, remainingMs: 0 };

    const key = `${userId}:${String(commandName).toLowerCase()}`;
    const now = Date.now();
    const expiresAt = entries.get(key) ?? 0;

    if (expiresAt > now) {
      // Still cooling down. The expiry is left untouched, so repeated attempts do
      // not push it further out.
      return { limited: true, remainingMs: expiresAt - now };
    }

    if (entries.size >= MAX_ENTRIES && !entries.has(key)) {
      sweep(now);
      if (entries.size >= MAX_ENTRIES) {
        evictSoonest();
        logger.warn('Cooldown store reached its cap; evicted the nearest entry', { cap: MAX_ENTRIES });
      }
    }

    entries.set(key, now + seconds * 1000);
    return { limited: false, remainingMs: 0 };
  }

  /**
   * Reads the remaining cooldown without recording anything.
   *
   * Used by the help detail view, which shows a command's cooldown without
   * consuming it.
   *
   * @param {string} userId
   * @param {string} commandName
   * @returns {number} milliseconds remaining, zero when not limited
   */
  function peek(userId, commandName) {
    const key = `${userId}:${String(commandName).toLowerCase()}`;
    const expiresAt = entries.get(key) ?? 0;
    const remaining = expiresAt - Date.now();
    return remaining > 0 ? remaining : 0;
  }

  /**
   * Clears cooldowns for a user.
   *
   * Called when an account is deleted, so a user who re-registers is not held to a
   * cooldown from a previous account.
   *
   * @param {string} userId
   * @param {string} [commandName] when omitted, clears every command for the user
   * @returns {number} how many entries were removed
   */
  function clear(userId, commandName) {
    if (commandName !== undefined) {
      const key = `${userId}:${String(commandName).toLowerCase()}`;
      return entries.delete(key) ? 1 : 0;
    }

    const prefix = `${userId}:`;
    let removed = 0;

    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) {
        entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  /**
   * Removes expired entries.
   *
   * @param {number} [now]
   * @returns {number} how many entries were removed
   */
  function sweep(now = Date.now()) {
    let removed = 0;

    for (const [key, expiresAt] of entries) {
      if (expiresAt <= now) {
        entries.delete(key);
        removed += 1;
      }
    }

    return removed;
  }

  /**
   * Starts the periodic sweeper.
   *
   * Expiry is already enforced on read, so this only reclaims memory for entries
   * nobody returns to. The timer is unref'd so a pending sweep never delays
   * shutdown.
   *
   * @param {number} [intervalMs]
   * @returns {NodeJS.Timeout}
   */
  function startSweeper(intervalMs = SWEEP_INTERVAL_MS) {
    const timer = setInterval(() => {
      const removed = sweep();
      if (removed > 0) logger.debug('Cooldown entries swept', { removed, active: entries.size });
    }, intervalMs);

    timer.unref();
    return timer;
  }

  return {
    check,
    peek,
    clear,
    secondsFor,
    sweep,
    startSweeper,
    size: () => entries.size,
    clearAll: () => {
      const size = entries.size;
      entries.clear();
      return size;
    },
  };
}

/**
 * Formats a remaining cooldown for a user-facing message.
 *
 * @param {number} remainingMs
 * @returns {string} for example "45 seconds" or "2 minutes"
 */
export function formatCooldown(remainingMs) {
  return formatDuration(remainingMs);
}

export { MAX_ENTRIES, SWEEP_INTERVAL_MS };
