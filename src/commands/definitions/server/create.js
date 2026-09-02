// Coded by Aditya | GitHub- @adityatheog

/**
 * Provisions a new server on the panel.
 *
 * Two invocation styles, both reaching the same service call:
 *
 *   kx!server create                       Interactive: a select menu of server types,
 *                                          then a modal for the name.
 *   kx!server create nodejs My Server       Direct: both values supplied up front.
 *   /server create type:nodejs name:…       Direct, on the slash surface.
 *
 * The interactive path exists because the type keys are operator-defined and nobody
 * memorises them. The direct path exists because repeat users should not have to click
 * through two dialogs. Neither path duplicates logic: both call
 * serverService.createServer(), which owns the limit check, egg validation,
 * environment construction and the orphan-handling on a failed local write.
 *
 * Guards run before any UI is shown. Discovering after two dialogs that you have no
 * account, or that you are already at your server limit, is a waste of the user's
 * time — and every one of those checks is cheap and local. The service repeats them,
 * because the interactive path has a gap of up to four minutes between the check and
 * the provisioning call during which the user could exhaust their limit elsewhere.
 *
 * Provisioning is deliberately not confirmed before it happens. It consumes a limit
 * slot rather than destroying anything, and `server delete` reverses it.
 */

import {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { EPHEMERAL, safeEdit } from '../../../core/reply.js';
import {
  bulletList,
  errorEmbed,
  foreignMenuEmbed,
  identifierFooter,
  infoEmbed,
  joinSections,
  successEmbed,
  timedOutEmbed,
} from '../../../utils/embeds.js';
import { toUserMessage } from '../../../utils/errors.js';
import { formatLimitMb, pluralise, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';
import { createSession, deleteSession } from '../../../utils/sessions.js';

/** Namespace prefixing this flow's component custom ids. */
const NS = 'srvnew';

/** How long the type selector stays live. */
const SELECT_TTL_MS = 120_000;

/** How long the name modal stays open before the submission is abandoned. */
const MODAL_TTL_MS = 240_000;

/**
 * Builds the server type selector.
 *
 * Options come from serverService.listEggChoices(), which excludes any egg with
 * unfilled placeholders. Offering a type that cannot provision would produce a panel
 * 422 after the user has already named their server.
 *
 * @param {string} sessionId
 * @param {Array<{ key: string, label: string }>} choices
 * @param {boolean} [disabled]
 * @returns {ActionRowBuilder}
 */
function buildTypeRow(sessionId, choices, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${NS}:type:${sessionId}`)
      .setPlaceholder('Choose a server type')
      .setDisabled(disabled)
      // Discord accepts at most 25 options; an operator with more configured types
      // than that has bigger problems than this truncation.
      .addOptions(
        choices.slice(0, 25).map((choice) => ({
          label: choice.label.slice(0, 100),
          value: choice.key,
          description: `Type key: ${choice.key}`.slice(0, 100),
        })),
      ),
  );
}

/**
 * Builds the server name modal.
 *
 * The length bounds mirror assertValidServerName, so most bad input is rejected by
 * Discord's own client before a request is sent. The service revalidates regardless.
 *
 * @param {string} modalId
 * @returns {ModalBuilder}
 */
function buildNameModal(modalId) {
  return new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Name Your Server')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('serverName')
          .setLabel('Server name')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(32)
          .setPlaceholder('My Server')
          .setRequired(true),
      ),
    );
}

/**
 * Renders the success embed for a provisioned server.
 *
 * @param {object} ctx
 * @param {object} record the stored server row
 * @returns {import('discord.js').EmbedBuilder}
 */
function buildCreatedEmbed(ctx, record) {
  const limits = ctx.config.defaults.limits;
  const eggLabel = ctx.config.eggs[record.egg_type]?.label ?? record.egg_type;

  return successEmbed(
    'Server Created',
    joinSections([
      bulletList([
        ['Name', sanitiseForDisplay(record.name, 64)],
        ['Type', eggLabel],
        ['Identifier', `\`${record.identifier}\``],
        ['RAM', formatLimitMb(limits.memory)],
        ['Disk', formatLimitMb(limits.disk)],
      ]),
      '',
      bulletList([
        ['Panel', ctx.serverService.panelUrlFor(record.identifier)],
        ['Manage', `\`${ctx.env.prefix}server manage\``],
        ['Start it', `\`${ctx.env.prefix}server power ${record.identifier} start\``],
      ]),
      '',
      '_The server is installing. It cannot be started until installation finishes._',
    ]),
    identifierFooter(record.identifier),
  );
}

