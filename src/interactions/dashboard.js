// Coded by Aditya | GitHub- @adityatheog

/**
 * Interactive server management dashboard.
 *
 * Renders and drives the control panel behind `server manage`: live status, power
 * controls, rename, container image switching, reinstall and a link to the panel.
 *
 * Layout:
 *
 *   ┌──────────────────────────────────────────┐
 *   │ Managing: My Server                      │
 *   │ • Name: My Server                        │
 *   │ • Type: Node.js                          │
 *   │ • Identifier: `a1b2c3d4`                 │
 *   │                                          │
 *   │ • State: 🟢 Running                       │
 *   │ • Uptime: 2h 14m 3s                      │
 *   │ • CPU: 12.40%                            │
 *   │ • RAM: 384.2 MB                          │
 *   │ • Disk: 1.2 GB                           │
 *   └──────────────────────────────────────────┘
 *   [ Start ] [ Stop ] [ Restart ] [ Refresh ]
 *   [ Rename ] [ Change Image ] [ Reinstall ] [ Open in Panel ]
 *
 * Every action re-resolves ownership through serverService.requireOwnedServer()
 * rather than trusting the session's stored identifier. The session is already
 * owner-bound, so this is belt-and-braces — but it also means a server deleted or
 * transferred while the dashboard was open is refused cleanly instead of producing a
 * confusing panel error.
 *
 * The two destructive actions behave differently from the rest on purpose. Reinstall
 * wipes files, so it requires a separate confirmation step. Power actions and rename
 * are reversible and act immediately.
 *
 * Acknowledgement discipline: every handler either updates the message, defers an
 * ephemeral reply, or shows a modal — exactly one initial response per interaction,
 * always within Discord's three-second window. The status refresh happens after the
 * user-facing reply, so a slow panel cannot cost the acknowledgement.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { EPHEMERAL, safeDeferUpdate, safeEdit } from '../core/reply.js';
import {
  bulletList,
  errorEmbed,
  identifierFooter,
  infoEmbed,
  successEmbed,
  warningEmbed,
} from '../utils/embeds.js';
import { toUserMessage } from '../utils/errors.js';
import {
  formatAllocation,
  formatMegabytes,
  formatPercent,
  formatServerStatus,
  formatUptime,
  sanitiseForDisplay,
} from '../utils/format.js';
import { logger } from '../utils/logger.js';
import { actionFromCustomId, buildCustomId } from '../utils/sessions.js';

/** Namespace prefixing every dashboard component's custom id. */
export const DASHBOARD_NS = 'dash';

/** How long a modal stays open before the submission is abandoned. */
const MODAL_TIMEOUT_MS = 120_000;

/** How long a nested confirmation or image picker waits. */
const CONFIRM_TIMEOUT_MS = 60_000;

/** Titles used for each power action's success embed. */
const POWER_TITLES = Object.freeze({
  start: 'Server Starting',
  stop: 'Server Stopping',
  restart: 'Server Restarted',
  kill: 'Server Killed',
});

/**
 * Builds the status embed.
 *
 * The live statistics read is best-effort. A node that is unreachable, or a server
 * that has never booted, must still produce a usable dashboard — the controls are
 * what the user came for, and refusing to render because a metric is missing would
 * make the command useless exactly when it is most needed.
 *
 * @param {object} input
 * @param {import('../services/serverService.js').ServerService} input.serverService
 * @param {object} input.server the local server row
 * @returns {Promise<import('discord.js').EmbedBuilder>}
 */
export async function buildDashboard({ serverService, server }) {
  const eggLabel = serverService.config.eggs[server.egg_type]?.label ?? server.egg_type;

  let statusBlock;
  let allocationLine = null;

  try {
    const { panel, resources, allocations } = await serverService.info({
      discordId: server.discord_id,
      identifier: server.identifier,
    });

    statusBlock = bulletList([
      ['State', formatServerStatus(panel, resources?.state)],
      ['Uptime', formatUptime(resources?.uptimeMs)],
      ['CPU', formatPercent(resources?.cpuPercent)],
      ['RAM', formatMegabytes(resources?.memoryBytes)],
      ['Disk', formatMegabytes(resources?.diskBytes)],
    ]);

    const primary = allocations.find((allocation) => allocation.primary) ?? allocations[0];
    if (primary) allocationLine = formatAllocation(primary);
  } catch (err) {
    logger.warn('Dashboard status unavailable', {
      identifier: server.identifier,
      code: err?.code ?? null,
      status: err?.status ?? null,
    });
    statusBlock = '• State: Unavailable (the panel did not return live statistics)';
  }

  const details = bulletList([
    // The stored name came from the bot's validator, but a rename made directly in
    // the panel has not, so it is neutralised for display.
    ['Name', sanitiseForDisplay(server.name, 64)],
    ['Type', eggLabel],
    ['Identifier', `\`${server.identifier}\``],
    ['Address', allocationLine],
  ]);

  return infoEmbed(
    `Managing: ${sanitiseForDisplay(server.name, 64)}`,
    [details, '', statusBlock].join('\n'),
    identifierFooter(server.identifier),
  );
}

