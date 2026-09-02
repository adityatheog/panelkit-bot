// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/core/context.js.
 *
 * The context is what makes one execute() serve both invocation surfaces. Its correctness has
 * two halves, and both are tested here.
 *
 * Argument parsing is the security-relevant half. Slash options arrive already typed by
 * Discord, but they are revalidated against the same rules the prefix surface uses — because
 * Discord's client-side constraints are a convenience, not a boundary. A stale registered
 * command, or a crafted request, can deliver values that violate them. These tests assert that
 * both paths reject the same input and produce the same error text, so a user cannot pick a
 * surface to bypass a check.
 *
 * Response handling is the awkward half. An interaction token expires three seconds after
 * arrival unless acknowledged, and every later edit must use editReply rather than reply. A
 * message has no such deadline. The tests use recording doubles to assert which Discord method
 * was called in which state, since that ordering is the difference between a reply appearing
 * and an interaction failing with 10062.
 *
 * No credentials, no network. Discord objects are replaced with minimal recording doubles.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { MessageFlags } from 'discord.js';

import {
  coerceArgument,
  createPrefixContext,
  createSlashContext,
  MAX_CONTENT_LENGTH,
  parsePrefixArgs,
  parseSlashArgs,
} from '../src/core/context.js';
import { ValidationError } from '../src/utils/errors.js';

/** A command declaring two required string options, one of them a choice. */
const POWER_COMMAND = Object.freeze({
  name: 'server power',
  options: [
    { name: 'server', type: 'string', description: 'The server identifier', required: true, minLength: 8, maxLength: 8 },
    {
      name: 'action',
      type: 'string',
      description: 'The power action',
      required: true,
      choices: [{ value: 'start' }, { value: 'stop' }, { value: 'restart' }, { value: 'kill' }],
    },
  ],
});

/** A command whose last option is greedy, so a multi-word value needs no quoting. */
const RENAME_COMMAND = Object.freeze({
  name: 'server rename',
  options: [
    { name: 'server', type: 'string', description: 'The server identifier', required: true },
    { name: 'name', type: 'string', description: 'The new name', required: true, greedy: true, maxLength: 32 },
  ],
});

/** A command with one optional option. */
const MANAGE_COMMAND = Object.freeze({
  name: 'server manage',
  options: [{ name: 'server', type: 'string', description: 'The server identifier', required: false }],
});

/** A command with an integer option and a default. */
const SERVERS_COMMAND = Object.freeze({
  name: 'admin servers',
  options: [{ name: 'page', type: 'integer', description: 'Page number', required: false, min: 1, max: 1000, default: 1 }],
});

/** A command with a user option. */
const SUSPEND_COMMAND = Object.freeze({
  name: 'admin suspend',
  options: [{ name: 'user', type: 'user', description: 'The target user', required: true }],
});

/** A command with no options. */
const PING_COMMAND = Object.freeze({ name: 'ping', options: [] });

/** Stand-ins for the wiring the context spreads in. */
const REGISTRY = Object.freeze({ counts: { commands: 24, categories: 5 } });
const ENV = Object.freeze({ prefix: 'kx!', freeServerLimit: 1 });
const CONFIG = Object.freeze({ identity: { name: 'PanelKit' } });
const SERVICES = Object.freeze({
  db: { marker: 'db' },
  accountService: { marker: 'account' },
  serverService: { marker: 'server' },
  adminService: { marker: 'admin' },
});

/**
 * Builds a recording double for a Discord Message.
 *
 * Records every call so the tests can assert which API was used rather than only what was
 * produced, since the distinction between reply and edit is the behaviour under test.
 *
 * @param {{ inGuild?: boolean, replyFails?: boolean, typingFails?: boolean }} [options]
 * @returns {object}
 */
