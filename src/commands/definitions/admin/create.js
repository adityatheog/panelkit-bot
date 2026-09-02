// Coded by Aditya | GitHub- @adityatheog

/**
 * Administrative shortcut: creates a panel account and a server for another user in one
 * step.
 *
 * A bare root command named `create` rather than `admin create`, because that is the
 * documented tree. It carries `admin create` as an alias so it remains discoverable
 * beside its siblings.
 *
 * Two self-service policies are deliberately bypassed. The Discord account age check
 * does not apply, because it is an anti-abuse rule for open registration and an
 * administrator vouching for someone supersedes it. The per-user server limit does not
 * apply, because an operator granting a second server is exercising the authority the
 * limit exists to reserve for them.
 *
 * Nothing else is bypassed. Provisioning runs through accountService and serverService,
 * so it inherits their credential generation, rollback on a failed local write,
 * per-user locking and orphan handling. The only difference between this and
 * `server create` is policy, not mechanism.
 *
 * Credentials go to the target user by direct message, never to the invoking
 * administrator. An operator does not need their user's password, and delivering it to
 * them would make the account's security dependent on the operator's discretion. When
 * the target's inbox is closed, the reply tells the administrator to have them run
 * `account reset` rather than exposing the password.
 *
 * Authorisation is enforced by the routers before this file runs, and adminService
 * writes an audit line naming the actor.
 */