/**
 * Builds the dashboard's component rows.
 *
 * Change Image is disabled when the egg type has no configured alternatives, rather
 * than hidden, so the row layout stays stable and the reason is discoverable.
 *
 * @param {object} input
 * @param {{ id: string }} input.session
 * @param {object} input.server
 * @param {import('../services/serverService.js').ServerService} input.serverService
 * @param {boolean} [input.disabled] renders every control inert, for the timeout state
 * @returns {ActionRowBuilder[]}
 */
export function buildDashboardRows({ session, server, serverService, disabled = false }) {
  const id = (action) => buildCustomId(DASHBOARD_NS, action, session.id);
  const hasImages = serverService.imageChoicesFor(server).length > 0;

  const powerRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id('start'))
      .setLabel('Start')
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(id('stop'))
      .setLabel('Stop')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(id('restart'))
      .setLabel('Restart')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(id('refresh'))
      .setLabel('Refresh')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
  );

  const manageRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(id('rename'))
      .setLabel('Rename')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled),
    new ButtonBuilder()
      .setCustomId(id('image'))
      .setLabel('Change Image')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled || !hasImages),
    new ButtonBuilder()
      .setCustomId(id('reinstall'))
      .setLabel('Reinstall')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(disabled),
    // A link button carries no custom id and cannot be disabled. The URL is built
    // from the configured panel origin plus a revalidated identifier, so it can
    // never point anywhere else.
    new ButtonBuilder()
      .setLabel('Open in Panel')
      .setStyle(ButtonStyle.Link)
      .setURL(serverService.panelUrlFor(server.identifier)),
  );

  return [powerRow, manageRow];
}

/**
 * Re-renders the dashboard in place.
 *
 * Called after every state-changing action so the panel reflects reality without the
 * user pressing Refresh. Failures are swallowed: the action itself already succeeded
 * and was reported, so a stale display is a cosmetic problem.
 *
 * @param {object} input
 * @param {{ id: string, ownerId: string, data: Record<string, unknown> }} input.session
 * @param {import('../services/serverService.js').ServerService} input.serverService
 * @param {import('discord.js').Message} input.prompt
 * @returns {Promise<void>}
 */
async function refreshDashboard({ session, serverService, prompt }) {
  try {
    const server = serverService.requireOwnedServer(session.ownerId, session.data.identifier);
    const embed = await buildDashboard({ serverService, server });
    const rows = buildDashboardRows({ session, server, serverService });

    await safeEdit(prompt, { embeds: [embed], components: rows });
  } catch (err) {
    logger.debug('Could not refresh the dashboard', {
      identifier: session.data.identifier,
      code: err?.code ?? null,
    });
  }
}

/**
 * Handles a power button.
 *
 * The result is reported ephemerally so a shared channel does not accumulate one
 * public message per button press.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function handlePower({ interaction, session, serverService, prompt, signal }) {
  // Deferred first: the service reads server state before sending the signal, which
  // is two panel round trips and can exceed the acknowledgement window.
  await interaction.deferReply({ ...EPHEMERAL });

  const { server } = await serverService.power({
    discordId: session.ownerId,
    identifier: session.data.identifier,
    signal,
  });

  await interaction.editReply({
    embeds: [
      successEmbed(
        POWER_TITLES[signal] ?? 'Power Action Sent',
        bulletList([
          ['Server', sanitiseForDisplay(server.name, 64)],
          ['Action', signal],
        ]),
        identifierFooter(server.identifier),
      ),
    ],
  });

  await refreshDashboard({ session, serverService, prompt });
}

/**
 * Handles the Rename button.
 *
 * showModal is itself the interaction's acknowledgement, so nothing may be deferred
 * or replied beforehand. The submission arrives as a separate interaction with its
 * own three-second window, which is why the service call happens after deferring
 * that one.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function handleRename({ interaction, session, serverService, prompt }) {
  const modalId = buildCustomId(DASHBOARD_NS, 'renameModal', session.id);

  const modal = new ModalBuilder()
    .setCustomId(modalId)
    .setTitle('Rename Server')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('serverName')
          .setLabel('New server name')
          .setStyle(TextInputStyle.Short)
          .setMinLength(3)
          .setMaxLength(32)
          .setPlaceholder('My Server')
          .setRequired(true),
      ),
    );

  await interaction.showModal(modal);

  /** @type {import('discord.js').ModalSubmitInteraction} */
  let submission;
  try {
    submission = await interaction.awaitModalSubmit({
      time: MODAL_TIMEOUT_MS,
      // Ownership is re-checked on the modal itself: a modal submission is a fresh
      // interaction and inherits no authorisation from the button that opened it.
      filter: (candidate) => candidate.customId === modalId && candidate.user.id === session.ownerId,
    });
  } catch {
    // Dismissed or timed out. Nothing to clean up; the dashboard is untouched.
    return;
  }

  await submission.deferReply({ ...EPHEMERAL });

  try {
    const { name, previousName } = await serverService.rename({
      discordId: session.ownerId,
      identifier: session.data.identifier,
      name: submission.fields.getTextInputValue('serverName'),
    });

    await submission.editReply({
      embeds: [
        successEmbed(
          'Server Renamed',
          bulletList([
            ['Previous name', sanitiseForDisplay(previousName, 64)],
            ['New name', sanitiseForDisplay(name, 64)],
          ]),
        ),
      ],
    });

    await refreshDashboard({ session, serverService, prompt });
  } catch (err) {
    logger.warn('Rename failed', {
      identifier: session.data.identifier,
      code: err?.code ?? null,
      status: err?.status ?? null,
    });
    await submission.editReply({ embeds: [errorEmbed(toUserMessage(err))] });
  }
}

