// Coded by Aditya | GitHub- @adityatheog

/**
 * Interaction router.
 *
 * Handles every InteractionCreate event: slash commands, buttons, select menus,
 * modal submissions and autocomplete. This is the entry point for the slash surface
 * and the safety net for stale components.
 *
 * Two distinct jobs, and the second is easy to overlook.
 *
 * Slash commands are dispatched here in full: resolved from the registry, gated for
 * context and permission, throttled, then executed with the same context shape the
 * prefix router builds. The checks run in the same order as the prefix router, for
 * the same reasons.
 *
 * Component interactions are normally consumed by the collector attached to the
 * message that created them, and this router never sees them. It only receives the
 * ones whose collector is gone: the session expired, or the bot restarted since the
 * message was posted. Those must be answered — an unacknowledged interaction leaves
 * the user's client showing a permanent error state — but they must never execute
 * anything, because the server-side state that authorised them no longer exists.
 * That is the whole reason component state lives in a session store rather than
 * being encoded in the custom id: a stale button resolves to no session, and no
 * session means no action.
 *
 * Interaction tokens expire three seconds after arrival unless acknowledged. Every
 * path here either replies, defers or explicitly acknowledges, and the timing-
 * sensitive work (permission checks, registry lookup, cooldown) is all synchronous
 * and completes in well under a millisecond.
 */

