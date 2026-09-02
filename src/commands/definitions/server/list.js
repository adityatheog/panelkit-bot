// Coded by Aditya | GitHub- @adityatheog

/**
 * Lists every server the user owns.
 *
 * The discovery command for the rest of the Server category. Every other command there
 * takes an 8-character identifier, and this is where users get them — so the identifier
 * is rendered in a code span, ready to copy, on every row.
 *
 * Live state is fetched per server and is best-effort. serverService.listWithState()
 * runs the reads concurrently, caps how many it will attempt, and reports 'unknown'
 * for any that fail rather than failing the command. A list of servers whose states
 * are partly unknown is still the answer to "what do I own"; refusing to render
 * because one node is unreachable is not.
 *
 * An empty list is treated as a first-run experience rather than an error. A user with
 * no servers has typically just created an account, and the reply points at
 * `server create` instead of reporting nothing found.
 *
 * Read-only, and never destructive, so it carries only the default cooldown.
 */

import {
  bulletList,
  infoEmbed,
  joinSections,
  paginateLines,
  warningEmbed,
} from '../../../utils/embeds.js';
import { formatStateWithIcon, pluralise, sanitiseForDisplay } from '../../../utils/format.js';

/**
 * How many servers get a live state lookup.
 *
 * Each is one panel request. Ten bounds the fan-out for a user with an unusually large
 * allocation while covering every realistic case, since FREE_SERVER_LIMIT is normally
 * one and admin provisioning rarely exceeds a handful.
 */
const STATE_LOOKUP_LIMIT = 10;

/**
 * Renders one server as a list row.
 *
 * The identifier sits in a code span because it is what the user needs to copy into
 * the next command. The name is neutralised for display, since a rename made directly
 * in the panel never passed through this bot's validator.
 *
 * @param {object} entry a server row with a `state` field attached
 * @param {Readonly<object>} config validated config.json
 * @returns {string}
 */
function renderServerRow(entry, config) {
  const label = config.eggs[entry.egg_type]?.label ?? entry.egg_type;

  return [
    `• **${sanitiseForDisplay(entry.name, 48)}**`,
    `\`${entry.identifier}\``,
    label,
    formatStateWithIcon(entry.state),
  ].join(' — ');
}

export default {
  name: 'server list',
  category: 'Server',
  description: 'List all your Pterodactyl servers',
  details:
    'Lists every server you own with its identifier, type and current state. The identifier shown here is what the other server commands expect.',

  guildOnly: true,
  aliases: ['servers', 'server ls'],
  examples: ['server list'],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // One panel request per server follows, so acknowledge first.
    await ctx.defer();

    const servers = await ctx.serverService.listWithState(ctx.user.id, { max: STATE_LOOKUP_LIMIT });

    // ------------------------------------------------------------- empty result

    if (servers.length === 0) {
      const hasAccount = ctx.accountService.hasAccount(ctx.user.id);

      await ctx.respond({
        embeds: [
          infoEmbed(
            'Your Servers',
            hasAccount
              ? joinSections([
                  'You do not own any servers yet.',
                  '',
                  bulletList([
                    ['Create one', `\`${ctx.env.prefix}server create\``],
                    ['Your limit', pluralise(ctx.env.freeServerLimit, 'server')],
                    ['See plans', `\`${ctx.env.prefix}plans\``],
                  ]),
                ])
              : joinSections([
                  'You do not have a panel account yet.',
                  '',
                  `Run \`${ctx.env.prefix}account create\` to get started.`,
                ]),
          ),
        ],
      });
      return;
    }

    // ------------------------------------------------------------------ listing

    const rows = servers.map((entry) => renderServerRow(entry, ctx.config));

    const header = joinSections([
      bulletList([
        ['Servers', `${servers.length} of ${ctx.env.freeServerLimit}`],
        [
          'Manage one',
          `\`${ctx.env.prefix}server manage\` or \`${ctx.env.prefix}server info <identifier>\``,
        ],
      ]),
    ]);

    /**
     * paginateLines splits across embeds at the description limit rather than
     * truncating, so a server can never fall off the end of the list. A single embed
     * covers every realistic case; the split exists for an operator who has raised
     * FREE_SERVER_LIMIT substantially.
     */
    const embeds = paginateLines({
      title: 'Your Servers',
      lines: rows,
      header,
      footer: `Use the identifier in \`${ctx.env.prefix}server\` commands`,
    });

    /**
     * State was not fetched for every server, so the display says which rows are
     * unverified rather than implying the panel reported 'unknown' for them.
     */
    if (servers.length > STATE_LOOKUP_LIMIT) {
      embeds.push(
        warningEmbed(
          'Partial Status',
          `Live status was checked for the first ${STATE_LOOKUP_LIMIT} servers only. Use \`${ctx.env.prefix}server info <identifier>\` for the rest.`,
        ),
      );
    }

    // Discord accepts at most ten embeds per message.
    await ctx.respond({ embeds: embeds.slice(0, 10) });
  },
};