import {
  bulletList,
  errorEmbed,
  identifierFooter,
  infoEmbed,
  joinSections,
  successEmbed,
  warningEmbed,
} from '../../../utils/embeds.js';
import { trySendDirectMessage } from '../../../core/reply.js';
import { formatLimitMb, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';
import { buildPanelAccountUrl } from '../../../utils/security.js';

export default {
  name: 'create',
  category: 'Admin',
  description: 'Create a panel account and server automatically',
  details:
    'Administrator shortcut. Creates a panel account for the target user if they do not already have one, then provisions a server for them, bypassing both the Discord account age requirement and the per-user server limit. Credentials are sent to the target user by direct message, never to you.',

  // Admin is documented as create, admin servers, admin suspend, admin unsuspend,
  // admin user — so this leads the category rather than sorting alphabetically.
  order: 0,

  adminOnly: true,
  guildOnly: true,
  aliases: ['admin create', 'provision'],
  examples: ['create @user nodejs Their Server'],

  options: [
    {
      name: 'user',
      type: 'user',
      description: 'The Discord user to provision for',
      required: true,
    },
    {
      name: 'type',
      type: 'string',
      description: 'Server type key from config.json, for example "nodejs"',
      required: true,
      maxLength: 32,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Name for the new server, 3 to 32 characters',
      required: true,
      // Greedy so a multi-word name needs no quoting on the prefix surface.
      greedy: true,
      maxLength: 32,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    await ctx.defer();

    /**
     * The context parser validated the user option into a snowflake, but the User object
     * itself is needed: createdTimestamp for the record, and the object to DM.
     *
     * A user who has never shared a guild with the bot may not be cached, so this is a
     * REST fetch that can legitimately fail.
     */
    let target;
    try {
      target = await ctx.client.users.fetch(String(ctx.args.user));
    } catch (err) {
      logger.warn('Admin provisioning could not resolve the target user', {
        actorId: ctx.user.id,
        targetId: ctx.args.user,
        code: err?.code ?? null,
      });

      await ctx.respond({
        embeds: [
          errorEmbed(
            joinSections([
              'That Discord user could not be found.',
              '',
              'Check the ID, and make sure the account still exists.',
            ]),
          ),
        ],
      });
      return;
    }

    if (target.bot) {
      await ctx.respond({
        embeds: [errorEmbed('Panel accounts cannot be created for bot accounts.')],
      });
      return;
    }

    /**
     * adminService creates the account if needed, then provisions the server with the
     * limit bypassed. If the server step fails after an account was created, the account
     * is deliberately kept — its credentials were generated and are about to be
     * delivered, so the target has a working account and the administrator can retry the
     * server without producing a second one.
     */
    const result = await ctx.adminService.provision({
      target: { id: target.id, createdTimestamp: target.createdTimestamp },
      eggKey: ctx.args.type,
      name: ctx.args.name,
      actorId: ctx.user.id,
    });

    const eggLabel = ctx.config.eggs[result.server.egg_type]?.label ?? result.server.egg_type;
    const limits = ctx.config.defaults.limits;
    const identity = ctx.config.identity?.name ?? 'the panel';

    // ------------------------------------------------------ credential delivery

    /**
     * Only present when an account was actually created. An existing account's password
     * is never regenerated here: doing so would lock the user out of an account they are
     * already using, for the administrator's convenience.
     */
    let deliveryNote = 'No new credentials were needed; the account already existed.';
    let deliveryFailed = false;

    if (result.password) {
      const delivery = await trySendDirectMessage(target, {
        embeds: [
          successEmbed(
            'Your Panel Account',
            joinSections([
              `An administrator has created an account for you on ${identity}.`,
              '',
              bulletList([
                ['Panel', ctx.env.panelUrl],
                ['Email', `\`${result.user.email}\``],
                ['Username', `\`${result.user.username}\``],
                ['Password', `\`${result.password}\``],
              ]),
              '',
              '**Keep this message safe.** This password is shown only once.',
              `Change it after your first login at ${buildPanelAccountUrl(ctx.env.panelUrl)}`,
            ]),
          ),
          infoEmbed(
            'Your Server',
            bulletList([
              ['Name', sanitiseForDisplay(result.server.name, 64)],
              ['Type', eggLabel],
              ['Identifier', `\`${result.server.identifier}\``],
              ['Manage it', `\`${ctx.env.prefix}server manage\``],
            ]),
          ),
        ],
      });

      if (delivery.delivered) {
        deliveryNote = 'Credentials sent to their direct messages.';
      } else {
        deliveryFailed = true;
        deliveryNote = delivery.blocked
          ? 'Their direct messages are closed.'
          : 'The direct message could not be delivered.';

        /**
         * The account exists and works; only the password is unrecoverable. It is not
         * stored, not logged, and deliberately not shown to the administrator.
         */
        logger.warn('Admin-provisioned credentials could not be delivered to the target', {
          actorId: ctx.user.id,
          targetId: target.id,
          panelUserId: result.user.panel_id,
          blocked: delivery.blocked,
        });
      }
    }

    // ------------------------------------------------------------------ reporting

    const embeds = [
      successEmbed(
        'Server Provisioned',
        joinSections([
          bulletList([
            ['User', `<@${target.id}>`],
            ['Panel account', result.accountCreated ? 'Created' : 'Already existed'],
            ['Panel username', `\`${result.user.username}\``],
          ]),
          '',
          bulletList([
            ['Server', sanitiseForDisplay(result.server.name, 64)],
            ['Type', eggLabel],
            ['Identifier', `\`${result.server.identifier}\``],
            ['RAM', formatLimitMb(limits.memory)],
            ['Disk', formatLimitMb(limits.disk)],
            ['Panel', ctx.serverService.panelUrlFor(result.server.identifier)],
          ]),
          '',
          bulletList([['Credentials', deliveryNote]]),
        ]),
        identifierFooter(result.server.identifier),
      ),
    ];

    if (deliveryFailed) {
      embeds.push(
        warningEmbed(
          'Credentials Not Delivered',
          joinSections([
            'The account and server were created, but the password could not be sent to the user.',
            '',
            `Ask them to enable direct messages from server members and run \`${ctx.env.prefix}account reset\`, which generates a new password and sends it to them.`,
            '',
            '_The password is not shown here and is not stored anywhere._',
          ]),
        ),
      );
    }

    if (!result.accountCreated) {
      embeds.push(
        infoEmbed(
          'Existing Account Reused',
          joinSections([
            'This user already had a panel account, so no new credentials were generated and their existing password is unchanged.',
            '',
            `The new server counts beyond the normal limit of ${ctx.env.freeServerLimit}.`,
          ]),
        ),
      );
    }

    await ctx.respond({ embeds });
  },
};
