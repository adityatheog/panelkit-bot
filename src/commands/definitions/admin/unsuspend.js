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

  async execute(ctx) {

    await ctx.defer();

    const targetId = String(ctx.args.user);

    const result = await ctx.adminService.setSuspended(targetId, false, { actorId: ctx.user.id });

    const embeds = [
      successEmbed(
        'Servers Unsuspended',
        joinSections([
          bulletList([
            ['User', `<@${targetId}>`],
            ['Servers found', result.total],
            ['Unsuspended now', result.changed],

            ['Already active', result.skipped > 0 ? result.skipped : null],
            ['Failed', result.failed.length > 0 ? result.failed.length : null],
          ]),
          '',
          result.changed > 0
            ? 'Their servers can be controlled again. They are **not** started automatically.'
            : result.failed.length > 0
              ? 'No servers were unsuspended by this request. Review the failures below and retry.'
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
