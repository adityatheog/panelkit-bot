// Coded by Aditya | GitHub- @adityatheog

/**
 * Response helpers and the single funnel for user-visible failures.
 *
 * Two responsibilities live here.
 *
 * First, responding without ever throwing. Discord rejects a reply for reasons that
 * have nothing to do with the command being wrong: the interaction token expired,
 * the invoking message was deleted, the bot lost Send Messages in the channel, the
 * channel itself is gone. None of those should propagate into a handler's catch
 * block and be misreported as a command failure, so every helper here logs and
 * returns rather than raising.
 *
 * Second, error presentation. respondWithError() is the only place that turns a
 * thrown value into something a user sees. It applies three rules:
 *
 *   The user gets a curated message from toUserMessage(). Never a stack trace, never
 *   an axios error, never SQL.
 *
 *   Expected user errors (bad input, wrong owner, missing resource) are logged at
 *   warn. Genuine faults are logged at error and carry a short reference code that is
 *   also shown to the user, so a support conversation can be tied to one log line
 *   without exposing anything.
 *
 *   Error replies are ephemeral wherever the surface allows it. A failed command is
 *   between the bot and the user; broadcasting it to a channel adds noise and can
 *   leak which servers someone owns.
 */

import { MessageFlags } from 'discord.js';
import { errorEmbed, referencedErrorEmbed } from '../utils/embeds.js';
import { isUserError, toLogMeta, toUserMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { newErrorReference } from '../utils/security.js';

/** Spread into a reply payload to make it ephemeral. */
export const EPHEMERAL = Object.freeze({ flags: MessageFlags.Ephemeral });

/**
 * Discord error codes that mean "the target is gone", not "the request was wrong".
 *
 * These are logged at debug rather than warn: they are routine on a busy bot and
 * indicate nothing actionable.
 *
 * 10003 Unknown Channel
 * 10008 Unknown Message
 * 10062 Unknown Interaction (the three-second acknowledgement window closed)
 * 40060 Interaction has already been acknowledged
 */
const BENIGN_DISCORD_CODES = Object.freeze(new Set([10003, 10008, 10062, 40060]));

/** 50007 Cannot send messages to this user: DMs are closed or the bot is blocked. */
export const DM_BLOCKED_CODE = 50007;

/**
 * Whether a Discord error means the interaction or its target no longer exists.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isBenignDeliveryFailure(err) {
  return BENIGN_DISCORD_CODES.has(Number(err?.code));
}

/**
 * Logs a delivery failure at the appropriate level.
 *
 * @param {string} what
 * @param {unknown} err
 * @param {Record<string, unknown>} context
 */
function logDeliveryFailure(what, err, context) {
  const meta = { ...context, code: err?.code ?? null, message: err?.message ?? String(err) };

  if (isBenignDeliveryFailure(err)) logger.debug(`${what} was not delivered`, meta);
  else logger.warn(`${what} could not be delivered`, meta);
}

/**
 * Replies to an interaction, or edits it when already acknowledged.
 *
 * Chooses between reply and editReply based on the interaction's current state, so
 * callers never have to track it. The ephemeral flag applies only to a first,
 * undeferred reply: Discord fixes ephemerality at acknowledgement time and an
 * editReply cannot change it.
 *
 * @param {import('discord.js').RepliableInteraction} interaction
 * @param {object} payload
 * @param {{ ephemeral?: boolean }} [options]
 * @returns {Promise<boolean>} whether something was delivered
 */
export async function safeRespond(interaction, payload, { ephemeral = false } = {}) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload);
      return true;
    }

    await interaction.reply(ephemeral ? { ...payload, ...EPHEMERAL } : payload);
    return true;
  } catch (err) {
    logDeliveryFailure('Interaction response', err, {
      interactionId: interaction?.id,
      commandName: interaction?.commandName ?? null,
      customId: interaction?.customId ?? null,
    });
    return false;
  }
}

