// Coded by Aditya | GitHub- @adityatheog

/**
 * Application entry point.
 *
 * Responsible for one thing: bringing the bot up in a defined order, and refusing to run
 * in a half-configured state. Nothing here contains business logic — every step either
 * validates something, constructs something, or wires two things together.
 *
 * Startup order, and why it is this order:
 *
 *   1. Environment       Nothing can be logged sensibly until the log level is known, and
 *                        nothing can be constructed until the credentials are validated.
 *                        Fails hard on a missing or malformed value.
 *   2. Configuration     Colours and identity must be installed before any embed is built.
 *                        Fails hard on structural errors; unfilled placeholders warn.
 *   3. Database          Opened and migrated before any service can hold a reference.
 *                        Fails hard: a bot that cannot persist is not usable.
 *   4. Panel client      Constructed, then optionally verified. Verification failure only
 *                        warns, because the panel restarting is not a reason to refuse to
 *                        start — commands report their own errors.
 *   5. Services          Constructed over the database and panel, sharing one lock manager
 *                        so `servers:<id>` means the same lock everywhere.
 *   6. Command registry  Loaded and validated from disk, including building the slash
 *                        payload, so a structural conflict surfaces here rather than at
 *                        deploy time.
 *   7. Discord client    Constructed with the required intents, handlers registered before
 *                        login so no event can arrive unhandled.
 *   8. Login             Last. Everything the bot needs to answer a command already exists.
 *
 * Failure policy: anything in steps 1 through 7 that cannot be satisfied exits non-zero
 * with a readable reason. Running in a broken state produces confusing user-facing errors
 * and is worse than not starting, and a supervisor restarting into the same failure at
 * least makes the problem visible.
 *
 * Shutdown is graceful and idempotent: SIGTERM stops timers, closes the gateway
 * connection, checkpoints and closes the database, and removes the heartbeat file.
 */

import fs from 'node:fs';
import path from 'node:path';
import { Client, Events, GatewayIntentBits, Options, Partials } from 'discord.js';

import { loadRegistry } from './commands/registry.js';
import { describeConfig, loadConfig } from './config/config.js';
import { describeEnv, loadDotEnv, loadEnv } from './config/env.js';
import { createCooldownManager } from './core/cooldowns.js';
import { registerMessageRouter } from './core/messageRouter.js';
import { registerInteractionRouter } from './interactions/router.js';
import { initDatabase } from './database/db.js';
import { initAccountService } from './services/accountService.js';
import { initAdminService } from './services/adminService.js';
import { initPterodactyl } from './services/pterodactyl.js';
import { initServerService } from './services/serverService.js';
import { setIdentity, setPalette } from './utils/embeds.js';
import { createLockManager } from './utils/locks.js';
import { logger, setLogLevel } from './utils/logger.js';
import { describeAdminConfiguration } from './utils/permissions.js';
import { clearAllSessions, sessionCount, startSessionSweeper } from './utils/sessions.js';

/** How often the liveness file is rewritten. */
const HEARTBEAT_INTERVAL_MS = 30_000;

/** How often session and cooldown stores are swept. */
const SWEEP_INTERVAL_MS = 60_000;

/** How long shutdown waits for the gateway to close before exiting anyway. */
const SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Minimum Node version.
 *
 * import.meta.dirname arrived in 20.11. Checked explicitly because the failure without it
 * is an opaque "cannot read properties of undefined" from a module three levels down.
 */
const MIN_NODE_MAJOR = 20;
const MIN_NODE_MINOR = 11;

/**
 * Verifies the runtime before anything else is attempted.
 *
 * @throws {Error} when the Node version is too old
 */
function assertNodeVersion() {
  const [major, minor] = process.versions.node.split('.').map(Number);

  if (major < MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && minor < MIN_NODE_MINOR)) {
    throw new Error(
      `Node.js ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR} or newer is required; this is ${process.versions.node}. ` +
        'Install a supported version and try again.',
    );
  }
}

