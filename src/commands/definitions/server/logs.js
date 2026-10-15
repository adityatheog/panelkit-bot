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

const ATTACHMENT_NAME = 'latest.log';

function truncateToTail(buffer, maxBytes) {
  if (buffer.byteLength <= maxBytes) {
    return { buffer, truncated: false, droppedBytes: 0 };
  }

  let start = buffer.byteLength - maxBytes;

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
    'Reads a configured log file and sends it to your direct messages, never to a channel. Files up to 32 MiB are fetched; logs larger than the upload limit are trimmed to their latest portion. Larger files must be downloaded through the panel.',

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

  async execute(ctx) {

    await ctx.defer({ ephemeral: true });
    ctx.serverService.requireOwnedServer(ctx.user.id, ctx.args.server);
    const probe = await trySendDirectMessage(ctx.user, {
      embeds: [infoEmbed('Logs Starting', 'Fetching your log file. It will only be sent to your direct messages.')],
    });
    if (!probe.delivered) {
      await ctx.respond({ embeds: [errorEmbed('Enable direct messages from this bot, then try again. No log was fetched.')] },
        { ephemeral: true });
      return;
    }

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

    const delivery = await trySendDirectMessage(ctx.user, { embeds, files: [attachment] });
    await ctx.respond({ embeds: [delivery.delivered
      ? successEmbed('Logs Sent', 'The log attachment was sent to your direct messages. Do not share it if it contains secrets.')
      : errorEmbed('The log could not be delivered. Enable direct messages and try again; nothing was posted in this channel.')],
    }, { ephemeral: true });
  },
};