function fakeMessage({ inGuild = true, replyFails = false, typingFails = false } = {}) {
  const calls = [];

  const sent = {
    id: 'sent-message-id',
    createdTimestamp: 1_700_000_001_000,
    async edit(payload) {
      calls.push(['edit', payload]);
      return sent;
    },
  };

  return {
    calls,
    sent,

    id: 'invoking-message-id',
    content: 'kx!server power a1b2c3d4 start',
    createdTimestamp: 1_700_000_000_000,
    system: false,

    author: { id: '111111111111111111', bot: false, createdTimestamp: 1_600_000_000_000, async send(payload) {
      calls.push(['dm', payload]);
      return { id: 'dm-message-id' };
    } },

    member: inGuild ? { id: '111111111111111111', roles: { cache: new Map() } } : null,
    guild: inGuild ? { id: '222222222222222222' } : null,
    guildId: inGuild ? '222222222222222222' : null,
    channelId: '333333333333333333',

    channel: {
      id: '333333333333333333',
      async send(payload) {
        calls.push(['channelSend', payload]);
        return { id: 'followup-message-id' };
      },
      async sendTyping() {
        calls.push(['sendTyping']);
        if (typingFails) throw new Error('missing permissions');
      },
    },

    client: { ws: { ping: 42 } },

    inGuild: () => inGuild,

    async reply(payload) {
      calls.push(['reply', payload]);
      if (replyFails) {
        const err = new Error('Missing Permissions');
        err.code = 50013;
        throw err;
      }
      return sent;
    },
  };
}

/**
 * Builds a recording double for a ChatInputCommandInteraction.
 *
 * `deferred` and `replied` are mutated by the double exactly as discord.js mutates them, so the
 * context's state-dependent branching is exercised for real.
 *
 * @param {{ options?: Record<string, unknown>, inGuild?: boolean, deferFails?: boolean, replyFails?: boolean }} [options]
 * @returns {object}
 */
function fakeInteraction({ options = {}, inGuild = true, deferFails = false, replyFails = false } = {}) {
  const calls = [];

  const interaction = {
    calls,

    id: 'interaction-id',
    commandName: 'server',
    deferred: false,
    replied: false,

    user: { id: '111111111111111111', createdTimestamp: 1_600_000_000_000, async send(payload) {
      calls.push(['dm', payload]);
      return { id: 'dm-message-id' };
    } },

    member: inGuild ? { id: '111111111111111111', roles: { cache: new Map() } } : null,
    guild: inGuild ? { id: '222222222222222222' } : null,
    guildId: inGuild ? '222222222222222222' : null,

    channel: { id: '333333333333333333' },
    client: { ws: { ping: 42 } },

    inGuild: () => inGuild,

    options: {
      getString(name) {
        const value = options[name];
        return value === undefined ? null : String(value);
      },
      getInteger(name) {
        const value = options[name];
        return value === undefined ? null : Number(value);
      },
      getUser(name) {
        const value = options[name];
        return value === undefined ? null : { id: String(value) };
      },
    },

    async deferReply(payload) {
      calls.push(['deferReply', payload]);
      if (deferFails) {
        const err = new Error('Unknown interaction');
        err.code = 10062;
        throw err;
      }
      interaction.deferred = true;
    },

    async reply(payload) {
      calls.push(['reply', payload]);
      if (replyFails) {
        const err = new Error('Unknown interaction');
        err.code = 10062;
        throw err;
      }
      interaction.replied = true;
      // discord.js 14.16 returns an InteractionCallbackResponse when withResponse is set.
      return { resource: { message: { id: 'reply-message-id' } } };
    },

    async editReply(payload) {
      calls.push(['editReply', payload]);
      return { id: 'reply-message-id' };
    },

    async followUp(payload) {
      calls.push(['followUp', payload]);
      return { id: 'followup-message-id' };
    },

    async fetchReply() {
      calls.push(['fetchReply']);
      return { id: 'reply-message-id' };
    },
  };

  return interaction;
}

describe('coerceArgument: absent values', () => {
  test('returns null for an absent optional option', () => {
    const option = { name: 'server', type: 'string', description: 'x', required: false };

    assert.equal(coerceArgument(option, null, 'cmd'), null);
    assert.equal(coerceArgument(option, undefined, 'cmd'), null);
    assert.equal(coerceArgument(option, '', 'cmd'), null);
    assert.equal(coerceArgument(option, '   ', 'cmd'), null, 'whitespace counts as absent');
  });

  test('returns the declared default when one is given', () => {
    const option = { name: 'page', type: 'integer', description: 'x', required: false, default: 1 };

    assert.equal(coerceArgument(option, null, 'cmd'), 1);
  });

  test('throws a usage error for an absent required option', () => {
    /**
     * The message names the command, the option and repeats its description, so a user who typed
     * the command wrong learns what is missing without opening help.
     */
    const option = { name: 'server', type: 'string', description: 'The 8-character server identifier', required: true };

    assert.throws(
      () => coerceArgument(option, null, 'server power'),
      (err) =>
        err instanceof ValidationError &&
        err.message.includes('server power') &&
        err.message.includes('`server`') &&
        err.message.includes('The 8-character server identifier'),
    );
  });
});

