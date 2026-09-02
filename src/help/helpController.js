// Coded by Aditya | GitHub- @adityatheog

/**
 * Interactive help menu controller.
 *
 * helpMenu.js renders; this file drives. It owns the session, the collector and the
 * navigation state machine, keeping all of the stateful concerns out of the pure
 * rendering functions so those stay directly testable.
 *
 * The state machine has two views and five transitions:
 *
 *   list  --category-->  list   (reset to page 0)
 *   list  --next/prev--> list   (page moves, category unchanged)
 *   list  --command-->   detail
 *   detail --back-->     list   (returns to the remembered category and page)
 *
 * Everything a transition needs lives in the session, server-side. The custom ids
 * carry only the session token, so a user cannot edit a component to jump to a
 * hidden command or a category that is not theirs to see.
 *
 * Three behaviours worth stating because they are easy to get wrong:
 *
 * Ownership is enforced in the handler, not by Discord. Any user who can see the
 * message can send its component interactions, so a foreign interaction gets an
 * ephemeral refusal rather than being allowed to drive someone else's menu.
 *
 * Every collected interaction is acknowledged exactly once. interaction.update()
 * both acknowledges and edits in a single call, which is what keeps the menu inside
 * the three-second window even when the update is a no-op.
 *
 * The session is extended on each interaction. A user reading through five
 * categories should not have the menu expire underneath them at a fixed two minutes
 * from when it opened.
 */

import { EPHEMERAL, safeDeferUpdate, safeEdit } from '../core/reply.js';
import { foreignMenuEmbed, timedOutEmbed } from '../utils/embeds.js';
import { logger } from '../utils/logger.js';
import { actionFromCustomId, createSession, deleteSession, touchSession } from '../utils/sessions.js';
import { buildCommandDetailView, buildHelpView, DEFAULT_PAGE_SIZE } from './helpMenu.js';

/** How long the menu stays interactive without use. */
const HELP_TTL_MS = 5 * 60_000;

/** Refreshes the session on each interaction, capped so a menu cannot live forever. */
const MAX_LIFETIME_MS = 15 * 60_000;

/**
 * Opens the interactive help menu.
 *
 * Works identically on both surfaces: the context abstracts responding, and the
 * anchor message it returns is what the collector attaches to.
 *
 * @param {object} input
 * @param {object} input.ctx the execution context
 * @param {string} [input.initialCategory] category to open on
 * @returns {Promise<void>}
 */
