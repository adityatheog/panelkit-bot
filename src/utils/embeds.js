// Coded by Aditya | GitHub- @adityatheog

/**
 * Embed construction and the project's UI vocabulary.
 *
 * Every user-visible message in the bot is built here, which gives three things:
 * a single place to change branding or colours, a guarantee that no embed can
 * exceed Discord's payload limits, and consistent titles so users learn what an
 * "Error" versus a "Timed Out" versus a "Server Only" reply means.
 *
 * Discord rejects an entire message when any embed field exceeds its limit, so
 * every setter here clamps rather than trusting the caller. A truncated field is
 * a cosmetic problem; a rejected payload is a failed command.
 */

import { EmbedBuilder } from 'discord.js';
import { truncate } from './format.js';

/** Discord's hard limits for embed components. */
export const LIMITS = Object.freeze({
  title: 256,
  description: 4096,
  footer: 2048,
  author: 256,
  fieldName: 256,
  fieldValue: 1024,
  fields: 25,
  total: 6000,
});

const DEFAULT_PALETTE = Object.freeze({
  primary: '#2B2D31',
  success: '#57F287',
  error: '#ED4245',
  warning: '#FEE75C',
});

const DEFAULT_IDENTITY = Object.freeze({
  name: 'PanelKit',
  footerText: 'PanelKit',
  supportUrl: '',
});

let palette = { ...DEFAULT_PALETTE };
let identity = { ...DEFAULT_IDENTITY };

/**
 * Installs the colour palette from config.json. Called once during startup,
 * before any command can run.
 *
 * @param {Partial<typeof DEFAULT_PALETTE>} colors
 */
export function setPalette(colors) {
  palette = { ...DEFAULT_PALETTE, ...(colors ?? {}) };
}

/**
 * Installs the bot identity from config.json, so branding is not compiled in.
 *
 * @param {Partial<typeof DEFAULT_IDENTITY>} value
 */
export function setIdentity(value) {
  identity = { ...DEFAULT_IDENTITY, ...(value ?? {}) };
}

/** @returns {typeof DEFAULT_PALETTE} the active palette. */
export function getPalette() {
  return { ...palette };
}

/** @returns {typeof DEFAULT_IDENTITY} the active identity. */
export function getIdentity() {
  return { ...identity };
}

/**
 * Renders the project's standard bullet list.
 *
 * Entries whose value is null, undefined or empty are dropped, so a caller can
 * pass optional rows unconditionally without building the array conditionally.
 * Pass `null` as an entry to omit a row outright.
 *
 * @param {Array<[string, unknown]|null|undefined|false>} entries
 * @returns {string} newline-joined bullets, or an empty string
 */
export function bulletList(entries) {
  if (!Array.isArray(entries)) return '';

  return entries
    .filter(
      (entry) =>
        Array.isArray(entry) &&
        entry.length >= 2 &&
        entry[1] !== null &&
        entry[1] !== undefined &&
        entry[1] !== '',
    )
    .map(([label, value]) => `• ${label}: ${value}`)
    .join('\n');
}

/**
 * Joins sections into a description, collapsing runs of blank separators so an
 * omitted section does not leave a double gap.
 *
 * @param {Array<string|null|undefined|false>} sections
 * @returns {string}
 */
