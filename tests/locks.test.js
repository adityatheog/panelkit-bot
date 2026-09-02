// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/utils/locks.js.
 *
 * The lock manager exists to close one concrete race, and that race is what these tests
 * reproduce directly rather than testing the primitive abstractly:
 *
 *   handler A: reads the server count -> 0, passes the limit check, awaits the panel
 *   handler B: reads the server count -> 0, passes the limit check, awaits the panel
 *   both succeed, and the user now owns two servers with FREE_SERVER_LIMIT=1
 *
 * Node's single thread does not prevent this. Every one of those handlers awaits a panel call,
 * and control returns to the event loop at exactly that point. A check-then-act sequence
 * spanning an await is only safe if it is serialised.
 *
 * Four properties are asserted throughout:
 *
 *   Mutual exclusion. Two callers on the same key never overlap, verified by tracking
 *   concurrency inside the critical section rather than by inspecting internal state.
 *
 *   Independence. Different keys never contend, so one user's provisioning does not block
 *   another's.
 *
 *   Exception safety. A thrown or rejected callback still releases the lock. A leaked lock is
 *   worse than no lock: it wedges a key permanently and the failure appears later, elsewhere.
 *
 *   No leaks. The internal map returns to empty, since a public bot would otherwise retain one
 *   entry per Discord user who ever ran a locked command.
 *
 * No credentials, no network, no filesystem.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createLockManager, DEFAULT_TIMEOUT_MS, locks, QUEUE_WARN_THRESHOLD } from '../src/utils/locks.js';
import { AppError } from '../src/utils/errors.js';

/**
 * Yields to the event loop.
 *
 * The await point every real handler has when it calls the panel, and the point at which an
 * unlocked check-then-act sequence interleaves.
 *
 * @param {number} [ms]
 * @returns {Promise<void>}
 */