describe('coerceArgument: string options', () => {
  test('trims the value', () => {
    const option = { name: 'name', type: 'string', description: 'x', required: true };

    assert.equal(coerceArgument(option, '  My Server  ', 'cmd'), 'My Server');
  });

  test('enforces the declared length bounds', () => {
    /**
     * The same bounds Discord advertises for the slash option. Enforcing them here means a value
     * that bypassed the client is rejected identically.
     */
    const option = { name: 'server', type: 'string', description: 'x', required: true, minLength: 8, maxLength: 8 };

    assert.equal(coerceArgument(option, 'a1b2c3d4', 'cmd'), 'a1b2c3d4');
    assert.throws(() => coerceArgument(option, 'short', 'cmd'), ValidationError);
    assert.throws(() => coerceArgument(option, 'a1b2c3d45', 'cmd'), ValidationError);
  });

  test('names the option in a length error', () => {
    const option = { name: 'name', type: 'string', description: 'x', required: true, maxLength: 32 };

    assert.throws(
      () => coerceArgument(option, 'x'.repeat(40), 'cmd'),
      (err) => err instanceof ValidationError && err.message.includes('`name`') && err.message.includes('32'),
    );
  });

  test('matches a choice case-insensitively and returns the canonical value', () => {
    const option = POWER_COMMAND.options[1];

    assert.equal(coerceArgument(option, 'start', 'cmd'), 'start');
    assert.equal(coerceArgument(option, 'START', 'cmd'), 'start');
    assert.equal(coerceArgument(option, '  Restart  ', 'cmd'), 'restart');
  });

  test('rejects a value outside the choice list and enumerates the options', () => {
    /**
     * Discord constrains choices client-side, so reaching this means a stale registered command
     * or a crafted request. The error lists what is accepted rather than only refusing.
     */
    assert.throws(
      () => coerceArgument(POWER_COMMAND.options[1], 'suspend', 'cmd'),
      (err) => err instanceof ValidationError && err.message.includes('start') && err.message.includes('kill'),
    );
  });
});

describe('coerceArgument: integer options', () => {
  test('accepts integers within bounds, including string forms', () => {
    const option = SERVERS_COMMAND.options[0];

    assert.equal(coerceArgument(option, '5', 'cmd'), 5);
    assert.equal(coerceArgument(option, 5, 'cmd'), 5);
    assert.equal(coerceArgument(option, '  7  ', 'cmd'), 7);
    assert.equal(coerceArgument(option, '1', 'cmd'), 1, 'the lower bound is inclusive');
    assert.equal(coerceArgument(option, '1000', 'cmd'), 1000, 'the upper bound is inclusive');
  });

  test('rejects out-of-range values', () => {
    const option = SERVERS_COMMAND.options[0];

    assert.throws(() => coerceArgument(option, '0', 'cmd'), ValidationError);
    assert.throws(() => coerceArgument(option, '1001', 'cmd'), ValidationError);
    assert.throws(() => coerceArgument(option, '-5', 'cmd'), ValidationError);
  });

  test('rejects non-integer values', () => {
    const option = SERVERS_COMMAND.options[0];

    for (const bad of ['1.5', 'abc', 'Infinity', 'NaN', '1e3', '0x10']) {
      assert.throws(() => coerceArgument(option, bad, 'cmd'), ValidationError, `should reject ${bad}`);
    }
  });
});

