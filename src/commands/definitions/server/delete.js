import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { EPHEMERAL, safeEdit } from '../../../core/reply.js';
import {
  bulletList,
  errorEmbed,
  foreignMenuEmbed,
  identifierFooter,
  joinSections,
  successEmbed,
  timedOutEmbed,
  warningEmbed,
} from '../../../utils/embeds.js';
import { toUserMessage } from '../../../utils/errors.js';
import { formatServerStatus, pluralise, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';
import { actionFromCustomId, createSession, deleteSession } from '../../../utils/sessions.js';

const NS = 'srvdel';

const CONFIRM_TTL_MS = 120_000;

function buildConfirmRow(sessionId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${NS}:confirm:${sessionId}`)
      .setLabel('Delete Server')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(`${NS}:cancel:${sessionId}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );
}

export default {
  name: 'server delete',
  category: 'Server',
  description: 'Delete one of your servers',
  details:
    'Permanently deletes a server and every file on it. Requires an explicit confirmation. This frees a slot against your server limit and cannot be undone.',

  guildOnly: true,
  aliases: ['server remove', 'server destroy'],
  examples: ['server delete a1b2c3d4'],

  options: [
    {
      name: 'server',
      type: 'string',
      description: 'The 8-character server identifier',
      required: true,
      minLength: 8,
      maxLength: 8,
    },
  ],

  async execute(ctx) {
    await ctx.defer();

    const server = ctx.serverService.requireOwnedServer(ctx.user.id, ctx.args.server);

    const eggLabel = ctx.config.eggs[server.egg_type]?.label ?? server.egg_type;

    let stateLine = null;
    try {
      const { panel, resources } = await ctx.serverService.info({
        discordId: ctx.user.id,
        identifier: server.identifier,
      });
      stateLine = formatServerStatus(panel, resources?.state);
    } catch (err) {
      logger.debug('Could not read server state for the deletion prompt', {
        identifier: server.identifier,
        code: err?.code ?? null,
      });
    }

    const remainingAfter = Math.max(0, ctx.serverService.listServers(ctx.user.id).length - 1);

    const session = createSession(
      ctx.user.id,
      { identifier: server.identifier, name: server.name },
      CONFIRM_TTL_MS,
    );

    await ctx.respond({
      embeds: [
        warningEmbed(
          'Confirm Server Deletion',
          joinSections([
            'This permanently deletes the following server and **every file on it**:',
            '',
            bulletList([
              ['Name', sanitiseForDisplay(server.name, 64)],
              ['Type', eggLabel],
              ['Identifier', `\`${server.identifier}\``],
              ['Current state', stateLine],
            ]),
            '',
            '**This cannot be undone.** Back up anything you need first with '
              + `\`${ctx.env.prefix}files backup ${server.identifier}\`.`,
            '',
            'Press **Delete Server** within 2 minutes to confirm.',
          ]),
          identifierFooter(server.identifier),
        ),
      ],
      components: [buildConfirmRow(session.id)],
    });

    const anchor = await ctx.anchorMessage();
    if (!anchor) {

      deleteSession(session.id);
      logger.debug('Server deletion prompt could not be delivered', {
        discordId: ctx.user.id,
        identifier: server.identifier,
      });
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
            embeds: [
              successEmbed(
                'Cancelled',
                `**${sanitiseForDisplay(session.data.name, 64)}** was **not** deleted.`,
              ),
            ],
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
          embeds: [warningEmbed('Deleting…', 'Removing the server from the panel. Please wait.')],
          components: [],
        })
        .catch(() => {});

      try {
        const deleted = await ctx.serverService.deleteServer({
          discordId: session.ownerId,
          identifier: session.data.identifier,
        });

        await interaction.editReply({
          embeds: [
            successEmbed(
              'Server Deleted',
              joinSections([
                bulletList([
                  ['Name', sanitiseForDisplay(deleted.name, 64)],
                  ['Identifier', `\`${deleted.identifier}\``],
                  ['Servers remaining', `${remainingAfter} of ${ctx.env.freeServerLimit}`],
                ]),
                '',
                remainingAfter < ctx.env.freeServerLimit
                  ? `You can create another with \`${ctx.env.prefix}server create\`.`
                  : '',
              ]),
            ),
          ],
          components: [],
        });
      } catch (err) {
        logger.error('Server deletion failed', {
          discordId: session.ownerId,
          identifier: session.data.identifier,
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
