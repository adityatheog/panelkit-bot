// Coded by Aditya | GitHub- @adityatheog

/**
 * Help menu rendering.
 *
 * Every function here is pure: given a registry, a prefix and a position in the
 * menu, it returns embeds and component rows. Nothing reads global state, performs
 * I/O or touches a session store. That is what makes the layout testable — the test
 * suite asserts the exact rendered lines, footer text and button states rather than
 * trusting a screenshot.
 *
 * The layout this produces, in order:
 *
 *   ┌────────────────────────────────────────────┐
 *   │ Prefix Commands                            │  title
 *   │ 24 commands • 5 categories • prefix: kx!   │  header line
 *   │                                            │
 *   │ • **account create** — Create a panel a... │  one line per command
 *   │ • **account delete** — Delete your pane... │
 *   │ …                                          │
 *   │ Account • Page 1 of 1                      │  footer
 *   └────────────────────────────────────────────┘
 *   [ Select a category                        ▾ ]  row 1
 *   [ Select a command to view details         ▾ ]  row 2
 *   [ Previous ] [ Next ]                            row 3, only when paginated
 *
 * Two constants drive the shape and both live in config.json rather than here.
 *
 * `help.pageSize` (8) is the number of commands per page. Eight is the value that
 * keeps Account, Admin, Files and General on a single page while paginating Server,
 * which has eleven commands.
 *
 * `help.descriptionMax` (51) is where a description is cut before the ellipsis. It
 * is a display concern only; the full text appears in the detail view.
 *
 * Discord's component limits are respected structurally: a select menu accepts at
 * most 25 options, which page size can never exceed, and every custom id is built
 * through buildCustomId() so an over-long id throws during development rather than
 * silently failing to render.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from 'discord.js';
import { bulletList, infoEmbed, joinSections, LIMITS } from '../utils/embeds.js';
import { formatDuration } from '../utils/format.js';
import { buildCustomId } from '../utils/sessions.js';

/** Namespace prefixing every help component's custom id. */
export const HELP_NS = 'help';

/** Fallbacks used when a caller does not pass config values. */
export const DEFAULT_PAGE_SIZE = 8;
export const DEFAULT_DESCRIPTION_MAX = 51;

/** Discord's ceiling on options in one select menu. */
const MAX_SELECT_OPTIONS = 25;

/** Discord's ceiling on a select option's label and description. */
const MAX_OPTION_TEXT = 100;

/** Placeholder text for the two select menus. Part of the specified design. */
const CATEGORY_PLACEHOLDER = 'Select a category';
const COMMAND_PLACEHOLDER = 'Select a command to view details';

/** Sentinel value used when a category renders no commands. */
const EMPTY_VALUE = '__none__';

/**
 * Truncates a command description for the list view.
 *
 * A description at or under the limit is returned unchanged, with no ellipsis. One
 * character over is cut to exactly `max` characters and suffixed with three dots, so
 * the visible width is stable across rows.
 *
 * @param {unknown} text
 * @param {number} [max]
 * @returns {string}
 */
export function truncateDescription(text, max = DEFAULT_DESCRIPTION_MAX) {
  const value = String(text ?? '').trim();
  const limit = Math.max(1, Number(max) || DEFAULT_DESCRIPTION_MAX);

  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}

/**
 * Number of pages needed for a command count.
 *
 * Always at least one, so an empty category still renders a page rather than
 * producing "Page 1 of 0".
 *
 * @param {number} total
 * @param {number} pageSize
 * @returns {number}
 */
export function pageCount(total, pageSize) {
  const count = Math.max(0, Number(total) || 0);
  const size = Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE);
  return Math.max(1, Math.ceil(count / size));
}

/**
 * Slices the commands visible on one page.
 *
 * Does not mutate the input and returns an empty array for an out-of-range page;
 * clamping is the caller's job, and buildHelpView does it.
 *
 * @param {Array<object>} commands
 * @param {number} page zero-based
 * @param {number} pageSize
 * @returns {Array<object>}
 */
export function commandsForPage(commands, page, pageSize) {
  const list = Array.isArray(commands) ? commands : [];
  const size = Math.max(1, Number(pageSize) || DEFAULT_PAGE_SIZE);
  const start = Math.max(0, Number(page) || 0) * size;

  return list.slice(start, start + size);
}

/**
 * Builds the header line.
 *
 * Reports only visible commands, so a hidden legacy command does not inflate the
 * count a user sees.
 *
 * @param {object} input
 * @param {ReturnType<import('../commands/registry.js').createRegistry>} input.registry
 * @param {string} input.prefix
 * @returns {string} for example "24 commands • 5 categories • prefix: kx!"
 */
export function buildHeaderLine({ registry, prefix }) {
  const { commands, categories } = registry.counts;
  return `${commands} commands • ${categories} categories • prefix: ${prefix}`;
}

/**
 * Builds the footer text.
 *
 * @param {object} input
 * @param {string} input.categoryName
 * @param {number} input.page zero-based
 * @param {number} input.pages
 * @returns {string} for example "Account • Page 1 of 1"
 */
