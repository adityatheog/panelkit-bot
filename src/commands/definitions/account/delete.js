// Coded by Aditya | GitHub- @adityatheog

/**
 * Deletes the invoking user's panel account and every server they own.
 *
 * The most destructive command in the project, and the confirmation flow reflects
 * that. Three properties are enforced here:
 *
 * Nothing is deleted before an explicit confirmation. The command's first act is to
 * show the user exactly what will be destroyed — every server by name and
 * identifier — because "delete my account" and "delete my four servers" are not the
 * same decision in most people's heads.
 *
 * The confirmation is owner-bound and single-use. The button carries only a session
 * token; ownership is verified in the handler, and the session is destroyed the
 * moment the flow resolves, so a confirmation cannot be replayed by pressing the
 * button twice.
 *
 * Success is never reported unless it happened. accountService aborts with nothing
 * changed if any server fails to delete, and this command surfaces that failure
 * verbatim rather than converting it into a partial success. A user who reads
 * "Account Deleted" must be able to trust that their servers stopped consuming
 * resources.
 *
 * Cooldowns and sessions are cleared afterwards, so a user who deletes and
 * re-registers is not held to a cooldown belonging to an account that no longer
 * exists, and no open menu still references removed servers.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { EPHEMERAL, safeEdit } from '../../../core/reply.js';
import {
  bulletList,
  errorEmbed,
  foreignMenuEmbed,
  joinSections,
  successEmbed,
  timedOutEmbed,
  warningEmbed,
} from '../../../utils/embeds.js';
import { toUserMessage } from '../../../utils/errors.js';
import { pluralise, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';
import {
  actionFromCustomId,
  createSession,
  deleteSession,
  deleteSessionsForOwner,
} from '../../../utils/sessions.js';

/** Namespace prefixing this flow's component custom ids. */
const NS = 'acctdel';

/** How long the confirmation stays live. */
const CONFIRM_TTL_MS = 120_000;

/** How many servers are listed individually before the rest are summarised. */
const MAX_LISTED_SERVERS = 10;

/**
 * Builds the confirmation buttons.
 *
 * Delete is styled Danger and placed first, matching the platform convention, but the
 * flow requires a deliberate press either way — there is no default action on timeout.
 *
 * @param {string} sessionId
 * @param {boolean} [disabled]
 * @returns {ActionRowBuilder}
 */
function buildConfirmRow(sessionId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${NS}:confirm:${sessionId}`)
      .setLabel('Delete Everything')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${NS}:cancel:${sessionId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

/**
 * Renders the list of servers that will be destroyed.
 *
 * Names come from the local record but may have been changed directly in the panel,
 * so they are neutralised for display.
 *
 * @param {object[]} servers
 * @returns {string}
 */
function renderServerList(servers) {
  if (servers.length === 0) return '_You have no servers._';

  const listed = servers
    .slice(0, MAX_LISTED_SERVERS)
    .map((server) => `• **${sanitiseForDisplay(server.name, 48)}** — \`${server.identifier}\``);

  if (servers.length > MAX_LISTED_SERVERS) {
    listed.push(`• _and ${servers.length - MAX_LISTED_SERVERS} more_`);
  }

  return listed.join('\n');
}

