// Coded by Aditya | GitHub- @adityatheog

/**
 * Lists every server on the panel, one page at a time.
 *
 * Reads the panel directly rather than the local database, which is the point: servers
 * created outside this bot are included, and so are servers whose local record was lost.
 * adminService cross-references each result against the local mapping and marks the ones
 * the bot does not know about.
 *
 * That cross-reference is the diagnostic value here. Two failure modes produce a panel
 * server with no local row, and both are worth an operator's attention:
 *
 *   A server created by hand in the panel, which is expected and harmless but means the
 *   bot cannot manage it.
 *
 *   The ORPHANED SERVER case from serverService, where provisioning succeeded and the
 *   local write failed. The user believes their creation failed; the server is running
 *   and consuming resources. This command is how it gets found.
 *
 * Pagination is by explicit page argument rather than buttons. An operator scanning a
 * panel with hundreds of servers wants to jump to a page, and a session-bound button
 * flow would expire between glances.
 *
 * Suspended servers are flagged, because a page full of suspended servers usually means
 * someone ran `admin suspend` and the operator is trying to work out who.
 */

import {
  bulletList,
  identifierFooter,
  infoEmbed,
  joinSections,
  paginateLines,
  warningEmbed,
} from '../../../utils/embeds.js';
import { pluralise, sanitiseForDisplay } from '../../../utils/format.js';

/**
 * Servers per page.
 *
 * Each row is one line of roughly 90 characters, so fifteen sits comfortably inside the
 * description limit with the header, and matches the panel's own default page size.
 */
const PER_PAGE = 15;

/**
 * Renders one server as a list row.
 *
 * Names come from the panel and have not passed through this bot's validator, so they
 * are neutralised for display.
 *
 * @param {object} server a server entry from adminService.listAllServers
 * @returns {string}
 */
function renderRow(server) {
  const flags = [];
  if (server.suspended) flags.push('**suspended**');
  if (!server.managedByBot) flags.push('_untracked_');

  const owner = server.discordId ? `<@${server.discordId}>` : `panel user ${server.ownerId}`;

  return [
    `• **${sanitiseForDisplay(server.name, 40)}**`,
    `\`${server.identifier}\``,
    owner,
    flags.length > 0 ? flags.join(' ') : null,
  ]
    .filter(Boolean)
    .join(' — ');
}

export default {
  name: 'admin servers',
  category: 'Admin',
  description: 'List all servers across all users',
  details:
    'Lists every server on the panel, including ones created outside this bot. Servers with no local record are marked untracked, which usually means they were created by hand in the panel or that a provisioning write failed. Reads the panel directly, so it reflects reality rather than this bot\'s records.',

  adminOnly: true,
  guildOnly: true,
  aliases: ['admin serverlist'],
  examples: ['admin servers', 'admin servers 3'],

  options: [
    {
      name: 'page',
      type: 'integer',
      description: 'Page number, starting at 1',
      required: false,
      min: 1,
      max: 1000,
      default: 1,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // One panel request plus a local lookup per row, so acknowledge first.
    await ctx.defer();

    const page = Number(ctx.args.page ?? 1);

    const { servers, pagination } = await ctx.adminService.listAllServers({
      page,
      perPage: PER_PAGE,
    });

    // ------------------------------------------------------------- empty result

    if (servers.length === 0) {
      const beyondEnd = pagination.total > 0 && page > pagination.totalPages;

      await ctx.respond({
        embeds: [
          infoEmbed(
            'All Panel Servers',
            beyondEnd
              ? joinSections([
                  `Page ${page} is past the end.`,
                  '',
                  `The panel has ${pluralise(pagination.total, 'server')} across ${pluralise(pagination.totalPages, 'page')}.`,
                ])
              : 'The panel reports no servers at all.',
            `Page ${page} of ${pagination.totalPages}`,
          ),
        ],
      });
      return;
    }

    // ------------------------------------------------------------------ listing

    const untracked = servers.filter((server) => !server.managedByBot);
    const suspended = servers.filter((server) => server.suspended);

    const header = bulletList([
      ['Total on panel', pluralise(pagination.total, 'server')],
      ['This page', `${servers.length} of ${pagination.total}`],
      ['Untracked here', untracked.length > 0 ? untracked.length : null],
      ['Suspended here', suspended.length > 0 ? suspended.length : null],
    ]);

    /**
     * paginateLines splits across embeds at the description limit rather than truncating,
     * so a row can never fall off the end even if names are unusually long.
     */
    const embeds = paginateLines({
      title: 'All Panel Servers',
      lines: servers.map(renderRow),
      header,
      footer:
        pagination.totalPages > 1
          ? `Page ${pagination.currentPage} of ${pagination.totalPages} • ${ctx.env.prefix}admin servers <page>`
          : `Page ${pagination.currentPage} of ${pagination.totalPages}`,
    });

    /**
     * Untracked servers are called out separately rather than left as an inline marker.
     * The ORPHANED SERVER case hides here, and an operator scanning fifteen rows will not
     * reliably notice a lowercase italic tag.
     */
    if (untracked.length > 0) {
      embeds.push(
        warningEmbed(
          'Untracked Servers',
          joinSections([
            `${pluralise(untracked.length, 'server')} on this page ${untracked.length === 1 ? 'has' : 'have'} no record in this bot, so users cannot manage ${untracked.length === 1 ? 'it' : 'them'} through commands.`,
            '',
            untracked
              .slice(0, 10)
              .map((server) => `• \`${server.identifier}\` — panel user ${server.ownerId}`)
              .join('\n'),
            '',
            'This is expected for servers created by hand in the panel. If a user reported a failed creation, search the logs for `ORPHANED SERVER` with that identifier.',
          ]),
        ),
      );
    }

    // Discord accepts at most ten embeds per message.
    await ctx.respond({ embeds: embeds.slice(0, 10) });
  },
};