import { Events, MessageFlags } from 'discord.js';
import { createSlashContext } from '../core/context.js';
import { formatCooldown } from '../core/cooldowns.js';
import { EPHEMERAL, respondWithError, safeRespond } from '../core/reply.js';
import {
  cooldownEmbed,
  errorEmbed,
  permissionErrorEmbed,
  serverOnlyEmbed,
  timedOutEmbed,
} from '../utils/embeds.js';
import { isUserError, toUserMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { resolveContextAdmin } from '../utils/permissions.js';
import { getSession, namespaceFromCustomId, sessionIdFromCustomId } from '../utils/sessions.js';

/**
 * Resolves an interaction's canonical command name.
 *
 * Discord delivers a nested invocation as three separate fields, which this
 * flattens back into the registry's canonical form:
 *
 *   /ping                     -> "ping"
 *   /account create           -> "account create"
 *   /server subuser add       -> "server subuser add"
 *
 * getSubcommandGroup and getSubcommand are called with `false` so they return null
 * instead of throwing on a command that has neither.
 *
 * @param {import('discord.js').ChatInputCommandInteraction|import('discord.js').AutocompleteInteraction} interaction
 * @returns {string}
 */
export function canonicalNameFromInteraction(interaction) {
  const parts = [interaction.commandName];

  const group = interaction.options.getSubcommandGroup(false);
  if (group) parts.push(group);

  const subcommand = interaction.options.getSubcommand(false);
  if (subcommand) parts.push(subcommand);

  return parts.join(' ');
}

/**
 * Builds the InteractionCreate handler.
 *
 * @param {object} deps
 * @param {ReturnType<import('../commands/registry.js').createRegistry>} deps.registry
 * @param {Readonly<object>} deps.env
 * @param {Readonly<object>} deps.config
 * @param {object} deps.services
 * @param {ReturnType<import('../core/cooldowns.js').createCooldownManager>} deps.cooldowns
 * @returns {(interaction: import('discord.js').Interaction) => Promise<void>}
 */
export function createInteractionRouter({ registry, env, config, services, cooldowns }) {
  /**
   * Dispatches a slash command.
   *
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @returns {Promise<void>}
   */
  async function handleChatInput(interaction) {
    const name = canonicalNameFromInteraction(interaction);
    const command = registry.get(name);

    if (!command) {
      /**
       * The invocation is registered with Discord but absent from the registry,
       * which means a command was removed without redeploying. Logged at warn
       * because it needs `npm run deploy` to resolve.
       */
      logger.warn('Received an unknown slash command', { name, userId: interaction.user.id });
      await safeRespond(
        interaction,
        { embeds: [errorEmbed('That command is no longer available. It may have been removed or renamed.')] },
        { ephemeral: true },
      );
      return;
    }

    if (command.guildOnly !== false && !interaction.inGuild()) {
      await safeRespond(interaction, { embeds: [serverOnlyEmbed()] }, { ephemeral: true });
      return;
    }

    /** @type {ReturnType<typeof createSlashContext>} */
    let ctx;
    try {
      ctx = createSlashContext({ interaction, command, registry, services, env, config });
    } catch (err) {
      // Option validation failed. Discord constrains options client-side, so this
      // means either a stale registered command or a crafted request.
      if (isUserError(err)) {
        logger.debug('Slash option validation rejected', {
          command: name,
          userId: interaction.user.id,
          code: err?.code,
        });
        await safeRespond(interaction, { embeds: [errorEmbed(toUserMessage(err))] }, { ephemeral: true });
        return;
      }
      throw err;
    }

    const admin = resolveContextAdmin(ctx);

    if (command.adminOnly && !admin.allowed) {
      logger.warn('Admin command refused', {
        command: name,
        userId: interaction.user.id,
        guildId: interaction.guildId ?? null,
      });
      await safeRespond(interaction, { embeds: [permissionErrorEmbed()] }, { ephemeral: true });
      return;
    }

    const cooldown = cooldowns.check(interaction.user.id, command.name, { bypass: admin.allowed });
    if (cooldown.limited) {
      await safeRespond(
        interaction,
        { embeds: [cooldownEmbed(formatCooldown(cooldown.remainingMs))] },
        { ephemeral: true },
      );
      return;
    }

    const startedAt = Date.now();

    logger.info('Slash command invoked', {
      command: name,
      userId: interaction.user.id,
      guildId: interaction.guildId ?? null,
      admin: command.adminOnly ? admin.source : undefined,
    });

    try {
      await command.execute(ctx);

      logger.debug('Slash command completed', {
        command: name,
        userId: interaction.user.id,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      await respondWithError({ interaction }, err, {
        surface: 'slash',
        command: name,
        userId: interaction.user.id,
        guildId: interaction.guildId ?? null,
        durationMs: Date.now() - startedAt,
      });
    }
  }

  /**
   * Handles a component or modal interaction whose collector did not claim it.
   *
   * Reaching this function means the owning session is gone. The interaction is
   * acknowledged so the user's client does not hang, and nothing is executed.
   *
   * @param {import('discord.js').MessageComponentInteraction|import('discord.js').ModalSubmitInteraction} interaction
   * @returns {Promise<void>}
   */
  async function handleOrphanedComponent(interaction) {
    const sessionId = sessionIdFromCustomId(interaction.customId);

    // A live session means the collector owns this interaction and will answer it.
    // Returning without acknowledging is correct: double-acknowledging produces a
    // 40060 and can clobber the collector's own reply.
    if (getSession(sessionId)) return;

    logger.debug('Stale component interaction rejected', {
      customId: interaction.customId,
      namespace: namespaceFromCustomId(interaction.customId),
      userId: interaction.user.id,
    });

    await safeRespond(interaction, { embeds: [timedOutEmbed()] }, { ephemeral: true });
  }

  /**
   * Answers an autocomplete request.
   *
   * Discord requires a response within three seconds and will not accept a deferral,
   * so a command's autocomplete callback must resolve locally. None of the
   * twenty-four commands currently declares one; the hook exists so adding
   * identifier autocompletion later requires no router change. An unhandled
   * autocomplete is answered with an empty list rather than left to time out.
   *
   * @param {import('discord.js').AutocompleteInteraction} interaction
   * @returns {Promise<void>}
   */
  async function handleAutocomplete(interaction) {
    const name = canonicalNameFromInteraction(interaction);
    const command = registry.get(name);

    if (!command || typeof command.autocomplete !== 'function') {
      await interaction.respond([]).catch(() => {});
      return;
    }

    try {
      const focused = interaction.options.getFocused(true);
      const choices = await command.autocomplete({
        interaction,
        focused,
        registry,
        env,
        config,
        ...services,
      });

      // Discord accepts at most 25 choices and rejects the whole response if any
      // name exceeds 100 characters.
      const payload = (Array.isArray(choices) ? choices : []).slice(0, 25).map((choice) => ({
        name: String(choice.name ?? choice.value).slice(0, 100),
        value: String(choice.value),
      }));

      await interaction.respond(payload);
    } catch (err) {
      logger.warn('Autocomplete failed', { command: name, code: err?.code, message: err?.message });
      await interaction.respond([]).catch(() => {});
    }
  }

  return async function onInteractionCreate(interaction) {
    try {
      if (interaction.isChatInputCommand()) {
        await handleChatInput(interaction);
        return;
      }

      if (interaction.isAutocomplete()) {
        await handleAutocomplete(interaction);
        return;
      }

      if (interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit()) {
        await handleOrphanedComponent(interaction);
        return;
      }

      // Context menus and any future interaction type. Acknowledged rather than
      // ignored, so the user's client does not show a failure.
      if (interaction.isRepliable()) {
        logger.debug('Unhandled interaction type', { type: interaction.type, userId: interaction.user?.id });
        await interaction
          .reply({ embeds: [errorEmbed('That interaction is not supported.')], flags: MessageFlags.Ephemeral })
          .catch(() => {});
      }
    } catch (err) {
      /**
       * Last line of defence. Anything here escaped every inner guard, so the fault
       * is in the router rather than a command. Logged and swallowed: an unhandled
       * rejection out of a discord.js listener must not take the process down over
       * one bad interaction.
       */
      logger.error('Interaction router failed', {
        code: err?.code ?? null,
        message: err?.message ?? String(err),
        interactionType: interaction?.type ?? null,
        commandName: interaction?.commandName ?? null,
        customId: interaction?.customId ?? null,
        userId: interaction?.user?.id ?? null,
      });

      // A best-effort reply, in case the failure happened before anything was sent.
      if (interaction?.isRepliable?.() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            embeds: [errorEmbed('Something went wrong handling that interaction. Please try again.')],
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
  };
}

/**
 * Registers the handler on a client.
 *
 * @param {import('discord.js').Client} client
 * @param {Parameters<typeof createInteractionRouter>[0]} deps
 * @returns {void}
 */
export function registerInteractionRouter(client, deps) {
  client.on(Events.InteractionCreate, createInteractionRouter(deps));
}
