// Coded by Aditya | GitHub- @adityatheog

/**
 * Shows the invoking user's panel account details.
 *
 * A read-only command with one hard rule: it never displays a password. There is
 * nothing to display — accountService returns a password exactly once at creation or
 * reset, and nothing in this project stores it. If a user has lost their password,
 * `account reset` is the only route, and this command says so rather than implying a
 * password could be recovered here.
 *
 * The email is shown because it is the panel login and the user needs it. The panel
 * user id is shown because it is the identifier an operator will ask for during
 * support, and it grants nothing on its own.
 *
 * Always ephemeral. An account's email, credits and server count are personal data,
 * and posting them into a shared channel exposes them to everyone present.
 *
 * The panel lookup is best-effort inside accountService, which reports it through
 * `panelReachable`. That distinction is surfaced here rather than hidden: "could not
 * verify" and "verified" are materially different pieces of information when someone
 * is trying to work out why their login is failing.
 */

import { bulletList, infoEmbed, joinSections, warningEmbed } from '../../../utils/embeds.js';
import { formatTimestamp, pluralise } from '../../../utils/format.js';
import { buildPanelAccountUrl } from '../../../utils/security.js';

export default {
  name: 'account info',
  category: 'Account',
  description: 'View your panel account details',
  details:
    'Shows your panel username, login email, credits balance, server usage and account age. Passwords are never displayed and cannot be recovered; use `account reset` to generate a new one.',

  guildOnly: true,
  aliases: ['account', 'whoami'],
  examples: ['account info'],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // Ephemeral: this reply contains the user's login email and balance.
    await ctx.defer({ ephemeral: true });

    const info = await ctx.accountService.getAccountInfo(ctx.user.id);

    const atLimit = info.serverCount >= info.serverLimit;
    const remaining = Math.max(0, info.serverLimit - info.serverCount);

    const embeds = [
      infoEmbed(
        'Account Info',
        joinSections([
          bulletList([
            ['Panel', ctx.env.panelUrl],
            ['Username', `\`${info.username}\``],
            ['Login email', `\`${info.email}\``],
            ['Panel ID', info.panelId],
          ]),
          '',
          bulletList([
            ['Credits', info.credits],
            [
              'Servers',
              `${info.serverCount} of ${pluralise(info.serverLimit, 'server')}${
                atLimit ? ' — **limit reached**' : ` — ${remaining} remaining`
              }`,
            ],
            ['Account created', formatTimestamp(info.createdAt)],
            // Only shown when true. A "no" row would be noise for every normal user.
            ['Panel administrator', info.panelAdmin ? 'Yes' : null],
          ]),
          '',
          bulletList([
            ['Change password', `\`${ctx.env.prefix}account reset\``],
            [
              'Manage servers',
              atLimit
                ? `\`${ctx.env.prefix}server list\``
                : `\`${ctx.env.prefix}server create\``,
            ],
            ['Panel settings', buildPanelAccountUrl(ctx.env.panelUrl)],
          ]),
        ]),
      ),
    ];

    /**
     * The panel could not confirm the account exists. Surfaced explicitly because it
     * changes what the user should conclude: the local record shown above is real, but
     * the panel side is unverified, so a failing login right now is probably the
     * panel rather than their credentials.
     */
    if (!info.panelReachable) {
      embeds.push(
        warningEmbed(
          'Panel Not Reachable',
          joinSections([
            'The details above come from this bot\'s records, but the panel could not be contacted to confirm them.',
            '',
            'The panel may be restarting. Try again in a few minutes; if logins keep failing, contact an administrator.',
          ]),
        ),
      );
    }

    await ctx.respond({ embeds }, { ephemeral: true });
  },
};
