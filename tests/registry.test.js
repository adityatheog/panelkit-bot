// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/commands/registry.js.
 *
 * The registry is the project's single source of truth for the command tree: one declaration
 * per command produces the prefix invocation, the nested slash invocation and the help entry.
 * These tests assert that the tree matches the documented specification and that both
 * surfaces are genuinely wired, rather than that the code runs without throwing.
 *
 * Three properties get the most attention:
 *
 *   The tree is exactly 24 visible commands in 5 categories, with the documented names and
 *   ordering. The expected tree is written out by hand rather than derived from the registry —
 *   deriving it would make the assertion vacuous.
 *
 *   Every command is reachable on both surfaces. Slash reachability is proven by walking the
 *   built JSON payload, not by inspecting the definitions, because the interesting bug is a
 *   three-word name that silently fails to become a subcommand group.
 *
 *   Structural conflicts are rejected at load time. Discord's bulk registration is
 *   all-or-nothing and reports only an array index, so every constraint it enforces is checked
 *   here where the offending command can be named.
 *
 * No credentials, no network. The real definitions are loaded from disk.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  auditRegistry,
  buildSlashBody,
  createRegistry,
  DISCORD_LIMITS,
  loadRegistry,
  OPTION_TYPES,
  slashLeaves,
} from '../src/commands/registry.js';
import { ConfigError } from '../src/utils/errors.js';

/** The src directory, which is what loadRegistry expects. */
const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');

/**
 * The documented command tree.
 *
 * Deliberately duplicated from the specification rather than read from the registry. The point
 * of the assertion is to compare the implementation against an independent statement of intent,
 * so a command silently renamed or dropped fails here.
 */
const EXPECTED_TREE = Object.freeze({
  Account: ['account create', 'account delete', 'account info', 'account reset'],
  Admin: ['create', 'admin servers', 'admin suspend', 'admin unsuspend', 'admin user'],
  Files: ['files backup'],
  General: ['ping', 'plans', 'help'],
  Server: [
    'server create',
    'server delete',
    'server info',
    'server list',
    'server logs',
    'server manage',
    'server power',
    'server rename',
    'server subuser add',
    'server subuser remove',
    'server usage',
  ],
});

const EXPECTED_COMMAND_COUNT = 24;
const EXPECTED_CATEGORY_COUNT = 5;

/**
 * Builds a minimal valid command definition.
 *
 * @param {string} name
 * @param {object} [overrides]
 * @returns {object}
 */
function stub(name, overrides = {}) {
  return {
    name,
    category: 'General',
    description: `Description for ${name}`,
    execute() {},
    ...overrides,
  };
}

/** Loaded once: reading and importing every definition is the slowest part of this suite. */
const registry = await loadRegistry(SRC_DIR);