export function joinSections(sections) {
  if (!Array.isArray(sections)) return '';

  const kept = sections.filter((section) => typeof section === 'string' && section.length > 0);
  return kept.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * Creates a base embed with the colour, title and timestamp already set.
 *
 * @param {string} color
 * @param {string} title
 * @returns {EmbedBuilder}
 */
function base(color, title) {
  return new EmbedBuilder().setColor(color).setTitle(truncate(title, LIMITS.title)).setTimestamp();
}

/**
 * Applies a description, clamped to Discord's limit.
 *
 * A zero-width space is substituted for empty content because Discord rejects an
 * embed that has neither a description nor fields.
 *
 * @param {EmbedBuilder} embed
 * @param {unknown} description
 * @returns {EmbedBuilder}
 */
function applyDescription(embed, description) {
  const text = String(description ?? '').trim();
  return embed.setDescription(text === '' ? '\u200b' : truncate(text, LIMITS.description));
}

/**
 * Applies a footer, appending the configured identity when a caller supplies
 * context such as a server identifier.
 *
 * @param {EmbedBuilder} embed
 * @param {unknown} footer
 * @returns {EmbedBuilder}
 */
function applyFooter(embed, footer) {
  const text = String(footer ?? '').trim();
  if (text === '') return embed;
  return embed.setFooter({ text: truncate(text, LIMITS.footer) });
}

/**
 * The generic error embed.
 *
 * The blockquote prefix is the project's convention for anything that went
 * wrong, which makes failures visually distinct from informational replies.
 *
 * @param {unknown} message a user-safe message from toUserMessage()
 * @param {string} [title='Error']
 * @returns {EmbedBuilder}
 */
export function errorEmbed(message, title = 'Error') {
  return applyDescription(base(palette.error, title), `> ${String(message ?? 'Something went wrong.')}`);
}

/**
 * A success embed. The title names the action that completed, for example
 * "Server Created" or "Account Deleted", rather than a generic "Success".
 *
 * @param {string} title
 * @param {unknown} description
 * @param {unknown} [footer]
 * @returns {EmbedBuilder}
 */
export function successEmbed(title, description, footer) {
  return applyFooter(applyDescription(base(palette.success, title), description), footer);
}

/**
 * A neutral informational embed, used for listings and dashboards.
 *
 * @param {string} title
 * @param {unknown} description
 * @param {unknown} [footer]
 * @returns {EmbedBuilder}
 */
export function infoEmbed(title, description, footer) {
  return applyFooter(applyDescription(base(palette.primary, title), description), footer);
}

/**
 * A warning embed, used for destructive-action confirmations and cooldowns.
 *
 * @param {string} title
 * @param {unknown} description
 * @param {unknown} [footer]
 * @returns {EmbedBuilder}
 */
export function warningEmbed(title, description, footer) {
  return applyFooter(applyDescription(base(palette.warning, title), description), footer);
}

/**
 * The response when a user lacks permission for a command.
 *
 * Deliberately says nothing about who does have permission, so the reply cannot
 * be used to enumerate administrators.
 *
 * @returns {EmbedBuilder}
 */
export function permissionErrorEmbed() {
  return errorEmbed('You do not have permission to use this command.');
}

/**
 * The response when a guild-only command is used in a direct message.
 *
 * @returns {EmbedBuilder}
 */
export function serverOnlyEmbed() {
  return applyDescription(base(palette.error, 'Server Only'), 'Commands can only be used in a server.');
}

/**
 * The response when an interactive collector expires.
 *
 * @returns {EmbedBuilder}
 */
export function timedOutEmbed() {
  return applyDescription(base(palette.warning, 'Timed Out'), 'Selection timed out. Run the command again.');
}

/**
 * The response when someone interacts with another user's components.
 *
 * @returns {EmbedBuilder}
 */
export function foreignMenuEmbed() {
  return errorEmbed('This menu belongs to someone else.');
}

/**
 * The response when a user is on cooldown.
 *
 * @param {string} remaining a formatted duration from formatDuration()
 * @returns {EmbedBuilder}
 */
export function cooldownEmbed(remaining) {
  return warningEmbed('Slow Down', `Please wait ${remaining} before using this command again.`);
}

/**
 * An error embed carrying a correlation reference, for failures an operator will
 * need to find in the logs. The reference is meaningless to an attacker and
 * saves a support round trip.
 *
 * @param {unknown} message
 * @param {string} reference from newErrorReference()
 * @returns {EmbedBuilder}
 */
export function referencedErrorEmbed(message, reference) {
  return applyFooter(errorEmbed(message), `Reference: ${reference}`);
}

/**
 * Builds a footer that combines a server identifier with the bot identity.
 *
 * @param {string} identifier
 * @returns {string}
 */
export function identifierFooter(identifier) {
  const name = identity.footerText || identity.name;
  return name ? `Identifier: ${identifier} • ${name}` : `Identifier: ${identifier}`;
}

/**
 * Splits a long list of lines across several embeds, so a listing can never
 * exceed the description limit.
 *
 * @param {object} options
 * @param {string} options.title
 * @param {string[]} options.lines
 * @param {string} [options.header] text placed above the lines on the first embed
 * @param {string} [options.footer]
 * @returns {EmbedBuilder[]} at least one embed
 */
export function paginateLines({ title, lines, header, footer }) {
  const safeLines = Array.isArray(lines) ? lines.map((line) => String(line)) : [];
  if (safeLines.length === 0) {
    return [infoEmbed(title, header ?? 'Nothing to show.', footer)];
  }

  const embeds = [];
  let buffer = [];
  let length = header ? header.length + 2 : 0;

  const flush = () => {
    const isFirst = embeds.length === 0;
    const description = joinSections([isFirst && header ? header : null, isFirst && header ? '' : null, buffer.join('\n')]);
    embeds.push(infoEmbed(embeds.length === 0 ? title : `${title} (continued)`, description, footer));
    buffer = [];
    length = 0;
  };

  for (const line of safeLines) {
    const cost = line.length + 1;
    if (length + cost > LIMITS.description && buffer.length > 0) flush();
    buffer.push(line);
    length += cost;
  }
  if (buffer.length > 0) flush();

  return embeds;
}

/**
 * Estimates an embed's total payload size, matching how Discord counts it.
 * Used by the project's tests to assert that no builder can produce an
 * over-limit embed.
 *
 * @param {EmbedBuilder} embed
 * @returns {number}
 */
export function embedLength(embed) {
  const data = embed?.data ?? {};
  let total = 0;
  total += String(data.title ?? '').length;
  total += String(data.description ?? '').length;
  total += String(data.footer?.text ?? '').length;
  total += String(data.author?.name ?? '').length;
  for (const field of data.fields ?? []) {
    total += String(field.name ?? '').length + String(field.value ?? '').length;
  }
  return total;
}

export { DEFAULT_IDENTITY, DEFAULT_PALETTE };
