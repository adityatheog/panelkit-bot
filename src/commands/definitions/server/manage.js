// Coded by Aditya | GitHub- @adityatheog

/**
 * Opens the interactive management dashboard for a server.
 *
 * The rendering and the action handlers live in src/interactions/dashboard.js. This
 * file is responsible for choosing which server to manage, creating the session, and
 * owning the collector lifecycle.
 *
 * Server selection has three cases:
 *
 *   An identifier was supplied      Ownership is resolved and that server is opened.
 *   The user owns exactly one       That server is opened without asking.
 *   The user owns several           A select menu is shown first.
 *
 * The single-server shortcut matters because FREE_SERVER_LIMIT is normally one, which
 * makes a selection prompt pure friction for the overwhelming majority of invocations.
 *
 * The dashboard's TTL is longer than the other interactive flows here — five minutes
 * rather than two — because a user watching a server start and then restarting it is
 * doing something legitimate that takes time. It is refreshed on each interaction, up
 * to a cap, so an active session does not expire underneath someone.
 *
 * Ownership is verified twice by design: once here when the session is created, and
 * again inside every dashboard action through requireOwnedServer(). The session is
 * already owner-bound, so the second check is redundant against a foreign user — but it
 * catches a server deleted or transferred while the dashboard sat open, which would
 * otherwise produce a confusing panel error rather than a clean refusal.
 */

import { ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { EPHEMERAL, safeEdit } from '../../../core/reply.js';
import {
  buildDashboard,
  buildDashboardRows,
  handleDashboardInteraction,
} from '../../../interactions/dashboard.js';
import {
  bulletList,
  errorEmbed,
  foreignMenuEmbed,
  infoEmbed,
  joinSections,
  timedOutEmbed,
} from '../../../utils/embeds.js';
import { formatStateWithIcon, pluralise, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';
import { createSession, deleteSession, touchSession } from '../../../utils/sessions.js';

/** Namespace for the server picker shown when a user owns several servers. */
const PICKER_NS = 'srvpick';

/** How long the dashboard stays interactive without use. */
const DASHBOARD_TTL_MS = 5 * 60_000;

/** Ceiling on session extension, so an idle-refreshed dashboard cannot live forever. */
const MAX_LIFETIME_MS = 20 * 60_000;

/** How long the server picker waits before expiring. */
const PICKER_TTL_MS = 120_000;

/**
 * Builds the server picker.
 *
 * @param {string} sessionId
 * @param {Array<object>} servers rows with a `state` field attached
 * @param {Readonly<object>} config
 * @param {boolean} [disabled]
 * @returns {ActionRowBuilder}
 */
function buildPickerRow(sessionId, servers, config, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${PICKER_NS}:pick:${sessionId}`)
      .setPlaceholder('Choose a server to manage')
      .setDisabled(disabled)
      .addOptions(
        servers.slice(0, 25).map((server) => ({
          label: sanitiseForDisplay(server.name, 100) || server.identifier,
          // The identifier is the value, and it is revalidated on selection.
          value: server.identifier,
          description: `${config.eggs[server.egg_type]?.label ?? server.egg_type} • ${server.identifier}`.slice(0, 100),
        })),
      ),
  );
}

/**
 * Attaches the dashboard to a message and drives it until it expires.
 *
 * Shared by both entry paths so the collector logic exists once.
 *
 * @param {object} input
 * @param {object} input.ctx
 * @param {object} input.server the local server row
 * @param {import('discord.js').Message} input.anchor the message hosting the dashboard
 * @returns {Promise<void>}
 */
async function attachDashboard({ ctx, server, anchor }) {
  const session = createSession(
    ctx.user.id,
    { identifier: server.identifier },
    DASHBOARD_TTL_MS,
  );

  const openedAt = Date.now();

  const embed = await buildDashboard({ serverService: ctx.serverService, server });
  const rows = buildDashboardRows({ session, server, serverService: ctx.serverService });

  await safeEdit(anchor, { embeds: [embed], components: rows });

  const collector = anchor.createMessageComponentCollector({
    time: DASHBOARD_TTL_MS,
    filter: (interaction) => interaction.customId.endsWith(`:${session.id}`),
  });

  collector.on('collect', async (interaction) => {
    // Discord's UI visibility is not an authorisation boundary: anyone who can see
    // this message can send its component interactions.
    if (interaction.user.id !== session.ownerId) {
      await interaction.reply({ embeds: [foreignMenuEmbed()], ...EPHEMERAL }).catch(() => {});
      return;
    }

    await handleDashboardInteraction({
      interaction,
      session,
      serverService: ctx.serverService,
      prompt: anchor,
    });

    /**
     * Extend on use, capped. A user who starts a server, waits for it to boot and then
     * restarts it should not lose the dashboard partway through; equally, a dashboard
     * kept alive by periodic clicking should not hold a session slot indefinitely.
     */
    if (Date.now() - openedAt < MAX_LIFETIME_MS) {
      touchSession(session.id, DASHBOARD_TTL_MS);
      collector.resetTimer({ time: DASHBOARD_TTL_MS });
    }
  });

  collector.on('end', async (_collected, reason) => {
    deleteSession(session.id);

    // Only a timeout needs cleanup; other reasons mean the message is gone or was
    // deliberately replaced.
    if (reason !== 'time') return;

    /**
     * The controls are disabled rather than removed, so an expired dashboard still
     * shows what it offered. Rebuilt from the local row rather than re-reading the
     * panel: this runs on a timer with no user waiting, and a panel request here would
     * be a request nobody asked for.
     */
    await safeEdit(anchor, {
      embeds: [timedOutEmbed()],
      components: buildDashboardRows({
        session,
        server,
        serverService: ctx.serverService,
        disabled: true,
      }),
    });
  });
}

export default {
  name: 'server manage',
  category: 'Server',
  description: 'Open a management panel for your server',
  details:
    'Opens an interactive dashboard with live status and controls for starting, stopping and restarting the server, renaming it, changing its container image, reinstalling it, and opening it in the panel. Defaults to your only server, or asks which one when you own several.',

  guildOnly: true,
  aliases: ['server panel', 'manage'],
  examples: ['server manage', 'server manage a1b2c3d4'],

  options: [
    {
      name: 'server',
      type: 'string',
      description: 'The 8-character server identifier. Omit to choose.',
      required: false,
      minLength: 8,
      maxLength: 8,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    const owned = ctx.serverService.listServers(ctx.user.id);

    if (owned.length === 0) {
      const hasAccount = ctx.accountService.hasAccount(ctx.user.id);

      await ctx.respond({
        embeds: [
          errorEmbed(
            hasAccount
              ? joinSections([
                  'You do not own any servers to manage.',
                  '',
                  `Create one with \`${ctx.env.prefix}server create\`.`,
                ])
              : joinSections([
                  'You do not have a panel account yet.',
                  '',
                  `Run \`${ctx.env.prefix}account create\` to get started.`,
                ]),
          ),
        ],
      });
      return;
    }

    // ------------------------------------------- explicit identifier, or only one

    if (ctx.args.server || owned.length === 1) {
      // requireOwnedServer validates and authorises; a bad or foreign identifier is
      // refused by the router's error funnel before anything is rendered.
      const server = ctx.args.server
        ? ctx.serverService.requireOwnedServer(ctx.user.id, ctx.args.server)
        : owned[0];

      // The dashboard reads live state, so acknowledge before building it.
      await ctx.defer();
      await ctx.respond({ embeds: [infoEmbed('Loading…', 'Reading server status from the panel.')] });

      const anchor = await ctx.anchorMessage();
      if (!anchor) {
        logger.debug('Dashboard could not be delivered', {
          discordId: ctx.user.id,
          identifier: server.identifier,
        });
        return;
      }

      await attachDashboard({ ctx, server, anchor });
      return;
    }

    // ----------------------------------------------------------- server selection

    await ctx.defer();

    // Live state on the picker so a user with several servers can tell them apart by
    // more than name. Best-effort; unknown states still render.
    const withState = await ctx.serverService.listWithState(ctx.user.id, { max: 25 });

    const pickerSession = createSession(ctx.user.id, {}, PICKER_TTL_MS);

    await ctx.respond({
      embeds: [
        infoEmbed(
          'Manage a Server',
          joinSections([
            `You own ${pluralise(owned.length, 'server')}. Choose which one to manage.`,
            '',
            withState
              .slice(0, 10)
              .map(
                (server) =>
                  `• **${sanitiseForDisplay(server.name, 48)}** — \`${server.identifier}\` — ${formatStateWithIcon(server.state)}`,
              )
              .join('\n'),
          ]),
        ),
      ],
      components: [buildPickerRow(pickerSession.id, withState, ctx.config)],
    });

    const anchor = await ctx.anchorMessage();
    if (!anchor) {
      deleteSession(pickerSession.id);
      logger.debug('Server picker could not be delivered', { discordId: ctx.user.id });
      return;
    }

    const picker = anchor.createMessageComponentCollector({
      time: PICKER_TTL_MS,
      filter: (interaction) => interaction.customId.endsWith(`:${pickerSession.id}`),
    });

    picker.on('collect', async (interaction) => {
      if (interaction.user.id !== pickerSession.ownerId) {
        await interaction.reply({ embeds: [foreignMenuEmbed()], ...EPHEMERAL }).catch(() => {});
        return;
      }

      /**
       * The selected identifier is revalidated through requireOwnedServer rather than
       * trusted. The menu can only offer the user's own servers, but the value arrives
       * from the client and a crafted one must not reach the panel.
       */
      let server;
      try {
        server = ctx.serverService.requireOwnedServer(pickerSession.ownerId, interaction.values?.[0]);
      } catch {
        await interaction.deferUpdate().catch(() => {});
        return;
      }

      // The picker is spent. Its session is dropped before the dashboard's is created,
      // so the two never coexist on the same message.
      deleteSession(pickerSession.id);
      picker.stop('picked');

      // update() acknowledges and clears the picker in one call, keeping this inside
      // the three-second window before the dashboard's panel reads begin.
      await interaction
        .update({
          embeds: [infoEmbed('Loading…', 'Reading server status from the panel.')],
          components: [],
        })
        .catch(() => {});

      await attachDashboard({ ctx, server, anchor });
    });

    picker.on('end', async (_collected, reason) => {
      deleteSession(pickerSession.id);

      // 'picked' means the dashboard took over this message; leave it alone.
      if (reason !== 'time') return;

      await safeEdit(anchor, {
        embeds: [timedOutEmbed()],
        components: [buildPickerRow(pickerSession.id, withState, ctx.config, true)],
      });
    });
  },
};