function tick(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Tracks how many callers are inside a critical section at once.
 *
 * Asserting on observed concurrency is what makes these tests meaningful: it measures the
 * property the lock provides rather than the bookkeeping it uses to provide it.
 *
 * @returns {{ enter: () => void, exit: () => void, max: () => number, current: () => number }}
 */
function concurrencyTracker() {
  let current = 0;
  let max = 0;

  return {
    enter() {
      current += 1;
      if (current > max) max = current;
    },
    exit() {
      current -= 1;
    },
    max: () => max,
    current: () => current,
  };
}

describe('mutual exclusion', () => {
  test('serialises concurrent callers on the same key', async () => {
    /**
     * The core guarantee. Each callback yields inside its critical section, so without the lock
     * both would be inside simultaneously and observed concurrency would reach two.
     */
    const manager = createLockManager();
    const tracker = concurrencyTracker();

    const work = async () =>
      manager.withLock('user:1', async () => {
        tracker.enter();
        await tick(5);
        tracker.exit();
      });

    await Promise.all([work(), work(), work(), work()]);

    assert.equal(tracker.max(), 1, 'only one caller may hold a key at a time');
  });

  test('reproduces the limit-check race the lock exists to prevent', async () => {
    /**
     * Without serialisation both callers read a count of zero, both pass the check, and both
     * write — which is precisely how a user ends up over FREE_SERVER_LIMIT. Run once unlocked to
     * demonstrate the failure, then once locked to show it is closed.
     */
    const limit = 1;

    /** @returns {Promise<number>} how many writes got through */
    async function attempt(useLock) {
      const manager = createLockManager();
      let stored = 0;

      const provision = async () => {
        const body = async () => {
          const owned = stored;
          // The await a real handler has when it calls the panel.
          await tick(5);
          if (owned >= limit) return false;
          stored += 1;
          return true;
        };

        return useLock ? manager.withLock('servers:1', body) : body();
      };

      await Promise.all([provision(), provision(), provision()]);
      return stored;
    }

    const unlocked = await attempt(false);
    assert.ok(unlocked > limit, `expected the unlocked path to exceed the limit, got ${unlocked}`);

    const locked = await attempt(true);
    assert.equal(locked, limit, 'the locked path must respect the limit');
  });

  test('runs waiters in arrival order', async () => {
    // FIFO per key, so a queued request is not starved by later arrivals.
    const manager = createLockManager();
    const order = [];

    await Promise.all(
      [1, 2, 3, 4, 5].map((index) =>
        manager.withLock('key', async () => {
          order.push(index);
          await tick(1);
        }),
      ),
    );

    assert.deepEqual(order, [1, 2, 3, 4, 5]);
  });

  test('returns each callback’s own value to its own caller', async () => {
    const manager = createLockManager();

    const results = await Promise.all([
      manager.withLock('key', async () => 'first'),
      manager.withLock('key', async () => 'second'),
      manager.withLock('key', async () => 'third'),
    ]);

    assert.deepEqual(results, ['first', 'second', 'third']);
  });

  test('accepts a synchronous callback', async () => {
    // Some callers do only local work under the lock; they should not have to be async.
    const manager = createLockManager();

    assert.equal(await manager.withLock('key', () => 42), 42);
  });
});

describe('key independence', () => {
  test('different keys do not contend', async () => {
    /**
     * The reason keys are namespaced per user. One person's provisioning must not block another's,
     * so distinct keys run concurrently.
     */
    const manager = createLockManager();
    const tracker = concurrencyTracker();

    const work = (key) =>
      manager.withLock(key, async () => {
        tracker.enter();
        await tick(5);
        tracker.exit();
      });

    await Promise.all([work('user:1'), work('user:2'), work('user:3')]);

    assert.equal(tracker.max(), 3, 'unrelated keys should proceed in parallel');
  });

  test('distinct namespaces on the same id do not contend', async () => {
    // servers:1 and backup:1 protect different resources for the same user.
    const manager = createLockManager();
    const tracker = concurrencyTracker();

    const work = (key) =>
      manager.withLock(key, async () => {
        tracker.enter();
        await tick(5);
        tracker.exit();
      });

    await Promise.all([work('servers:1'), work('backup:1'), work('account:1')]);

    assert.equal(tracker.max(), 3);
  });

  test('coerces the key to a string', async () => {
    // A caller passing a numeric id must still hit the same lock as its string form.
    const manager = createLockManager();
    const tracker = concurrencyTracker();

    const work = (key) =>
      manager.withLock(key, async () => {
        tracker.enter();
        await tick(5);
        tracker.exit();
      });

    await Promise.all([work(1), work('1')]);

    assert.equal(tracker.max(), 1, 'numeric and string keys must be the same lock');
  });
});

describe('exception safety', () => {
  test('releases the lock when the callback throws', async () => {
    /**
     * A leaked lock is worse than no lock: the key is wedged permanently and the resulting failure
     * appears later, in an unrelated request, with no obvious cause.
     */
    const manager = createLockManager();

    await assert.rejects(
      () =>
        manager.withLock('key', async () => {
          throw new Error('boom');
        }),
      /boom/,
    );

    // The key must be usable immediately afterwards.
    assert.equal(await manager.withLock('key', async () => 'recovered'), 'recovered');
    assert.equal(manager.isLocked('key'), false);
  });

  test('releases the lock when a synchronous callback throws', async () => {
    const manager = createLockManager();

    await assert.rejects(
      () =>
        manager.withLock('key', () => {
          throw new Error('sync boom');
        }),
      /sync boom/,
    );

    assert.equal(await manager.withLock('key', () => 'recovered'), 'recovered');
  });

  test('a failing holder does not prevent its successors from running', async () => {
    /**
     * The predecessor's rejection is swallowed while waiting, since it was already delivered to
     * that caller. Without that, one failure would cascade into every queued request.
     */
    const manager = createLockManager();
    const completed = [];

    const results = await Promise.allSettled([
      manager.withLock('key', async () => {
        await tick(2);
        throw new Error('first fails');
      }),
      manager.withLock('key', async () => {
        completed.push('second');
        return 'second';
      }),
      manager.withLock('key', async () => {
        completed.push('third');
        return 'third';
      }),
    ]);

    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[2].status, 'fulfilled');
    assert.deepEqual(completed, ['second', 'third']);
  });

  test('preserves the original error rather than wrapping it', async () => {
    // Callers classify errors by type and code, so the lock must be transparent.
    const manager = createLockManager();
    const original = new AppError('specific failure', { code: 'PANEL_HTTP_409', status: 409 });

    await assert.rejects(
      () =>
        manager.withLock('key', async () => {
          throw original;
        }),
      (err) => err === original && err.code === 'PANEL_HTTP_409',
    );
  });
});

