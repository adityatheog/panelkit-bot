// Coded by Aditya | GitHub- @adityatheog

/**
 * Downloads the latest log file for one of the user's servers.
 *
 * An important limitation, stated plainly because it shapes the whole command:
 * Pterodactyl serves live console output over a websocket only. There is no REST
 * endpoint for the console stream. This command therefore reads a log *file* through
 * the documented file-manager endpoint, trying each path configured for the server's
 * egg type in order. That is a real integration rather than a stub, but it is not the
 * live console, and a server whose egg writes no log file will legitimately have
 * nothing to return.
 *
 * The log is delivered as an attachment rather than pasted into an embed. A Minecraft
 * server produces megabytes of log within minutes, and a 4096-character embed would
 * show the oldest lines while discarding the ones a user is debugging.
 *
 * Oversized files are truncated from the *front*, keeping the tail. The newest lines
 * are where the error is; keeping the head would deliver the startup banner and drop
 * the stack trace. The reply says which end was kept, so nobody concludes the log
 * simply stops mid-error.
 *
 * Truncation is done on a line boundary, so the first surviving line is not a partial
 * fragment that reads like corruption.
 */

import { AttachmentBuilder } from 'discord.js';
import {
  bulletList,
  identifierFooter,
  infoEmbed,
  joinSections,
  warningEmbed,
} from '../../../utils/embeds.js';
import { formatBytes, sanitiseForDisplay } from '../../../utils/format.js';
import { logger } from '../../../utils/logger.js';

/**
 * Attachment filename.
 *
 * Fixed rather than derived from the server name, which would need sanitising for the
 * filesystem and could produce a confusing name for a user with several servers. The
 * embed names the source path and the server.
 */
const ATTACHMENT_NAME = 'latest.log';

/**
 * Truncates a buffer to the last `maxBytes`, starting at a line boundary.
 *
 * Slicing at an arbitrary byte offset leaves a partial first line, and on a multi-byte
 * UTF-8 character it leaves a broken codepoint that renders as a replacement glyph.
 * Advancing to the next newline avoids both.
 *
 * @param {Buffer} buffer
 * @param {number} maxBytes
 * @returns {{ buffer: Buffer, truncated: boolean, droppedBytes: number }}
 */
function truncateToTail(buffer, maxBytes) {
  if (buffer.byteLength <= maxBytes) {
    return { buffer, truncated: false, droppedBytes: 0 };
  }

  let start = buffer.byteLength - maxBytes;

  // Advance past the remainder of the partial line, and past any partial codepoint
  // with it. Bounded to a kilobyte so a file with no newlines at all still returns.
  const searchLimit = Math.min(start + 1024, buffer.byteLength - 1);
  for (let index = start; index < searchLimit; index += 1) {
    if (buffer[index] === 0x0a) {
      start = index + 1;
      break;
    }
  }

  return {
    buffer: buffer.subarray(start),
    truncated: true,
    droppedBytes: start,
  };
}

export default {
  name: 'server logs',
  category: 'Server',
  description: 'Download the latest log file for your server',
  details:
    'Reads the newest log file for your server and uploads it as an attachment. Pterodactyl exposes live console output over websockets only, so this reads a log file from the server\'s filesystem rather than the console stream. Large files are trimmed to their most recent portion.',

  guildOnly: true,
  aliases: ['server log'],
  examples: ['server logs a1b2c3d4'],

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
    /**
     * Reading a log involves one panel request per configured path until one yields
     * content, so acknowledge before starting.
     */
    await ctx.defer();

    const { server, path, content } = await ctx.serverService.logs({
      discordId: ctx.user.id,
      identifier: ctx.args.server,
    });

    const maxUploadBytes = ctx.config.logs.maxUploadBytes;

    const full = Buffer.from(content, 'utf8');
    const { buffer, truncated, droppedBytes } = truncateToTail(full, maxUploadBytes);

    if (truncated) {
      logger.debug('Log file was truncated for upload', {
        identifier: server.identifier,
        originalBytes: full.byteLength,
        deliveredBytes: buffer.byteLength,
      });
    }

    const attachment = new AttachmentBuilder(buffer, {
      name: ATTACHMENT_NAME,
      description: `Log file for ${server.identifier}`,
    });

    const embeds = [
      infoEmbed(
        `Logs: ${sanitiseForDisplay(server.name, 64)}`,
        joinSections([
          bulletList([
            ['Source', `\`${path}\``],
            ['Size', formatBytes(buffer.byteLength)],
            ['Original size', truncated ? formatBytes(full.byteLength) : null],
            ['Lines', buffer.toString('utf8').split('\n').length - 1],
          ]),
        ]),
        identifierFooter(server.identifier),
      ),
    ];

    if (truncated) {
      embeds.push(
        warningEmbed(
          'Log Trimmed',
          joinSections([
            `The log was larger than the ${formatBytes(maxUploadBytes)} upload limit, so only its most recent portion is attached.`,
            '',
            `${formatBytes(droppedBytes)} of older output was dropped. Download the full file from the panel if you need it: ${ctx.serverService.panelUrlFor(server.identifier)}`,
          ]),
        ),
      );
    }

    await ctx.respond({ embeds, files: [attachment] });
  },
};
