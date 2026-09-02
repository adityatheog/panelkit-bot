// Coded by Aditya | GitHub- @adityatheog

/**
 * Suspends every server belonging to a Discord user.
 *
 * The moderation tool for the bot: a suspended server is stopped by the panel and cannot
 * be started until it is unsuspended. Nothing is deleted, no files are touched, and
 * `admin unsuspend` restores the previous state exactly — which is why this is a bulk
 * action without a confirmation prompt, unlike the deletion commands.
 *
 * It operates on the servers this bot has records for, not on everything the panel
 * attributes to that panel account. A server created by hand in the panel is outside the
 * bot's mapping and is left alone; `admin servers` surfaces those separately. The reply
 * says so, because "I suspended them and one is still running" is otherwise a confusing
 * outcome.
 *
 * Per-server outcomes are reported rather than aborting on the first failure. Suspension
 * is reversible and partially applied state is recoverable, so getting eight of ten
 * suspended and naming the two that failed is more useful than an all-or-nothing result.
 * A panel 409 means the server is already suspended, which counts as skipped: the desired
 * end state has been reached.
 *
 * adminService writes an ADMIN ACTION audit line naming the actor, the target and the
 * outcome. That line is the record if this is ever questioned.
 */

import {
  bulletList,
  errorEmbed,
  infoEmbed,
  joinSections,
  successEmbed,
  warningEmbed,
} from '../../../utils/embeds.js';
import { pluralise } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';

export default {
  name: 'admin suspend',
  category: 'Admin',
  description: 'Suspend all servers belonging to a user',
  details:
    'Suspends every server this bot has recorded for a Discord user. Suspended servers are stopped by the panel and cannot be started by their owner. Nothing is deleted and no files are affected; `admin unsuspend` reverses it completely.',

  adminOnly: true,
  guildOnly: true,
  examples: ['admin suspend @user'],

  options: [
    {
      name: 'user',
      type: 'user',
      description: 'The Discord user whose servers should be suspended',
      required: true,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // One panel request per server follows, so acknowledge first.
    await ctx.defer();

    const targetId = String(ctx.args.user);

    /**
     * Suspending your own servers is almost certainly a mistake — an operator testing the
     * command on themselves is the usual cause — and the recovery is another command
     * away, so it is refused rather than silently performed.
     */
    if (targetId === ctx.user.id) {
      await ctx.respond({
        embeds: [
          errorEmbed(
            joinSections([
              'That would suspend your own servers.',
              '',
              'If you meant to do this, suspend them individually from the panel.',
            ]),
          ),
        ],
      });
      return;
    }

    /**
     * adminService validates the id, refuses unknown users and users with no servers,
     * enforces the bulk ceiling, and reports per-server outcomes. A 409 is counted as
     * skipped and a 404 as already gone.
     */
    const result = await ctx.adminService.setSuspended(targetId, true, { actorId: ctx.user.id });

    const embeds = [
      successEmbed(
        'Servers Suspended',
        joinSections([
          bulletList([
            ['User', `<@${targetId}>`],
            ['Servers found', result.total],
            ['Suspended now', result.changed],
            // Rendered only when non-zero, so a clean run reads as three rows not five.
            ['Already suspended', result.skipped > 0 ? result.skipped : null],
            ['Failed', result.failed.length > 0 ? result.failed.length : null],
          ]),
          '',
          result.changed > 0
            ? 'Their servers have been stopped and cannot be started until unsuspended.'
            : 'No change was needed; the servers were already suspended.',
          '',
          bulletList([
            ['Reverse this', `\`${ctx.env.prefix}admin unsuspend <@${targetId}>\``],
            ['Inspect them', `\`${ctx.env.prefix}admin user <@${targetId}>\``],
          ]),
        ]),
      ),
    ];

    /**
     * Failures are named individually. An operator needs the identifiers to finish the
     * job by hand in the panel, and a bare count would send them hunting.
     */
    if (result.failed.length > 0) {
      logger.warn('Bulk suspension completed with failures', {
        actorId: ctx.user.id,
        targetDiscordId: targetId,
        failed: result.failed.length,
        total: result.total,
      });

      embeds.push(
        warningEmbed(
          'Partially Applied',
          joinSections([
            `${pluralise(result.failed.length, 'server')} could not be suspended:`,
            '',
            result.failed.slice(0, 10).map((identifier) => `• \`${identifier}\``).join('\n'),
            '',
            'The panel rejected these or was unreachable. Run the command again, or suspend them from the panel directly.',
          ]),
        ),
      );
    }

    /**
     * Servers outside the bot's mapping are untouched by this command. Stated so the
     * operator does not assume the user is fully locked out when a hand-created server may
     * still be running.
     */
    embeds.push(
      infoEmbed(
        'Scope',
        joinSections([
          'Only servers recorded by this bot were affected.',
          '',
          `Servers created directly in the panel are not tracked here and were not suspended. Check with \`${ctx.env.prefix}admin servers\`.`,
        ]),
      ),
    );

    await ctx.respond({ embeds });
  },
};