describe('re-entrancy detection', () => {
  test('rejects a nested acquisition of the same key', async () => {
    /**
     * Recursive acquisition can never succeed: the outer hold is released only after its callback
     * returns, and the callback is what is waiting. Without detection this hangs forever with no
     * error and no log line, which is close to impossible to diagnose.
     */
    const manager = createLockManager();

    await assert.rejects(
      () =>
        manager.withLock('key', async () => {
          await manager.withLock('key', async () => 'never reached');
        }),
      (err) => err instanceof AppError && err.code === 'LOCK_REENTRANT',
    );
  });

  test('names the offending key in the error detail', async () => {
    const manager = createLockManager();

    await assert.rejects(
      () =>
        manager.withLock('servers:1', async () => {
          await manager.withLock('servers:1', async () => 'never reached');
        }),
      (err) => err.details.key === 'servers:1',
    );
  });

  test('releases the outer lock after a re-entrancy failure', async () => {
    // The detection must not itself wedge the key it was protecting.
    const manager = createLockManager();

    await assert.rejects(
      () =>
        manager.withLock('key', async () => {
          await manager.withLock('key', async () => 'never reached');
        }),
      (err) => err.code === 'LOCK_REENTRANT',
    );

    assert.equal(await manager.withLock('key', async () => 'recovered'), 'recovered');
    assert.equal(manager.size(), 0);
  });

  test('permits nesting different keys', async () => {
    /**
     * Legitimate and used in practice: adminService holds account:<id> while serverService acquires
     * servers:<id> beneath it.
     */
    const manager = createLockManager();

    const result = await manager.withLock('account:1', async () =>
      manager.withLock('servers:1', async () => 'nested ok'),
    );

    assert.equal(result, 'nested ok');
    assert.equal(manager.size(), 0, 'both keys should be released');
  });

  test('permits reacquiring a key sequentially', async () => {
    // Only concurrent nesting is a deadlock; acquiring the same key one after another is fine.
    const manager = createLockManager();

    assert.equal(await manager.withLock('key', async () => 'first'), 'first');
    assert.equal(await manager.withLock('key', async () => 'second'), 'second');
  });
});

describe('timeout', () => {
  test('gives up waiting after the configured timeout', async () => {
    /**
     * A stuck holder must not wedge a key indefinitely. The waiter fails with a message the user
     * can act on rather than hanging until the interaction token expires.
     */
    const manager = createLockManager({ timeoutMs: 30 });

    const holder = manager.withLock('key', async () => {
      await tick(200);
      return 'holder';
    });

    await assert.rejects(
      () => manager.withLock('key', async () => 'waiter'),
      (err) => err instanceof AppError && err.code === 'LOCK_TIMEOUT',
    );

    assert.equal(await holder, 'holder', 'the holder should still complete');
  });

  test('reports the key and the timeout in the error detail', async () => {
    const manager = createLockManager({ timeoutMs: 20 });

    const holder = manager.withLock('servers:1', async () => tick(150));

    await assert.rejects(
      () => manager.withLock('servers:1', async () => 'waiter'),
      (err) => err.details.key === 'servers:1' && err.details.timeoutMs === 20,
    );

    await holder;
  });

  test('the timeout error carries a user-safe message', async () => {
    // It reaches a Discord embed, so it must explain the situation without internals.
    const manager = createLockManager({ timeoutMs: 20 });
    const holder = manager.withLock('key', async () => tick(150));

    await assert.rejects(
      () => manager.withLock('key', async () => 'waiter'),
      (err) => /taking too long/i.test(err.userMessage) && /try again/i.test(err.userMessage),
    );

    await holder;
  });

  test('an abandoned waiter does not block its successors', async () => {
    /**
     * The timeout path releases its queue slot before throwing. Skipping that would let one
     * timed-out waiter block every later request on the key.
     */
    const manager = createLockManager({ timeoutMs: 25 });

    const holder = manager.withLock('key', async () => {
      await tick(80);
      return 'holder';
    });

    await assert.rejects(() => manager.withLock('key', async () => 'abandoned'), (err) => err.code === 'LOCK_TIMEOUT');

    await holder;

    assert.equal(await manager.withLock('key', async () => 'later'), 'later');
    assert.equal(manager.size(), 0);
  });

  test('a per-call timeout overrides the manager default', async () => {
    const manager = createLockManager({ timeoutMs: 5000 });
    const holder = manager.withLock('key', async () => tick(120));

    await assert.rejects(
      () => manager.withLock('key', async () => 'waiter', { timeoutMs: 20 }),
      (err) => err.code === 'LOCK_TIMEOUT',
    );

    await holder;
  });

  test('a timeout of zero waits indefinitely', async () => {
    // Opt-out for a caller that would rather queue than fail.
    const manager = createLockManager({ timeoutMs: 0 });
    const order = [];

    await Promise.all([
      manager.withLock('key', async () => {
        await tick(40);
        order.push('holder');
      }),
      manager.withLock('key', async () => {
        order.push('waiter');
      }),
    ]);

    assert.deepEqual(order, ['holder', 'waiter']);
  });

  test('the default timeout is bounded', () => {
    /**
     * Well above any legitimate panel operation, but finite. An unbounded default would turn a
     * stuck holder into a permanently unusable key.
     */
    assert.ok(DEFAULT_TIMEOUT_MS > 0);
    assert.ok(DEFAULT_TIMEOUT_MS <= 120_000);
  });
});

