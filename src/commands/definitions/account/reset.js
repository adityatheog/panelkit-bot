// Coded by Aditya | GitHub- @adityatheog

/**
 * Resets the invoking user's panel password.
 *
 * This is the recovery path for the two ways a password becomes unusable: the user
 * lost it, or `account create` could not deliver it because their direct messages
 * were closed. Both are common enough that the command carries a long cooldown rather
 * than being gated behind an administrator.
 *
 * The command is destructive in a narrow sense — the old password stops working the
 * instant the panel accepts the change — so the ordering here is the opposite of
 * `account create`. There, the account was already created before delivery was
 * attempted, and a failed DM left something usable. Here, a failed DM after a
 * successful reset leaves the user *worse off than before*: their old password is dead
 * and the new one went nowhere.
 *
 * That cannot be fully avoided, because the panel offers no way to test DM
 * deliverability without a password to send. What it can do is check first: a probe
 * message is delivered before the reset is performed, so the overwhelmingly common
 * failure (closed DMs) is caught while the existing password still works. Only once
 * delivery is proven does the password change.
 *
 * Always ephemeral. Whether someone is resetting a password is not channel business.
 */

import { bulletList, errorEmbed, infoEmbed, joinSections, successEmbed } from '../../../utils/embeds.js';
import { trySendDirectMessage } from '../../../core/reply.js';
import { logger } from '../../../utils/logger.js';
import { buildPanelAccountUrl } from '../../../utils/security.js';

export default {
  name: 'account reset',
  category: 'Account',
  description: 'Reset your Pterodactyl panel account password',
  details:
    'Generates a new random password on the panel and sends it to you in a direct message. Your old password stops working immediately. Your direct messages are checked before the password is changed, so a closed inbox does not leave you locked out.',

  guildOnly: true,
  aliases: ['account password', 'resetpassword'],
  examples: ['account reset'],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // Ephemeral: a password reset is between the bot and the user.
    await ctx.defer({ ephemeral: true });

    const account = ctx.accountService.getAccount(ctx.user.id);

    if (!account) {
      await ctx.respond(
        {
          embeds: [
            errorEmbed(
              joinSections([
                'You do not have a panel account to reset.',
                '',
                `Run \`${ctx.env.prefix}account create\` to make one.`,
              ]),
            ),
          ],
        },
        { ephemeral: true },
      );
      return;
    }

    const identity = ctx.config.identity?.name ?? 'the panel';

    /**
     * Deliverability probe.
     *
     * Sent before the reset, so a closed inbox is discovered while the existing
     * password still works. This is the difference between "your DMs are closed, fix
     * them and try again" and "your password has been changed and you cannot have it".
     *
     * The probe is also genuinely useful to the user rather than a bare test message:
     * it confirms what is about to happen.
     */
    const probe = await trySendDirectMessage(ctx.user, {
      embeds: [
        infoEmbed(
          'Password Reset Starting',
          joinSections([
            `A new password for your account on ${identity} is being generated.`,
            'It will arrive in the next message.',
          ]),
        ),
      ],
    });

    if (!probe.delivered) {
      logger.debug('Password reset aborted: direct messages unavailable', {
        discordId: ctx.user.id,
        blocked: probe.blocked,
      });

      await ctx.respond(
        {
          embeds: [
            errorEmbed(
              joinSections([
                'Your password was **not** changed, because the new one could not be delivered to you.',
                '',
                probe.blocked
                  ? 'Your direct messages are closed. Open this server\'s privacy settings, enable **Direct Messages** from server members, then run this command again.'
                  : 'A direct message could not be delivered. Once you can receive messages from this bot, run this command again.',
                '',
                'Your existing password still works.',
              ]),
              'Reset Cancelled — Direct Messages Unavailable',
            ),
          ],
        },
        { ephemeral: true },
      );
      return;
    }

    // Delivery is proven, so the password can be changed.
    const { user, password } = await ctx.accountService.resetPassword(ctx.user.id);

    const delivery = await trySendDirectMessage(ctx.user, {
      embeds: [
        successEmbed(
          'Your New Panel Password',
          joinSections([
            bulletList([
              ['Panel', ctx.env.panelUrl],
              ['Email', `\`${user.email}\``],
              ['Username', `\`${user.username}\``],
              ['New password', `\`${password}\``],
            ]),
            '',
            '**Keep this message safe.** This password is shown only once.',
            `Your previous password no longer works. Change this one at ${buildPanelAccountUrl(ctx.env.panelUrl)}`,
          ]),
        ),
      ],
    });

    if (!delivery.delivered) {
      /**
       * The probe succeeded and this failed, so the user closed their inbox or blocked
       * the bot in the intervening seconds, or Discord dropped the message. The
       * password has already changed and cannot be recovered — it is not stored
       * anywhere and is never logged. Running the command again is the only remedy.
       */
      logger.error('Password was reset but the new credentials could not be delivered', {
        discordId: ctx.user.id,
        panelUserId: user.panel_id,
        blocked: delivery.blocked,
      });

      await ctx.respond(
        {
          embeds: [
            errorEmbed(
              joinSections([
                'Your password was changed, but the new one could not be delivered.',
                '',
                'The old password no longer works, and the new one cannot be shown again — it is not stored anywhere.',
                '',
                `Make sure you can receive direct messages from this bot, then run \`${ctx.env.prefix}account reset\` again.`,
              ]),
              'Password Changed — Delivery Failed',
            ),
          ],
        },
        { ephemeral: true },
      );
      return;
    }

    await ctx.respond(
      {
        embeds: [
          successEmbed(
            'Password Reset',
            bulletList([
              ['New password', 'Sent to your direct messages'],
              ['Previous password', 'No longer works'],
              ['Panel', ctx.env.panelUrl],
            ]),
          ),
        ],
      },
      { ephemeral: true },
    );
  },
};