describe('coerceArgument: user options', () => {
  test('accepts both mention forms and a bare id', () => {
    /**
     * The prefix surface receives whatever the user typed, which is usually a mention; the slash
     * surface receives a resolved id.
     */
    const option = SUSPEND_COMMAND.options[0];

    assert.equal(coerceArgument(option, '<@111111111111111111>', 'cmd'), '111111111111111111');
    assert.equal(coerceArgument(option, '<@!111111111111111111>', 'cmd'), '111111111111111111');
    assert.equal(coerceArgument(option, '111111111111111111', 'cmd'), '111111111111111111');
  });

  test('rejects role and channel mentions', () => {
    // A role mention is the likely slip, and accepting it would send a role id as a user id.
    const option = SUSPEND_COMMAND.options[0];

    assert.throws(() => coerceArgument(option, '<@&111111111111111111>', 'cmd'), ValidationError);
    assert.throws(() => coerceArgument(option, '<#111111111111111111>', 'cmd'), ValidationError);
    assert.throws(() => coerceArgument(option, '@everyone', 'cmd'), ValidationError);
    assert.throws(() => coerceArgument(option, 'someone', 'cmd'), ValidationError);
  });
});

describe('parsePrefixArgs', () => {
  test('maps positional tokens onto named options', () => {
    assert.deepEqual(parsePrefixArgs(POWER_COMMAND, ['a1b2c3d4', 'start']), {
      server: 'a1b2c3d4',
      action: 'start',
    });
  });

  test('a greedy option absorbs every remaining token', () => {
    /**
     * This is what lets `kx!server rename a1b2c3d4 My New Server` work without quoting, which is
     * the whole reason the greedy flag exists.
     */
    assert.deepEqual(parsePrefixArgs(RENAME_COMMAND, ['a1b2c3d4', 'My', 'New', 'Server']), {
      server: 'a1b2c3d4',
      name: 'My New Server',
    });
  });

  test('a greedy option accepts a single token', () => {
    assert.deepEqual(parsePrefixArgs(RENAME_COMMAND, ['a1b2c3d4', 'Solo']), {
      server: 'a1b2c3d4',
      name: 'Solo',
    });
  });

  test('an absent greedy option is null when optional', () => {
    const command = {
      name: 'help',
      options: [{ name: 'command', type: 'string', description: 'x', required: false, greedy: true }],
    };

    assert.deepEqual(parsePrefixArgs(command, []), { command: null });
  });

  test('extra tokens are ignored when no option consumes them', () => {
    // Trailing noise should not fail a command whose options are all satisfied.
    assert.deepEqual(parsePrefixArgs(POWER_COMMAND, ['a1b2c3d4', 'start', 'extra', 'words']), {
      server: 'a1b2c3d4',
      action: 'start',
    });
  });

  test('throws for a missing required option, naming it', () => {
    assert.throws(
      () => parsePrefixArgs(POWER_COMMAND, ['a1b2c3d4']),
      (err) => err instanceof ValidationError && err.message.includes('`action`'),
    );

    assert.throws(
      () => parsePrefixArgs(POWER_COMMAND, []),
      (err) => err instanceof ValidationError && err.message.includes('`server`'),
    );
  });

  test('returns an empty object for a command with no options', () => {
    assert.deepEqual(parsePrefixArgs(PING_COMMAND, []), {});
    assert.deepEqual(parsePrefixArgs(PING_COMMAND, ['ignored']), {});
  });

  test('applies the default for an absent optional option', () => {
    assert.deepEqual(parsePrefixArgs(SERVERS_COMMAND, []), { page: 1 });
    assert.deepEqual(parsePrefixArgs(SERVERS_COMMAND, ['3']), { page: 3 });
  });

  test('tolerates a missing token list', () => {
    assert.deepEqual(parsePrefixArgs(MANAGE_COMMAND, undefined), { server: null });
    assert.deepEqual(parsePrefixArgs(MANAGE_COMMAND, null), { server: null });
  });
});