describe('bookkeeping and leaks', () => {
  test('the map returns to empty after every lock is released', async () => {
    /**
     * The leak this guards against is subtle: a naive implementation stores a chained promise per
     * key and never deletes it, so a public bot retains one entry per Discord user who has ever
     * run a locked command.
     */
    const manager = createLockManager();

    await Promise.all([
      manager.withLock('user:1', async () => tick(2)),
      manager.withLock('user:2', async () => tick(2)),
      manager.withLock('user:3', async () => tick(2)),
    ]);

    assert.equal(manager.size(), 0, 'no entries should be retained');
    assert.deepEqual(manager.activeKeys(), []);
  });

  test('the map returns to empty after contention on one key', async () => {
    const manager = createLockManager();

    await Promise.all(
      Array.from({ length: 10 }, () => manager.withLock('busy', async () => tick(1))),
    );

    assert.equal(manager.size(), 0);
  });

  test('does not accumulate entries across repeated use', async () => {
    // Simulates sustained traffic from many distinct users.
    const manager = createLockManager();

    for (let index = 0; index < 100; index += 1) {
      await manager.withLock(`user:${index}`, async () => tick(0));
    }

    assert.equal(manager.size(), 0, 'the map must not grow with the number of distinct keys');
  });

  test('the map returns to empty even when callbacks fail', async () => {
    const manager = createLockManager();

    await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        manager.withLock('key', async () => {
          throw new Error('boom');
        }),
      ),
    );

    assert.equal(manager.size(), 0);
  });

  test('reports contention while a lock is held', async () => {
    const manager = createLockManager();
    let observedLocked = false;
    let observedQueue = 0;

    const holder = manager.withLock('key', async () => {
      await tick(30);
    });

    // Let the holder acquire before inspecting.
    await tick(5);

    observedLocked = manager.isLocked('key');
    observedQueue = manager.queueLength('key');

    await holder;

    assert.equal(observedLocked, true);
    assert.ok(observedQueue >= 1);
    assert.equal(manager.isLocked('key'), false, 'released once the holder finishes');
  });

  test('reports zero for a key that was never locked', () => {
    const manager = createLockManager();

    assert.equal(manager.isLocked('never'), false);
    assert.equal(manager.queueLength('never'), 0);
    assert.equal(manager.size(), 0);
  });

  test('lists the currently contended keys', async () => {
    const manager = createLockManager();

    const first = manager.withLock('user:1', async () => tick(30));
    const second = manager.withLock('user:2', async () => tick(30));

    await tick(5);

    assert.deepEqual(manager.activeKeys().sort(), ['user:1', 'user:2']);

    await Promise.all([first, second]);

    assert.deepEqual(manager.activeKeys(), []);
  });

  test('clear drops all bookkeeping', () => {
    // Used by tests between cases; unsafe while work is in flight.
    const manager = createLockManager();

    manager.withLock('key', async () => tick(50));
    manager.clear();

    assert.equal(manager.size(), 0);
  });
});

describe('the queue warning threshold', () => {
  test('is a sane bound', () => {
    /**
     * Exceeding it logs a warning rather than failing, since a long queue is a signal of abuse or
     * a stalled holder rather than an error in itself.
     */
    assert.ok(QUEUE_WARN_THRESHOLD > 1);
    assert.ok(QUEUE_WARN_THRESHOLD <= 32);
  });

  test('a queue past the threshold still completes correctly', async () => {
    const manager = createLockManager();
    const order = [];

    await Promise.all(
      Array.from({ length: QUEUE_WARN_THRESHOLD + 4 }, (_unused, index) =>
        manager.withLock('busy', async () => {
          order.push(index);
          await tick(1);
        }),
      ),
    );

    assert.equal(order.length, QUEUE_WARN_THRESHOLD + 4);
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'order must still be FIFO');
    assert.equal(manager.size(), 0);
  });
});

describe('the shared manager', () => {
  test('is a usable lock manager', async () => {
    /**
     * src/index.js constructs its own and passes it to every service, but the module-level export
     * is the default for a service constructed without one.
     */
    assert.equal(typeof locks.withLock, 'function');
    assert.equal(await locks.withLock('test:shared', async () => 'ok'), 'ok');
    assert.equal(locks.isLocked('test:shared'), false);
  });

  test('serialises on the shared instance', async () => {
    const tracker = concurrencyTracker();

    const work = () =>
      locks.withLock('test:shared:exclusive', async () => {
        tracker.enter();
        await tick(3);
        tracker.exit();
      });

    await Promise.all([work(), work()]);

    assert.equal(tracker.max(), 1);
  });
});
