// Coded by Aditya | GitHub- @adityatheog

/**
 * PM2 process definition.
 *
 * The alternative to Docker for operators running the bot directly on a host —
 * typically the same host as the Pterodactyl panel, where Node is already
 * installed and a container adds nothing.
 *
 * Deliberately a .cjs file. package.json declares "type": "module", so a .js
 * file in this directory is parsed as ESM — and PM2 loads its config with
 * require(), which fails on ESM with an ERR_REQUIRE_ESM that names the file
 * without explaining why. The .cjs extension forces CommonJS regardless of the
 * package type.
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs                Start under PM2.
 *   pm2 logs panelkit-bot                         Follow the output.
 *   pm2 restart panelkit-bot                      Restart after an update.
 *   pm2 stop panelkit-bot                         Stop, keeping the entry.
 *   pm2 delete panelkit-bot                       Remove the entry entirely.
 *   pm2 save                                      Persist the process list.
 *   pm2 startup                                   Print the boot-time command.
 *
 * The last two matter together: without `pm2 save` after `pm2 startup`, the bot
 * does not come back after a host reboot.
 *
 * Environment variables are read from .env by the application itself, through
 * dotenv in src/config/env.js. They are deliberately not listed here — PM2's
 * `env` block ends up in ~/.pm2/dump.pm2 in plaintext, which is a second copy of
 * the credentials in a file operators rarely think about.
 */

const path = require('node:path');

/** Absolute, so PM2's cwd cannot change where the log files land. */
const root = __dirname;