describe('parseSlashArgs', () => {
  test('reads options by name and type', () => {
    const interaction = fakeInteraction({ options: { server: 'a1b2c3d4', action: 'start' } });

    assert.deepEqual(parseSlashArgs(POWER_COMMAND, interaction), {
      server: 'a1b2c3d4',
      action: 'start',
    });
  });

  test('reads an integer option as a number', () => {
    const interaction = fakeInteraction({ options: { page: 3 } });

    assert.deepEqual(parseSlashArgs(SERVERS_COMMAND, interaction), { page: 3 });
  });

  test('reads a user option as an id', () => {
    const interaction = fakeInteraction({ options: { user: '111111111111111111' } });

    assert.deepEqual(parseSlashArgs(SUSPEND_COMMAND, interaction), { user: '111111111111111111' });
  });

  test('produces the project's own error for a missing required option', () => {
    /**
     * Every option is fetched as not-required, so an absent value produces this project's message
     * rather than a discord.js exception — which keeps the failure text identical across surfaces.
     */
    const interaction = fakeInteraction({ options: { server: 'a1b2c3d4' } });

    assert.throws(
      () => parseSlashArgs(POWER_COMMAND, interaction),
      (err) => err instanceof ValidationError && err.message.includes('`action`'),
    );
  });

  test('revalidates a value that violates the declared constraints', () => {
    /**
     * The property that matters. Discord advertises minLength 8 for this option, so a value of a
     * different length means the registered command is stale or the request was crafted. Trusting
     * it would send an invalid identifier to the panel.
     */
    const tooShort = fakeInteraction({ options: { server: 'short', action: 'start' } });
    assert.throws(() => parseSlashArgs(POWER_COMMAND, tooShort), ValidationError);

    const badChoice = fakeInteraction({ options: { server: 'a1b2c3d4', action: 'suspend' } });
    assert.throws(() => parseSlashArgs(POWER_COMMAND, badChoice), ValidationError);
  });

  test('applies the default for an absent optional option', () => {
    const interaction = fakeInteraction({ options: {} });

    assert.deepEqual(parseSlashArgs(SERVERS_COMMAND, interaction), { page: 1 });
  });
});

describe('both surfaces agree', () => {
  test('the same input produces the same arguments', () => {
    /**
     * The invariant the dual-surface design rests on: a command cannot observe which surface it
     * was invoked from by inspecting its arguments.
     */
    const fromPrefix = parsePrefixArgs(POWER_COMMAND, ['a1b2c3d4', 'restart']);
    const fromSlash = parseSlashArgs(
      POWER_COMMAND,
      fakeInteraction({ options: { server: 'a1b2c3d4', action: 'restart' } }),
    );

    assert.deepEqual(fromPrefix, fromSlash);
  });

  test('the same invalid input produces the same error message', () => {
    let prefixError;
    let slashError;

    try {
      parsePrefixArgs(POWER_COMMAND, ['a1b2c3d4', 'suspend']);
    } catch (err) {
      prefixError = err;
    }

    try {
      parseSlashArgs(POWER_COMMAND, fakeInteraction({ options: { server: 'a1b2c3d4', action: 'suspend' } }));
    } catch (err) {
      slashError = err;
    }

    assert.ok(prefixError instanceof ValidationError);
    assert.ok(slashError instanceof ValidationError);
    assert.equal(prefixError.message, slashError.message);
  });
});

