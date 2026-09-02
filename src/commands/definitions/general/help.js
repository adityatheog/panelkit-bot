// Coded by Aditya | GitHub- @adityatheog

/**
 * The help command.
 *
 * Two behaviours in one command, chosen by whether an argument was supplied.
 *
 *   kx!help                  Opens the interactive browser: a category select, a
 *                            command-details select, and pagination when a category
 *                            needs more than one page.
 *
 *   kx!help server power     Renders that command's detail view directly, with no
 *                            session and no components.
 *
 * The static form exists because it is what people actually type once they know a
 * command's name, and spinning up a session with a five-minute collector for a
 * one-shot lookup wastes a session slot for no benefit. It also means `help` remains
 * useful in a channel where the bot cannot attach components.
 *
 * Lookup goes through registry.getVisible() rather than get(), so a hidden command is
 * not discoverable by guessing its name. That matters because hidden commands are
 * retained for backwards compatibility and are not part of the documented surface.
 *
 * A near-miss on the name suggests alternatives instead of only refusing. Users
 * reliably type `help power` when they mean `server power`, and a bare "no such
 * command" sends them back to browsing.
 *
 * Available in direct messages: it reads no account and touches no panel.
 */

import { runHelpMenu } from '../../../help/helpController.js';
import { buildCommandDetailView } from '../../../help/helpMenu.js';
import { errorEmbed, joinSections } from '../../../utils/embeds.js';

/** How many suggestions are offered for an unrecognised name. */
const MAX_SUGGESTIONS = 5;

/**
 * Finds visible commands whose name or category resembles the query.
 *
 * Substring matching in both directions, which covers the two common near-misses:
 * a partial name (`power` for `server power`) and an over-qualified one
 * (`server power start` for `server power`). Ranked so a name match beats a category
 * match, and shorter names beat longer ones, since the shorter is usually the
 * intended target.
 *
 * @param {ReturnType<import('../../../commands/registry.js').createRegistry>} registry
 * @param {string} query already lowercased and trimmed
 * @returns {object[]}
 */
function findSimilarCommands(registry, query) {
  if (query.length < 2) return [];

  const scored = [];

  for (const command of registry.all) {
    const name = command.name.toLowerCase();
    let score = 0;

    if (name === query) score = 100;
    else if (name.startsWith(query)) score = 80;
    else if (name.includes(query)) score = 60;
    else if (query.includes(name)) score = 50;
    else if (command.category.toLowerCase() === query) score = 40;
    else {
      // Any shared word, which catches "subuser" for "server subuser add".
      const queryWords = query.split(/\s+/).filter(Boolean);
      const nameWords = name.split(/\s+/);
      if (queryWords.some((word) => word.length >= 3 && nameWords.includes(word))) score = 30;
    }

    if (score > 0) scored.push({ command, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.command.name.length - b.command.name.length)
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => entry.command);
}

export default {
  name: 'help',
  category: 'General',
  description: 'Browse prefix commands or get info on a specific one',
  details:
    'Opens an interactive command browser with a category selector and pagination. Pass a command name to jump straight to that command\'s details, including its arguments, aliases and cooldown.',

  // General is documented as ping, plans, help, which is not alphabetical.
  order: 2,

  // Needs no account and no guild context.
  guildOnly: false,

  aliases: ['commands', 'h'],
  examples: ['help', 'help server power', 'help account create'],

  options: [
    {
      name: 'command',
      type: 'string',
      description: 'A command name to describe, for example "server power"',
      required: false,
      // Greedy so a multi-word name works without quoting on the prefix surface.
      greedy: true,
      maxLength: 60,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    const query = String(ctx.args.command ?? '').trim();

    // ------------------------------------------------------------ browser mode

    if (query === '') {
      await runHelpMenu({ ctx });
      return;
    }

    // ------------------------------------------------------- direct lookup mode

    const normalised = query.toLowerCase().replace(/\s+/g, ' ');

    // Strip a leading prefix so `kx!help kx!ping` behaves as expected.
    const withoutPrefix = normalised.startsWith(ctx.env.prefix.toLowerCase())
      ? normalised.slice(ctx.env.prefix.length).trim()
      : normalised;

    // Strip a leading slash so `kx!help /server power` also works.
    const cleaned = withoutPrefix.startsWith('/') ? withoutPrefix.slice(1).trim() : withoutPrefix;

    // A category name opens the browser at that category, which is what someone
    // typing `kx!help admin` means.
    const category = ctx.registry.categories.find(
      (entry) => entry.name.toLowerCase() === cleaned,
    );
    if (category) {
      await runHelpMenu({ ctx, initialCategory: category.name });
      return;
    }

    // getVisible, so hidden commands stay undiscoverable by name.
    const command = ctx.registry.getVisible(cleaned);

    if (!command) {
      const suggestions = findSimilarCommands(ctx.registry, cleaned);

      await ctx.respond({
        embeds: [
          errorEmbed(
            joinSections([
              `No command named \`${cleaned}\` was found.`,
              suggestions.length > 0
                ? joinSections([
                    '',
                    'Did you mean:',
                    suggestions.map((entry) => `• \`${ctx.env.prefix}${entry.name}\``).join('\n'),
                  ])
                : '',
              '',
              `Run \`${ctx.env.prefix}help\` to browse every command.`,
            ]),
          ),
        ],
      });
      return;
    }

    /**
     * No sessionId is passed, so the detail view renders without a Back button.
     * There is no listing to return to in this mode, and a button that resolves to
     * no session would be refused with "Timed Out" the moment it was pressed.
     */
    const detail = buildCommandDetailView({
      command,
      prefix: ctx.env.prefix,
      registry: ctx.registry,
      // secondsFor reads the configured cooldown without recording one.
      cooldownSeconds: ctx.cooldowns?.secondsFor?.(command.name),
    });

    await ctx.respond({ embeds: [detail.embed] });
  },
};
