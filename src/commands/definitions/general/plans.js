// Coded by Aditya | GitHub- @adityatheog

/**
 * Lists the hosting plans an operator has configured.
 *
 * Plans are read entirely from config.json. Nothing here invents pricing, tiers or
 * resource figures, because doing so would put numbers in front of users that the
 * operator never agreed to and may not be able to honour.
 *
 * A fresh clone ships one placeholder plan, so the command is functional from the
 * first run while making clear that the catalogue is operator-owned. If the list is
 * emptied entirely, the command says so and names the file to edit rather than
 * rendering a blank embed.
 *
 * The rendered figures are the plan's advertised limits. They are not the same thing
 * as the limits actually applied when a server is created — those come from
 * `defaults.limits`. Keeping the two separate is deliberate: an operator may
 * advertise several tiers while the bot's self-service path provisions only the free
 * one, with the rest sold or granted by other means. The footer states which tier
 * self-service uses so the difference is visible rather than surprising.
 *
 * Available in direct messages: it reads no account and touches no panel.
 */

import { bulletList, infoEmbed, joinSections, paginateLines } from '../../../utils/embeds.js';
import { formatCpuLimit, formatLimitMb, pluralise } from '../../../utils/format.js';
import { sanitiseForDisplay } from '../../../utils/validation.js';

/**
 * How many plans are rendered per embed.
 *
 * Each plan occupies roughly six lines, so four keeps a page comfortably inside the
 * description limit even with long descriptions.
 */
const PLANS_PER_EMBED = 4;

/**
 * Renders one plan as a block of text.
 *
 * Every field is operator-supplied, so all of it passes through sanitiseForDisplay
 * to neutralise markdown and mention syntax. A stray `@everyone` in a plan
 * description should not ping a server.
 *
 * @param {object} plan a validated plan entry from config.json
 * @returns {string}
 */
function renderPlan(plan) {
  const heading = `**${sanitiseForDisplay(plan.name, 100)}** — ${sanitiseForDisplay(plan.price, 100)}`;

  const specs = bulletList([
    ['RAM', formatLimitMb(plan.ram)],
    ['Disk', formatLimitMb(plan.disk)],
    ['CPU', formatCpuLimit(plan.cpu)],
    ['Servers', plan.servers],
    // Omitted entirely when empty, rather than rendered as a blank row.
    ['Notes', plan.description ? sanitiseForDisplay(plan.description, 400) : null],
  ]);

  return joinSections([heading, specs]);
}

export default {
  name: 'plans',
  category: 'General',
  description: 'View available hosting plans and pricing',
  details:
    'Lists the hosting plans configured for this bot, including their resource limits and pricing. Plans are defined by the operator in config.json; the bot does not set pricing itself.',

  // General is documented as ping, plans, help, which is not alphabetical.
  order: 1,

  // Needs no account and no guild context.
  guildOnly: false,

  aliases: ['pricing', 'tiers'],
  examples: ['plans'],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    const plans = ctx.config.plans ?? [];
    const identity = ctx.config.identity?.name ?? 'this bot';

    if (plans.length === 0) {
      await ctx.respond({
        embeds: [
          infoEmbed(
            'Hosting Plans',
            joinSections([
              'No hosting plans have been configured yet.',
              '',
              'An administrator can add them under the `plans` array in `config.json`.',
            ]),
          ),
        ],
      });
      return;
    }

    /**
     * The footer states what self-service actually provisions, which is governed by
     * FREE_SERVER_LIMIT and defaults.limits rather than by this catalogue. Without
     * it, a user reading a four-tier list has no way to know which one they get by
     * running `server create`.
     */
    const selfServiceLimits = ctx.config.defaults.limits;
    const footer = joinSections([
      `Self-service: ${pluralise(ctx.env.freeServerLimit, 'server')} per user`,
      `at ${formatLimitMb(selfServiceLimits.memory)} RAM and ${formatLimitMb(selfServiceLimits.disk)} disk.`,
    ]).replace('\n', ' ');

    // A short catalogue renders as one embed; a long one is split rather than
    // truncated, so a plan can never silently disappear off the end.
    if (plans.length <= PLANS_PER_EMBED) {
      await ctx.respond({
        embeds: [
          infoEmbed(
            'Hosting Plans',
            plans.map(renderPlan).join('\n\n'),
            `${pluralise(plans.length, 'plan')} • ${footer}`,
          ),
        ],
      });
      return;
    }

    const embeds = paginateLines({
      title: 'Hosting Plans',
      lines: plans.map((plan) => `${renderPlan(plan)}\n`),
      header: `${identity} offers ${pluralise(plans.length, 'plan')}.`,
      footer,
    });

    // Discord accepts at most ten embeds in one message.
    await ctx.respond({ embeds: embeds.slice(0, 10) });
  },
};