export async function runHelpMenu({ ctx, initialCategory }) {
  const { registry, env, config } = ctx;

  const pageSize = config?.help?.pageSize ?? DEFAULT_PAGE_SIZE;
  const descriptionMax = config?.help?.descriptionMax;

  // An unrecognised category falls back to the first, matching buildHelpView.
  const startCategory = registry.category(initialCategory)?.name ?? registry.categories[0]?.name;

  if (!startCategory) {
    // Only reachable if the registry loaded zero visible commands, which
    // loadRegistry already refuses. Guarded so the menu cannot render an
    // undefined category.
    logger.error('Help menu opened with no categories available');
    return;
  }

  const session = createSession(
    ctx.user.id,
    { category: startCategory, page: 0, view: 'list' },
    HELP_TTL_MS,
  );

  const openedAt = Date.now();

  /**
   * Renders the listing for the session's current position.
   *
   * @returns {ReturnType<typeof buildHelpView>}
   */
  const renderList = () =>
    buildHelpView({
      registry,
      prefix: env.prefix,
      categoryName: session.data.category,
      page: session.data.page,
      sessionId: session.id,
      pageSize,
      descriptionMax,
    });

  const initial = renderList();
  await ctx.respond({ embeds: [initial.embed], components: initial.components });

  const anchor = await ctx.anchorMessage();
  if (!anchor) {
    // The reply could not be delivered, so there is nothing to collect on. The
    // session is dropped immediately rather than left to expire.
    deleteSession(session.id);
    logger.debug('Help menu could not attach a collector; no anchor message', { userId: ctx.user.id });
    return;
  }

  const collector = anchor.createMessageComponentCollector({
    time: HELP_TTL_MS,
    // Only components belonging to this session reach this collector. Other
    // sessions' components on other messages are handled by their own collectors,
    // and stale ones fall through to the interaction router.
    filter: (interaction) => interaction.customId.endsWith(`:${session.id}`),
  });

  collector.on('collect', async (interaction) => {
    // Discord's UI visibility is not an authorisation boundary.
    if (interaction.user.id !== session.ownerId) {
      await interaction.reply({ embeds: [foreignMenuEmbed()], ...EPHEMERAL }).catch(() => {});
      return;
    }

    try {
      const action = actionFromCustomId(interaction.customId);

      switch (action) {
        case 'category': {
          // The value is resolved through the registry rather than trusted. A
          // crafted value naming a nonexistent category is acknowledged and ignored.
          const chosen = registry.category(interaction.values?.[0]);
          if (!chosen) {
            await safeDeferUpdate(interaction);
            return;
          }
          session.data.category = chosen.name;
          session.data.page = 0;
          session.data.view = 'list';
          break;
        }

        case 'prev':
          session.data.page = Math.max(0, session.data.page - 1);
          session.data.view = 'list';
          break;

        case 'next':
          // buildHelpView clamps to the last page, so no upper bound is needed here.
          session.data.page += 1;
          session.data.view = 'list';
          break;

        case 'back':
          session.data.view = 'list';
          break;

        case 'command': {
          // getVisible, not get: a hidden command must not be reachable through a
          // crafted select-menu value.
          const command = registry.getVisible(interaction.values?.[0]);
          if (!command) {
            await safeDeferUpdate(interaction);
            return;
          }

          const detail = buildCommandDetailView({
            command,
            prefix: env.prefix,
            sessionId: session.id,
            registry,
            // peek, not check: displaying a cooldown must not start one.
            cooldownSeconds: ctx.cooldowns?.secondsFor?.(command.name),
          });

          session.data.view = 'detail';
          session.data.command = command.name;

          await interaction.update({ embeds: [detail.embed], components: detail.components });
          extendSession();
          return;
        }

        default:
          // An unrecognised action on a live session. Acknowledged so the client
          // does not hang, but nothing is executed.
          logger.debug('Unknown help menu action', { action, customId: interaction.customId });
          await safeDeferUpdate(interaction);
          return;
      }

      const view = renderList();
      // buildHelpView clamps the page; write the clamped value back so a repeated
      // Next press cannot accumulate an out-of-range index in the session.
      session.data.page = view.page;

      await interaction.update({ embeds: [view.embed], components: view.components });
      extendSession();
    } catch (err) {
      // A failure here is a rendering or delivery problem, not a user-facing
      // command failure, so the menu is left as it was rather than replaced with an
      // error embed the user cannot dismiss.
      logger.error('Help menu interaction failed', {
        userId: interaction.user.id,
        customId: interaction.customId,
        code: err?.code ?? null,
        message: err?.message ?? String(err),
      });
      await safeDeferUpdate(interaction);
    }
  });

  collector.on('end', async (_collected, reason) => {
    deleteSession(session.id);

    // 'messageDelete', 'user' and similar reasons need no cleanup: the message is
    // gone or was replaced deliberately.
    if (reason !== 'time') return;

    // Render the current view with every control disabled, so the menu visibly
    // expires instead of leaving live-looking buttons that would be refused.
    const expired = buildHelpView({
      registry,
      prefix: env.prefix,
      categoryName: session.data.category,
      page: session.data.page,
      sessionId: session.id,
      pageSize,
      descriptionMax,
      disabled: true,
    });

    await safeEdit(anchor, { embeds: [timedOutEmbed()], components: expired.components });
  });

  /**
   * Extends the session and the collector deadline while the user is active.
   *
   * Capped at MAX_LIFETIME_MS so a menu left open in a busy channel cannot be kept
   * alive indefinitely, which would hold a session slot and a collector for as long
   * as anyone kept clicking.
   */
  function extendSession() {
    if (Date.now() - openedAt >= MAX_LIFETIME_MS) return;

    touchSession(session.id, HELP_TTL_MS);
    collector.resetTimer({ time: HELP_TTL_MS });
  }
}

export { HELP_TTL_MS, MAX_LIFETIME_MS };
