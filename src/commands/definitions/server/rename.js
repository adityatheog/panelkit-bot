// Coded by Aditya | GitHub- @adityatheog

/**
 * Renames one of the user's servers.
 *
 * Cosmetic and reversible, so there is no confirmation step. The name changes on the
 * panel first and in the local record second — serverService.rename() owns that
 * ordering and the reasoning behind it: if the local update failed after the panel
 * succeeded the two would disagree, which is self-correcting on the next rename and
 * not worth a rollback.
 *
 * The name is validated by assertValidServerName, which is stricter than the panel's
 * own rules. It allowlists letters, digits, spaces, dots, underscores and hyphens,
 * requires the first and last characters to be alphanumeric, and rejects control
 * codepoints. That excludes markdown control characters and mention syntax, because a
 * server name is rendered inside embeds throughout this bot — a name containing
 * `@everyone` or backticks would break formatting or ping a channel every time the
 * dashboard refreshed.
 *
 * The greedy option means multi-word names need no quoting on the prefix surface:
 * `kx!server rename a1b2c3d4 My New Server` works as typed.
 */

import {
  bulletList,
  identifierFooter,
  joinSections,
  successEmbed,
} from '../../../utils/embeds.js';
import { sanitiseForDisplay } from '../../../utils/format.js';
import { SERVER_NAME_MAX, SERVER_NAME_MIN } from '../../../utils/validation.js';

export default {
  name: 'server rename',
  category: 'Server',
  description: 'Rename one of your Pterodactyl servers',
  details:
    `Changes a server's display name on the panel and in this bot. Names are ${SERVER_NAME_MIN} to ${SERVER_NAME_MAX} characters and may contain letters, numbers, spaces, dots, underscores and hyphens. This is cosmetic only: the server identifier, files and configuration are untouched.`,

  guildOnly: true,
  examples: ['server rename a1b2c3d4 My New Server'],

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
      name: 'name',
      type: 'string',
      description: `The new server name, ${SERVER_NAME_MIN} to ${SERVER_NAME_MAX} characters`,
      required: true,
      // Greedy so a multi-word name needs no quoting on the prefix surface.
      greedy: true,
      minLength: SERVER_NAME_MIN,
      maxLength: SERVER_NAME_MAX,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // One panel write plus one local update, so acknowledge first.
    await ctx.defer();

    /**
     * The service resolves ownership, validates the name, rejects a no-op rename, and
     * updates the panel before the local record.
     */
    const { server, name, previousName } = await ctx.serverService.rename({
      discordId: ctx.user.id,
      identifier: ctx.args.server,
      name: ctx.args.name,
    });

    await ctx.respond({
      embeds: [
        successEmbed(
          'Server Renamed',
          joinSections([
            bulletList([
              ['Previous name', sanitiseForDisplay(previousName, 64)],
              ['New name', sanitiseForDisplay(name, 64)],
              ['Identifier', `\`${server.identifier}\``],
            ]),
            '',
            // The identifier is what every other command takes, and it does not change.
            '_The identifier is unchanged, so your other commands and any saved links still work._',
          ]),
          identifierFooter(server.identifier),
        ),
      ],
    });
  },
};
