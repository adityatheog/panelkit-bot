// Coded by Aditya | GitHub- @adityatheog

/**
 * Grants another panel account access to one of the user's servers.
 *
 * Sub-users are how a server owner shares control without sharing credentials. The
 * permission set is chosen by the operator in config.json under
 * `subuser.defaultPermissions`, not by the user running this command — a per-invocation
 * permission picker would let an owner grant rights they do not understand, and the
 * config-level list is validated at startup with the destructive server-level
 * permissions rejected outright.
 *
 * The target is identified by their panel email, which has two consequences worth
 * stating in the reply. They must already have a panel account, because Pterodactyl
 * does not create one implicitly and answers with a validation error otherwise. And the
 * email is the panel login, not a Discord identity — so this command cannot take a
 * mention, and the person being added is whoever controls that panel account.
 *
 * The reply is ephemeral. Adding a sub-user reveals both the server and a third party's
 * email address, and neither belongs in a shared channel.
 *
 * Ownership is resolved before anything else through requireOwnedServer(), so a user
 * cannot add themselves to a server they do not own.
 */

import {
  bulletList,
  identifierFooter,
  infoEmbed,
  joinSections,
  successEmbed,
} from '../../../utils/embeds.js';
import { pluralise, sanitiseForDisplay } from '../../../utils/format.js';

/**
 * Groups panel permission strings by their namespace for display.
 *
 * A flat list of eleven dotted strings is unreadable; grouping by prefix turns it into
 * a short summary an owner can actually assess before handing over access.
 *
 * @param {readonly string[]} permissions
 * @returns {Array<[string, string]>} rows for bulletList
 */
function summarisePermissions(permissions) {
  /** @type {Map<string, string[]>} */
  const groups = new Map();

  for (const permission of permissions) {
    const [namespace, action] = String(permission).split('.');
    if (!groups.has(namespace)) groups.set(namespace, []);
    groups.get(namespace).push(action);
  }

  /** Human-readable names for the namespaces Pterodactyl defines. */
  const labels = {
    control: 'Console and power',
    file: 'Files',
    database: 'Databases',
    allocation: 'Network',
    backup: 'Backups',
    schedule: 'Schedules',
    settings: 'Settings',
    startup: 'Startup',
    user: 'Sub-users',
    activity: 'Activity log',
  };

  return [...groups.entries()].map(([namespace, actions]) => [
    labels[namespace] ?? namespace,
    actions.sort().join(', '),
  ]);
}

export default {
  name: 'server subuser add',
  category: 'Server',
  description: 'Add a sub-user to your server',
  details:
    'Grants an existing panel account access to your server using the permission set the operator has configured. The person must already have an account on the panel; this command cannot create one for them. Sub-users cannot delete your server.',

  guildOnly: true,
  examples: ['server subuser add a1b2c3d4 friend@example.com'],

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
      description: 'The panel email address of the person to add',
      required: true,
      maxLength: 191,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    /**
     * Ephemeral: the reply names a third party's email address and one of the user's
     * servers.
     */
    await ctx.defer({ ephemeral: true });

    /**
     * The service resolves ownership, validates and normalises the email, refuses the
     * owner's own address, refuses a duplicate, and creates the sub-user under a
     * per-server lock so two concurrent adds cannot both pass the duplicate check.
     */
    const { server, subuser, permissions } = await ctx.serverService.addSubuser({
      discordId: ctx.user.id,
      identifier: ctx.args.server,
      email: ctx.args.email,
    });

    const embeds = [
      successEmbed(
        'Sub-user Added',
        joinSections([
          bulletList([
            ['Server', sanitiseForDisplay(server.name, 64)],
            ['Identifier', `\`${server.identifier}\``],
            ['Email', `\`${subuser.email}\``],
            // The panel returns a username only once the account is confirmed.
            ['Panel username', subuser.username ? `\`${subuser.username}\`` : null],
            ['Permissions granted', pluralise(permissions.length, 'permission')],
          ]),
          '',
          `They can now sign in at ${ctx.env.panelUrl} and will see this server on their dashboard.`,
        ]),
        identifierFooter(server.identifier),
      ),
      infoEmbed(
        'What they can do',
        joinSections([
          bulletList(summarisePermissions(permissions)),
          '',
          bulletList([
            ['Cannot', 'Delete this server or change its ownership'],
            ['Remove access', `\`${ctx.env.prefix}server subuser remove ${server.identifier} ${subuser.email}\``],
          ]),
        ]),
      ),
    ];

    await ctx.respond({ embeds }, { ephemeral: true });
  },
};
