// Coded by Aditya | GitHub- @adityatheog

/**
 * Slash command registration.
 *
 * A standalone script rather than part of startup, and that separation is deliberate.
 * Discord's command registration is a global write against the application: it is
 * rate-limited, it takes effect for every guild the bot is in, and running it on every
 * boot means a crash-looping process hammers the endpoint. Registration is a deployment
 * step, so it lives in a deployment script.
 *
 *   npm run deploy           Register to GUILD_ID when set, otherwise globally.
 *   npm run deploy:global    Force global registration even when GUILD_ID is set.
 *   npm run deploy:clear     Remove every registered command from the chosen scope.
 *
 * Scope matters more than it appears. Guild-scoped commands appear instantly, which is
 * what makes development tolerable. Global commands propagate to Discord's edge over
 * roughly an hour, so a deploy that looks like it did nothing usually has not finished.
 * The script says which scope it used and what to expect.
 *
 * The payload is built from the same registry the bot executes, so registration cannot
 * drift from implementation. There is no second list of commands to keep in sync — a
 * command file is added, and both surfaces pick it up.
 *
 * Failures are reported with the specific remedy rather than a raw REST error. The four
 * that actually happen — a bad token, a wrong application id, a missing bot in the target
 * guild, and an invalid payload — each get their own message.
 */

import { REST, Routes } from 'discord.js';
import { loadRegistry } from './commands/registry.js';
import { loadDotEnv, loadEnv } from './config/env.js';
import { logger, setLogLevel } from './utils/logger.js';

/** Discord's ceiling on top-level global commands. */
const MAX_GLOBAL_COMMANDS = 100;

/**
 * Parses the command line.
 *
 * @param {string[]} argv
 * @returns {{ global: boolean, clear: boolean, dryRun: boolean, help: boolean }}
 */
function parseArgs(argv) {
  const flags = new Set(argv.slice(2));

  return {
    global: flags.has('--global') || flags.has('-g'),
    clear: flags.has('--clear'),
    dryRun: flags.has('--dry-run'),
    help: flags.has('--help') || flags.has('-h'),
  };
}

/** Prints usage and exits. */
function printHelp() {
  process.stdout.write(
    [
      '',
      'Register slash commands with Discord.',
      '',
      'Usage: node src/deploy-commands.js [options]',
      '',
      'Options:',
      '  -g, --global   Register globally even when GUILD_ID is set.',
      '                 Global commands can take up to an hour to appear.',
      '      --clear    Remove every registered command from the target scope.',
      '      --dry-run  Print what would be sent without contacting Discord.',
      '  -h, --help     Show this message.',
      '',
      'Scope is chosen from GUILD_ID unless --global is passed:',
      '  GUILD_ID set    Commands register to that guild and appear immediately.',
      '  GUILD_ID empty  Commands register globally.',
      '',
    ].join('\n'),
  );
}

/**
 * Summarises a payload for human review.
 *
 * Reports the invocable paths rather than the top-level count, because "5 commands" is
 * misleading when one of them is `server` carrying eleven subcommands.
 *
 * @param {Array<object>} body
 * @returns {{ roots: number, leaves: string[] }}
 */
function summarisePayload(body) {
  const leaves = [];

  for (const command of body) {
    const options = Array.isArray(command.options) ? command.options : [];
    // ApplicationCommandOptionType: 1 = Subcommand, 2 = SubcommandGroup
    const subcommands = options.filter((option) => option.type === 1);
    const groups = options.filter((option) => option.type === 2);

    if (subcommands.length === 0 && groups.length === 0) {
      leaves.push(`/${command.name}`);
      continue;
    }

    for (const sub of subcommands) {
      leaves.push(`/${command.name} ${sub.name}`);
    }

    for (const group of groups) {
      for (const sub of Array.isArray(group.options) ? group.options : []) {
        leaves.push(`/${command.name} ${group.name} ${sub.name}`);
      }
    }
  }

  return { roots: body.length, leaves: leaves.sort() };
}

/**
 * Turns a REST failure into an actionable message.
 *
 * @param {unknown} err
 * @param {{ guildId: string|null, clientId: string }} context
 * @returns {string}
 */
function explainFailure(err, { guildId, clientId }) {
  const status = err?.status ?? err?.response?.status ?? null;
  const code = err?.code ?? null;

  if (status === 401) {
    return 'Discord rejected the token. Check DISCORD_TOKEN: it must be the bot token from Developer Portal → Bot → Reset Token, not the OAuth2 client secret.';
  }

  if (status === 403) {
    return guildId
      ? `Discord denied access to guild ${guildId}. The bot must be a member of that guild, and it must have been invited with the applications.commands scope.`
      : 'Discord denied the request. Confirm the token and application belong to the same bot.';
  }

  if (status === 404) {
    return guildId
      ? `Guild ${guildId} was not found, or the bot is not in it. Check GUILD_ID, or clear it to register globally.`
      : `Application ${clientId} was not found. Check CLIENT_ID against Developer Portal → General Information → Application ID.`;
  }

  if (status === 429) {
    return 'Discord is rate limiting command registration. Wait a few minutes and run the deploy again.';
  }

  if (status === 400) {
    // The response body names the offending index and field, which is the only way to
    // locate the problem in a bulk write of two dozen commands.
    const detail = err?.rawError ? JSON.stringify(err.rawError.errors ?? err.rawError) : null;
    return `Discord rejected the command payload as invalid.${detail ? ` Details: ${detail}` : ''}`;
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'Could not reach Discord. Check network connectivity and DNS.';
  }

  return err?.message ?? String(err);
}