describe('the loaded command tree', () => {
  test('contains exactly the documented number of visible commands', () => {
    assert.equal(registry.counts.commands, EXPECTED_COMMAND_COUNT);
  });

  test('contains exactly the documented categories', () => {
    assert.equal(registry.counts.categories, EXPECTED_CATEGORY_COUNT);
    assert.deepEqual(
      registry.categories.map((category) => category.name),
      Object.keys(EXPECTED_TREE).sort(),
    );
  });

  test('each category contains the documented commands in the documented order', () => {
    /**
     * Ordering is asserted, not just membership. The documented layout is not alphabetical in
     * Admin, where `create` leads, or in General, where the order is ping, plans, help — and
     * those are expressed through the `order` field, which a refactor could easily drop.
     */
    for (const [category, expected] of Object.entries(EXPECTED_TREE)) {
      const actual = registry.category(category).commands.map((command) => command.name);

      assert.deepEqual(actual, expected, `category ${category} does not match`);
    }
  });

  test('every command carries the metadata the help menu needs', () => {
    for (const command of registry.all) {
      assert.ok(command.description, `${command.name} is missing a description`);
      assert.ok(
        command.description.length <= DISCORD_LIMITS.description,
        `${command.name} has a description longer than Discord allows`,
      );
      assert.ok(command.category, `${command.name} is missing a category`);
      assert.equal(typeof command.execute, 'function', `${command.name} has no execute function`);
    }
  });

  test('admin commands are marked adminOnly and nothing else is', () => {
    /**
     * The routers gate on this flag, so a mislabelled command is either an unguarded privileged
     * operation or a user command nobody can run.
     */
    const adminOnly = registry.all.filter((command) => command.adminOnly).map((command) => command.name);

    assert.deepEqual(adminOnly.sort(), [...EXPECTED_TREE.Admin].sort());
  });

  test('only ping, plans and help are usable in direct messages', () => {
    /**
     * Everything else touches a panel account, which is meaningless without a guild context for
     * permission checks.
     */
    const dmCapable = registry.all
      .filter((command) => command.guildOnly === false)
      .map((command) => command.name)
      .sort();

    assert.deepEqual(dmCapable, ['help', 'ping', 'plans']);
  });

  test('every option declares a supported type and a description', () => {
    for (const command of registry.all) {
      for (const option of command.options ?? []) {
        assert.ok(OPTION_TYPES.includes(option.type ?? 'string'), `${command.name}.${option.name} has an unsupported type`);
        assert.ok(option.description, `${command.name}.${option.name} is missing a description`);
        assert.ok(
          option.description.length <= DISCORD_LIMITS.description,
          `${command.name}.${option.name} has an over-long description`,
        );
      }
    }
  });

  test('required options precede optional ones', () => {
    /**
     * Discord rejects the reverse outright, and on the prefix surface a required option after an
     * optional one cannot be resolved positionally.
     */
    for (const command of registry.all) {
      let seenOptional = false;

      for (const option of command.options ?? []) {
        if (option.required) {
          assert.ok(!seenOptional, `${command.name} declares a required option after an optional one`);
        } else {
          seenOptional = true;
        }
      }
    }
  });

  test('a greedy option is always declared last', () => {
    // A greedy option consumes the remaining input, so anything after it could never be filled.
    for (const command of registry.all) {
      const options = command.options ?? [];
      const greedyIndex = options.findIndex((option) => option.greedy === true);

      if (greedyIndex !== -1) {
        assert.equal(greedyIndex, options.length - 1, `${command.name} has a greedy option that is not last`);
      }
    }
  });
});

describe('prefix resolution', () => {
  test('resolves the longest matching name first', () => {
    /**
     * Three tokens are tried, then two, then one. Without longest-match, `server subuser add`
     * would resolve to a hypothetical `server` command with the rest treated as arguments.
     */
    const three = registry.resolvePrefix(['server', 'subuser', 'add', 'a1b2c3d4', 'friend@example.com']);

    assert.equal(three.command.name, 'server subuser add');
    assert.deepEqual(three.rest, ['a1b2c3d4', 'friend@example.com']);

    const two = registry.resolvePrefix(['server', 'power', 'a1b2c3d4', 'restart']);

    assert.equal(two.command.name, 'server power');
    assert.deepEqual(two.rest, ['a1b2c3d4', 'restart']);

    const one = registry.resolvePrefix(['ping']);

    assert.equal(one.command.name, 'ping');
    assert.deepEqual(one.rest, []);
  });

  test('resolves every documented command', () => {
    for (const command of registry.all) {
      const resolved = registry.resolvePrefix(command.name.split(' '));

      assert.ok(resolved, `${command.name} is not reachable as a prefix command`);
      assert.equal(resolved.command.name, command.name);
      assert.deepEqual(resolved.rest, []);
    }
  });

  test('matches case-insensitively', () => {
    assert.equal(registry.resolvePrefix(['SERVER', 'POWER']).command.name, 'server power');
    assert.equal(registry.resolvePrefix(['Ping']).command.name, 'ping');
  });

  test('accepts a raw string as well as a token array', () => {
    assert.equal(registry.resolvePrefix('server power a1b2c3d4').command.name, 'server power');
    assert.equal(registry.resolvePrefix('  ping  ').command.name, 'ping');
  });

  test('resolves declared aliases', () => {
    // Each is a real alias from a definition file; a rename would break these.
    assert.equal(registry.resolvePrefix(['servers']).command.name, 'server list');
    assert.equal(registry.resolvePrefix(['commands']).command.name, 'help');
    assert.equal(registry.resolvePrefix(['backup']).command.name, 'files backup');
    assert.equal(registry.resolvePrefix(['register']).command.name, 'account create');
  });

  test('returns null for an unknown invocation', () => {
    /**
     * The message router relies on null to stay silent. Answering every near-miss would make the
     * bot unbearable in a busy channel, since `kx!` is short enough to appear by accident.
     */
    assert.equal(registry.resolvePrefix(['nonexistent']), null);
    assert.equal(registry.resolvePrefix([]), null);
    assert.equal(registry.resolvePrefix(''), null);
    assert.equal(registry.resolvePrefix(['server', 'nonexistent']), null);
  });
});

