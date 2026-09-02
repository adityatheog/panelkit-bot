// Coded by Aditya | GitHub- @adityatheog

/**
 * Archives a server's files and delivers them to the user's direct messages.
 *
 * Delivery is DM-only, and that is a security requirement rather than a preference.
 * Two different things must never reach a channel:
 *
 *   The archive itself, which contains configuration files, and for many eggs those
 *   include database passwords, API tokens and RCON credentials.
 *
 *   The signed download URL, when the archive is too large to attach. That URL grants
 *   file access to anyone holding it, with no authentication header — it is a bearer
 *   credential in query-string form.
 *
 * So the DM is probed before the archive is created. Compressing a filesystem is the
 * most expensive operation this bot can ask of a node, and discovering afterwards that
 * the user's inbox is closed wastes that work and leaves a stray archive on their disk.
 *
 * Two delivery paths, chosen by size. Small archives are downloaded by the bot and
 * attached, then deleted from the server so a backup nobody asked to keep does not
 * consume the user's disk quota. Larger ones exceed Discord's upload limit, so they are
 * left in place and delivered as a link — and the reply says the file is still there and
 * how to remove it.
 *
 * This carries the longest cooldown in the tree after `account reset`, at 120 seconds,
 * because each invocation makes a node compress an entire directory tree.
 */