module.exports = {
  apps: [
    {
      // -----------------------------------------------------------------------
      // Identity
      // -----------------------------------------------------------------------
      name: 'panelkit-bot',
      script: path.join(root, 'src', 'index.js'),
      cwd: root,

      /**
       * Node 20.11 or newer is required, and PM2 resolves `node` from the PATH of
       * whoever ran it. On a host with nvm that is frequently a different version
       * from the one an operator tested with, so the interpreter is left to the
       * environment rather than pinned to a guessed path — but the README
       * documents checking `pm2 describe panelkit-bot` for the resolved version.
       */
      interpreter: 'node',

      /**
       * No --experimental flags and no loaders. The project uses only stable
       * features of Node 20: ESM, node:test, and import.meta.dirname.
       */
      node_args: [],

      // -----------------------------------------------------------------------
      // Process model
      // -----------------------------------------------------------------------

      /**
       * Fork mode with a single instance, and this is not a default to be
       * increased.
       *
       * Interactive component sessions (src/utils/sessions.js) and the per-user
       * locks (src/utils/locks.js) live in process memory. Two instances would
       * each hold half the sessions, so a button press could arrive at the
       * process that does not know about it — and, worse, the locks that prevent
       * a user exceeding FREE_SERVER_LIMIT would not serialise across them.
       *
       * A single Discord gateway connection is also the correct shape: two
       * instances with the same token both receive every event and would execute
       * every command twice.
       *
       * Horizontal scaling would require moving sessions and locks to Redis. See
       * the README's limitations section.
       */
      exec_mode: 'fork',
      instances: 1,

      // -----------------------------------------------------------------------
      // Restart policy
      // -----------------------------------------------------------------------
      autorestart: true,

      /**
       * A configuration error exits non-zero immediately and will do so again on
       * every restart. Without a floor on uptime, PM2 would spin through restarts
       * as fast as Node can start, filling the log with the same message.
       *
       * min_uptime is what makes max_restarts meaningful: a process that fails to
       * reach 30 seconds counts as a failed start, so ten consecutive
       * configuration failures stop the cycle and leave the process errored —
       * which is the state an operator can actually see.
       */
      min_uptime: '30s',
      max_restarts: 10,

      /**
       * Backoff between restarts. Long enough that a transient panel outage or a
       * Discord gateway problem is not hammered, short enough that a genuine
       * crash recovers within seconds.
       */
      restart_delay: 5000,
      exp_backoff_restart_delay: 2000,

      /**
       * A memory ceiling as a safety net rather than an expectation. SQLite plus a
       * gateway connection sits well under 200 MB in normal operation; the headroom
       * covers a large backup archive being buffered before DM delivery.
       *
       * PM2 restarts on breach, which for this bot means losing open interactive
       * menus — acceptable, and preferable to the host's OOM killer choosing what
       * to terminate.
       */
      max_memory_restart: '512M',

      // -----------------------------------------------------------------------
      // Shutdown
      // -----------------------------------------------------------------------

      /**
       * PM2 sends SIGINT rather than SIGTERM by default. src/index.js handles
       * SIGINT, SIGTERM and SIGHUP identically, so either works — SIGTERM is set
       * explicitly so the signal matches what the Docker and systemd deployments
       * send, and one shutdown path is exercised everywhere.
       */
      kill_signal: 'SIGTERM',

      /**
       * Long enough for the shutdown sequence: stop the timers, close the Discord
       * gateway connection, checkpoint the SQLite write-ahead log, and remove the
       * heartbeat file.
       *
       * The checkpoint is the reason this is raised from PM2's 1600ms default. On
       * a slow or contended disk it can take seconds, and a truncated checkpoint
       * leaves recent commits in the -wal sidecar file — still valid, but missed
       * by a backup that copies only the main database.
       */
      kill_timeout: 15_000,

      /**
       * The bot does not call process.send('ready'), so PM2 must not wait for it.
       * With wait_ready true and no signal, every start would stall for
       * listen_timeout before PM2 considered the process up.
       */
      wait_ready: false,

      // -----------------------------------------------------------------------
      // Logging
      // -----------------------------------------------------------------------

      /**
       * The application writes line-delimited JSON to stdout and stderr, with
       * secrets redacted by src/utils/logger.js. PM2 captures both streams.
       *
       * Paths are absolute so they do not follow a changed cwd. The logs directory
       * is git-ignored; PM2 creates it if absent.
       */
      out_file: path.join(root, 'logs', 'out.log'),
      error_file: path.join(root, 'logs', 'error.log'),

      /**
       * One file per stream rather than one per instance. With a single instance
       * the -0 suffix PM2 would otherwise add is noise.
       */
      merge_logs: true,

      /**
       * PM2 prefixes each line with its own timestamp. The application's own log
       * lines already carry an ISO timestamp in the JSON, so this is redundant for
       * them — but it is what timestamps anything Node writes directly, such as an
       * unhandled startup error or a native module's stderr.
       */
      time: true,

      /**
       * PM2 does not rotate logs on its own. Without pm2-logrotate these files
       * grow until the disk fills, which for a busy bot is weeks rather than
       * months:
       *
       *   pm2 install pm2-logrotate
       *   pm2 set pm2-logrotate:max_size 10M
       *   pm2 set pm2-logrotate:retain 7
       *   pm2 set pm2-logrotate:compress true
       */

      // -----------------------------------------------------------------------
      // File watching
      // -----------------------------------------------------------------------

      /**
       * Off in production. Watching would restart the bot when the SQLite file
       * changes — which is on every command — producing a restart loop that looks
       * like a crash.
       *
       * For development, `npm run dev` uses node --watch with a scope limited to
       * source files.
       */
      watch: false,
      ignore_watch: ['node_modules', 'data', 'logs', '.git'],

      // -----------------------------------------------------------------------
      // Environment
      // -----------------------------------------------------------------------

      /**
       * Only NODE_ENV is set here. Credentials come from .env via dotenv, because
       * anything in this block is written to ~/.pm2/dump.pm2 in plaintext by
       * `pm2 save` — a second copy of the bot token and both panel API keys in a
       * file that is not git-ignored and rarely audited.
       *
       * .env is git-ignored and should be chmod 600.
       */
      env: {
        NODE_ENV: 'production',
      },

      /**
       * Selected with `pm2 start ecosystem.config.cjs --env development`.
       * Raises the log level; still reads credentials from .env.
       */
      env_development: {
        NODE_ENV: 'development',
        LOG_LEVEL: 'debug',
      },
    },
  ],
};
