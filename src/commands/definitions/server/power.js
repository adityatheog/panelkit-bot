// Coded by Aditya | GitHub- @adityatheog

/**
 * Sends a power action to one of the user's servers.
 *
 * The non-interactive counterpart to the dashboard's power buttons. Both go through
 * serverService.power(), which reads the server's lifecycle flags before dispatching
 * the signal — the panel rejects power actions during installation, suspension and
 * transfer with a bare 409 that tells a user nothing, so those states are checked
 * first and reported specifically.
 *
 * Four signals, and the difference between two of them matters:
 *
 *   start     Boots the server.
 *   stop      Sends the egg's configured stop command, letting the process shut down
 *             cleanly. For a game server this is what saves the world.
 *   restart   Stop followed by start.
 *   kill      SIGKILL. Immediate, and any unsaved state is lost.
 *
 * `kill` is offered because a hung process cannot be stopped any other way, but the
 * reply says plainly what was lost. It is not gated behind a confirmation: the
 * dashboard deliberately omits it, and a user who typed `kill` explicitly has stated
 * their intent more clearly than a button press does.
 *
 * The response is public rather than ephemeral, unlike the dashboard's equivalent.
 * Someone running this in a shared channel is usually coordinating with others, and a
 * visible "server restarting" is the point.
 */

import {
  bulletList,
  identifierFooter,
  joinSections,
  successEmbed,
  warningEmbed,
} from '../../../utils/embeds.js';
import { POWER_SIGNALS } from '../../../utils/validation.js';
import { sanitiseForDisplay } from '../../../utils/format.js';

/** Title per signal, naming what is happening rather than a generic "Success". */
const TITLES = Object.freeze({
  start: 'Server Starting',
  stop: 'Server Stopping',
  restart: 'Server Restarting',
  kill: 'Server Killed',
});

/** What the user should expect after each signal. */
const OUTCOMES = Object.freeze({
  start: 'The server is booting. Check its console in the panel if it does not come online.',
  stop: 'A graceful shutdown was requested. The server will stop once it finishes saving.',
  restart: 'The server is stopping and will start again automatically.',
  kill: 'The process was terminated immediately. Any unsaved data since the last save is lost.',
});

export default {
  name: 'server power',
  category: 'Server',
  description: 'Send a power action to your server',
  details:
    'Starts, stops, restarts or kills a server. "stop" runs the egg\'s shutdown command so the process exits cleanly, while "kill" terminates it immediately and loses unsaved data. Power actions are refused while a server is installing, suspended or being transferred.',

  guildOnly: true,
  aliases: ['power'],
  examples: [
    'server power a1b2c3d4 start',
    'server power a1b2c3d4 restart',
    'server power a1b2c3d4 kill',
  ],

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
      name: 'action',
      type: 'string',
      description: 'The power action to perform',
      required: true,
      /**
       * Choices come from the single source of truth in utils/validation.js, so the
       * registered slash options and the runtime validator can never disagree about
       * what is accepted.
       */
      choices: POWER_SIGNALS.map((signal) => ({ name: signal, value: signal })),
    },
  ],

  /**
   * @param {object} ctx the execution context
   * @returns {Promise<void>}
   */
  async execute(ctx) {
    /**
     * The service performs two panel round trips — a state read, then the signal — so
     * acknowledge before either.
     */
    await ctx.defer();

    const { server, signal } = await ctx.serverService.power({
      discordId: ctx.user.id,
      identifier: ctx.args.server,
      signal: ctx.args.action,
    });

    const embeds = [
      successEmbed(
        TITLES[signal],
        joinSections([
          bulletList([
            ['Server', sanitiseForDisplay(server.name, 64)],
            ['Identifier', `\`${server.identifier}\``],
            ['Action', `\`${signal}\``],
          ]),
          '',
          OUTCOMES[signal],
        ]),
        identifierFooter(server.identifier),
      ),
    ];

    /**
     * A power signal is queued by the panel, not applied synchronously, so the state
     * cannot be reported here without a further read that would frequently still show
     * the old value. The follow-up commands are named instead.
     */
    embeds.push(
      warningEmbed(
        'Signal Sent',
        joinSections([
          'The panel has queued this action; it is not applied instantly.',
          '',
          bulletList([
            ['Check status', `\`${ctx.env.prefix}server info ${server.identifier}\``],
            ['Watch live', `\`${ctx.env.prefix}server manage ${server.identifier}\``],
          ]),
        ]),
      ),
    );

    await ctx.respond({ embeds });
  },
};