describe('lookup by name', () => {
  test('get finds a command by canonical name or alias', () => {
    assert.equal(registry.get('server power').name, 'server power');
    assert.equal(registry.get('SERVER POWER').name, 'server power');
    assert.equal(registry.get('  ping  ').name, 'ping');
    assert.equal(registry.get('servers').name, 'server list');
  });

  test('get returns null rather than throwing for an unknown name', () => {
    assert.equal(registry.get('nonexistent'), null);
    assert.equal(registry.get(''), null);
    assert.equal(registry.get(null), null);
    assert.equal(registry.get(undefined), null);
  });

  test('getVisible hides commands excluded from help', () => {
    /**
     * The help menu resolves select-menu values through getVisible, so a hidden command cannot be
     * surfaced by a crafted value. Every documented command must still be visible.
     */
    for (const command of registry.all) {
      assert.ok(registry.getVisible(command.name), `${command.name} should be visible`);
    }

    const hidden = registry.every.filter((command) => command.hidden === true);

    for (const command of hidden) {
      assert.ok(registry.get(command.name), `${command.name} should still resolve`);
      assert.equal(registry.getVisible(command.name), null, `${command.name} must not be visible`);
    }
  });

  test('category returns null for an unknown category', () => {
    assert.equal(registry.category('Nonexistent'), null);
    assert.equal(registry.category(''), null);
    assert.equal(registry.category(null), null);
  });
});

describe('the slash payload', () => {
  const body = registry.slashBody();

  test('every command appears as an invocable path', () => {
    /**
     * Reachability is proven by walking the built payload rather than the definitions. A
     * three-word name that failed to become a subcommand group would pass a definition-based
     * check and vanish from Discord.
     */
    const leaves = slashLeaves(body);

    for (const command of registry.all) {
      if (command.slash === false) continue;

      assert.ok(leaves.has(command.name), `${command.name} is not reachable as a slash command`);
    }
  });

  test('produces the expected top-level roots', () => {
    // Six roots covering 24 paths: account, admin, create, files, ping, plans, help, server.
    const roots = body.map((command) => command.name).sort();

    assert.deepEqual(roots, ['account', 'admin', 'create', 'files', 'help', 'ping', 'plans', 'server']);
  });

  test('nests three-word names as a group containing subcommands', () => {
    /**
     * Discord has no flat form for `server subuser add`; it must be command → group →
     * subcommand. This asserts the structure rather than only the resulting path.
     */
    const server = body.find((command) => command.name === 'server');
    const subuser = server.options.find((option) => option.name === 'subuser');

    assert.ok(subuser, 'the subuser group should exist');
    assert.equal(subuser.type, 2, 'subuser must be a SubcommandGroup');

    const leaves = subuser.options.map((option) => option.name).sort();

    assert.deepEqual(leaves, ['add', 'remove']);

    for (const leaf of subuser.options) {
      assert.equal(leaf.type, 1, `${leaf.name} must be a Subcommand`);
    }
  });

  test('emits both direct subcommands and groups under the same root', () => {
    /**
     * The `server` root carries nine direct subcommands and one group. This is the case the
     * two-pass build exists for: a single-pass implementation would add the group before both of
     * its leaves were known and silently drop the second.
     */
    const server = body.find((command) => command.name === 'server');

    const subcommands = server.options.filter((option) => option.type === 1);
    const groups = server.options.filter((option) => option.type === 2);

    assert.equal(subcommands.length, 9, 'nine direct subcommands');
    assert.equal(groups.length, 1, 'one subcommand group');
  });

  test('nests no deeper than Discord permits', () => {
    for (const command of body) {
      for (const option of command.options ?? []) {
        if (option.type !== 2) continue;

        for (const leaf of option.options ?? []) {
          assert.equal(leaf.type, 1, `${command.name} ${option.name} ${leaf.name} nests too deeply`);
        }
      }
    }
  });

  test('satisfies Discord naming and description constraints', () => {
    /**
     * Checked here because a bulk PUT is all-or-nothing: a single over-long description rejects
     * all 24 commands with an error naming only an array index.
     */
    const check = (node, label) => {
      assert.match(node.name, /^[a-z0-9-]{1,32}$/, `${label} has an invalid name`);
      assert.ok(node.description, `${label} is missing a description`);
      assert.ok(
        node.description.length <= DISCORD_LIMITS.description,
        `${label} has a description of ${node.description.length} characters`,
      );
    };

    for (const command of body) {
      check(command, command.name);

      for (const option of command.options ?? []) {
        check(option, `${command.name} ${option.name}`);

        for (const leaf of option.options ?? []) {
          check(leaf, `${command.name} ${option.name} ${leaf.name}`);
        }
      }
    }
  });

  test('stays within the option and command count limits', () => {
    assert.ok(body.length <= DISCORD_LIMITS.commandsGlobal, `${body.length} top-level commands`);

    for (const command of body) {
      assert.ok(
        (command.options ?? []).length <= DISCORD_LIMITS.optionsPerCommand,
        `${command.name} declares too many options`,
      );
    }
  });

  test('marks guild-only roots as unavailable in direct messages', () => {
    /**
     * discord.js exposes this as either contexts or dm_permission depending on the minor version,
     * so both spellings are accepted. The routers enforce guildOnly at runtime regardless, which
     * is why a missing flag is not fatal.
     */
    const account = body.find((command) => command.name === 'account');
    const restricted =
      account.contexts !== undefined ? !account.contexts.includes(1) : account.dm_permission === false;

    assert.ok(restricted, 'the account root should be restricted to guilds');
  });

  test('carries the power action choices from the shared signal list', () => {
    /**
     * server power derives its choices from POWER_SIGNALS in validation.js. Hardcoding them would
     * let the registered command accept a value the validator rejects.
     */
    const server = body.find((command) => command.name === 'server');
    const power = server.options.find((option) => option.name === 'power');
    const action = power.options.find((option) => option.name === 'action');

    assert.deepEqual(
      action.choices.map((choice) => choice.value).sort(),
      ['kill', 'restart', 'start', 'stop'],
    );
  });

  test('orders required options before optional ones in the payload', () => {
    // applyOptions sorts them, because Discord rejects the reverse.
    const server = body.find((command) => command.name === 'server');
    const create = server.options.find((option) => option.name === 'create');

    let seenOptional = false;

    for (const option of create.options ?? []) {
      if (option.required) assert.ok(!seenOptional, 'a required option follows an optional one');
      else seenOptional = true;
    }
  });
});

