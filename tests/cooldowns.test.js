// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/core/cooldowns.js.
 *
 * Discord's own rate limits protect Discord's API. They do nothing for the Pterodactyl panel, which
 * is the resource that actually matters here: a user looping `files backup` makes a node compress a
 * filesystem repeatedly, and a user looping `account create` generates panel accounts as fast as the
 * network allows. Neither is throttled by anything upstream of this module.
 *
 * The behaviour these tests exist for is the one that is easy to get backwards:
 *
 *   The cooldown is recorded only when the command is allowed to proceed. Recording on every attempt
 *   would let a user extend their own cooldown indefinitely by hammering the command, turning a
 *   throttle into an escalating penalty that punishes impatience rather than abuse.
 *
 * Everything else follows from the policy being per user and per command: one person spamming
 * `server logs` must not throttle anyone else, and a cheap command must not inherit an expensive
 * command's cooldown.
 *
 * No credentials, no network, no filesystem.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import { createCooldownManager, formatCooldown, MAX_ENTRIES, SWEEP_INTERVAL_MS } from '../src/core/cooldowns.js';
import { loadConfig } from '../src/config/config.js';

const ROOT = path.resolve(import.meta.dirname, '..');

const USER = '111111111111111111';
const OTHER_USER = '222222222222222222';

/**
 * Builds a manager over a synthetic cooldown configuration.
 *
 * @param {{ defaultSeconds?: number, perCommand?: Record<string, number> }} [cooldowns]
 * @returns {ReturnType<typeof createCooldownManager>}
 */
function manager(cooldowns = {}) {
  return createCooldownManager({
    config: { cooldowns: { defaultSeconds: 3, perCommand: {}, ...cooldowns } },
  });
}

/**
 * Waits, for the one test that needs a real cooldown to lapse.
 *
 * Cooldowns are configured in whole seconds, so expiry cannot be exercised faster than this without
 * injecting a clock the module does not accept.
 *
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe('secondsFor', () => {
  test('applies the default when a command has no override', () => {
    const cooldowns = manager({ defaultSeconds: 3 });

    assert.equal(cooldowns.secondsFor('ping'), 3);
    assert.equal(cooldowns.secondsFor('server info'), 3);
  });

  test('applies a per-command override', () => {
    /**
     * Expensive commands carry their own cost. `files backup` makes a node compress a directory tree,
     * so it is throttled far harder than a read.
     */
    const cooldowns = manager({ defaultSeconds: 3, perCommand: { 'files backup': 120, 'account reset': 300 } });

    assert.equal(cooldowns.secondsFor('files backup'), 120);
    assert.equal(cooldowns.secondsFor('account reset'), 300);
    assert.equal(cooldowns.secondsFor('ping'), 3, 'other commands keep the default');
  });

  test('matches the command name case-insensitively', () => {
    // config.json keys are lowercased at validation, and lookups must agree.
    const cooldowns = manager({ perCommand: { 'files backup': 120 } });

    assert.equal(cooldowns.secondsFor('FILES BACKUP'), 120);
    assert.equal(cooldowns.secondsFor('  files backup  '), 120);
  });

  test('treats an override of zero as no cooldown', () => {
    const cooldowns = manager({ defaultSeconds: 3, perCommand: { ping: 0 } });

    assert.equal(cooldowns.secondsFor('ping'), 0);
  });

  test('tolerates a missing name', () => {
    const cooldowns = manager({ defaultSeconds: 3 });

    assert.equal(cooldowns.secondsFor(undefined), 3);
    assert.equal(cooldowns.secondsFor(null), 3);
    assert.equal(cooldowns.secondsFor(''), 3);
  });

  test('tolerates a configuration with no cooldown section', () => {
    // Defensive: config validation supplies defaults, but a partial object must not throw.
    const bare = createCooldownManager({ config: {} });

    assert.equal(typeof bare.secondsFor('ping'), 'number');
    assert.ok(bare.secondsFor('ping') >= 0);
  });
});

