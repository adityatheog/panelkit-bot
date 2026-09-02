// Coded by Aditya | GitHub- @adityatheog

/**
 * Restores every suspended server belonging to a Discord user.
 *
 * The exact inverse of `admin suspend`, sharing its service method with the flag flipped.
 * Unsuspending returns a server to whatever state it held before suspension; it does not
 * start it. That distinction matters because an operator lifting a suspension usually
 * expects the owner's server to come back online, and it will not until someone starts
 * it — so the reply says so and names the command.
 *
 * Like its counterpart, this operates on the servers this bot has records for. A server
 * created by hand in the panel is outside the mapping and stays suspended, which is worth
 * stating: an operator who lifts a suspension and hears "it is still suspended" needs to
 * know where to look.
 *
 * Per-server outcomes are reported rather than aborting on the first failure. A panel 409
 * means the server is already active, which counts as skipped: the desired end state has
 * been reached.
 *
 * No self-guard here, unlike `admin suspend`. Unsuspending your own servers is harmless,
 * and an operator recovering from having suspended themselves should not be blocked from
 * the fix.
 *
 * adminService writes an ADMIN ACTION audit line naming the actor, the target and the
 * outcome.
 */

import {
  bulletList,
  infoEmbed,
  joinSections,
  successEmbed,
  warningEmbed,
} from '../../../utils/embeds.js';
import { pluralise } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';

export default {
  name: 'admin unsuspend',
  category: 'Admin',
  description: 'Unsuspend all servers belonging to a user',
  details:
    'Lifts the suspension on every server this bot has recorded for a Discord user, restoring the owner\'s ability to control them. Servers are not started automatically; their owner must start them.',

  adminOnly: true,
  guildOnly: true,
  aliases: ['admin unban'],
  examples: ['admin unsuspend @user'],

  options: [
    {
      name: 'user',
      type: 'user',
      description: 'The Discord user whose servers should be unsuspended',
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
     * Same service method as `admin suspend` with the flag inverted, so both directions
     * share the per-server error handling, the 409-as-skipped rule and the bulk ceiling.
     */
    const result = await ctx.adminService.setSuspended(targetId, false, { actorId: ctx.user.id });

    const embeds = [
      successEmbed(
        'Servers Unsuspended',
        joinSections([
          bulletList([
            ['User', `<@${targetId}>`],
            ['Servers found', result.total],
            ['Unsuspended now', result.changed],
            // Rendered only when non-zero, so a clean run stays terse.
            ['Already active', result.skipped > 0 ? result.skipped : null],
            ['Failed', result.failed.length > 0 ? result.failed.length : null],
          ]),
          '',
          result.changed > 0
            ? 'Their servers can be controlled again. They are **not** started automatically.'
            : 'No change was needed; the servers were already active.',
          '',
          bulletList([
            [
              'They can start with',
              `\`${ctx.env.prefix}server power <identifier> start\``,
            ],
            ['Inspect them', `\`${ctx.env.prefix}admin user <@${targetId}>\``],
          ]),
        ]),
      ),
    ];

    /**
     * Failures are named individually so an operator has the identifiers needed to finish
     * in the panel, rather than a count that sends them hunting.
     */
    if (result.failed.length > 0) {
      logger.warn('Bulk unsuspension completed with failures', {
        actorId: ctx.user.id,
        targetDiscordId: targetId,
        failed: result.failed.length,
        total: result.total,
      });

      embeds.push(
        warningEmbed(
          'Partially Applied',
          joinSections([
            `${pluralise(result.failed.length, 'server')} could not be unsuspended:`,
            '',
            result.failed.slice(0, 10).map((identifier) => `• \`${identifier}\``).join('\n'),
            '',
            'The panel rejected these or was unreachable. Run the command again, or unsuspend them from the panel directly.',
          ]),
        ),
      );
    }

    /**
     * Servers outside the bot's mapping stay suspended. Stated so a report of "still
     * suspended" points at the panel rather than at this command.
     */
    embeds.push(
      infoEmbed(
        'Scope',
        joinSections([
          'Only servers recorded by this bot were affected.',
          '',
          `Servers created directly in the panel are not tracked here and remain suspended. Check with \`${ctx.env.prefix}admin servers\`.`,
        ]),
      ),
    );

    await ctx.respond({ embeds });
  },
};