export function buildFooterText({ categoryName, page, pages }) {
  return `${categoryName} • Page ${Number(page) + 1} of ${pages}`;
}

/**
 * Renders one list line per command.
 *
 * The format is fixed by the design: a bullet, the command name in bold, an em dash,
 * then the truncated description.
 *
 * @param {Array<object>} commands
 * @param {number} [max] description truncation width
 * @returns {string[]}
 */
export function buildCommandLines(commands, max = DEFAULT_DESCRIPTION_MAX) {
  return (Array.isArray(commands) ? commands : []).map(
    (command) => `• **${command.name}** — ${truncateDescription(command.description, max)}`,
  );
}

/**
 * Builds the category select menu.
 *
 * Each option carries the category's command count as its description, and the
 * active category is marked default so the menu reflects the current view after a
 * page change.
 *
 * @param {object} input
 * @param {ReturnType<import('../commands/registry.js').createRegistry>} input.registry
 * @param {string} input.sessionId
 * @param {string} input.categoryName the active category
 * @param {boolean} input.disabled
 * @returns {ActionRowBuilder}
 */
function categorySelectRow({ registry, sessionId, categoryName, disabled }) {
  const options = registry.categories.slice(0, MAX_SELECT_OPTIONS).map((category) => ({
    label: category.name.slice(0, MAX_OPTION_TEXT),
    value: category.name,
    description: `${category.commands.length} command${category.commands.length === 1 ? '' : 's'}`,
    default: category.name === categoryName,
  }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId(HELP_NS, 'category', sessionId))
      .setPlaceholder(CATEGORY_PLACEHOLDER)
      .setDisabled(Boolean(disabled))
      .addOptions(options),
  );
}

/**
 * Builds the command detail select menu.
 *
 * Only commands on the visible page are offered, which keeps the menu aligned with
 * the list above it and guarantees the option count stays within Discord's limit.
 *
 * A select menu must carry at least one option, so an empty category renders a
 * single disabled placeholder rather than an invalid component.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {Array<object>} input.commands the page's commands
 * @param {boolean} input.disabled
 * @returns {ActionRowBuilder}
 */
function commandSelectRow({ sessionId, commands, disabled }) {
  const list = Array.isArray(commands) ? commands : [];

  const options =
    list.length === 0
      ? [{ label: 'No commands available', value: EMPTY_VALUE }]
      : list.slice(0, MAX_SELECT_OPTIONS).map((command) => ({
          label: command.name.slice(0, MAX_OPTION_TEXT),
          value: command.name,
          description: truncateDescription(command.description, MAX_OPTION_TEXT),
        }));

  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(buildCustomId(HELP_NS, 'command', sessionId))
      .setPlaceholder(COMMAND_PLACEHOLDER)
      .setDisabled(Boolean(disabled) || list.length === 0)
      .addOptions(options),
  );
}

/**
 * Builds the pagination row.
 *
 * Both buttons always render when a category paginates; the unavailable direction is
 * disabled rather than hidden, so the row does not shift position as a user pages
 * through.
 *
 * @param {object} input
 * @param {string} input.sessionId
 * @param {number} input.page zero-based
 * @param {number} input.pages
 * @param {boolean} input.disabled
 * @returns {ActionRowBuilder}
 */
function paginationRow({ sessionId, page, pages, disabled }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(buildCustomId(HELP_NS, 'prev', sessionId))
      .setLabel('Previous')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(Boolean(disabled) || page <= 0),
    new ButtonBuilder()
      .setCustomId(buildCustomId(HELP_NS, 'next', sessionId))
      .setLabel('Next')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(Boolean(disabled) || page >= pages - 1),
  );
}

/**
 * Builds the category listing view.
 *
 * An unknown category falls back to the first one rather than throwing, because the
 * category name can arrive from a select menu value on a message that outlived a
 * configuration change. The page index is clamped for the same reason.
 *
 * @param {object} input
 * @param {ReturnType<import('../commands/registry.js').createRegistry>} input.registry
 * @param {string} input.prefix
 * @param {string} [input.categoryName]
 * @param {number} [input.page] zero-based
 * @param {string} input.sessionId
 * @param {number} [input.pageSize]
 * @param {number} [input.descriptionMax]
 * @param {boolean} [input.disabled] renders every control inert, for the timeout state
 * @returns {{ embed: import('discord.js').EmbedBuilder, components: ActionRowBuilder[], page: number, pages: number, category: object }}
 */
