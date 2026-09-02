// Coded by Aditya | GitHub- @adityatheog

/**
 * Reports bot latency.
 *
 * Two distinct measurements, which answer different questions:
 *
 *   Roundtrip  How long the bot took to receive the invocation and get its reply
 *              accepted by Discord. This covers the event loop, the command router
 *              and the outbound REST call, so it is the number that moves when the
 *              bot itself is under load.
 *
 *   WebSocket  The gateway heartbeat interval discord.js maintains with Discord.
 *              This reflects the network path to Discord and is independent of
 *              anything the bot is doing.
 *
 * A high roundtrip with a low WebSocket ping means the bot is busy; both high means
 * the network or Discord is the problem. Reporting only one hides that distinction.
 *
 * Measuring roundtrip differs by surface. On the prefix surface both timestamps are
 * available from Discord itself, so the value is exact. On the slash surface the
 * interaction has a creation timestamp but the reply does not expose one, so the
 * measurement is taken locally around the acknowledgement.
 *
 * This is the only command that works in direct messages, since it needs no panel
 * account and no guild context.
 */

import { bulletList, infoEmbed } from '../../../utils/embeds.js';
import { formatUptime } from '../../../utils/format.js';

export default {
  name: 'ping',
  category: 'General',
  description: 'Check the bot latency',
  details:
    'Reports the measured roundtrip latency and the Discord gateway (WebSocket) latency, plus how long the bot has been running. Useful for telling apart a slow bot from a slow network.',

  // General is documented as ping, plans, help, which is not alphabetical.
  order: 0,

  // The only command usable outside a server.
  guildOnly: false,

  aliases: ['latency'],
  examples: ['ping'],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    const startedAt = Date.now();

    // A placeholder is sent first so the roundtrip can be measured against a real
    // delivered message rather than estimated.
    await ctx.respond({ embeds: [infoEmbed('Pong!', 'Measuring latency…')] });

    let roundtripMs;

    if (ctx.surface === 'prefix' && ctx.message) {
      const anchor = await ctx.anchorMessage();

      /**
       * Both timestamps come from Discord, so this measures the full path without
       * depending on the local clock's agreement with Discord's.
       *
       * anchor is null when the reply could not be delivered, in which case there is
       * nothing to edit and the local measurement is the best available.
       */
      roundtripMs = anchor
        ? anchor.createdTimestamp - ctx.message.createdTimestamp
        : Date.now() - startedAt;
    } else {
      // The interaction reply carries no usable creation timestamp, so this is
      // measured locally around the acknowledgement.
      roundtripMs = Date.now() - startedAt;
    }

    /**
     * client.ws.ping is -1 until the first heartbeat acknowledgement arrives, which
     * is briefly true right after startup or a reconnect. Reporting -1 ms would read
     * as a bug rather than as "not yet known".
     */
    const websocketPing = Math.round(ctx.client.ws.ping);
    const websocketText = websocketPing < 0 ? 'not yet measured' : `**${websocketPing} ms**`;

    // process.uptime() is seconds; formatUptime expects milliseconds.
    const uptimeMs = Math.round(process.uptime() * 1000);

    await ctx.respond({
      embeds: [
        infoEmbed(
          'Pong!',
          bulletList([
            ['Roundtrip', `**${roundtripMs} ms**`],
            ['WebSocket', websocketText],
            ['Uptime', formatUptime(uptimeMs)],
          ]),
        ),
      ],
    });
  },
};