/**
 * Registers or clears commands.
 *
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  loadDotEnv();
  const env = loadEnv();
  setLogLevel(env.logLevel);

  /**
   * Scope resolution. GUILD_ID chooses guild scope unless --global overrides it, which is
   * stated explicitly so a developer with GUILD_ID set does not wonder why their global
   * deploy went to one guild.
   */
  const useGuildScope = Boolean(env.guildId) && !args.global;
  const scopeLabel = useGuildScope ? `guild ${env.guildId}` : 'global';

  if (args.global && env.guildId) {
    logger.info('GUILD_ID is set, but --global was passed; registering globally as requested', {
      guildId: env.guildId,
    });
  }

  const route = useGuildScope
    ? Routes.applicationGuildCommands(env.clientId, /** @type {string} */ (env.guildId))
    : Routes.applicationCommands(env.clientId);

  const rest = new REST({ version: '10' }).setToken(env.discordToken);

  // ------------------------------------------------------------------- clearing

  if (args.clear) {
    if (args.dryRun) {
      process.stdout.write(`\nWould remove every command from ${scopeLabel}.\n\n`);
      return;
    }

    logger.warn('Removing every registered command', { scope: scopeLabel });

    // An empty array is Discord's documented way to clear a scope.
    await rest.put(route, { body: [] });

    process.stdout.write(`\nCleared all commands from ${scopeLabel}.\n\n`);

    if (!useGuildScope) {
      process.stdout.write('Global changes can take up to an hour to propagate.\n\n');
    }
    return;
  }

  // ------------------------------------------------------------------ building

  /**
   * The registry validates every definition and builds the payload. A duplicate name, an
   * over-long description or a parent/command conflict throws here, before anything is
   * sent — which is what keeps a bulk registration from failing with an error that names
   * only an array index.
   */
  const registry = await loadRegistry(import.meta.dirname);
  const body = registry.slashBody();

  if (body.length === 0) {
    process.stderr.write('\nNo slash commands were found to deploy.\n\n');
    process.exit(1);
  }

  if (body.length > MAX_GLOBAL_COMMANDS) {
    process.stderr.write(
      `\nThe command tree produces ${body.length} top-level commands, exceeding Discord's limit of ${MAX_GLOBAL_COMMANDS}.\n\n`,
    );
    process.exit(1);
  }

  const summary = summarisePayload(body);

  /**
   * Reachability check.
   *
   * Confirms that every command in the registry actually appears in the payload, by
   * walking the built JSON rather than trusting the definitions. This catches the class of
   * bug where a three-word name fails to become a subcommand group and silently vanishes
   * from the tree.
   */
  const leafPaths = new Set(summary.leaves.map((leaf) => leaf.slice(1)));
  const unreachable = registry.all
    .filter((command) => command.slash !== false && !leafPaths.has(command.name))
    .map((command) => command.name);

  if (unreachable.length > 0) {
    process.stderr.write(
      `\nThese commands are in the registry but not in the payload, so they would not be invocable:\n${unreachable
        .map((name) => `  - ${name}`)
        .join('\n')}\n\nThis is a bug in the command tree; nothing was deployed.\n\n`,
    );
    process.exit(1);
  }

  // ------------------------------------------------------------------- dry run

  if (args.dryRun) {
    process.stdout.write(
      [
        '',
        `Would register ${summary.roots} top-level command(s) to ${scopeLabel},`,
        `covering ${summary.leaves.length} invocable path(s):`,
        '',
        ...summary.leaves.map((leaf) => `  ${leaf}`),
        '',
        'No request was sent.',
        '',
      ].join('\n'),
    );
    return;
  }

  // ------------------------------------------------------------------ deploying

  logger.info('Registering slash commands', {
    scope: scopeLabel,
    topLevel: summary.roots,
    invocablePaths: summary.leaves.length,
  });

  /**
   * PUT replaces the entire scope in one call, so commands removed from the codebase
   * disappear without a separate delete step. It is also all-or-nothing: a single invalid
   * command rejects the whole array, which is why the registry validates first.
   */
  const result = await rest.put(route, { body });
  const registered = Array.isArray(result) ? result.length : summary.roots;

  process.stdout.write(
    [
      '',
      `Registered ${registered} top-level command(s) to ${scopeLabel}.`,
      `Covering ${summary.leaves.length} invocable path(s):`,
      '',
      ...summary.leaves.map((leaf) => `  ${leaf}`),
      '',
      useGuildScope
        ? 'Guild commands are available immediately.'
        : 'Global commands can take up to an hour to appear in every server.',
      '',
    ].join('\n'),
  );

  if (!useGuildScope && env.guildId === null) {
    process.stdout.write(
      'Tip: set GUILD_ID in .env during development for instant registration in one server.\n\n',
    );
  }
}

main().catch((err) => {
  const status = err?.status ?? err?.response?.status ?? null;

  logger.error('Command deployment failed', {
    name: err?.name ?? 'Error',
    status,
    code: err?.code ?? null,
    message: err?.message ?? String(err),
  });

  // Read from process.env directly: loadEnv may not have run, and this path must produce
  // a useful message either way.
  const explanation = explainFailure(err, {
    guildId: process.env.GUILD_ID?.trim() || null,
    clientId: process.env.CLIENT_ID?.trim() || 'unknown',
  });

  process.stderr.write(`\nDeployment failed: ${explanation}\n\n`);
  process.exit(1);
});