describe('check', () => {
  test('allows a first invocation', () => {
    const cooldowns = manager({ defaultSeconds: 30 });
    const result = cooldowns.check(USER, 'ping');

    assert.equal(result.limited, false);
    assert.equal(result.remainingMs, 0);
  });

  test('refuses a second invocation within the window', () => {
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'ping');
    const second = cooldowns.check(USER, 'ping');

    assert.equal(second.limited, true);
    assert.ok(second.remainingMs > 0, 'a remaining duration should be reported');
    assert.ok(second.remainingMs <= 30_000);
  });

  test('does not extend the window when it refuses', () => {
    /**
     * The behaviour this module exists to get right. A user firing a command five times in a second
     * gets one cooldown, not five — the naive implementation writes a fresh expiry on every call and
     * turns a throttle into an escalating penalty.
     */
    const cooldowns = manager({ defaultSeconds: 60 });

    cooldowns.check(USER, 'files backup');
    const first = cooldowns.check(USER, 'files backup');

    for (let index = 0; index < 20; index += 1) {
      cooldowns.check(USER, 'files backup');
    }

    const last = cooldowns.check(USER, 'files backup');

    assert.equal(last.limited, true);
    assert.ok(
      last.remainingMs <= first.remainingMs,
      `repeated attempts must not push the expiry out: first ${first.remainingMs}ms, last ${last.remainingMs}ms`,
    );
  });

  test('allows again once the window lapses', async () => {
    // The only test that waits: cooldowns are configured in whole seconds.
    const cooldowns = manager({ defaultSeconds: 1 });

    assert.equal(cooldowns.check(USER, 'ping').limited, false);
    assert.equal(cooldowns.check(USER, 'ping').limited, true);

    await wait(1100);

    assert.equal(cooldowns.check(USER, 'ping').limited, false, 'the cooldown should have lapsed');
  });

  test('never limits a command whose cooldown is zero', () => {
    const cooldowns = manager({ defaultSeconds: 0 });

    for (let index = 0; index < 10; index += 1) {
      assert.equal(cooldowns.check(USER, 'ping').limited, false);
    }

    assert.equal(cooldowns.size(), 0, 'nothing should be tracked for an unthrottled command');
  });

  test('records nothing for an unthrottled command', () => {
    // Avoids filling the store with entries that could never limit anything.
    const cooldowns = manager({ defaultSeconds: 3, perCommand: { ping: 0 } });

    cooldowns.check(USER, 'ping');

    assert.equal(cooldowns.size(), 0);
  });
});

describe('isolation', () => {
  test('tracks each user separately', () => {
    /**
     * One person spamming a command must not throttle everyone else.
     */
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'server logs');

    assert.equal(cooldowns.check(USER, 'server logs').limited, true);
    assert.equal(cooldowns.check(OTHER_USER, 'server logs').limited, false, 'a different user is unaffected');
  });

  test('tracks each command separately', () => {
    // A cheap command must not inherit an expensive one's cooldown.
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'files backup');

    assert.equal(cooldowns.check(USER, 'files backup').limited, true);
    assert.equal(cooldowns.check(USER, 'ping').limited, false, 'a different command is unaffected');
  });

  test('treats a command name case-insensitively when recording', () => {
    /**
     * Both routers pass the canonical name, but a case mismatch would otherwise create two
     * independent windows for the same command.
     */
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'server logs');

    assert.equal(cooldowns.check(USER, 'SERVER LOGS').limited, true);
  });

  test('does not conflate users whose ids share a prefix', () => {
    // The key is `${userId}:${command}`, so a prefix collision would be a real bug.
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check('11111111111111111', 'ping');

    assert.equal(cooldowns.check('111111111111111111', 'ping').limited, false);
  });
});

describe('the administrator bypass', () => {
  test('skips the check entirely when bypass is set', () => {
    /**
     * An operator diagnosing a problem should not be throttled by an anti-abuse control aimed at
     * users, and admin actions are already audited in the log.
     */
    const cooldowns = manager({ defaultSeconds: 300 });

    for (let index = 0; index < 5; index += 1) {
      assert.equal(cooldowns.check(USER, 'admin suspend', { bypass: true }).limited, false);
    }
  });

  test('records nothing when bypassing', () => {
    // A bypassed call must not leave a window that would limit the operator's next attempt.
    const cooldowns = manager({ defaultSeconds: 300 });

    cooldowns.check(USER, 'admin suspend', { bypass: true });

    assert.equal(cooldowns.size(), 0);
    assert.equal(cooldowns.check(USER, 'admin suspend').limited, false, 'no window should exist');
  });

  test('a bypassed user is still limited on a non-bypassed call', () => {
    // The flag is per invocation, decided by the routers from the admin check.
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'ping');

    assert.equal(cooldowns.check(USER, 'ping', { bypass: true }).limited, false);
    assert.equal(cooldowns.check(USER, 'ping').limited, true, 'the original window still applies');
  });
});

