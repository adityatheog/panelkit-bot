// Coded by Aditya | GitHub- @adityatheog

/**
 * The surface-agnostic execution context.
 *
 * A command's execute() receives a `ctx` object and never touches a discord.js
 * Message or ChatInputCommandInteraction directly. That indirection is what allows a
 * single implementation to serve both invocation surfaces: the prefix router builds
 * a prefix context, the interaction router builds a slash context, and both expose
 * the same shape.
 *
 *   ctx.args              parsed and validated arguments, keyed by option name
 *   ctx.user              the invoking Discord user
 *   ctx.member            guild member, or null in a direct message
 *   ctx.defer()           acknowledge before slow work
 *   ctx.respond()         send or replace the primary reply
 *   ctx.followUp()        send an additional message
 *   ctx.anchorMessage()   the Message components attach to, for collectors
 *   ctx.dm()              send a direct message to the invoker
 *   plus every service, the registry, env and config
 *
 * The two surfaces differ in ways that cannot be papered over entirely, and the
 * important one is acknowledgement. Discord invalidates an interaction token three
 * seconds after it arrives unless the bot has replied or deferred, and every later
 * edit must use editReply rather than reply. A message has no such deadline. The
 * slash context tracks that state so a command can call defer() then respond()
 * unconditionally, and get correct behaviour on both.
 *
 * Argument parsing is unified deliberately. Slash options arrive already typed by
 * Discord, but they are still revalidated here against the same rules the prefix
 * surface uses. Discord's client-side constraints are a convenience, not a security
 * boundary: a stale registered command or a crafted request can deliver values that
 * violate them.
 */

import { MessageFlags } from 'discord.js';
import { ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import {
  assertOneOf,
  assertValidInteger,
  assertValidUserReference,
} from '../utils/validation.js';

/** Discord's ceiling on a single message's content field. */
const MAX_CONTENT_LENGTH = 2000;

/**
 * Coerces one raw argument value according to its option declaration.
 *
 * Applied to both surfaces so validation cannot diverge between them.
 *
 * @param {object} option the option declaration from the command definition
 * @param {unknown} raw the value supplied by the user, or null when absent
 * @param {string} commandName for error messages
 * @returns {string|number|null}
 * @throws {ValidationError}
 */
function coerceArgument(option, raw, commandName) {
  const absent = raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '');

  if (absent) {
    if (option.required) {
      // The message names the option and repeats its description, so a user who
      // typed the command wrong learns what is missing without opening help.
      throw new ValidationError(
        `\`${commandName}\` needs the \`${option.name}\` argument. ${option.description}`,
      );
    }
    return option.default ?? null;
  }

  switch (option.type) {
    case 'integer':
      return assertValidInteger(raw, {
        name: option.name,
        min: option.min !== undefined ? Number(option.min) : Number.MIN_SAFE_INTEGER,
        max: option.max !== undefined ? Number(option.max) : Number.MAX_SAFE_INTEGER,
      });

    case 'user':
      return assertValidUserReference(raw);

    case 'string':
    default: {
      const value = String(raw).trim();

      if (option.choices) {
        return assertOneOf(
          value,
          option.choices.map((choice) => String(choice.value)),
          { name: option.name },
        );
      }

      if (option.minLength !== undefined && value.length < Number(option.minLength)) {
        throw new ValidationError(
          `\`${option.name}\` must be at least ${option.minLength} characters.`,
        );
      }
      if (option.maxLength !== undefined && value.length > Number(option.maxLength)) {
        throw new ValidationError(
          `\`${option.name}\` must be ${option.maxLength} characters or fewer.`,
        );
      }

      return value;
    }
  }
}

/**
 * Maps positional prefix tokens onto named options.
 *
 * Options are consumed in declaration order. A greedy option absorbs every
 * remaining token, which is what lets `kx!server rename a1b2c3d4 My New Server`
 * work without quoting. The registry guarantees a greedy option is declared last.
 *
 * @param {object} command
 * @param {string[]} tokens the tokens after the command name
 * @returns {Record<string, string|number|null>}
 * @throws {ValidationError}
 */
export function parsePrefixArgs(command, tokens) {
  /** @type {Record<string, string|number|null>} */
  const args = {};
  const options = command.options ?? [];
  const list = Array.isArray(tokens) ? tokens : [];

  let index = 0;

  for (const option of options) {
    /** @type {string|null} */
    let raw;

    if (option.greedy === true) {
      raw = index < list.length ? list.slice(index).join(' ') : null;
      index = list.length;
    } else {
      raw = index < list.length ? list[index] : null;
      index += 1;
    }

    args[option.name] = coerceArgument(option, raw, command.name);
  }

  return args;
}