export default {
  name: 'server create',
  category: 'Server',
  description: 'Create a new server on the Pterodactyl panel',
  details:
    'Provisions a server against your panel account. Run it with no arguments to pick a type and name interactively, or pass both to create one immediately. The server is created stopped and must finish installing before it can start.',

  guildOnly: true,
  aliases: ['server new'],
  examples: ['server create', 'server create nodejs My Server'],

  options: [
    {
      name: 'type',
      type: 'string',
      description: 'Server type key, for example "nodejs". Omit to choose from a menu.',
      required: false,
      maxLength: 32,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Server name, 3 to 32 characters. Omit to be prompted.',
      required: false,
      // Greedy so a multi-word name needs no quoting on the prefix surface.
      greedy: true,
      maxLength: 32,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // ------------------------------------------------------------------- guards

    if (!ctx.accountService.hasAccount(ctx.user.id)) {
      await ctx.respond({
        embeds: [
          errorEmbed(
            joinSections([
              'You need a panel account before you can create a server.',
              '',
              `Run \`${ctx.env.prefix}account create\` first.`,
            ]),
          ),
        ],
      });
      return;
    }

    const owned = ctx.serverService.listServers(ctx.user.id).length;
    const limit = ctx.env.freeServerLimit;

    if (limit === 0) {
      await ctx.respond({
        embeds: [errorEmbed('Server creation is currently disabled. Contact an administrator.')],
      });
      return;
    }

    if (owned >= limit) {
      await ctx.respond({
        embeds: [
          errorEmbed(
            joinSections([
              `You already own ${pluralise(owned, 'server')}, which is your limit of ${limit}.`,
              '',
              `Delete one with \`${ctx.env.prefix}server delete <identifier>\` or list them with \`${ctx.env.prefix}server list\`.`,
            ]),
          ),
        ],
      });
      return;
    }

    const choices = ctx.serverService.listEggChoices();

    if (choices.length === 0) {
      // Every configured egg still has placeholder values. This is an operator
      // problem, and the message says so rather than blaming the user.
      await ctx.respond({
        embeds: [
          errorEmbed(
            joinSections([
              'No server types are available yet.',
              '',
              'An administrator needs to fill in the `eggs` section of `config.json` with real panel IDs.',
            ]),
          ),
        ],
      });
      return;
    }

    // ----------------------------------------------------------- direct creation

    if (ctx.args.type && ctx.args.name) {
      await ctx.defer();

      const record = await ctx.serverService.createServer({
        discordId: ctx.user.id,
        eggKey: ctx.args.type,
        name: ctx.args.name,
      });

      await ctx.respond({ embeds: [buildCreatedEmbed(ctx, record)] });
      return;
    }

    /**
     * A partial invocation. Rather than silently discarding the supplied value, the
     * missing one is collected interactively — a name given without a type is carried
     * through the selector and used when the modal is skipped.
     */
    const presetName = ctx.args.name ? String(ctx.args.name) : null;
    const presetType = ctx.args.type ? String(ctx.args.type) : null;

    // ------------------------------------------------------ interactive creation

    const session = createSession(ctx.user.id, { presetName, presetType }, SELECT_TTL_MS);

    await ctx.respond({
      embeds: [
        infoEmbed(
          'Create a Server',
          joinSections([
            'Choose the type of server you want to create.',
            '',
            bulletList([
              ['RAM', formatLimitMb(ctx.config.defaults.limits.memory)],
              ['Disk', formatLimitMb(ctx.config.defaults.limits.disk)],
              ['Your servers', `${owned} of ${limit}`],
              ['Name', presetName ? `\`${sanitiseForDisplay(presetName, 64)}\`` : 'You will be asked next'],
            ]),
          ]),
        ),
      ],
      components: [buildTypeRow(session.id, choices)],
    });

    const anchor = await ctx.anchorMessage();
    if (!anchor) {
      deleteSession(session.id);
      logger.debug('Server creation prompt could not be delivered', { discordId: ctx.user.id });
      return;
    }

    const collector = anchor.createMessageComponentCollector({
      time: SELECT_TTL_MS,
      filter: (interaction) => interaction.customId.endsWith(`:${session.id}`),
    });

    collector.on('collect', async (interaction) => {
      // Discord's UI visibility is not an authorisation boundary.
      if (interaction.user.id !== session.ownerId) {
        await interaction.reply({ embeds: [foreignMenuEmbed()], ...EPHEMERAL }).catch(() => {});
        return;
      }

      const eggKey = interaction.values?.[0];

      /**
       * A name was already supplied, so no modal is needed. showModal cannot be used
       * here anyway without an interaction to attach it to — update() acknowledges and
       * replaces the selector in one call, staying inside the three-second window.
       */
      if (session.data.presetName) {
        deleteSession(session.id);
        collector.stop('provisioning');

        await interaction
          .update({
            embeds: [infoEmbed('Creating…', 'Provisioning your server on the panel. This can take a moment.')],
            components: [],
          })
          .catch(() => {});

        try {
          const record = await ctx.serverService.createServer({
            discordId: session.ownerId,
            eggKey,
            name: session.data.presetName,
          });

          await interaction.editReply({ embeds: [buildCreatedEmbed(ctx, record)], components: [] });
        } catch (err) {
          logger.warn('Server creation failed', {
            discordId: session.ownerId,
            eggKey,
            code: err?.code ?? null,
            status: err?.status ?? null,
          });
          await interaction
            .editReply({ embeds: [errorEmbed(toUserMessage(err))], components: [] })
            .catch(() => {});
        }
        return;
      }

      /**
       * showModal is itself this interaction's acknowledgement, so nothing may be
       * deferred or replied beforehand. The submission arrives as a separate
       * interaction with its own three-second window.
       */
      const modalId = `${NS}:name:${session.id}`;
      await interaction.showModal(buildNameModal(modalId));

      // The selector is spent either way, so it stops accepting input now.
      collector.stop('modal');

      /** @type {import('discord.js').ModalSubmitInteraction} */
      let submission;
      try {
        submission = await interaction.awaitModalSubmit({
          time: MODAL_TTL_MS,
          // Ownership is re-checked: a modal submission is a fresh interaction and
          // inherits no authorisation from the select menu that opened it.
          filter: (candidate) =>
            candidate.customId === modalId && candidate.user.id === session.ownerId,
        });
      } catch {
        // Dismissed or timed out. Nothing was created.
        deleteSession(session.id);
        await safeEdit(anchor, { embeds: [timedOutEmbed()], components: [] });
        return;
      }

      deleteSession(session.id);
      await submission.deferReply();

      try {
        const record = await ctx.serverService.createServer({
          discordId: submission.user.id,
          eggKey,
          name: submission.fields.getTextInputValue('serverName'),
        });

        await submission.editReply({ embeds: [buildCreatedEmbed(ctx, record)] });
      } catch (err) {
        logger.warn('Server creation failed', {
          discordId: submission.user.id,
          eggKey,
          code: err?.code ?? null,
          status: err?.status ?? null,
        });
        await submission.editReply({ embeds: [errorEmbed(toUserMessage(err))] });
      } finally {
        // The selector no longer applies, whichever way the modal resolved.
        await safeEdit(anchor, { components: [] });
      }
    });

    collector.on('end', async (_collected, reason) => {
      deleteSession(session.id);

      // Only a plain timeout needs cleanup; the other paths already replaced or
      // cleared the message.
      if (reason !== 'time') return;

      await safeEdit(anchor, {
        embeds: [timedOutEmbed()],
        components: [buildTypeRow(session.id, choices, true)],
      });
    });
  },
};