import { AttachmentBuilder } from 'discord.js';
import { trySendDirectMessage } from '../../../core/reply.js';
import {
  bulletList,
  errorEmbed,
  identifierFooter,
  infoEmbed,
  joinSections,
  successEmbed,
  warningEmbed,
} from '../../../utils/embeds.js';
import { formatBytes, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';

export default {
  name: 'files backup',
  category: 'Files',
  description: 'Archive and download your server files to your DMs',
  details:
    'Creates a compressed archive of your server\'s files and sends it to you in a direct message. Small archives are attached directly; larger ones are delivered as a temporary download link. Nothing is ever posted in a channel, because server files commonly contain passwords and API keys.',

  guildOnly: true,
  aliases: ['backup', 'files download'],
  examples: ['files backup a1b2c3d4'],

  options: [
    {
      name: 'server',
      type: 'string',
      description: 'The 8-character server identifier',
      required: true,
      minLength: 8,
      maxLength: 8,
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    // Ephemeral throughout: even the progress messages name one of the user's servers.
    await ctx.defer({ ephemeral: true });

    /**
     * Ownership first, before the deliverability probe. A user probing identifiers
     * should not be able to make the bot send them a DM about a server that is not
     * theirs.
     */
    const server = ctx.serverService.requireOwnedServer(ctx.user.id, ctx.args.server);

    /**
     * Deliverability probe.
     *
     * Sent before the archive is created. Compression is the expensive part — it can
     * take a minute on a large server and leaves a file on the user's disk — so a closed
     * inbox is discovered while nothing has been spent.
     *
     * The probe doubles as a useful notice rather than being a bare test message.
     */
    const probe = await trySendDirectMessage(ctx.user, {
      embeds: [
        infoEmbed(
          'Backup Starting',
          joinSections([
            `Archiving **${sanitiseForDisplay(server.name, 64)}** (\`${server.identifier}\`).`,
            '',
            'This can take a minute on a large server. The archive will arrive in the next message.',
          ]),
        ),
      ],
    });

    if (!probe.delivered) {
      logger.debug('Backup aborted: direct messages unavailable', {
        discordId: ctx.user.id,
        identifier: server.identifier,
        blocked: probe.blocked,
      });

      await ctx.respond(
        {
          embeds: [
            errorEmbed(
              joinSections([
                'No archive was created, because it could not be delivered to you.',
                '',
                probe.blocked
                  ? 'Your direct messages are closed. Open this server\'s privacy settings, enable **Direct Messages** from server members, then run this command again.'
                  : 'A direct message could not be delivered. Once you can receive messages from this bot, run this command again.',
                '',
                '_Backups are never posted in a channel: server files commonly contain passwords and API keys._',
              ]),
              'Backup Cancelled — Direct Messages Unavailable',
            ),
          ],
        },
        { ephemeral: true },
      );
      return;
    }

    // Progress is reported in the channel reply, since compression is slow enough that
    // silence reads as a hang.
    await ctx.respond(
      {
        embeds: [
          infoEmbed(
            'Archiving…',
            'Compressing your server files. This can take a minute; the archive will be sent to your direct messages.',
          ),
        ],
      },
      { ephemeral: true },
    );

    /**
     * The service lists the server root, compresses it, requests a signed URL, and
     * either downloads the archive and cleans it up, or leaves it in place for link
     * delivery. Serialised per server, so two concurrent backups cannot interleave.
     */
    const result = await ctx.serverService.backup({
      discordId: ctx.user.id,
      identifier: server.identifier,
    });

    // ------------------------------------------------------------ inline delivery

    if (result.inline) {
      const delivery = await trySendDirectMessage(ctx.user, {
        embeds: [
          successEmbed(
            'Your Server Backup',
            joinSections([
              bulletList([
                ['Server', sanitiseForDisplay(result.server.name, 64)],
                ['Identifier', `\`${result.server.identifier}\``],
                ['Archive', `\`${result.archiveName}\``],
                ['Size', formatBytes(result.size)],
              ]),
              '',
              '_This archive may contain passwords and API keys from your configuration files. Do not share it._',
            ]),
            identifierFooter(result.server.identifier),
          ),
        ],
        files: [
          new AttachmentBuilder(result.buffer, {
            name: result.archiveName,
            description: `Backup of ${result.server.identifier}`,
          }),
        ],
      });

      if (!delivery.delivered) {
        /**
         * The probe succeeded and this failed, so the inbox closed in the intervening
         * time or Discord rejected the attachment. The temporary archive was already
         * removed from the server by the service, so there is nothing to clean up and
         * nothing was leaked.
         */
        logger.warn('Backup archive could not be delivered after a successful probe', {
          discordId: ctx.user.id,
          identifier: result.server.identifier,
          bytes: result.size,
        });

        await ctx.respond(
          {
            embeds: [
              errorEmbed(
                joinSections([
                  'The archive was created but could not be delivered to your direct messages.',
                  '',
                  'It has been removed from your server, so nothing was left behind. Make sure you can receive direct messages from this bot, then run the command again.',
                ]),
                'Delivery Failed',
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
              'Backup Sent',
              bulletList([
                ['Delivered', 'Attached to a direct message'],
                ['Size', formatBytes(result.size)],
                ['Left on server', 'No — the temporary archive was removed'],
              ]),
            ),
          ],
        },
        { ephemeral: true },
      );
      return;
    }

    // -------------------------------------------------------------- link delivery

    /**
     * Too large to attach, so the signed URL is sent instead.
     *
     * The URL is a bearer credential: it authenticates by itself. It goes in the DM
     * only, is never written to a log, and never appears in the channel reply below.
     */
    const delivery = await trySendDirectMessage(ctx.user, {
      embeds: [
        successEmbed(
          'Your Server Backup',
          joinSections([
            bulletList([
              ['Server', sanitiseForDisplay(result.server.name, 64)],
              ['Identifier', `\`${result.server.identifier}\``],
              ['Archive', `\`${result.archiveName}\``],
              ['Size', formatBytes(result.size)],
            ]),
            '',
            'The archive is too large to attach, so download it with the link below.',
            '',
            '**This link expires shortly and anyone holding it can download the archive. Do not share it.**',
            '',
            `The archive is still on your server as \`${result.archiveName}\`. Delete it from the panel's file manager once you have downloaded it, or it will keep using your disk quota.`,
          ]),
          identifierFooter(result.server.identifier),
        ),
      ],
      // Sent as plain content so Discord renders it as a clickable link.
      content: result.downloadUrl,
    });

    if (!delivery.delivered) {
      /**
       * The archive exists on the server and its link was not delivered. The link is
       * short-lived and was never logged, so it is not recoverable — which is the
       * correct outcome for an undelivered credential. The user is told the file is
       * there so they can retrieve or remove it themselves.
       */
      logger.warn('Backup link could not be delivered after a successful probe', {
        discordId: ctx.user.id,
        identifier: result.server.identifier,
        archive: result.archiveName,
        bytes: result.size,
      });

      await ctx.respond(
        {
          embeds: [
            errorEmbed(
              joinSections([
                'The archive was created but its download link could not be delivered to your direct messages.',
                '',
                `The archive is on your server as \`${result.archiveName}\`. Download it from the panel's file manager, or delete it to reclaim the space:`,
                ctx.serverService.panelUrlFor(result.server.identifier),
                '',
                'The download link is not recoverable and is deliberately not shown here.',
              ]),
              'Delivery Failed',
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
            'Backup Sent',
            bulletList([
              ['Delivered', 'Download link sent by direct message'],
              ['Size', formatBytes(result.size)],
              ['Left on server', `Yes — \`${result.archiveName}\``],
            ]),
          ),
          warningEmbed(
            'Clean Up',
            joinSections([
              'The archive is still on your server and counts against your disk quota.',
              '',
              `Delete it from the panel's file manager once you have downloaded it: ${ctx.serverService.panelUrlFor(result.server.identifier)}`,
            ]),
          ),
        ],
      },
      { ephemeral: true },
    );
  },
};