describe('the prefix context', () => {
  /**
   * @param {object} [messageOptions]
   * @param {object} [command]
   * @param {string[]} [tokens]
   */
  function build(messageOptions = {}, command = POWER_COMMAND, tokens = ['a1b2c3d4', 'start']) {
    const message = fakeMessage(messageOptions);
    const ctx = createPrefixContext({
      message,
      command,
      tokens,
      registry: REGISTRY,
      services: SERVICES,
      env: ENV,
      config: CONFIG,
    });

    return { message, ctx };
  }

  test('exposes the surface, the command and the parsed arguments', () => {
    const { ctx } = build();

    assert.equal(ctx.surface, 'prefix');
    assert.equal(ctx.command, POWER_COMMAND);
    assert.deepEqual(ctx.args, { server: 'a1b2c3d4', action: 'start' });
  });

  test('exposes the invoking user and guild context', () => {
    const { message, ctx } = build();

    assert.equal(ctx.user, message.author);
    assert.equal(ctx.member, message.member);
    assert.equal(ctx.guild, message.guild);
    assert.equal(ctx.guildId, '222222222222222222');
    assert.equal(ctx.channel, message.channel);
    assert.equal(ctx.client, message.client);
    assert.equal(ctx.message, message);
    assert.equal(ctx.interaction, null, 'the prefix surface has no interaction');
  });

  test('spreads the services and the wiring', () => {
    // Commands read ctx.serverService directly rather than ctx.services.serverService.
    const { ctx } = build();

    assert.equal(ctx.serverService, SERVICES.serverService);
    assert.equal(ctx.accountService, SERVICES.accountService);
    assert.equal(ctx.adminService, SERVICES.adminService);
    assert.equal(ctx.registry, REGISTRY);
    assert.equal(ctx.env, ENV);
    assert.equal(ctx.config, CONFIG);
  });

  test('defer sends a typing indicator', () => {
    // Typing is the prefix-surface equivalent of deferring an interaction.
    const { message, ctx } = build();

    return ctx.defer().then(() => {
      assert.deepEqual(
        message.calls.map(([name]) => name),
        ['sendTyping'],
      );
    });
  });

  test('defer swallows a typing failure', async () => {
    /**
     * Typing expires after ten seconds and cannot fail a command, so a missing permission or a
     * deleted channel must not propagate.
     */
    const { ctx } = build({ typingFails: true });

    await assert.doesNotReject(() => ctx.defer());
  });

  test('respond replies once, then edits that reply', async () => {
    /**
     * The prefix surface mirrors the slash surface's single-primary-response model, so a command
     * that reports progress and then a result updates one message rather than posting twice.
     */
    const { message, ctx } = build();

    const first = await ctx.respond({ content: 'first' });
    const second = await ctx.respond({ content: 'second' });

    assert.equal(first, message.sent);
    assert.equal(second, message.sent, 'the same message is returned');
    assert.deepEqual(
      message.calls.map(([name]) => name),
      ['reply', 'edit'],
    );
  });

  test('respond returns null and logs rather than throwing when delivery fails', async () => {
    /**
     * The invoking message may have been deleted, or the bot may lack Send Messages. Neither is a
     * command failure, so respond degrades instead of raising into the handler.
     */
    const { ctx } = build({ replyFails: true });

    assert.equal(await ctx.respond({ content: 'x' }), null);
  });

  test('anchorMessage returns the reply, or null when none was delivered', async () => {
    const { message, ctx } = build();

    assert.equal(await ctx.anchorMessage(), null, 'no anchor before responding');

    await ctx.respond({ content: 'x' });
    assert.equal(await ctx.anchorMessage(), message.sent);
  });

  test('followUp sends a separate channel message', async () => {
    const { message, ctx } = build();

    await ctx.followUp({ content: 'extra' });

    assert.deepEqual(
      message.calls.map(([name]) => name),
      ['channelSend'],
    );
  });

  test('dm lets errors propagate', async () => {
    /**
     * The asymmetry that matters. DM delivery is how generated passwords and signed download URLs
     * reach a user, so a caller must be able to detect failure and fall back to a message
     * explaining the recovery path. A swallowed error would mean a user believing a password
     * arrived when nothing was sent.
     */
    const message = fakeMessage();
    message.author.send = async () => {
      const err = new Error('Cannot send messages to this user');
      err.code = 50007;
      throw err;
    };

    const ctx = createPrefixContext({
      message,
      command: PING_COMMAND,
      tokens: [],
      registry: REGISTRY,
      services: SERVICES,
      env: ENV,
      config: CONFIG,
    });

    await assert.rejects(() => ctx.dm({ content: 'secret' }), (err) => err.code === 50007);
  });

  test('throws during construction when arguments are invalid', () => {
    /**
     * The router catches this and answers with the usage hint, before any handler runs.
     */
    assert.throws(
      () =>
        createPrefixContext({
          message: fakeMessage(),
          command: POWER_COMMAND,
          tokens: ['a1b2c3d4'],
          registry: REGISTRY,
          services: SERVICES,
          env: ENV,
          config: CONFIG,
        }),
      ValidationError,
    );
  });

  test('reports a null guild in a direct message', () => {
    const { ctx } = build({ inGuild: false }, PING_COMMAND, []);

    assert.equal(ctx.guild, null);
    assert.equal(ctx.guildId, null);
    assert.equal(ctx.member, null);
  });
});