export function buildHelpView({
  registry,
  prefix,
  categoryName,
  page = 0,
  sessionId,
  pageSize = DEFAULT_PAGE_SIZE,
  descriptionMax = DEFAULT_DESCRIPTION_MAX,
  disabled = false,
}) {
  const category = registry.category(categoryName) ?? registry.categories[0];

  const pages = pageCount(category.commands.length, pageSize);
  const safePage = Math.min(Math.max(0, Number(page) || 0), pages - 1);
  const visible = commandsForPage(category.commands, safePage, pageSize);

  const commandLines =
    visible.length > 0
      ? buildCommandLines(visible, descriptionMax).join('\n')
      : 'No commands in this category.';

  /**
   * Composed directly rather than through joinSections, which filters empty strings.
   *
   * That filtering is correct for optional sections — an omitted one should not leave a
   * double gap — but it also swallows this deliberate separator, and the specified layout
   * requires a blank line between the header and the list.
   */
  const embed = infoEmbed(
    'Prefix Commands',
    `${buildHeaderLine({ registry, prefix })}\n\n${commandLines}`,
    buildFooterText({ categoryName: category.name, page: safePage, pages }),
  );

  const components = [
    categorySelectRow({ registry, sessionId, categoryName: category.name, disabled }),
    commandSelectRow({ sessionId, commands: visible, disabled }),
  ];

  // The pagination row is present only when it would do something, per the design.
  if (pages > 1) {
    components.push(paginationRow({ sessionId, page: safePage, pages, disabled }));
  }

  return { embed, components, page: safePage, pages, category };
}

/**
 * Renders a command's slash invocation.
 *
 * Required options appear in angle brackets and optional ones in square brackets,
 * which is the convention the detail view uses for both surfaces.
 *
 * @param {object} command
 * @returns {string|null} null when the command is not registered as a slash command
 */
export function slashForm(command) {
  if (command.slash === false) return null;

  const options = (command.options ?? []).map((option) =>
    option.required ? `<${option.name}>` : `[${option.name}]`,
  );

  return `/${command.name}${options.length > 0 ? ` ${options.join(' ')}` : ''}`;
}

/**
 * Renders a command's prefix invocation.
 *
 * @param {object} command
 * @param {string} prefix
 * @returns {string}
 */
export function prefixForm(command, prefix) {
  const options = (command.options ?? []).map((option) =>
    option.required ? `<${option.name}>` : `[${option.name}]`,
  );

  return `${prefix}${command.name}${options.length > 0 ? ` ${options.join(' ')}` : ''}`;
}

/**
 * Builds the argument documentation block.
 *
 * @param {object} command
 * @returns {string}
 */
function buildArgumentLines(command) {
  const options = command.options ?? [];
  if (options.length === 0) return '';

  const lines = options.map((option) => {
    const parts = [`• \`${option.name}\``];

    if (option.required) parts.push('(required)');
    parts.push(`— ${option.description}`);

    if (option.choices) {
      parts.push(`[${option.choices.map((choice) => choice.value).join(' | ')}]`);
    }

    return parts.join(' ');
  });

  return joinSections(['', '**Arguments**', lines.join('\n')]);
}

/**
 * Builds the examples block.
 *
 * @param {object} command
 * @param {string} prefix
 * @returns {string}
 */
function buildExampleLines(command, prefix) {
  const examples = command.examples ?? [];
  if (examples.length === 0) return '';

  return joinSections([
    '',
    '**Examples**',
    examples.map((example) => `\`${prefix}${example}\``).join('\n'),
  ]);
}

/**
 * Builds the detail view for one command.
 *
 * Shows the full description rather than the truncated form, both invocation
 * surfaces, aliases, access level, where it can be used, its arguments and its
 * cooldown. The Back button returns to the listing when a session is live; the
 * static form used by `kx!help <command>` omits it.
 *
 * @param {object} input
 * @param {object} input.command
 * @param {string} input.prefix
 * @param {string} [input.sessionId] when omitted, no Back button is rendered
 * @param {ReturnType<import('../commands/registry.js').createRegistry>} input.registry
 * @param {number} [input.cooldownSeconds]
 * @returns {{ embed: import('discord.js').EmbedBuilder, components: ActionRowBuilder[] }}
 */
export function buildCommandDetailView({ command, prefix, sessionId, registry, cooldownSeconds }) {
  const slash = slashForm(command);
  const aliases = command.aliases ?? [];

  const summary = bulletList([
    ['Category', command.category],
    ['Prefix', `\`${prefixForm(command, prefix)}\``],
    ['Slash', slash ? `\`${slash}\`` : 'Not available'],
    ['Aliases', aliases.length > 0 ? aliases.map((alias) => `\`${prefix}${alias}\``).join(', ') : 'None'],
    ['Access', command.adminOnly ? 'Administrators only' : 'Everyone'],
    ['Where', command.guildOnly === false ? 'Servers and direct messages' : 'Servers only'],
    [
      'Cooldown',
      Number(cooldownSeconds) > 0 ? formatDuration(Number(cooldownSeconds) * 1000) : 'None',
    ],
  ]);

  const description = joinSections([
    // The detail view is where the untruncated description belongs.
    command.details ?? command.description,
    '',
    summary,
    buildArgumentLines(command),
    buildExampleLines(command, prefix),
  ]);

  const embed = infoEmbed(
    `Command: ${command.name}`,
    description.slice(0, LIMITS.description),
    `${command.category} • ${registry.counts.commands} commands available`,
  );

  const components = sessionId
    ? [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(buildCustomId(HELP_NS, 'back', sessionId))
            .setLabel('Back')
            .setStyle(ButtonStyle.Secondary),
        ),
      ]
    : [];

  return { embed, components };
}

export { CATEGORY_PLACEHOLDER, COMMAND_PLACEHOLDER, EMPTY_VALUE, MAX_SELECT_OPTIONS };
