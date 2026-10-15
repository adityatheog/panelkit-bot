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

const NS = 'acctdel';

const CONFIRM_TTL_MS = 120_000;

const MAX_LISTED_SERVERS = 10;

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
    'Permanently deletes your panel account together with every server tracked by this bot. Requires an explicit confirmation. If some servers cannot be removed, the account and local records are kept, but servers already removed cannot be restored. This cannot be undone.',

  guildOnly: true,
  aliases: ['account remove'],
  examples: ['account delete'],

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

      deleteSession(session.id);
      logger.debug('Account deletion prompt could not be delivered', { discordId: ctx.user.id });
      return;
    }

    const collector = anchor.createMessageComponentCollector({
      time: CONFIRM_TTL_MS,
      filter: (interaction) => interaction.customId.endsWith(`:${session.id}`),
    });

    collector.on('collect', async (interaction) => {

      if (interaction.user.id !== session.ownerId) {
        await interaction.reply({ embeds: [foreignMenuEmbed()], ...EPHEMERAL }).catch(() => {});
        return;
      }

      const action = actionFromCustomId(interaction.customId);

      if (action === 'cancel') {

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

        await interaction.deferUpdate().catch(() => {});
        return;
      }

      if (!deleteSession(session.id)) {
        await interaction.deferUpdate().catch(() => {});
        return;
      }
      collector.stop('confirmed');

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
        const result = await ctx.accountService.deleteAccount(session.ownerId, {
          expectedPanelId: session.data.panelUserId,
        });

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

      if (reason !== 'time') return;

      await safeEdit(anchor, {
        embeds: [timedOutEmbed()],
        components: [buildConfirmRow(session.id, true)],
      });
    });
  },
};