describe('the slash context', () => {
  /**
   * @param {object} [interactionOptions]
   * @param {object} [command]
   */
  function build(interactionOptions = {}, command = POWER_COMMAND) {
    const interaction = fakeInteraction({
      options: { server: 'a1b2c3d4', action: 'start' },
      ...interactionOptions,
    });

    const ctx = createSlashContext({
      interaction,
      command,
      registry: REGISTRY,
      services: SERVICES,
      env: ENV,
      config: CONFIG,
    });

    return { interaction, ctx };
  }

  test('exposes the surface, the command and the parsed arguments', () => {
    const { ctx } = build();

    assert.equal(ctx.surface, 'slash');
    assert.equal(ctx.command, POWER_COMMAND);
    assert.deepEqual(ctx.args, { server: 'a1b2c3d4', action: 'start' });
  });

  test('exposes the invoking user and guild context', () => {
    const { interaction, ctx } = build();

    assert.equal(ctx.user, interaction.user);
    assert.equal(ctx.member, interaction.member);
    assert.equal(ctx.guildId, '222222222222222222');
    assert.equal(ctx.interaction, interaction);
    assert.equal(ctx.message, null, 'the slash surface has no message');
  });

  test('defer acknowledges the interaction', async () => {
    const { interaction, ctx } = build();

    await ctx.defer();

    assert.deepEqual(
      interaction.calls.map(([name]) => name),
      ['deferReply'],
    );
    assert.equal(interaction.deferred, true);
  });

  test('defer is idempotent', async () => {
    /**
     * A command may call defer unconditionally, and a second call must not attempt a second
     * acknowledgement — Discord answers that with 40060.
     */
    const { interaction, ctx } = build();

    await ctx.defer();
    await ctx.defer();
    await ctx.defer();

    assert.equal(interaction.calls.filter(([name]) => name === 'deferReply').length, 1);
  });

  test('defer passes the ephemeral flag', async () => {
    const { interaction, ctx } = build();

    await ctx.defer({ ephemeral: true });

    const [, payload] = interaction.calls.find(([name]) => name === 'deferReply');
    assert.equal(payload.flags, MessageFlags.Ephemeral);
  });

  test('defer swallows an expired-interaction failure', async () => {
    /**
     * 10062 means the three-second window closed, usually because the event loop was blocked.
     * Nothing can be sent for this interaction, so raising would only obscure the cause.
     */
    const { ctx } = build({ deferFails: true });

    await assert.doesNotReject(() => ctx.defer());
  });

  test('respond replies when undeferred and edits when deferred', async () => {
    /**
     * The state-dependent branch. Calling reply on an acknowledged interaction fails with 40060,
     * and calling editReply on an unacknowledged one fails with 10062, so the choice must follow
     * the interaction's actual state rather than the caller's assumption.
     */
    const fresh = build();
    await fresh.ctx.respond({ content: 'first' });

    assert.deepEqual(
      fresh.interaction.calls.map(([name]) => name),
      ['reply'],
    );

    const deferredCtx = build();
    await deferredCtx.ctx.defer();
    await deferredCtx.ctx.respond({ content: 'result' });

    assert.deepEqual(
      deferredCtx.interaction.calls.map(([name]) => name),
      ['deferReply', 'editReply'],
    );
  });

  test('respond edits on every call after the first', async () => {
    const { interaction, ctx } = build();

    await ctx.respond({ content: 'first' });
    await ctx.respond({ content: 'second' });
    await ctx.respond({ content: 'third' });

    assert.deepEqual(
      interaction.calls.map(([name]) => name),
      ['reply', 'editReply', 'editReply'],
    );
  });

  test('respond honours ephemeral only on a first, undeferred reply', async () => {
    /**
     * Discord fixes ephemerality at acknowledgement. Once deferred publicly, a later editReply
     * cannot become ephemeral — so the flag is applied on the first reply and ignored afterwards
     * rather than silently producing a public message the caller believed was private.
     */
    const first = build();
    await first.ctx.respond({ content: 'x' }, { ephemeral: true });

    const [, payload] = first.interaction.calls.find(([name]) => name === 'reply');
    assert.equal(payload.flags, MessageFlags.Ephemeral);

    const later = build();
    await later.ctx.defer();
    await later.ctx.respond({ content: 'x' }, { ephemeral: true });

    const [, editPayload] = later.interaction.calls.find(([name]) => name === 'editReply');
    assert.equal(editPayload.flags, undefined, 'an edit cannot carry the ephemeral flag');
  });

  test('respond returns the sent message when Discord provides one', async () => {
    const { ctx } = build();

    const sent = await ctx.respond({ content: 'x' });
    assert.equal(sent.id, 'reply-message-id');
  });

  test('respond returns null rather than throwing when delivery fails', async () => {
    const { ctx } = build({ replyFails: true });

    assert.equal(await ctx.respond({ content: 'x' }), null);
  });

  test('anchorMessage fetches the reply for a collector to attach to', async () => {
    const { interaction, ctx } = build();

    const anchor = await ctx.anchorMessage();

    assert.equal(anchor.id, 'reply-message-id');
    assert.ok(interaction.calls.some(([name]) => name === 'fetchReply'));
  });

  test('anchorMessage returns null when the reply cannot be fetched', async () => {
    const { interaction, ctx } = build();
    interaction.fetchReply = async () => {
      throw new Error('Unknown Message');
    };

    assert.equal(await ctx.anchorMessage(), null);
  });

  test('followUp sends an additional message', async () => {
    const { interaction, ctx } = build();

    await ctx.followUp({ content: 'extra' }, { ephemeral: true });

    const [, payload] = interaction.calls.find(([name]) => name === 'followUp');
    assert.equal(payload.flags, MessageFlags.Ephemeral);
  });

  test('dm lets errors propagate', async () => {
    // The same reasoning as on the prefix surface: credential delivery must be detectable.
    const { interaction, ctx } = build();
    interaction.user.send = async () => {
      const err = new Error('Cannot send messages to this user');
      err.code = 50007;
      throw err;
    };

    await assert.rejects(() => ctx.dm({ content: 'secret' }), (err) => err.code === 50007);
  });

  test('throws during construction when options are invalid', () => {
    assert.throws(
      () =>
        createSlashContext({
          interaction: fakeInteraction({ options: { server: 'a1b2c3d4' } }),
          command: POWER_COMMAND,
          registry: REGISTRY,
          services: SERVICES,
          env: ENV,
          config: CONFIG,
        }),
      ValidationError,
    );
  });
});

