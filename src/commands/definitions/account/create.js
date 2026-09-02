// Coded by Aditya | GitHub- @adityatheog

/**
 * Creates a panel account linked to the invoking Discord user.
 *
 * The credential delivery rule shapes this entire command: a generated password is
 * shown exactly once, in a direct message, and never anywhere else. It is not
 * logged, not stored, and not repeated in the channel confirmation. That is why the
 * DM is attempted before the success reply is sent — if delivery fails, the user must
 * be told how to recover rather than being congratulated on an account whose
 * password nobody has.
 *
 * The failure path matters as much as the success path. When DMs are closed, the
 * account already exists on the panel and deleting it would be worse than leaving it:
 * the user has a real account and needs a working password, not a clean slate. So the
 * reply names `account reset` as the recovery route, which regenerates the password
 * and retries delivery once their DMs are open.
 *
 * Both replies are ephemeral on the slash surface. Whether someone has a panel
 * account is their business, and a public "Account Created" in a shared channel
 * advertises it to everyone present.
 *
 * Everything about eligibility — the Discord account age policy, the duplicate check,
 * the panel call, the rollback if the local write fails — lives in accountService.
 * This file is presentation and delivery only.
 */

import { bulletList, errorEmbed, infoEmbed, joinSections, successEmbed } from '../../../utils/embeds.js';
import { buildPanelAccountUrl } from '../../../utils/security.js';
import { trySendDirectMessage } from '../../../core/reply.js';
import { logger } from '../../../utils/logger.js';

export default {
  name: 'account create',
  category: 'Account',
  description: 'Create a Pterodactyl panel account linked to your Discord account',
  details:
    'Generates a panel account with a random username and a cryptographically secure password. The credentials are sent to you in a direct message and are never shown in a channel. Your Discord account must meet the minimum age requirement configured by the operator.',

  guildOnly: true,
  aliases: ['register', 'signup'],
  examples: ['account create'],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // Ephemeral: creating an account should not be announced to the channel.
    await ctx.defer({ ephemeral: true });

    /**
     * The password exists only in this local binding for the lifetime of this
     * function. accountService returns it once and stores nothing.
     */
    const { user, password } = await ctx.accountService.createAccount({
      id: ctx.user.id,
      createdTimestamp: ctx.user.createdTimestamp,
    });

    const panelUrl = ctx.env.panelUrl;
    const accountUrl = buildPanelAccountUrl(panelUrl);
    const identity = ctx.config.identity?.name ?? 'the panel';

    const credentialEmbed = successEmbed(
      'Your Panel Credentials',
      joinSections([
        `Your account on ${identity} is ready.`,
        '',
        bulletList([
          ['Panel', panelUrl],
          ['Email', `\`${user.email}\``],
          ['Username', `\`${user.username}\``],
          ['Password', `\`${password}\``],
        ]),
        '',
        '**Keep this message safe.** This password is shown only once.',
        `Change it after your first login at ${accountUrl}`,
      ]),
    );

    // Delivery is attempted before the channel confirmation, so the confirmation
    // never claims something that did not happen.
    const delivery = await trySendDirectMessage(ctx.user, { embeds: [credentialEmbed] });

    if (!delivery.delivered) {
      /**
       * The account exists and is usable; only the password is unrecoverable. It is
       * deliberately not deleted: the user now has a real panel account, and
       * `account reset` regenerates the password without creating a second one.
       *
       * The password is not written to the log here or anywhere else.
       */
      logger.warn('Panel credentials could not be delivered by direct message', {
        discordId: ctx.user.id,
        panelUserId: user.panel_id,
        blocked: delivery.blocked,
      });

      await ctx.respond(
        {
          embeds: [
            errorEmbed(
              joinSections([
                'Your panel account was created, but the credentials could not be sent to you.',
                '',
                delivery.blocked
                  ? 'Your direct messages are closed. Enable **Direct Messages** from server members in this server\'s privacy settings, then run the command below.'
                  : 'The direct message could not be delivered. Once you can receive direct messages from this bot, run the command below.',
                '',
                `\`${ctx.env.prefix}account reset\` — generates a new password and sends it to you.`,
              ]),
              'Account Created — Credentials Not Delivered',
            ),
          ],
        },
        { ephemeral: true },
      );
      return;
    }

    /**
     * The channel confirmation carries no identifying detail: no username, no email,
     * no panel link. Everything specific is in the direct message.
     */
    await ctx.respond(
      {
        embeds: [
          successEmbed(
            'Account Created',
            bulletList([
              ['Credentials', 'Sent to your direct messages'],
              ['Credits', user.credits],
              ['Server limit', ctx.env.freeServerLimit],
              ['Next step', `\`${ctx.env.prefix}server create\``],
            ]),
          ),
          infoEmbed(
            'Before you start',
            `Change your password after your first login. If you lose it, run \`${ctx.env.prefix}account reset\`.`,
          ),
        ],
      },
      { ephemeral: true },
    );
  },
};
