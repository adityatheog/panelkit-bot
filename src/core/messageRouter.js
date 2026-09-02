// Coded by Aditya | GitHub- @adityatheog

/**
 * Prefix command router.
 *
 * Handles every MessageCreate event and dispatches the ones that are commands. This
 * is the entry point for the prefix surface, and it is the one place where a
 * malformed message, a missing permission or a thrown handler must never crash the
 * process — a single unhandled rejection in an event listener takes down the bot for
 * everyone.
 *
 * Order of checks, and why each comes where it does:
 *
 *   1. Cheap rejections first. Bot authors, system messages and anything not
 *      starting with the prefix are discarded before any parsing, because this
 *      listener runs on every message the bot can see.
 *
 *   2. Command resolution. A message starting with the prefix but naming nothing
 *      known is ignored silently rather than answered. Replying "unknown command" to
 *      every near-miss makes a bot in a busy server unbearable, and the prefix is
 *      short enough to be typed by accident.
 *
 *   3. Context guards. Guild-only commands refuse in direct messages before
 *      argument parsing, so the user gets the specific reason.
 *
 *   4. Argument parsing. Failures here are user errors and produce the command's
 *      usage hint.
 *
 *   5. Authorisation. Admin gating happens before the cooldown check, so a refused
 *      user does not also consume a cooldown slot.
 *
 *   6. Cooldown. Recorded only once the command is actually going to run.
 *
 *   7. Execution, wrapped so any throw becomes a safe embed.
 *
 * The bot's own missing channel permissions are detected explicitly. Without Embed
 * Links every reply is silently dropped by Discord, which users report as "the bot
 * ignores me" — logging the specific missing permission turns an unfalsifiable
 * complaint into a one-line fix.
 */

