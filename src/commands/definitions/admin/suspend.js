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

  async execute(ctx) {

    await ctx.defer();

    const targetId = String(ctx.args.user);

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

    const result = await ctx.adminService.setSuspended(targetId, true, { actorId: ctx.user.id });

    const embeds = [
      successEmbed(
        'Servers Suspended',
        joinSections([
          bulletList([
            ['User', `<@${targetId}>`],
            ['Servers found', result.total],
            ['Suspended now', result.changed],

            ['Already suspended', result.skipped > 0 ? result.skipped : null],
            ['Failed', result.failed.length > 0 ? result.failed.length : null],
          ]),
          '',
          result.changed > 0
            ? 'Their servers have been stopped and cannot be started until unsuspended.'
            : result.failed.length > 0
              ? 'No servers were suspended by this request. Review the failures below and retry.'
              : 'No change was needed; the servers were already suspended.',
          '',
          bulletList([
            ['Reverse this', `\`${ctx.env.prefix}admin unsuspend <@${targetId}>\``],
            ['Inspect them', `\`${ctx.env.prefix}admin user <@${targetId}>\``],
          ]),
        ]),
      ),
    ];

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