/**
 * Starts writing the liveness file.
 *
 * A file rather than an HTTP endpoint, deliberately: a health port would be an
 * unauthenticated network surface added purely for monitoring, and this bot otherwise
 * makes only outbound connections. scripts/healthcheck.js, the Docker HEALTHCHECK and the
 * systemd unit all read this file.
 *
 * @param {string} heartbeatPath
 * @returns {NodeJS.Timeout}
 */
function startHeartbeat(heartbeatPath) {
  const resolved = path.resolve(heartbeatPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });

  const write = () => {
    try {
      fs.writeFileSync(resolved, String(Date.now()));
    } catch (err) {
      // A read-only volume or a permissions change. Worth a warning, but the bot is
      // otherwise healthy and stopping over a monitoring file would be worse.
      logger.warn('Could not write the heartbeat file', { path: resolved, message: err?.message });
    }
  };

  write();

  const timer = setInterval(write, HEARTBEAT_INTERVAL_MS);
  timer.unref();
  return timer;
}

/**
 * Brings the application up.
 *
 * @returns {Promise<void>}
 */
async function main() {
  assertNodeVersion();

  // ------------------------------------------------------------ 1. environment

  // Best-effort: in Docker, systemd and most PaaS deployments the variables arrive from
  // the environment and no .env file exists.
  const dotenv = loadDotEnv();

  const env = loadEnv();
  setLogLevel(env.logLevel);

  logger.info('Environment loaded', {
    ...describeEnv(env),
    dotEnvFile: dotenv.loaded ? dotenv.file : null,
    node: process.versions.node,
    pid: process.pid,
  });

  // Non-fatal misconfigurations that silently change behaviour, surfaced rather than
  // discovered later. See loadEnv for what lands here.
  for (const note of env.notes) {
    logger.warn(note);
  }

  // ----------------------------------------------------------- 2. configuration

  const config = loadConfig();

  // Installed before any embed is constructed.
  setPalette(config.colors);
  setIdentity(config.identity);

  const configState = describeConfig(config);
  logger.info('Configuration loaded', {
    identity: config.identity.name,
    eggs: configState.eggs,
    availableEggs: configState.availableEggs,
    plans: config.plans.length,
    provisioningReady: configState.ready,
  });

  for (const warning of configState.warnings) {
    logger.warn(warning);
  }

  const adminConfig = describeAdminConfiguration(env);
  if (adminConfig.warning) {
    logger.warn(adminConfig.warning);
  } else {
    logger.info('Admin access configured', { users: adminConfig.users, roles: adminConfig.roles });
  }

  // --------------------------------------------------------------- 3. database

  // Throws on failure: a bot that cannot persist cannot honour a provisioning request.
  const db = initDatabase(env.databasePath);

  const stats = db.getStats();
  logger.info('Database opened', {
    path: env.databasePath,
    schemaVersion: stats.schemaVersion,
    users: stats.users,
    servers: stats.servers,
  });

  // ------------------------------------------------------------ 4. panel client

  const panel = initPterodactyl({
    panelUrl: env.panelUrl,
    appKey: env.panelAppKey,
    clientKey: env.panelClientKey,
    timeoutMs: env.panelTimeoutMs,
    maxRetries: env.panelMaxRetries,
  });

  if (env.verifyPanelOnStartup) {
    /**
     * Both keys are checked independently so a partial misconfiguration names the key at
     * fault. Failure warns rather than exits: the panel may simply be restarting, and
     * refusing to start would turn a transient outage into an operator intervention.
     */
    const verification = await panel.verifyCredentials();

    if (verification.application.ok && verification.client.ok) {
      logger.info('Panel credentials verified', { panelUrl: env.panelUrl });
    } else {
      if (!verification.application.ok) {
        logger.warn('The Application API key could not be verified', {
          reason: verification.application.error,
          hint: 'Check PANEL_APP_KEY and that it has Users, Servers and Nests permissions.',
        });
      }
      if (!verification.client.ok) {
        logger.warn('The Client API key could not be verified', {
          reason: verification.client.error,
          hint: 'Check PANEL_CLIENT_KEY. Client keys are created under Account, not Admin.',
        });
      }
      logger.warn('Starting anyway; panel commands will fail until the panel is reachable.');
    }
  }

  // --------------------------------------------------------------- 5. services

  /**
   * One lock manager shared by every service, so `servers:<discordId>` refers to the same
   * lock whether it is acquired by serverService or via adminService.
   */
  const locks = createLockManager();

  const accountService = initAccountService({ db, panel, config, env, locks });
  const serverService = initServerService({ db, panel, config, env, locks });
  const adminService = initAdminService({ db, panel, config, env, accountService, serverService });

  const cooldowns = createCooldownManager({ config });

  /** Spread into every command context, so a command reads ctx.serverService directly. */
  const services = {
    db,
    panel,
    locks,
    cooldowns,
    accountService,
    serverService,
    adminService,
  };

  // --------------------------------------------------------------- 6. registry

  /**
   * Loads and validates every definition, and builds the slash payload. A duplicate name,
   * an over-long description or a parent/command conflict fails here rather than at
   * deploy time.
   */
  const registry = await loadRegistry(import.meta.dirname);

  logger.info('Commands ready', {
    visible: registry.counts.commands,
    categories: registry.counts.categories,
    categoryNames: registry.categories.map((category) => category.name),
  });

  // ---------------------------------------------------------- 7. Discord client

  const client = new Client({
    /**
     * MessageContent is a privileged intent and must be enabled in the Developer Portal.
     * Without it, message.content is empty and every prefix command silently stops
     * working while slash commands keep functioning — which is why the ready handler
     * checks for it explicitly.
     */
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
    /**
     * Channel partials allow DM channels to be resolved without being cached, which is
     * required for credential delivery to a user the bot has not messaged before.
     */
    partials: [Partials.Channel],
    /**
     * Message history is not needed: commands act on the invoking message only. Capping
     * the cache keeps memory flat on a bot in busy servers.
     */
    makeCache: Options.cacheWithLimits({
      ...Options.DefaultMakeCacheSettings,
      MessageManager: 10,
      ReactionManager: 0,
      GuildMemberManager: 50,
    }),
  });

  // Registered before login, so no event can arrive without a handler.
  registerMessageRouter(client, { registry, env, config, services, cooldowns });
  registerInteractionRouter(client, { registry, env, config, services, cooldowns });

  client.once(Events.ClientReady, (ready) => {
    logger.info('Connected to Discord', {
      user: ready.user.tag,
      userId: ready.user.id,
      guilds: ready.guilds.cache.size,
    });

    /**
     * A mismatch here means slash commands were registered under a different application
     * than the token belongs to, which presents as "the commands exist but nothing
     * happens".
     */
    if (ready.user.id !== env.clientId) {
      logger.error(
        'CLIENT_ID does not match the authenticated bot. Slash commands are registered under CLIENT_ID and will not work.',
        { configured: env.clientId, actual: ready.user.id },
      );
    }
  });

  client.on(Events.Error, (err) => {
    logger.error('Discord client error', { name: err?.name, message: err?.message });
  });

  client.on(Events.Warn, (info) => {
    logger.warn('Discord client warning', { info });
  });

  // Reconnection is handled by discord.js; these are logged so a flapping connection is
  // visible in the operational record.
  client.on(Events.ShardDisconnect, (event, shardId) => {
    logger.warn('Gateway disconnected', { shardId, code: event?.code });
  });

  client.on(Events.ShardReconnecting, (shardId) => {
    logger.info('Gateway reconnecting', { shardId });
  });

  client.on(Events.ShardResume, (shardId, replayed) => {
    logger.info('Gateway resumed', { shardId, replayedEvents: replayed });
  });

  // ------------------------------------------------------- background and signals

  const heartbeat = startHeartbeat(env.heartbeatPath);
  const sessionSweeper = startSessionSweeper(SWEEP_INTERVAL_MS);
  const cooldownSweeper = cooldowns.startSweeper(SWEEP_INTERVAL_MS);

  /**
   * Last-resort process guards.
   *
   * Both routers already funnel their own failures, so anything reaching here escaped
   * every handler. Logged and survived rather than exited: killing the process over one
   * stray rejection denies service to every user, and the alternative — an unhandled
   * rejection terminating Node — is strictly worse.
   */
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      message: reason?.message ?? String(reason),
      name: reason?.name ?? null,
      code: reason?.code ?? null,
    });
  });

  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception', { name: err?.name, message: err?.message, code: err?.code });
  });

  let shuttingDown = false;

  /**
   * Closes everything in reverse order of construction.
   *
   * Idempotent: a supervisor sending SIGTERM then SIGKILL, or a double Ctrl-C, must not
   * run this twice. Bounded by a timer, so a hung gateway close cannot prevent exit.
   *
   * @param {string} signal
   * @param {number} [exitCode]
   * @returns {Promise<void>}
   */
  async function shutdown(signal, exitCode = 0) {
    if (shuttingDown) return;
    shuttingDown = true;

    logger.info('Shutting down', { signal, activeSessions: sessionCount() });

    // Exit even if something below hangs. Unref'd so it does not itself hold the process
    // open when shutdown completes normally.
    const failsafe = setTimeout(() => {
      logger.warn('Shutdown timed out; exiting immediately', { timeoutMs: SHUTDOWN_TIMEOUT_MS });
      process.exit(exitCode);
    }, SHUTDOWN_TIMEOUT_MS);
    failsafe.unref();

    clearInterval(heartbeat);
    clearInterval(sessionSweeper);
    clearInterval(cooldownSweeper);

    // Open menus are dead the moment the collectors go, so their state goes too.
    clearAllSessions();

    try {
      await client.destroy();
      logger.info('Discord connection closed');
    } catch (err) {
      logger.warn('Error while closing the Discord connection', { message: err?.message });
    }

    try {
      // Checkpoints the WAL so the main database file is self-contained afterwards, which
      // matters when a supervisor archives the volume immediately after stopping.
      db.close();
    } catch (err) {
      logger.warn('Error while closing the database', { message: err?.message });
    }

    try {
      fs.rmSync(path.resolve(env.heartbeatPath), { force: true });
    } catch {
      // Nothing useful to do; the file is stale either way and healthcheck treats a
      // missing file as unhealthy.
    }

    clearTimeout(failsafe);
    logger.info('Shutdown complete');
    process.exit(exitCode);
  }

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  // SIGHUP arrives when a terminal closes. Treated as a stop request rather than ignored,
  // so an interactively started bot exits cleanly instead of being orphaned.
  process.on('SIGHUP', () => {
    void shutdown('SIGHUP');
  });

  // ------------------------------------------------------------------- 8. login

  await client.login(env.discordToken);

  logger.info('Startup complete', {
    identity: config.identity.name,
    prefix: env.prefix,
    commands: registry.counts.commands,
    provisioningReady: configState.ready,
  });
}

main().catch((err) => {
  /**
   * A failed startup dependency must not leave the bot half-running. The message is the
   * only thing an operator sees, so it is printed rather than only logged as JSON — a
   * ConfigError's message lists every problem found, and burying that in a structured
   * field makes it harder to read.
   */
  logger.error('Fatal startup error', {
    name: err?.name ?? 'Error',
    code: err?.code ?? null,
    message: err?.message ?? String(err),
  });

  process.stderr.write(`\nStartup failed: ${err?.message ?? String(err)}\n\n`);
  process.exit(1);
});
