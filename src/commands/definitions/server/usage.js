// Coded by Aditya | GitHub- @adityatheog

/**
 * Shows live resource usage for one of the user's servers.
 *
 * Deliberately narrower than `server info`. That command reports configuration,
 * allocations, quotas and lifecycle state alongside usage; this one answers a single
 * question — what is this server consuming right now — and answers it in a form that
 * can be re-run repeatedly without scrolling past static detail that has not changed.
 *
 * The usage figures come from Pterodactyl's resources endpoint, whose units are
 * inconsistent in a way that is easy to get wrong: memory, disk and network counters
 * are bytes, uptime is milliseconds, and `cpu_absolute` is a percentage that legitimately
 * exceeds 100 on a multi-core allocation. Every value here goes through the formatters,
 * which encode those conventions in one place.
 *
 * Missing fields render as "Unknown" rather than zero. The panel omits resource fields
 * entirely for a server that has never booted, and reporting "0 MB" for an absent
 * measurement is a factual claim the bot cannot support.
 *
 * Network counters are cumulative since the container last started, not a rate. Users
 * consistently read them as bandwidth, so the reply says which they are.
 */

import {
  bulletList,
  identifierFooter,
  infoEmbed,
  joinSections,
  warningEmbed,
} from '../../../utils/embeds.js';
import {
  formatBytes,
  formatCpuLimit,
  formatPercent,
  formatServerStatus,
  formatUptime,
  formatUsageAgainstLimit,
  sanitiseForDisplay,
} from '../../../utils/format.js';

export default {
  name: 'server usage',
  category: 'Server',
  description: 'View live resource usage for your server',
  details:
    'Reports a server\'s current CPU, memory, disk and network usage, along with its uptime and state. Memory and disk are shown against your configured limits. Network figures are cumulative totals since the server last started, not transfer rates.',

  guildOnly: true,
  aliases: ['server stats', 'usage'],
  examples: ['server usage a1b2c3d4'],

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

    /**
     * info() is used rather than usage() because the configured limits live on the
     * client-server payload, and usage without a denominator is far less useful. The
     * two reads run concurrently inside the service and either may fail independently.
     */
    const { record, panel, resources } = await ctx.serverService.info({
      discordId: ctx.user.id,
      identifier: ctx.args.server,
    });

    const displayName = sanitiseForDisplay(panel?.name || record.name, 64);

    /**
     * No live statistics at all. Distinguished from "everything is zero", and the
     * likely reason is named: an installing server and a never-started server both
     * produce this, and only one of them is worth waiting on.
     */
    if (!resources) {
      await ctx.respond({
        embeds: [
          warningEmbed(
            `Usage: ${displayName}`,
            joinSections([
              'The panel did not return live statistics for this server.',
              '',
              panel?.isInstalling
                ? 'The server is still installing. Statistics become available once installation finishes.'
                : panel?.isSuspended
                  ? 'The server is suspended. Contact an administrator.'
                  : 'This is normal for a server that has never been started, or if its node is briefly unreachable.',
              '',
              bulletList([
                ['Start it', `\`${ctx.env.prefix}server power ${record.identifier} start\``],
                ['Full details', `\`${ctx.env.prefix}server info ${record.identifier}\``],
              ]),
            ]),
            identifierFooter(record.identifier),
          ),
        ],
      });
      return;
    }

    const limits = panel?.limits ?? null;

    const compute = joinSections([
      '**Compute**',
      bulletList([
        ['State', formatServerStatus(panel, resources.state)],
        ['Uptime', formatUptime(resources.uptimeMs)],
        [
          'CPU',
          limits
            ? `${formatPercent(resources.cpuPercent)} of ${formatCpuLimit(limits.cpu)}`
            : formatPercent(resources.cpuPercent),
        ],
      ]),
    ]);

    const storage = joinSections([
      '**Memory and disk**',
      bulletList([
        [
          'RAM',
          limits
            ? formatUsageAgainstLimit(resources.memoryBytes, limits.memory)
            : formatBytes(resources.memoryBytes),
        ],
        [
          'Disk',
          limits
            ? formatUsageAgainstLimit(resources.diskBytes, limits.disk)
            : formatBytes(resources.diskBytes),
        ],
      ]),
    ]);

    const network = joinSections([
      '**Network** _(cumulative since last start)_',
      bulletList([
        ['Inbound', formatBytes(resources.networkRxBytes)],
        ['Outbound', formatBytes(resources.networkTxBytes)],
      ]),
    ]);

    const embeds = [
      infoEmbed(
        `Usage: ${displayName}`,
        joinSections([compute, '', storage, '', network]),
        identifierFooter(record.identifier),
      ),
    ];

    /**
     * Limits were unavailable, so the figures above are absolute rather than
     * proportional. Stated so nobody mistakes a bare number for headroom.
     */
    if (!limits) {
      embeds.push(
        warningEmbed(
          'Limits Unavailable',
          'The panel did not return this server\'s configured limits, so usage is shown as absolute values without percentages.',
        ),
      );
    }

    await ctx.respond({ embeds });
  },
};
