// Coded by Aditya | GitHub- @adityatheog

/**
 * Revokes a sub-user's access to one of the user's servers.
 *
 * The counterpart to `server subuser add`, and deliberately not gated behind a
 * confirmation. Removing access destroys nothing: the sub-user's panel account, the
 * server and its files are all untouched, and access can be granted again in one
 * command. A confirmation step on a reversible, non-destructive action is friction
 * that trains people to click through prompts without reading them.
 *
 * The sub-user is identified by email, matching how they were added. serverService
 * resolves that email to the panel's internal UUID by listing the server's sub-users,
 * so no internal identifier is ever accepted from a user — which keeps panel UUIDs out
 * of the command surface entirely and means a crafted value cannot target a sub-user on
 * a different server.
 *
 * The reply lists who still has access. After a removal, "who can reach this server
 * now" is the question the owner actually has, and answering it here saves a follow-up
 * command.
 *
 * Ephemeral, because the reply enumerates third-party email addresses.
 */

import {
  bulletList,
  identifierFooter,
  infoEmbed,
  joinSections,
  successEmbed,
} from '../../../utils/embeds.js';
import { pluralise, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';

/** How many remaining sub-users are listed individually. */
const MAX_LISTED_SUBUSERS = 10;

export default {
  name: 'server subuser remove',
  category: 'Server',
  description: 'Remove a sub-user from your server',
  details:
    'Revokes a sub-user\'s access to your server. Their panel account and your server files are untouched; only the permission grant is removed. Access can be restored with `server subuser add`.',

  guildOnly: true,
  examples: ['server subuser remove a1b2c3d4 friend@example.com'],

  options: [
    {
      name: 'server',
      type: 'string',
      description: 'The 8-character server identifier',
      required: true,
      minLength: 8,
      maxLength: 8,
    },
    {
      name: 'email',
      type: 'string',
      description: 'The panel email address of the sub-user to remove',
      required: true,
      maxLength: 191,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // Ephemeral: the reply enumerates third-party email addresses.
    await ctx.defer({ ephemeral: true });

    /**
     * The service resolves ownership, validates the email, lists the server's sub-users
     * to find the matching UUID, and performs the removal under a per-server lock so a
     * concurrent add and remove cannot interleave.
     *
     * An email that is not a sub-user raises NotFoundError, which the router's error
     * funnel reports without reaching this point.
     */
    const { server, email, username } = await ctx.serverService.removeSubuser({
      discordId: ctx.user.id,
      identifier: ctx.args.server,
      email: ctx.args.email,
    });

    const embeds = [
      successEmbed(
        'Sub-user Removed',
        joinSections([
          bulletList([
            ['Server', sanitiseForDisplay(server.name, 64)],
            ['Identifier', `\`${server.identifier}\``],
            ['Email', `\`${email}\``],
            ['Panel username', username ? `\`${username}\`` : null],
          ]),
          '',
          'Their access has been revoked. Their panel account and your server files are unchanged.',
        ]),
        identifierFooter(server.identifier),
      ),
    ];

    /**
     * Report who still has access.
     *
     * Best-effort: the removal has already succeeded, so a failure to re-read the list
     * must not turn a completed action into an error reply.
     */
    try {
      const { subusers } = await ctx.serverService.subusers({
        discordId: ctx.user.id,
        identifier: server.identifier,
      });

      if (subusers.length === 0) {
        embeds.push(
          infoEmbed(
            'Remaining Access',
            joinSections([
              'You are now the only person with access to this server.',
              '',
              `Grant access again with \`${ctx.env.prefix}server subuser add ${server.identifier} <email>\`.`,
            ]),
          ),
        );
      } else {
        const listed = subusers
          .slice(0, MAX_LISTED_SUBUSERS)
          .map((entry) => `• \`${entry.email}\``);

        if (subusers.length > MAX_LISTED_SUBUSERS) {
          listed.push(`• _and ${subusers.length - MAX_LISTED_SUBUSERS} more_`);
        }

        embeds.push(
          infoEmbed(
            'Remaining Access',
            joinSections([
              `${pluralise(subusers.length, 'sub-user')} still ${subusers.length === 1 ? 'has' : 'have'} access:`,
              '',
              listed.join('\n'),
            ]),
          ),
        );
      }
    } catch (err) {
      // The removal succeeded; only the follow-up read failed.
      logger.debug('Could not list remaining sub-users after removal', {
        identifier: server.identifier,
        code: err?.code ?? null,
      });
    }

    await ctx.respond({ embeds }, { ephemeral: true });
  },
};
