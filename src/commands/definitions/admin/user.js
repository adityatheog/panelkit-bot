// Coded by Aditya | GitHub- @adityatheog

/**
 * Looks up a Discord user's panel account and servers.
 *
 * The support command. When someone reports that a command is failing, this is what an
 * operator runs first, and it is built to answer the questions that actually get asked:
 * does this person have an account, does the panel agree, how many servers do they own,
 * and is anything out of sync.
 *
 * The reconciliation report is the part that earns its place. adminService cross-checks
 * the local records against the panel's own list for that account and returns anything
 * the panel knows about that this bot does not. Two situations produce that gap:
 *
 *   A server created by hand in the panel. Harmless, but it explains why the user cannot
 *   see it in `server list`.
 *
 *   The ORPHANED SERVER case, where provisioning succeeded and the local write failed. The
 *   user believes their creation failed and their limit is consumed by a server they
 *   cannot manage. This command is how that gets diagnosed for a specific complaint,
 *   where `admin servers` finds them in bulk.
 *
 * No password is shown, because none exists to show — accountService returns a generated
 * password exactly once and stores nothing. The reply says so explicitly, so an operator
 * does not go looking for a lookup that does not exist.
 *
 * The reply is ephemeral: it contains another person's email address and account details.
 */

import {
  bulletList,
  errorEmbed,
  infoEmbed,
  joinSections,
  warningEmbed,
} from '../../../utils/embeds.js';
import { formatTimestamp, pluralise, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';

/** How many servers are listed individually before the rest are summarised. */
const MAX_LISTED = 15;

export default {
  name: 'admin user',
  category: 'Admin',
  description: "Look up a user's panel account and servers",
  details:
    "Shows a Discord user's panel account, credits, servers and account age, and cross-checks the bot's records against the panel to surface anything out of sync. Read-only. Passwords are never shown and cannot be recovered.",

  adminOnly: true,
  guildOnly: true,
  aliases: ['admin lookup', 'admin whois'],
  examples: ['admin user @user'],

  options: [
    {
      name: 'user',
      type: 'user',
      description: 'The Discord user to look up',
      required: true,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    /**
     * Ephemeral: this reply contains another person's login email and account details.
     */
    await ctx.defer({ ephemeral: true });

    const targetId = String(ctx.args.user);

    /**
     * adminService validates the id, raises NotFoundError when the bot has no record,
     * reads the panel account best-effort and returns the reconciliation result. A user
     * with no local record reaches the router's error funnel rather than this point.
     */
    const info = await ctx.adminService.lookupUser(targetId);

    const atLimit = info.servers.length >= info.serverLimit;

    const account = joinSections([
      '**Account**',
      bulletList([
        ['Discord', `<@${info.discordId}> (\`${info.discordId}\`)`],
        ['Panel username', `\`${info.username}\``],
        ['Login email', `\`${info.email}\``],
        ['Panel user ID', info.panelId],
        ['Registered', formatTimestamp(info.createdAt)],
        ['Credits', info.credits],
        [
          'Servers',
          `${info.servers.length} of ${pluralise(info.serverLimit, 'server')}${atLimit ? ' — **at limit**' : ''}`,
        ],
        // Only shown when true; a "no" row would be noise on every lookup.
        ['Panel administrator', info.panelAdmin ? '**Yes**' : null],
      ]),
    ]);

    const serverList =
      info.servers.length > 0
        ? joinSections([
            `**Servers (${info.servers.length})**`,
            info.servers
              .slice(0, MAX_LISTED)
              .map(
                (server) =>
                  `• **${sanitiseForDisplay(server.name, 40)}** — \`${server.identifier}\` — ${
                    ctx.config.eggs[server.egg_type]?.label ?? server.egg_type
                  }`,
              )
              .join('\n'),
            info.servers.length > MAX_LISTED
              ? `_and ${info.servers.length - MAX_LISTED} more_`
              : '',
          ])
        : joinSections(['**Servers**', '• None recorded.']);

    const actions = joinSections([
      '**Actions**',
      bulletList([
        ['Suspend all', `\`${ctx.env.prefix}admin suspend <@${info.discordId}>\``],
        ['Unsuspend all', `\`${ctx.env.prefix}admin unsuspend <@${info.discordId}>\``],
        ['Provision another', `\`${ctx.env.prefix}create <@${info.discordId}> <type> <name>\``],
      ]),
    ]);

    const embeds = [
      infoEmbed(
        'User Lookup',
        joinSections([account, '', serverList, '', actions]),
        `Panel user ${info.panelId} • passwords are never stored`,
      ),
    ];

    /**
     * The panel could not confirm the account. Distinguished from "no account", because
     * the local record shown above is real and the panel side is simply unverified — which
     * changes what the operator should conclude about a login failure.
     */
    if (!info.panelReachable) {
      embeds.push(
        warningEmbed(
          'Panel Not Reachable',
          joinSections([
            'The details above come from this bot\'s records. The panel could not be contacted to confirm the account still exists, and the reconciliation check below was skipped.',
            '',
            'Try again shortly. If this persists, check the panel and the Application API key.',
          ]),
        ),
      );
    }

    /**
     * Servers the panel attributes to this account that the bot has no record of. Reported
     * as a warning rather than an inline note, because the ORPHANED SERVER case hides here
     * and it is the specific thing an operator is looking for when a user reports a failed
     * creation.
     */
    if (info.untrackedServers.length > 0) {
      logger.info('Admin lookup found untracked servers', {
        actorId: ctx.user.id,
        targetDiscordId: info.discordId,
        panelUserId: info.panelId,
        untracked: info.untrackedServers.length,
      });

      embeds.push(
        warningEmbed(
          'Out of Sync',
          joinSections([
            `The panel attributes ${pluralise(info.untrackedServers.length, 'server')} to this account that this bot has no record of:`,
            '',
            info.untrackedServers
              .slice(0, 10)
              .map(
                (server) =>
                  `• \`${server.identifier}\` — ${sanitiseForDisplay(server.name, 40)}${server.suspended ? ' — **suspended**' : ''}`,
              )
              .join('\n'),
            '',
            'The user cannot manage these through commands, and they do not count against their limit here.',
            '',
            'Expected if they were created by hand in the panel. If the user reported a failed creation, search the logs for `ORPHANED SERVER` with that identifier.',
          ]),
        ),
      );
    }

    /**
     * Recovery routes for the two account problems that generate support requests. Stated
     * once, here, so an operator does not have to remember which commands exist.
     */
    embeds.push(
      infoEmbed(
        'Common Fixes',
        bulletList([
          ['Lost password', `They run \`${ctx.env.prefix}account reset\` — a new one is DM'd to them`],
          ['Cannot receive DMs', 'They must enable direct messages from server members, then reset'],
          ['Password lookup', 'Not possible — passwords are never stored by this bot'],
        ]),
      ),
    );

    await ctx.respond({ embeds }, { ephemeral: true });
  },
};