/**
 * Reads slash options and revalidates them.
 *
 * Every option is fetched as not-required so a missing value produces this
 * project's error message rather than a discord.js exception, keeping the failure
 * text identical across surfaces.
 *
 * @param {object} command
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @returns {Record<string, string|number|null>}
 * @throws {ValidationError}
 */
export function parseSlashArgs(command, interaction) {
  /** @type {Record<string, string|number|null>} */
  const args = {};

  for (const option of command.options ?? []) {
    /** @type {unknown} */
    let raw = null;

    switch (option.type) {
      case 'integer':
        raw = interaction.options.getInteger(option.name, false);
        break;
      case 'user':
        raw = interaction.options.getUser(option.name, false)?.id ?? null;
        break;
      case 'string':
      default:
        raw = interaction.options.getString(option.name, false);
        break;
    }

    args[option.name] = coerceArgument(option, raw, command.name);
  }

  return args;
}

/**
 * Truncates message content to Discord's limit.
 *
 * Embeds are clamped in utils/embeds.js; this covers the rarer case of a payload
 * carrying a `content` string, such as a backup download link.
 *
 * @param {object} payload
 * @returns {object}
 */
function clampContent(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  if (typeof payload.content !== 'string' || payload.content.length <= MAX_CONTENT_LENGTH) return payload;

  return { ...payload, content: payload.content.slice(0, MAX_CONTENT_LENGTH) };
}

/**
 * Fields shared by both contexts.
 *
 * Services are spread in so a command reads `ctx.serverService` rather than
 * `ctx.services.serverService`, which keeps command bodies terse.
 *
 * @param {object} input
 * @returns {object}
 */
function baseContext({ surface, command, registry, services, env, config }) {
  return {
    surface,
    command,
    registry,
    env,
    config,
    ...services,
  };
}

/**
 * Builds the context for a prefix command.
 *
 * `respond()` replies once and edits that reply on subsequent calls, mirroring the
 * slash surface's single-primary-response model. A command that reports progress and
 * then a result therefore updates one message on both surfaces rather than posting
 * twice on one of them.
 *
 * @param {object} input
 * @param {import('discord.js').Message} input.message
 * @param {object} input.command
 * @param {string[]} input.tokens tokens after the command name
 * @param {object} input.registry
 * @param {object} input.services
 * @param {Readonly<object>} input.env
 * @param {Readonly<object>} input.config
 * @returns {object} the execution context
 * @throws {ValidationError} when argument parsing fails
 */
export function createPrefixContext({ message, command, tokens, registry, services, env, config }) {
  /** @type {import('discord.js').Message|null} The reply this context owns. */
  let anchor = null;

  return {
    ...baseContext({ surface: 'prefix', command, registry, services, env, config }),

    args: parsePrefixArgs(command, tokens),

    user: message.author,
    member: message.member,
    guild: message.guild,
    guildId: message.guildId,
    channel: message.channel,
    client: message.client,

    message,
    interaction: null,

    /**
     * Signals that work is in progress.
     *
     * Typing is the prefix-surface equivalent of deferring. It expires after ten
     * seconds and cannot fail the command, so errors are swallowed.
     *
     * @returns {Promise<void>}
     */
    async defer() {
      try {
        if (typeof message.channel?.sendTyping === 'function') await message.channel.sendTyping();
      } catch {
        // A missing permission or a deleted channel must not fail the command.
      }
    },

    /**
     * Sends or updates this context's reply.
     *
     * @param {object} payload
     * @returns {Promise<import('discord.js').Message|null>}
     */
    async respond(payload) {
      const body = clampContent(payload);

      try {
        if (anchor) {
          await anchor.edit(body);
          return anchor;
        }
        anchor = await message.reply(body);
        return anchor;
      } catch (err) {
        // Most often: the invoking message was deleted, or the bot lacks Send
        // Messages or Embed Links here. Neither is worth crashing the handler.
        logger.warn('Could not deliver a prefix reply', {
          command: command.name,
          channelId: message.channelId,
          code: err?.code,
          message: err?.message,
        });
        return null;
      }
    },

    /**
     * Sends an additional message in the channel.
     *
     * @param {object} payload
     * @returns {Promise<import('discord.js').Message|null>}
     */
    async followUp(payload) {
      try {
        return await message.channel.send(clampContent(payload));
      } catch (err) {
        logger.warn('Could not deliver a prefix follow-up', {
          command: command.name,
          channelId: message.channelId,
          code: err?.code,
        });
        return null;
      }
    },

    /**
     * The message interactive components are attached to.
     *
     * Returns null when respond() failed, which callers must handle before creating
     * a collector.
     *
     * @returns {Promise<import('discord.js').Message|null>}
     */
    async anchorMessage() {
      return anchor;
    },

    /**
     * Sends a direct message to the invoker.
     *
     * Errors propagate: DM delivery is the security boundary for credentials, so a
     * caller must know it failed and fall back to a safe channel message rather
     * than assuming success.
     *
     * @param {object} payload
     * @returns {Promise<import('discord.js').Message>}
     */
    async dm(payload) {
      return message.author.send(clampContent(payload));
    },
  };
}