export default {
  name: 'account delete',
  category: 'Account',
  description: 'Delete your Pterodactyl panel account and all associated servers',
  details:
    'Permanently deletes your panel account together with every server you own. Requires an explicit confirmation. Servers are removed from the panel first; if any of them cannot be removed, nothing is deleted and you are told to try again. This cannot be undone.',

  guildOnly: true,
  aliases: ['account remove'],
  examples: ['account delete'],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    const account = ctx.accountService.getAccount(ctx.user.id);

    if (!account) {
      await ctx.respond(
        { embeds: [errorEmbed('You do not have a panel account to delete.')] },
        { ephemeral: true },
      );
      return;
    }

    const servers = ctx.serverService.listServers(ctx.user.id);

    const session = createSession(ctx.user.id, { panelUserId: account.panel_id }, CONFIRM_TTL_MS);

    await ctx.respond({
      embeds: [
        warningEmbed(
          'Confirm Account Deletion',
          joinSections([
            'This permanently deletes:',
            '',
            bulletList([
              ['Panel account', `\`${account.username}\``],
              ['Servers', pluralise(servers.length, 'server')],
              ['Credits', account.credits],
            ]),
            '',
            servers.length > 0 ? '**Servers to be destroyed**' : '',
            servers.length > 0 ? renderServerList(servers) : '',
            '',
            '**All server files will be lost. This cannot be undone.**',
            '',
            'Press **Delete Everything** within 2 minutes to confirm.',
          ]),
        ),
      ],
      components: [buildConfirmRow(session.id)],
    });

    const anchor = await ctx.anchorMessage();
    if (!anchor) {
      // The prompt was not delivered, so no confirmation can be collected. The
      // session is dropped rather than left to expire holding a slot.
      deleteSession(session.id);
      logger.debug('Account deletion prompt could not be delivered', { discordId: ctx.user.id });
      return;
    }

    const collector = anchor.createMessageComponentCollector({
      time: CONFIRM_TTL_MS,
      filter: (interaction) => interaction.customId.endsWith(`:${session.id}`),
    });

    collector.on('collect', async (interaction) => {
      // Discord's UI visibility is not an authorisation boundary: anyone who can see
      // this message can send its component interactions.
      if (interaction.user.id !== session.ownerId) {
        await interaction.reply({ embeds: [foreignMenuEmbed()], ...EPHEMERAL }).catch(() => {});
        return;
      }

      const action = actionFromCustomId(interaction.customId);

      if (action === 'cancel') {
        // Destroyed immediately, so the button cannot be pressed again.
        deleteSession(session.id);
        collector.stop('cancelled');

        await interaction
          .update({
            embeds: [successEmbed('Cancelled', 'Your account and servers were **not** deleted.')],
            components: [],
          })
          .catch(() => {});
        return;
      }

      if (action !== 'confirm') {
        // Unrecognised action on a live session: acknowledge, execute nothing.
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      /**
       * The session is destroyed before the work begins, not after. Deletion involves
       * one panel call per server plus one for the account, which can take tens of
       * seconds — long enough for a second press to arrive and start a concurrent
       * deletion. Removing the session first makes the confirmation single-use.
       */
      deleteSession(session.id);
      collector.stop('confirmed');

      // update() both acknowledges and replaces the prompt, keeping this inside the
      // three-second window before any panel work starts.
      await interaction
        .update({
          embeds: [
            warningEmbed(
              'Deleting…',
              joinSections([
                'Removing your servers and panel account.',
                'This can take up to a minute. Please wait.',
              ]),
            ),
          ],
          components: [],
        })
        .catch(() => {});

      try {
        const result = await ctx.accountService.deleteAccount(session.ownerId);

        /**
         * Housekeeping after a successful deletion. Without the cooldown clear, a
         * user who re-registers is refused by a cooldown from the account they just
         * destroyed; without the session clear, an open dashboard still references
         * servers that no longer exist.
         */
        ctx.cooldowns?.clear?.(session.ownerId);
        deleteSessionsForOwner(session.ownerId);

        await interaction.editReply({
          embeds: [
            successEmbed(
              'Account Deleted',
              bulletList([
                ['Servers removed', result.deletedServers],
                [
                  'Already absent',
                  result.alreadyGone > 0 ? `${result.alreadyGone} (deleted outside the bot)` : null,
                ],
                ['Panel account', 'Deleted'],
                ['Start again', `\`${ctx.env.prefix}account create\``],
              ]),
            ),
          ],
          components: [],
        });
      } catch (err) {
        /**
         * accountService aborts with nothing changed when it cannot complete, and its
         * message says so. It is passed through unmodified rather than being softened
         * into a partial success.
         */
        logger.error('Account deletion failed', {
          discordId: session.ownerId,
          panelUserId: account.panel_id,
          code: err?.code ?? null,
          status: err?.status ?? null,
        });

        await interaction
          .editReply({ embeds: [errorEmbed(toUserMessage(err))], components: [] })
          .catch(() => {});
      }
    });

    collector.on('end', async (_collected, reason) => {
      deleteSession(session.id);

      // Only a timeout needs cleanup; the other paths already replaced the message.
      if (reason !== 'time') return;

      // Buttons are disabled rather than removed, so the expired prompt still shows
      // what it was offering instead of becoming an unexplained warning.
      await safeEdit(anchor, {
        embeds: [timedOutEmbed()],
        components: [buildConfirmRow(session.id, true)],
      });
    });
  },
};