/**
 * Sends an additional message on an interaction.
 *
 * @param {import('discord.js').RepliableInteraction} interaction
 * @param {object} payload
 * @param {{ ephemeral?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
export async function safeFollowUp(interaction, payload, { ephemeral = false } = {}) {
  try {
    await interaction.followUp(ephemeral ? { ...payload, ...EPHEMERAL } : payload);
    return true;
  } catch (err) {
    logDeliveryFailure('Interaction follow-up', err, { interactionId: interaction?.id });
    return false;
  }
}

/**
 * Acknowledges a component interaction without changing the message.
 *
 * Used when a handler needs to consume an interaction it has decided not to act on.
 * Failing to acknowledge leaves the user's client showing an error state.
 *
 * @param {import('discord.js').MessageComponentInteraction} interaction
 * @returns {Promise<boolean>}
 */
export async function safeDeferUpdate(interaction) {
  try {
    if (interaction.deferred || interaction.replied) return true;
    await interaction.deferUpdate();
    return true;
  } catch (err) {
    logDeliveryFailure('Interaction acknowledgement', err, { customId: interaction?.customId ?? null });
    return false;
  }
}

/**
 * Replies to a message.
 *
 * @param {import('discord.js').Message} message
 * @param {object} payload
 * @returns {Promise<import('discord.js').Message|null>}
 */
export async function replyToMessage(message, payload) {
  try {
    return await message.reply(payload);
  } catch (err) {
    logDeliveryFailure('Message reply', err, {
      channelId: message?.channelId,
      guildId: message?.guildId ?? null,
    });
    return null;
  }
}

/**
 * Edits a message the bot previously sent.
 *
 * @param {import('discord.js').Message|null} message
 * @param {object} payload
 * @returns {Promise<boolean>}
 */
export async function safeEdit(message, payload) {
  if (!message) return false;

  try {
    await message.edit(payload);
    return true;
  } catch (err) {
    logDeliveryFailure('Message edit', err, { messageId: message?.id, channelId: message?.channelId });
    return false;
  }
}

/**
 * Removes the components from a message, leaving its embeds intact.
 *
 * Called when an interactive flow ends, so stale controls disappear rather than
 * sitting there inviting a click that will be refused.
 *
 * @param {import('discord.js').Message|null} message
 * @returns {Promise<boolean>}
 */
export async function stripComponents(message) {
  return safeEdit(message, { components: [] });
}

/**
 * Reports a failure to the user and records it for operators.
 *
 * The single funnel for anything thrown out of a command or component handler.
 *
 * @param {object} target
 * @param {import('discord.js').RepliableInteraction} [target.interaction]
 * @param {import('discord.js').Message} [target.message]
 * @param {unknown} err
 * @param {Record<string, unknown>} [context] command name, user id, custom id
 * @returns {Promise<void>}
 */
export async function respondWithError({ interaction, message }, err, context = {}) {
  const userMessage = toUserMessage(err);

  if (isUserError(err)) {
    // Invalid input, a foreign resource, a missing record. Expected traffic on a
    // public bot, so it must not pollute the error log that operators watch.
    logger.warn('Command rejected', toLogMeta(err, context));

    if (interaction) {
      await safeRespond(interaction, { embeds: [errorEmbed(userMessage)], components: [] }, { ephemeral: true });
    } else if (message) {
      await replyToMessage(message, { embeds: [errorEmbed(userMessage)] });
    }
    return;
  }

  // A genuine fault. The reference ties the user's screenshot to this log line
  // without revealing anything about the cause.
  const reference = newErrorReference();
  logger.error('Handler error', toLogMeta(err, { ...context, reference }));

  const embed = referencedErrorEmbed(userMessage, reference);

  if (interaction) {
    await safeRespond(interaction, { embeds: [embed], components: [] }, { ephemeral: true });
  } else if (message) {
    await replyToMessage(message, { embeds: [embed] });
  }
}

/**
 * Sends a direct message, reporting whether it arrived.
 *
 * Credentials and signed download URLs are delivered only this way, so callers must
 * be able to distinguish closed DMs from every other failure and fall back to a
 * message that explains the recovery path. The payload is never logged.
 *
 * @param {import('discord.js').User} user
 * @param {object} payload
 * @returns {Promise<{ delivered: boolean, blocked: boolean }>}
 */
export async function trySendDirectMessage(user, payload) {
  try {
    await user.send(payload);
    return { delivered: true, blocked: false };
  } catch (err) {
    const blocked = Number(err?.code) === DM_BLOCKED_CODE;

    logger.warn('Direct message could not be delivered', {
      userId: user?.id,
      blocked,
      code: err?.code ?? null,
    });

    return { delivered: false, blocked };
  }
}