describe('peek', () => {
  test('reports the remaining duration without recording anything', () => {
    /**
     * The help detail view displays a command's cooldown. Reusing check there would silently start
     * one, so a user reading about `files backup` would find themselves throttled by having looked.
     */
    const cooldowns = manager({ defaultSeconds: 30 });

    assert.equal(cooldowns.peek(USER, 'ping'), 0, 'nothing is pending yet');
    assert.equal(cooldowns.size(), 0, 'peeking must not record');

    cooldowns.check(USER, 'ping');

    assert.ok(cooldowns.peek(USER, 'ping') > 0, 'the pending window should be visible');
  });

  test('does not alter an existing window', () => {
    const cooldowns = manager({ defaultSeconds: 60 });

    cooldowns.check(USER, 'ping');
    const before = cooldowns.peek(USER, 'ping');

    for (let index = 0; index < 10; index += 1) {
      cooldowns.peek(USER, 'ping');
    }

    assert.ok(cooldowns.peek(USER, 'ping') <= before, 'peeking must not push the expiry out');
  });

  test('reports zero for an unknown user or command', () => {
    const cooldowns = manager({ defaultSeconds: 30 });

    assert.equal(cooldowns.peek(OTHER_USER, 'ping'), 0);
    assert.equal(cooldowns.peek(USER, 'nonexistent'), 0);
  });

  test('reports zero once the window has lapsed', async () => {
    const cooldowns = manager({ defaultSeconds: 1 });

    cooldowns.check(USER, 'ping');
    assert.ok(cooldowns.peek(USER, 'ping') > 0);

    await wait(1100);

    assert.equal(cooldowns.peek(USER, 'ping'), 0);
  });
});

describe('clear', () => {
  test('clears one command for one user', () => {
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'ping');
    cooldowns.check(USER, 'server logs');

    assert.equal(cooldowns.clear(USER, 'ping'), 1);
    assert.equal(cooldowns.check(USER, 'ping').limited, false, 'the cleared command is available');
    assert.equal(cooldowns.check(USER, 'server logs').limited, true, 'the other command is untouched');
  });

  test('clears every command for one user', () => {
    /**
     * Called when an account is deleted. Without it a user who re-registers inherits a stale
     * `account create` cooldown belonging to an account that no longer exists.
     */
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'account create');
    cooldowns.check(USER, 'server create');
    cooldowns.check(OTHER_USER, 'account create');

    assert.equal(cooldowns.clear(USER), 2);
    assert.equal(cooldowns.check(USER, 'account create').limited, false);
    assert.equal(cooldowns.check(OTHER_USER, 'account create').limited, true, 'the other user is untouched');
  });

  test('reports zero when nothing was cleared', () => {
    const cooldowns = manager({ defaultSeconds: 30 });

    assert.equal(cooldowns.clear(USER), 0);
    assert.equal(cooldowns.clear(USER, 'ping'), 0);
  });

  test('does not clear a different user whose id shares a prefix', () => {
    /**
     * The bulk clear matches on a `${userId}:` prefix, so a shorter id must not sweep away a longer
     * one that happens to start with the same digits.
     */
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check('11111111111111111', 'ping');
    cooldowns.check('111111111111111111', 'ping');

    cooldowns.clear('11111111111111111');

    assert.equal(cooldowns.check('111111111111111111', 'ping').limited, true, 'the longer id must survive');
  });
});

describe('sweep', () => {
  test('removes expired entries and keeps live ones', () => {
    /**
     * Expiry is enforced on read, so the sweeper only reclaims memory for windows nobody returns to.
     */
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'ping');

    assert.equal(cooldowns.sweep(Date.now()), 0, 'nothing has expired yet');
    assert.equal(cooldowns.size(), 1);

    assert.equal(cooldowns.sweep(Date.now() + 60_000), 1, 'the window has lapsed at the later clock');
    assert.equal(cooldowns.size(), 0);
  });

  test('handles an empty store', () => {
    assert.equal(manager().sweep(), 0);
  });

  test('sweeps several users at once', () => {
    const cooldowns = manager({ defaultSeconds: 5 });

    for (let index = 0; index < 10; index += 1) {
      cooldowns.check(`1111111111111111${index}1`, 'ping');
    }

    assert.equal(cooldowns.size(), 10);
    assert.equal(cooldowns.sweep(Date.now() + 10_000), 10);
    assert.equal(cooldowns.size(), 0);
  });
});

