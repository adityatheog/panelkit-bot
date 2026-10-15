import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createLockManager, DEFAULT_TIMEOUT_MS, locks, QUEUE_WARN_THRESHOLD } from '../src/utils/locks.js';
import { AppError } from '../src/utils/errors.js';

function tick(ms = 0) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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

    const limit = 1;

    async function attempt(useLock) {
      const manager = createLockManager();
      let stored = 0;

      const provision = async () => {
        const body = async () => {
          const owned = stored;

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

    const manager = createLockManager();

    assert.equal(await manager.withLock('key', () => 42), 42);
  });
});

describe('key independence', () => {
  test('different keys do not contend', async () => {

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

    const manager = createLockManager();

    await assert.rejects(
      () =>
        manager.withLock('key', async () => {
          throw new Error('boom');
        }),
      /boom/,
    );

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

    const manager = createLockManager();

    const result = await manager.withLock('account:1', async () =>
      manager.withLock('servers:1', async () => 'nested ok'),
    );

    assert.equal(result, 'nested ok');
    assert.equal(manager.size(), 0, 'both keys should be released');
  });

  test('permits reacquiring a key sequentially', async () => {

    const manager = createLockManager();

    assert.equal(await manager.withLock('key', async () => 'first'), 'first');
    assert.equal(await manager.withLock('key', async () => 'second'), 'second');
  });
});

describe('timeout', () => {
  test('gives up waiting after the configured timeout', async () => {

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

    const manager = createLockManager({ timeoutMs: 20 });
    const holder = manager.withLock('key', async () => tick(150));

    await assert.rejects(
      () => manager.withLock('key', async () => 'waiter'),
      (err) => /taking too long/i.test(err.userMessage) && /try again/i.test(err.userMessage),
    );

    await holder;
  });

  test('an abandoned waiter does not block its successors', async () => {

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

    assert.ok(DEFAULT_TIMEOUT_MS > 0);
    assert.ok(DEFAULT_TIMEOUT_MS <= 120_000);
  });
});

describe('bookkeeping and leaks', () => {
  test('the map returns to empty after every lock is released', async () => {

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

  test('clear refuses to discard active locks', async () => {
    const manager = createLockManager();
    const work = manager.withLock('key', async () => tick(5));
    assert.throws(() => manager.clear(), { code: 'LOCK_ACTIVE' });
    await work;
    manager.clear();
    assert.equal(manager.size(), 0);
  });
});

describe('async lock ownership', () => {
  test('an independent request arriving after acquisition queues instead of reporting recursion', async () => {
    const manager = createLockManager();
    let release;
    let acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const order = [];
    const first = manager.withLock('key', async () => {
      order.push('first');
      acquired();
      await gate;
    });
    await ready;
    const second = manager.withLock('key', () => order.push('second'));
    assert.equal(manager.queueLength('key'), 2);
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ['first', 'second']);
    assert.equal(manager.size(), 0);
  });

  test('nested acquisition after an await rejects without deadlocking', async () => {
    const manager = createLockManager();
    await manager.withLock('key', async () => {
      await tick();
      await assert.rejects(() => manager.withLock('key', () => {}), { code: 'LOCK_REENTRANT' });
    });
    assert.equal(manager.size(), 0);
  });

  test('a detached descendant can acquire after its ancestor releases the lock', async () => {
    const manager = createLockManager();
    let release;
    let detached;
    const gate = new Promise((resolve) => { release = resolve; });
    await manager.withLock('key', () => {
      detached = gate.then(() => manager.withLock('key', () => 42));
    });
    release();
    assert.equal(await detached, 42);
    assert.equal(manager.size(), 0);
  });
});

describe('the queue warning threshold', () => {
  test('is a sane bound', () => {

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