/**
 * Handles the Change Image button.
 *
 * The select menu's values are indices into the allowlist rather than image strings,
 * so no container reference ever returns from the client. serverService revalidates
 * the resolved image against the same allowlist regardless.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function handleImage({ interaction, session, serverService, prompt }) {
  const server = serverService.requireOwnedServer(session.ownerId, session.data.identifier);
  const choices = serverService.imageChoicesFor(server);

  if (choices.length === 0) {
    await interaction.reply({
      embeds: [
        errorEmbed(
          `No alternative container images are configured for the "${server.egg_type}" server type. An administrator can add them in config.json.`,
        ),
      ],
      ...EPHEMERAL,
    });
    return;
  }

  const selectId = buildCustomId(DASHBOARD_NS, 'imagePick', session.id);

  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(selectId)
      .setPlaceholder('Choose a container image')
      .addOptions(
        choices.slice(0, 25).map((choice, index) => ({
          label: choice.label.slice(0, 100),
          value: String(index),
          description: choice.image.slice(0, 100),
        })),
      ),
  );

  await interaction.reply({
    embeds: [
      infoEmbed(
        'Change Image',
        'Select the container image to apply. The server must be restarted before the change takes effect.',
      ),
    ],
    components: [row],
    ...EPHEMERAL,
  });

  // fetchReply resolves the ephemeral message so a component collector can attach.
  const reply = await interaction.fetchReply();

  /** @type {import('discord.js').StringSelectMenuInteraction} */
  let pick;
  try {
    pick = await reply.awaitMessageComponent({
      time: CONFIRM_TIMEOUT_MS,
      filter: (candidate) => candidate.customId === selectId && candidate.user.id === session.ownerId,
    });
  } catch {
    await interaction
      .editReply({
        embeds: [warningEmbed('Timed Out', 'Image selection timed out. Press Change Image again.')],
        components: [],
      })
      .catch(() => {});
    return;
  }

  await pick.deferUpdate();

  try {
    const index = Number(pick.values?.[0]);
    const choice = choices[index];

    if (!choice) {
      // Only reachable through a crafted value; the menu cannot produce it.
      throw new Error(`invalid image index: ${pick.values?.[0]}`);
    }

    const { image } = await serverService.changeImage({
      discordId: session.ownerId,
      identifier: session.data.identifier,
      image: choice.image,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          'Image Changed',
          bulletList([
            ['Image', `\`${image}\``],
            ['Next step', 'Restart the server to apply the change.'],
          ]),
        ),
      ],
      components: [],
    });

    await refreshDashboard({ session, serverService, prompt });
  } catch (err) {
    logger.warn('Image change failed', {
      identifier: session.data.identifier,
      code: err?.code ?? null,
      status: err?.status ?? null,
    });
    await interaction
      .editReply({ embeds: [errorEmbed(toUserMessage(err))], components: [] })
      .catch(() => {});
  }
}

/**
 * Handles the Reinstall button.
 *
 * Reinstalling deletes the server's files and reruns the install script, so it is
 * gated behind an explicit confirmation. The confirmation is ephemeral and
 * owner-filtered, so nobody else can confirm it.
 *
 * @param {object} input
 * @returns {Promise<void>}
 */