/**
 * Builds the context for a slash command.
 *
 * The interaction lifecycle is tracked internally so commands do not have to.
 * defer() is idempotent, and respond() chooses between reply and editReply based on
 * whether the interaction has already been acknowledged.
 *
 * @param {object} input
 * @param {import('discord.js').ChatInputCommandInteraction} input.interaction
 * @param {object} input.command
 * @param {object} input.registry
 * @param {object} input.services
 * @param {Readonly<object>} input.env
 * @param {Readonly<object>} input.config
 * @returns {object} the execution context
 * @throws {ValidationError} when argument parsing fails
 */
export function createSlashContext({ interaction, command, registry, services, env, config }) {
  /**
   * Whether this context deferred ephemerally.
   *
   * Discord fixes ephemerality at acknowledgement time: once deferred publicly, a
   * later editReply cannot become ephemeral. Tracking it lets respond() ignore a
   * contradictory ephemeral flag instead of silently producing a public reply that
   * the caller believed was private.
   */
  let deferredEphemeral = false;

  return {
    ...baseContext({ surface: 'slash', command, registry, services, env, config }),

    args: parseSlashArgs(command, interaction),

    user: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    guildId: interaction.guildId,
    channel: interaction.channel,
    client: interaction.client,

    message: null,
    interaction,

    /**
     * Acknowledges the interaction before slow work.
     *
     * Must be called within three seconds of the interaction arriving, which in
     * practice means before the first panel request. Idempotent, so a command may
     * call it unconditionally.
     *
     * @param {{ ephemeral?: boolean }} [options]
     * @returns {Promise<void>}
     */
    async defer({ ephemeral = false } = {}) {
      if (interaction.deferred || interaction.replied) return;

      try {
        await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
        deferredEphemeral = ephemeral;
      } catch (err) {
        // 10062 Unknown Interaction: the three-second window closed, usually
        // because the event loop was blocked. Nothing can be sent for this
        // interaction, so the command's later respond() will also fail harmlessly.
        logger.warn('Could not defer an interaction', {
          command: command.name,
          code: err?.code,
          message: err?.message,
        });
      }
    },

    /**
     * Sends or replaces the primary response.
     *
     * @param {object} payload
     * @param {{ ephemeral?: boolean }} [options] honoured only on the first, undeferred reply
     * @returns {Promise<import('discord.js').Message|null>}
     */
    async respond(payload, { ephemeral = false } = {}) {
      const body = clampContent(payload);

      try {
        if (interaction.deferred || interaction.replied) {
          if (ephemeral && !deferredEphemeral) {
            // Cannot be honoured now. Logged rather than ignored silently, because
            // it means a command intended privacy and will not get it.
            logger.debug('Ephemeral requested after a public acknowledgement; sending publicly', {
              command: command.name,
            });
          }
          return await interaction.editReply(body);
        }

        const sent = await interaction.reply({
          ...body,
          ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
          withResponse: true,
        });

        if (ephemeral) deferredEphemeral = true;

        // discord.js 14.16 returns an InteractionCallbackResponse for withResponse.
        return sent?.resource?.message ?? null;
      } catch (err) {
        logger.warn('Could not deliver an interaction response', {
          command: command.name,
          code: err?.code,
          message: err?.message,
        });
        return null;
      }
    },

    /**
     * Sends an additional message on the same interaction.
     *
     * @param {object} payload
     * @param {{ ephemeral?: boolean }} [options]
     * @returns {Promise<import('discord.js').Message|null>}
     */
    async followUp(payload, { ephemeral = false } = {}) {
      try {
        return await interaction.followUp({
          ...clampContent(payload),
          ...(ephemeral ? { flags: MessageFlags.Ephemeral } : {}),
        });
      } catch (err) {
        logger.warn('Could not deliver an interaction follow-up', {
          command: command.name,
          code: err?.code,
        });
        return null;
      }
    },

    /**
     * The message interactive components are attached to.
     *
     * fetchReply resolves the deferred placeholder or the sent reply, either of
     * which can host a component collector.
     *
     * @returns {Promise<import('discord.js').Message|null>}
     */
    async anchorMessage() {
      try {
        return await interaction.fetchReply();
      } catch (err) {
        logger.warn('Could not fetch the interaction reply', { command: command.name, code: err?.code });
        return null;
      }
    },

    /**
     * Sends a direct message to the invoker.
     *
     * Errors propagate, for the same reason as on the prefix surface.
     *
     * @param {object} payload
     * @returns {Promise<import('discord.js').Message>}
     */
    async dm(payload) {
      return interaction.user.send(clampContent(payload));
    },
  };
}

export { coerceArgument, MAX_CONTENT_LENGTH };