describe('startSweeper', () => {
  test('returns a timer that does not hold the process open', () => {
    /**
     * The timer is unref'd so shutdown proceeds immediately rather than waiting out the next sweep
     * interval. A regression here would make the bot take up to a minute to stop.
     */
    const cooldowns = manager();
    const timer = cooldowns.startSweeper(60_000);

    assert.ok(timer, 'a timer handle should be returned');
    assert.equal(typeof timer.unref, 'function');

    clearInterval(timer);
  });

  test('sweeps on its interval', async () => {
    const cooldowns = manager({ defaultSeconds: 1 });

    cooldowns.check(USER, 'ping');
    assert.equal(cooldowns.size(), 1);

    const timer = cooldowns.startSweeper(20);

    await wait(1200);
    clearInterval(timer);

    assert.equal(cooldowns.size(), 0, 'the lapsed entry should have been reclaimed');
  });

  test('the default interval is sane', () => {
    // Frequent enough to reclaim memory, infrequent enough not to matter.
    assert.ok(SWEEP_INTERVAL_MS > 0);
    assert.ok(SWEEP_INTERVAL_MS <= 300_000);
  });
});

describe('bounded growth', () => {
  test('the entry cap is a real bound', () => {
    /**
     * A public bot cannot let an unbounded map grow from command spam. Filling the store to the cap
     * would be slow, so the constant is asserted rather than exercised — the eviction path itself is
     * reachable only past it.
     */
    assert.ok(MAX_ENTRIES > 0);
    assert.ok(MAX_ENTRIES <= 100_000, 'the cap must bound memory');
  });

  test('does not accumulate entries once they lapse', () => {
    // Sustained traffic from many distinct users, with the sweeper reclaiming behind it.
    const cooldowns = manager({ defaultSeconds: 5 });

    for (let index = 0; index < 500; index += 1) {
      cooldowns.check(`1111111111111111${String(index).padStart(2, '0')}`, 'ping');
    }

    assert.equal(cooldowns.size(), 500);

    cooldowns.sweep(Date.now() + 10_000);

    assert.equal(cooldowns.size(), 0, 'the store must return to empty');
  });

  test('clearAll empties the store and reports how many were removed', () => {
    const cooldowns = manager({ defaultSeconds: 30 });

    cooldowns.check(USER, 'ping');
    cooldowns.check(OTHER_USER, 'ping');

    assert.equal(cooldowns.clearAll(), 2);
    assert.equal(cooldowns.size(), 0);
  });
});

describe('formatCooldown', () => {
  test('renders a remaining duration for a user-facing message', () => {
    assert.equal(formatCooldown(1000), '1 second');
    assert.equal(formatCooldown(45_000), '45 seconds');
    assert.equal(formatCooldown(60_000), '1 minute');
    assert.equal(formatCooldown(120_000), '2 minutes');
  });

  test('rounds up, so a user is never told to wait less than they must', () => {
    /**
     * Rounding down would report "0 seconds" for a 400ms remainder and invite an immediate retry that
     * is still refused.
     */
    assert.equal(formatCooldown(400), '1 second');
    assert.equal(formatCooldown(1400), '2 seconds');
  });

  test('tolerates a zero or missing duration', () => {
    assert.equal(formatCooldown(0), '0 seconds');
    assert.equal(formatCooldown(-1), '0 seconds');
    assert.equal(formatCooldown(null), '0 seconds');
  });
});

describe('the shipped cooldown configuration', () => {
  test('throttles the expensive commands harder than the default', () => {
    /**
     * Cross-checks config.json against the reasoning in the module. Each of these makes the panel do
     * real work: compressing a filesystem, creating an account, provisioning a server.
     */
    const config = loadConfig(path.join(ROOT, 'config.json'));
    const cooldowns = createCooldownManager({ config });

    const expensive = ['files backup', 'account create', 'account reset', 'server create'];

    for (const command of expensive) {
      assert.ok(
        cooldowns.secondsFor(command) > config.cooldowns.defaultSeconds,
        `${command} should carry more than the default cooldown`,
      );
    }
  });

  test('keeps the default low enough not to impede ordinary use', () => {
    const config = loadConfig(path.join(ROOT, 'config.json'));

    assert.ok(config.cooldowns.defaultSeconds > 0, 'some throttle should apply by default');
    assert.ok(config.cooldowns.defaultSeconds <= 10, 'reads should not feel throttled');
  });

  test('every configured command name is one the registry knows', async () => {
    /**
     * A typo in a cooldown key would silently apply the default instead, so the expensive command it
     * was meant to protect would be unthrottled.
     */
    const config = loadConfig(path.join(ROOT, 'config.json'));
    const { loadRegistry } = await import('../src/commands/registry.js');
    const registry = await loadRegistry(path.join(ROOT, 'src'));

    for (const name of Object.keys(config.cooldowns.perCommand)) {
      assert.ok(registry.get(name), `cooldowns.perCommand["${name}"] does not match any command`);
    }
  });
});
