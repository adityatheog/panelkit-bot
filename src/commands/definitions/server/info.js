// Coded by Aditya | GitHub- @adityatheog

/**
 * Shows detailed information about one of the user's servers.
 *
 * Read-only, and the most diagnostic command in the Server category: it answers "why
 * can I not connect", "how much of my quota am I using" and "is it still installing"
 * in a single reply.
 *
 * Three sources are combined. The local record supplies the stored name, type and
 * creation date. The panel's client endpoint supplies the node, configured limits,
 * lifecycle flags and network allocations. The resources endpoint supplies live usage.
 * serverService.info() fetches the two panel reads concurrently and tolerates either
 * failing, because a server that has never booted returns no resources while still
 * having useful configuration to show, and a node that is briefly unreachable should
 * not make the command fail outright.
 *
 * Usage is rendered against the configured limit rather than as a bare number. "384
 * MB" tells a user very little; "384.2 MB / 1.0 GB (38%)" tells them whether they are
 * about to hit a wall.
 *
 * Lifecycle state takes precedence over live state in the display. A suspended or
 * installing server may still report `offline` from the resources endpoint, and
 * showing "Offline" to someone whose server was suspended sends them to the wrong
 * question entirely.
 */

import {
  bulletList,
  identifierFooter,
  infoEmbed,
  joinSections,
  warningEmbed,
} from '../../../utils/embeds.js';
import {
  formatAllocation,
  formatBytes,
  formatCpuLimit,
  formatLimitMb,
  formatPercent,
  formatServerStatus,
  formatTimestamp,
  formatUptime,
  formatUsageAgainstLimit,
  sanitiseForDisplay,
} from '../../../utils/format.js';

export default {
  name: 'server info',
  category: 'Server',
  description: 'View detailed information about your server',
  details:
    'Shows a server\'s configuration, resource limits, live usage and network allocations, along with its installation and suspension state. Read-only; nothing is changed.',

  guildOnly: true,
  aliases: ['server details', 'server status'],
  examples: ['server info a1b2c3d4'],

  options: [
    {
      name: 'server',
      type: 'string',
      description: 'The 8-character server identifier',
      required: true,
      minLength: 8,
      maxLength: 8,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // Two panel reads follow, so acknowledge before them.
    await ctx.defer();

    const { record, panel, resources, allocations } = await ctx.serverService.info({
      discordId: ctx.user.id,
      identifier: ctx.args.server,
    });

    const eggLabel = ctx.config.eggs[record.egg_type]?.label ?? record.egg_type;

    /**
     * The panel's name is preferred when available, because a rename made directly in
     * the panel is authoritative and the local row may lag behind. It has not passed
     * through this bot's validator, so it is neutralised for display.
     */
    const displayName = sanitiseForDisplay(panel?.name || record.name, 64);

    const identity = joinSections([
      '**Server**',
      bulletList([
        ['Name', displayName],
        ['Type', eggLabel],
        ['Identifier', `\`${record.identifier}\``],
        ['Node', panel?.node ? sanitiseForDisplay(panel.node, 48) : null],
        ['Created', formatTimestamp(record.created_at)],
        // Lifecycle flags win over live state; see the header note.
        ['State', formatServerStatus(panel, resources?.state)],
      ]),
    ]);

    /**
     * Usage against limits. Rendered only when the panel returned limits, since
     * computing a percentage against an unknown denominator would be misleading.
     */
    const usage = joinSections([
      '**Resources**',
      bulletList([
        ['Uptime', formatUptime(resources?.uptimeMs)],
        [
          'CPU',
          resources
            ? `${formatPercent(resources.cpuPercent)} of ${formatCpuLimit(panel?.limits?.cpu)}`
            : 'Unknown',
        ],
        [
          'RAM',
          resources && panel?.limits
            ? formatUsageAgainstLimit(resources.memoryBytes, panel.limits.memory)
            : formatLimitMb(panel?.limits?.memory),
        ],
        [
          'Disk',
          resources && panel?.limits
            ? formatUsageAgainstLimit(resources.diskBytes, panel.limits.disk)
            : formatLimitMb(panel?.limits?.disk),
        ],
        ['Network in', formatBytes(resources?.networkRxBytes)],
        ['Network out', formatBytes(resources?.networkTxBytes)],
      ]),
    ]);

    /**
     * Allocations are the connection address, which is the single most requested piece
     * of information for a game server. The primary one is listed first and labelled.
     */
    const primary = allocations.find((allocation) => allocation.primary) ?? allocations[0] ?? null;
    const secondary = allocations.filter((allocation) => allocation !== primary);

    const network = joinSections([
      '**Connection**',
      primary
        ? bulletList([
            ['Address', `\`${formatAllocation(primary)}\``],
            [
              'Additional ports',
              secondary.length > 0
                ? secondary.map((allocation) => `\`${formatAllocation(allocation)}\``).join(', ')
                : null,
            ],
          ])
        : '• No allocation reported by the panel.',
    ]);

    /** Feature quotas, shown only when the panel reported them. */
    const features = panel?.featureLimits
      ? joinSections([
          '**Quotas**',
          bulletList([
            ['Databases', panel.featureLimits.databases],
            ['Allocations', panel.featureLimits.allocations],
            ['Backups', panel.featureLimits.backups],
          ]),
        ])
      : '';

    const embeds = [
      infoEmbed(
        `Server: ${displayName}`,
        joinSections([identity, '', usage, '', network, features ? '' : null, features]),
        identifierFooter(record.identifier),
      ),
    ];

    /**
     * Partial results are stated rather than silently rendered as "Unknown" rows. A
     * user comparing two servers needs to know the difference between "this metric is
     * zero" and "the panel did not answer".
     */
    if (!panel) {
      embeds.push(
        warningEmbed(
          'Configuration Unavailable',
          'The panel did not return this server\'s configuration, so limits and allocations are missing. The node may be unreachable; try again shortly.',
        ),
      );
    } else if (!resources) {
      embeds.push(
        warningEmbed(
          'Live Statistics Unavailable',
          panel.isInstalling
            ? 'Live statistics are not available while the server is installing.'
            : 'The panel did not return live statistics. This is normal for a server that has never been started.',
        ),
      );
    }

    await ctx.respond({ embeds });
  },
};
