import { AsyncLocalStorage } from 'node:async_hooks';
import { AppError } from './errors.js';
import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 60_000;

const QUEUE_WARN_THRESHOLD = 8;

export function createLockManager({ timeoutMs: defaultTimeoutMs = DEFAULT_TIMEOUT_MS } = {}) {

  const locks = new Map();

  const context = new AsyncLocalStorage();

  async function withLock(key, fn, { timeoutMs = defaultTimeoutMs } = {}) {
    const name = String(key);

    const inherited = context.getStore() ?? new Set();
    if ([...inherited].some((lease) => lease.active && lease.name === name)) {

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

    let release;
    const finished = new Promise((resolve) => {
      release = resolve;
    });

    locks.set(name, {
      tail: previous.then(() => finished),
      depth,
      holderStartedAt: existing?.holderStartedAt ?? null,
    });

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

    const lease = { name, active: true };
    try {
      return await context.run(new Set([...inherited, lease]), fn);
    } finally {
      lease.active = false;
      release();
      settle(name);
    }
  }

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

    isLocked(key) {
      return locks.has(String(key));
    },

    queueLength(key) {
      return locks.get(String(key))?.depth ?? 0;
    },

    activeKeys() {
      return [...locks.keys()];
    },

    size() {
      return locks.size;
    },

    clear() {
      if (locks.size > 0) {
        throw new AppError('Cannot clear locks while operations are in progress.', { code: 'LOCK_ACTIVE' });
      }
    },
  };
}

export const locks = createLockManager();

export { DEFAULT_TIMEOUT_MS, QUEUE_WARN_THRESHOLD };