describe('createRegistry validation', () => {
  test('rejects a duplicate command name', () => {
    assert.throws(() => createRegistry([stub('ping'), stub('ping')]), ConfigError);
  });

  test('rejects an alias that collides with a command name', () => {
    /**
     * Aliases are registered after every canonical name, so a collision is caught regardless of
     * file load order — otherwise an alias could shadow a real command depending on which file
     * happened to be read first.
     */
    assert.throws(
      () => createRegistry([stub('ping'), stub('plans', { aliases: ['ping'] })]),
      ConfigError,
    );

    assert.throws(
      () => createRegistry([stub('plans', { aliases: ['ping'] }), stub('ping')]),
      ConfigError,
      'order must not affect detection',
    );
  });

  test('rejects two commands sharing an alias', () => {
    assert.throws(
      () => createRegistry([stub('ping', { aliases: ['p'] }), stub('plans', { aliases: ['p'] })]),
      ConfigError,
    );
  });

  test('excludes hidden commands from the counts', () => {
    const built = createRegistry([stub('ping'), stub('plans'), stub('legacy', { hidden: true })]);

    assert.equal(built.counts.commands, 2);
    assert.equal(built.all.length, 2);
    assert.equal(built.every.length, 3);
    assert.ok(built.get('legacy'), 'a hidden command should still resolve');
    assert.equal(built.getVisible('legacy'), null);
  });

  test('sorts by explicit order, then alphabetically', () => {
    const built = createRegistry([
      stub('zebra'),
      stub('alpha'),
      stub('first', { order: 0 }),
      stub('second', { order: 1 }),
    ]);

    assert.deepEqual(
      built.all.map((command) => command.name),
      ['first', 'second', 'alpha', 'zebra'],
    );
  });
});