describe('content clamping', () => {
  test('truncates over-long content on both surfaces', async () => {
    /**
     * Discord rejects a message whose content exceeds 2000 characters, which would fail the whole
     * reply. Embeds are clamped in utils/embeds.js; this covers the rarer payload carrying a
     * content string, such as a backup download link.
     */
    const message = fakeMessage();
    const prefixCtx = createPrefixContext({
      message,
      command: PING_COMMAND,
      tokens: [],
      registry: REGISTRY,
      services: SERVICES,
      env: ENV,
      config: CONFIG,
    });

    await prefixCtx.respond({ content: 'x'.repeat(MAX_CONTENT_LENGTH + 500) });

    const [, payload] = message.calls.find(([name]) => name === 'reply');
    assert.equal(payload.content.length, MAX_CONTENT_LENGTH);

    const interaction = fakeInteraction({ options: {} });
    const slashCtx = createSlashContext({
      interaction,
      command: PING_COMMAND,
      registry: REGISTRY,
      services: SERVICES,
      env: ENV,
      config: CONFIG,
    });

    await slashCtx.respond({ content: 'y'.repeat(MAX_CONTENT_LENGTH + 500) });

    const [, slashPayload] = interaction.calls.find(([name]) => name === 'reply');
    assert.equal(slashPayload.content.length, MAX_CONTENT_LENGTH);
  });

  test('leaves content within the limit untouched', async () => {
    const message = fakeMessage();
    const ctx = createPrefixContext({
      message,
      command: PING_COMMAND,
      tokens: [],
      registry: REGISTRY,
      services: SERVICES,
      env: ENV,
      config: CONFIG,
    });

    await ctx.respond({ content: 'short' });

    const [, payload] = message.calls.find(([name]) => name === 'reply');
    assert.equal(payload.content, 'short');
  });

  test('leaves a payload with no content field untouched', async () => {
    const message = fakeMessage();
    const ctx = createPrefixContext({
      message,
      command: PING_COMMAND,
      tokens: [],
      registry: REGISTRY,
      services: SERVICES,
      env: ENV,
      config: CONFIG,
    });

    await ctx.respond({ embeds: [{ title: 'x' }] });

    const [, payload] = message.calls.find(([name]) => name === 'reply');
    assert.deepEqual(payload, { embeds: [{ title: 'x' }] });
  });
});