import { Events } from 'discord.js';
import { createPrefixContext } from './context.js';
import { formatCooldown } from './cooldowns.js';
import { replyToMessage, respondWithError } from './reply.js';
import { cooldownEmbed, errorEmbed, permissionErrorEmbed, serverOnlyEmbed } from '../utils/embeds.js';
import { isUserError, toUserMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { missingChannelPermissions, resolveContextAdmin } from '../utils/permissions.js';

/**
 * Longest command name in the tree, in words. Bounds how many tokens are examined
 * during resolution; the registry enforces the same limit.
 */
const MAX_COMMAND_WORDS = 3;

/**
 * How many tokens past the command name are kept.
 *
 * Generous enough for a greedy server name, bounded so a pathological message
 * cannot make the router do meaningful work before the command is even resolved.
 */
const MAX_TOKENS = 64;

/**
 * Builds the MessageCreate handler.
 *
 * @param {object} deps
 * @param {ReturnType<import('../commands/registry.js').createRegistry>} deps.registry
 * @param {Readonly<object>} deps.env
 * @param {Readonly<object>} deps.config
 * @param {object} deps.services every service, spread into the context
 * @param {ReturnType<import('./cooldowns.js').createCooldownManager>} deps.cooldowns
 * @returns {(message: import('discord.js').Message) => Promise<void>}
 */
export function createMessageRouter({ registry, env, config, services, cooldowns }) {
  const prefix = env.prefix;
  const prefixLower = prefix.toLowerCase();

  /**
   * Whether the message opens with the configured prefix.
   *
   * Compared case-insensitively so `KX!ping` works. The prefix itself is never
   * matched against message content beyond this, so a prefix containing regex
   * metacharacters is harmless.
   *
   * @param {string} content
   * @returns {boolean}
   */
  function hasPrefix(content) {
    return content.slice(0, prefix.length).toLowerCase() === prefixLower;
  }

  return async function onMessageCreate(message) {
    try {
      // ---------------------------------------------------------------- filtering

      // Ignore other bots and this bot's own messages. Without this, a bot that
      // echoes content could trigger an infinite loop between two bots.
      if (message.author?.bot) return;

      // Join notifications, pins, thread starters and similar have no content.
      if (message.system) return;

      // Partial messages arrive when MessageContent is missing or the message was
      // uncached. Nothing can be parsed from them.
      if (typeof message.content !== 'string' || message.content === '') return;

      if (!hasPrefix(message.content)) return;

      // ---------------------------------------------------------------- resolution

      const withoutPrefix = message.content.slice(prefix.length).trim();
      if (withoutPrefix === '') return;

      const tokens = withoutPrefix.split(/\s+/).slice(0, MAX_TOKENS);

      // tokens is already capped at MAX_TOKENS above, and resolvePrefix examines at most
      // MAX_COMMAND_WORDS of them.
      const resolved = registry.resolvePrefix(tokens);
      if (!resolved) {
        // Deliberately silent. See the header note on near-misses.
        logger.debug('Prefix message did not match a command', {
          userId: message.author.id,
          guildId: message.guildId ?? null,
          firstToken: tokens[0],
        });
        return;
      }

      const { command, rest } = resolved;

      // ------------------------------------------------------------ context guards

      if (command.guildOnly !== false && !message.inGuild()) {
        await replyToMessage(message, { embeds: [serverOnlyEmbed()] });
        return;
      }

      // Detect the bot's own missing permissions before doing any work, so a
      // dropped reply is diagnosable rather than mysterious.
      if (message.inGuild()) {
        const botMember = message.guild?.members?.me ?? null;
        const missing = missingChannelPermissions(message.channel, botMember);

        if (missing.length > 0) {
          logger.warn('Missing channel permissions; a reply may not be delivered', {
            command: command.name,
            guildId: message.guildId,
            channelId: message.channelId,
            missing,
          });

          // Without Send Messages nothing can be delivered here at all, so stop
          // rather than attempting a reply that Discord will reject.
          if (missing.includes('SendMessages') || missing.includes('ViewChannel')) return;
        }
      }

      // ------------------------------------------------------------------- context

      /** @type {ReturnType<typeof createPrefixContext>} */
      let ctx;
      try {
        ctx = createPrefixContext({
          message,
          command,
          tokens: rest,
          registry,
          services,
          env,
          config,
        });
      } catch (err) {
        // Argument parsing failed. Expected traffic, so it is answered with the
        // usage hint rather than routed through the fault path.
        if (isUserError(err)) {
          logger.debug('Prefix argument parsing rejected', {
            command: command.name,
            userId: message.author.id,
            code: err?.code,
          });
          await replyToMessage(message, { embeds: [errorEmbed(toUserMessage(err))] });
          return;
        }
        throw err;
      }

      // ------------------------------------------------------------- authorisation

      const admin = resolveContextAdmin(ctx);

      if (command.adminOnly && !admin.allowed) {
        // Logged at warn: an attempt on an admin command is worth seeing, even
        // though refusing it is routine.
        logger.warn('Admin command refused', {
          command: command.name,
          userId: message.author.id,
          guildId: message.guildId ?? null,
        });
        await replyToMessage(message, { embeds: [permissionErrorEmbed()] });
        return;
      }

      // ------------------------------------------------------------------ cooldown

      const cooldown = cooldowns.check(message.author.id, command.name, { bypass: admin.allowed });
      if (cooldown.limited) {
        await replyToMessage(message, { embeds: [cooldownEmbed(formatCooldown(cooldown.remainingMs))] });
        return;
      }

      // ----------------------------------------------------------------- execution

      const startedAt = Date.now();

      logger.info('Prefix command invoked', {
        command: command.name,
        userId: message.author.id,
        guildId: message.guildId ?? null,
        admin: command.adminOnly ? admin.source : undefined,
      });

      try {
        await command.execute(ctx);

        logger.debug('Prefix command completed', {
          command: command.name,
          userId: message.author.id,
          durationMs: Date.now() - startedAt,
        });
      } catch (err) {
        await respondWithError({ message }, err, {
          surface: 'prefix',
          command: command.name,
          userId: message.author.id,
          guildId: message.guildId ?? null,
          durationMs: Date.now() - startedAt,
        });
      }
    } catch (err) {
      /**
       * Last line of defence.
       *
       * Anything reaching here escaped every inner guard, which means the failure is
       * in the router itself rather than in a command. It is logged and swallowed:
       * an unhandled rejection out of a discord.js listener would otherwise be
       * caught by the process-level handler and, on older Node defaults, terminate
       * the bot for every user over one bad message.
       */
      logger.error('Message router failed', {
        code: err?.code ?? null,
        message: err?.message ?? String(err),
        userId: message?.author?.id ?? null,
        guildId: message?.guildId ?? null,
      });
    }
  };
}

/**
 * Registers the handler on a client.
 *
 * @param {import('discord.js').Client} client
 * @param {Parameters<typeof createMessageRouter>[0]} deps
 * @returns {void}
 */
export function registerMessageRouter(client, deps) {
  client.on(Events.MessageCreate, createMessageRouter(deps));
}

export { MAX_COMMAND_WORDS, MAX_TOKENS };