describe('buildSlashBody validation', () => {
  test('rejects a name that is both a command and a parent', () => {
    /**
     * Discord cannot represent `/server` as an executable command while `/server power` also
     * exists. Detected in both declaration orders.
     */
    assert.throws(() => buildSlashBody([stub('server'), stub('server power')]), ConfigError);
    assert.throws(() => buildSlashBody([stub('server power'), stub('server')]), ConfigError);
  });

  test('rejects a name that is both a subcommand and a group', () => {
    // `server subuser` cannot be an executable subcommand and a group at once.
    assert.throws(
      () => buildSlashBody([stub('server subuser'), stub('server subuser add')]),
      ConfigError,
    );
    assert.throws(
      () => buildSlashBody([stub('server subuser add'), stub('server subuser')]),
      ConfigError,
    );
  });

  test('rejects duplicate subcommands and duplicate leaves', () => {
    assert.throws(
      () => buildSlashBody([stub('server power'), stub('server power')]),
      ConfigError,
    );
    assert.throws(
      () => buildSlashBody([stub('server subuser add'), stub('server subuser add')]),
      ConfigError,
    );
  });

  test('omits a command that opts out of the slash surface', () => {
    const body = buildSlashBody([stub('ping'), stub('legacy-thing', { slash: false })]);

    assert.deepEqual(
      body.map((command) => command.name),
      ['ping'],
    );
  });

  test('builds a standalone root with its options', () => {
    const body = buildSlashBody([
      stub('create', {
        options: [{ name: 'user', type: 'user', description: 'Target user', required: true }],
      }),
    ]);

    assert.equal(body.length, 1);
    assert.equal(body[0].name, 'create');
    assert.equal(body[0].options.length, 1);
    assert.equal(body[0].options[0].name, 'user');
  });
});

describe('slashLeaves', () => {
  test('enumerates standalone commands, subcommands and group leaves', () => {
    const body = buildSlashBody([
      stub('ping'),
      stub('server power'),
      stub('server subuser add'),
      stub('server subuser remove'),
    ]);

    assert.deepEqual(
      [...slashLeaves(body)].sort(),
      ['ping', 'server power', 'server subuser add', 'server subuser remove'],
    );
  });

  test('returns an empty set for an empty payload', () => {
    assert.equal(slashLeaves([]).size, 0);
  });
});

describe('auditRegistry', () => {
  test('passes for the real tree', () => {
    /**
     * The same assertion scripts/verify-project.js makes, run here so a broken tree fails the test
     * suite as well as the audit.
     */
    const audit = auditRegistry(registry, {
      expectedCommands: EXPECTED_COMMAND_COUNT,
      expectedCategories: EXPECTED_CATEGORY_COUNT,
    });

    assert.equal(audit.ok, true, `audit reported: ${audit.problems.join('; ')}`);
    assert.deepEqual(audit.problems, []);
  });

  test('reports a mismatched command count without throwing', () => {
    // The audit collects findings so one run surfaces every problem.
    const audit = auditRegistry(registry, { expectedCommands: 99, expectedCategories: 5 });

    assert.equal(audit.ok, false);
    assert.ok(audit.problems.some((problem) => problem.includes('99')));
  });

  test('reports a command that is unreachable on the slash surface', () => {
    const built = createRegistry([stub('ping'), stub('server'), stub('server power')]);
    const audit = auditRegistry(built, { expectedCommands: 3, expectedCategories: 1 });

    assert.equal(audit.ok, false);
    assert.ok(
      audit.problems.some((problem) => problem.includes('payload could not be built')),
      `unexpected problems: ${audit.problems.join('; ')}`,
    );
  });
});

describe('loadRegistry', () => {
  test('throws when the definitions directory is empty or absent', async () => {
    /**
     * A silent empty registry would start a bot with no commands, which presents as the bot
     * ignoring everything.
     */
    await assert.rejects(() => loadRegistry(path.join(SRC_DIR, 'nonexistent')), ConfigError);
  });

  test('loads deterministically', async () => {
    // Files are sorted, so the payload order is stable and diffable across runs.
    const first = await loadRegistry(SRC_DIR);
    const second = await loadRegistry(SRC_DIR);

    assert.deepEqual(
      first.all.map((command) => command.name),
      second.all.map((command) => command.name),
    );
    assert.deepEqual(first.slashBody(), second.slashBody());
  });
});
