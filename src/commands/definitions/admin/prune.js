// Coded by Aditya | GitHub- @adityatheog

/**
 * Removes local tracking records for servers that no longer exist on the panel.
 *
 * This command resolves the "drift" that happens when a server is deleted directly
 * in the panel rather than through the bot. The bot retains the local row, which
 * consumes a slot in the user's limit and produces an "untracked" or "orphaned"
 * warning in admin commands.
 *
 * It uses findStaleServers to locate candidates, then pruneStaleServers to re-verify
 * and remove them. Safe to run: servers are checked again immediately before deletion,
 * so a server that came back online between discovery and removal is not touched.
 *
 * It operates silently on success if there was no work to do, but provides a detailed
 * report when it modifies the database. adminService writes an audit line for every
 * bulk prune action.
 */

import {
  bulletList,
  infoEmbed,
  joinSections,
  successEmbed,
} from '../../../utils/embeds.js';
import { pluralise } from '../../../utils/format.js';

export default {
  name: 'admin prune',
  category: 'Admin',
  description: 'Remove local records for servers deleted from the panel',
  details:
    'Finds servers that exist in the bot\'s database but are missing from the panel, and removes their local records. This frees up the owner\'s server limit slot. Safe to run: servers are re-verified with the panel immediately before removal.',

  adminOnly: true,
  guildOnly: true,
  aliases: ['admin cleanup'],
  examples: ['admin prune'],

  options: [],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // This can issue several dozen requests if many servers exist, so acknowledge first.
    await ctx.defer();

    const { checked, stale } = await ctx.adminService.findStaleServers();

    if (stale.length === 0) {
      await ctx.respond({
        embeds: [
          successEmbed(
            'No Stale Servers',
            `Checked ${pluralise(checked, 'local record')}. Every recorded server still exists on the panel.`,
          ),
        ],
      });
      return;
    }

    const { removed, kept } = await ctx.adminService.pruneStaleServers({
      stale,
      actorId: ctx.user.id,
    });

    const embeds = [
      successEmbed(
        'Stale Servers Pruned',
        joinSections([
          bulletList([
            ['Records checked', checked],
            ['Stale records found', stale.length],
            ['Records removed', removed],
            ['Kept (reappeared)', kept > 0 ? kept : null],
          ]),
          '',
          removed > 0
            ? 'These slots have been returned to their owners\' server limits.'
            : 'No records were removed.',
        ]),
      ),
    ];

    if (removed > 0) {
      embeds.push(
        infoEmbed(
          'Scope',
          'This only removed the bot\'s local tracking records for servers that were already deleted directly in the panel. No live servers were affected.',
        ),
      );
    }

    await ctx.respond({ embeds });
  },
};