async function handleReinstall({ interaction, session, serverService, prompt }) {
  const confirmId = buildCustomId(DASHBOARD_NS, 'reinstallYes', session.id);
  const cancelId = buildCustomId(DASHBOARD_NS, 'reinstallNo', session.id);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel('Reinstall').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(cancelId).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );

  await interaction.reply({
    embeds: [
      warningEmbed(
        'Confirm Reinstall',
        [
          'Reinstalling **deletes every file on the server** and reruns the install script.',
          'This cannot be undone.',
          '',
          'Press **Reinstall** within 60 seconds to confirm.',
        ].join('\n'),
      ),
    ],
    components: [row],
    ...EPHEMERAL,
  });

  const reply = await interaction.fetchReply();

  /** @type {import('discord.js').ButtonInteraction} */
  let confirmation;
  try {
    confirmation = await reply.awaitMessageComponent({
      time: CONFIRM_TIMEOUT_MS,
      filter: (candidate) =>
        [confirmId, cancelId].includes(candidate.customId) && candidate.user.id === session.ownerId,
    });
  } catch {
    // Timing out is the safe outcome for a destructive action.
    await interaction
      .editReply({
        embeds: [warningEmbed('Timed Out', 'Reinstall confirmation timed out. The server was not reinstalled.')],
        components: [],
      })
      .catch(() => {});
    return;
  }

  await confirmation.deferUpdate();

  if (confirmation.customId === cancelId) {
    await interaction.editReply({
      embeds: [successEmbed('Cancelled', 'The server was **not** reinstalled.')],
      components: [],
    });
    return;
  }

  try {
    const server = await serverService.reinstall({
      discordId: session.ownerId,
      identifier: session.data.identifier,
    });

    await interaction.editReply({
      embeds: [
        successEmbed(
          'Reinstall Started',
          bulletList([
            ['Server', sanitiseForDisplay(server.name, 64)],
            ['Identifier', `\`${server.identifier}\``],
            ['Note', 'The server will be unavailable until the installation finishes.'],
          ]),
        ),
      ],
      components: [],
    });

    await refreshDashboard({ session, serverService, prompt });
  } catch (err) {
    logger.warn('Reinstall failed', {
      identifier: session.data.identifier,
      code: err?.code ?? null,
      status: err?.status ?? null,
    });
    await interaction.editReply({ embeds: [errorEmbed(toUserMessage(err))], components: [] });
  }
}

/**
 * Routes one dashboard component interaction.
 *
 * Ownership has already been verified by the caller's collector, and each handler
 * re-resolves the server through requireOwnedServer().
 *
 * @param {object} input
 * @param {import('discord.js').MessageComponentInteraction} input.interaction
 * @param {{ id: string, ownerId: string, data: Record<string, unknown> }} input.session
 * @param {import('../services/serverService.js').ServerService} input.serverService
 * @param {import('discord.js').Message} input.prompt the dashboard message
 * @returns {Promise<void>}
 */
export async function handleDashboardInteraction({ interaction, session, serverService, prompt }) {
  const action = actionFromCustomId(interaction.customId);

  try {
    switch (action) {
      case 'start':
      case 'stop':
      case 'restart':
        await handlePower({ interaction, session, serverService, prompt, signal: action });
        break;

      case 'refresh':
        // deferUpdate acknowledges without changing anything, then the edit follows.
        await safeDeferUpdate(interaction);
        await refreshDashboard({ session, serverService, prompt });
        break;

      case 'rename':
        await handleRename({ interaction, session, serverService, prompt });
        break;

      case 'image':
        await handleImage({ interaction, session, serverService, prompt });
        break;

      case 'reinstall':
        await handleReinstall({ interaction, session, serverService, prompt });
        break;

      default:
        logger.warn('Unknown dashboard action', { action, customId: interaction.customId });
        await interaction
          .reply({ embeds: [errorEmbed('That control is no longer available.')], ...EPHEMERAL })
          .catch(() => {});
    }
  } catch (err) {
    logger.error('Dashboard action failed', {
      action,
      identifier: session.data.identifier,
      userId: interaction.user.id,
      code: err?.code ?? null,
      status: err?.status ?? null,
      message: err?.message ?? String(err),
    });

    const payload = { embeds: [errorEmbed(toUserMessage(err))], components: [] };

    // The handler may or may not have acknowledged before failing, so both paths
    // are covered rather than assumed.
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(payload).catch(() => {});
    } else {
      await interaction.reply({ ...payload, ...EPHEMERAL }).catch(() => {});
    }
  }
}

export { CONFIRM_TIMEOUT_MS, MODAL_TIMEOUT_MS, POWER_TITLES };
