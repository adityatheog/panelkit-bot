// Coded by Aditya | GitHub- @adityatheog

/**
 * Liveness probe.
 *
 * Reports whether the bot is alive by reading the heartbeat file that src/index.js
 * rewrites every thirty seconds. Exit code 0 means healthy, 1 means not.
 *
 * A file rather than an HTTP endpoint, deliberately. This bot makes only outbound
 * connections: it holds a gateway websocket to Discord and calls the panel's REST API.
 * Adding a listening port purely so a supervisor can ask "are you alive" would introduce
 * an unauthenticated network surface into a process that otherwise has none, and that
 * endpoint would then need its own access control, binding decision and exposure review. A
 * file the process already writes carries none of that cost.
 *
 * What this proves, and what it does not:
 *
 *   Proven      The process exists, its event loop is turning, and it can write to its
 *               data directory. A blocked event loop stops updating the file, and that is
 *               precisely the failure a restart repairs.
 *
 *   Not proven  That Discord is reachable, that the panel is reachable, or that commands
 *               succeed. Those are excluded on purpose. discord.js reconnects with its own
 *               backoff, and a panel outage is upstream — a probe that failed during
 *               either would have the supervisor restart-loop a recovering process,
 *               turning someone else's incident into a self-inflicted outage.
 *
 * This script imports nothing from src/. That is a design choice, not an oversight: a probe
 * that depended on the application's module graph could report unhealthy because of an
 * unrelated syntax error, which is the opposite of what a health check is for. Only
 * node:fs and node:path are used.
 *
 * Consumed by the Docker HEALTHCHECK, the systemd unit and `npm run health`.
 *
 * Usage:
 *   node scripts/healthcheck.js                Check, then exit 0 or 1.
 *   node scripts/healthcheck.js --verbose      Print detail on success as well.
 *   node scripts/healthcheck.js --json         Machine-readable output.
 *   node scripts/healthcheck.js --path <file>  Check a specific file.
 *
 * Environment:
 *   HEARTBEAT_PATH        Heartbeat file to read. Default ./data/heartbeat
 *   HEARTBEAT_MAX_AGE_MS  Staleness threshold in milliseconds. Default 90000
 */

import fs from 'node:fs';
import path from 'node:path';

/** The bot's write interval. Kept in sync with HEARTBEAT_INTERVAL_MS in src/index.js. */
const WRITE_INTERVAL_MS = 30_000;

/**
 * Default staleness threshold: three write intervals.
 *
 * One missed write is ordinary jitter from a garbage-collection pause or a slow disk.
 * Three consecutive misses means the event loop has been blocked for ninety seconds, which
 * no healthy state explains. A tighter threshold restarts working bots; a looser one delays
 * detection past the point of usefulness.
 */
const DEFAULT_MAX_AGE_MS = WRITE_INTERVAL_MS * 3;

/** Matches the default in .env.example and src/config/env.js. */
const DEFAULT_HEARTBEAT_PATH = './data/heartbeat';

/**
 * Tolerance for a heartbeat dated in the future.
 *
 * An NTP step correction, a VM resumed from a snapshot, or a container whose clock is set
 * after start can all produce a timestamp slightly ahead of now. Failing on that would
 * restart a healthy process over a clock adjustment, so a small skew is accepted while a
 * large one is reported — because past that point the age cannot be trusted at all.
 */
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

const EXIT_HEALTHY = 0;
const EXIT_UNHEALTHY = 1;

/**
 * Parses the command line.
 *
 * @param {string[]} argv
 * @returns {{ verbose: boolean, json: boolean, help: boolean, heartbeatPath: string|null }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  /** @type {{ verbose: boolean, json: boolean, help: boolean, heartbeatPath: string|null }} */
  const parsed = { verbose: false, json: false, help: false, heartbeatPath: null };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--verbose':
      case '-v':
        parsed.verbose = true;
        break;

      case '--json':
        parsed.json = true;
        break;

      case '--path':
      case '-p':
        // Consumes the following argument as the file to check.
        parsed.heartbeatPath = args[index + 1] ?? null;
        index += 1;
        break;

      case '--help':
      case '-h':
        parsed.help = true;
        break;

      default:
        /**
         * An unrecognised flag is a typo. Ignoring it would mean reporting health for a
         * file nobody intended to check, so it fails loudly instead.
         */
        if (arg.startsWith('-')) {
          process.stderr.write(`unhealthy: unknown option ${arg}\n`);
          process.exit(EXIT_UNHEALTHY);
        }
        break;
    }
  }

  return parsed;
}

/** Prints usage. */
function printHelp() {
  process.stdout.write(
    [
      '',
      'Report whether the bot is alive, by reading its heartbeat file.',
      '',
      'Usage: node scripts/healthcheck.js [options]',
      '',
      'Options:',
      '  -p, --path <file>  Heartbeat file to read. Overrides HEARTBEAT_PATH.',
      '  -v, --verbose      Print detail on success as well as failure.',
      '      --json         Print a JSON object instead of prose.',
      '  -h, --help         Show this message.',
      '',
      'Environment:',
      '  HEARTBEAT_PATH        Heartbeat file to read.',
      `                        Default: ${DEFAULT_HEARTBEAT_PATH}`,
      '  HEARTBEAT_MAX_AGE_MS  How stale the heartbeat may be, in milliseconds.',
      `                        Default: ${DEFAULT_MAX_AGE_MS} (three write intervals)`,
      '',
      'Exit codes:',
      '  0  healthy   the heartbeat is fresh',
      '  1  unhealthy the heartbeat is missing, stale, or unreadable',
      '',
      'This checks that the process is alive and its event loop is turning. It does not',
      'check Discord or the panel: an outage there is not a reason to restart this bot,',
      'and its Discord connection recovers on its own.',
      '',
    ].join('\n'),
  );
}

/**
 * Resolves the staleness threshold from the environment.
 *
 * A threshold below one write interval guarantees false alarms, so a nonsensical value
 * falls back to the default rather than causing a restart loop.
 *
 * @returns {number}
 */
function resolveMaxAgeMs() {
  const raw = process.env.HEARTBEAT_MAX_AGE_MS;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_MAX_AGE_MS;

  const value = Number(raw);
  if (!Number.isFinite(value) || value < WRITE_INTERVAL_MS) return DEFAULT_MAX_AGE_MS;

  return value;
}

/**
 * Resolves the heartbeat file path.
 *
 * Reads process.env directly rather than through loadEnv(). A probe must work when the
 * environment is incomplete, and full validation would demand a Discord token and panel
 * keys this script never touches — requiring them would make the health check fail for
 * configuration reasons unrelated to the bot's health, and a container reported unhealthy
 * is a container the orchestrator kills.
 *
 * @param {string|null} override
 * @returns {string} an absolute path
 */
function resolveHeartbeatPath(override) {
  const configured = override ?? process.env.HEARTBEAT_PATH?.trim() ?? '';
  return path.resolve(configured === '' ? DEFAULT_HEARTBEAT_PATH : configured);
}

/**
 * Reads the heartbeat file and evaluates its freshness.
 *
 * Pure apart from the filesystem read: it returns a verdict rather than exiting, so every
 * failure mode is reported through one path.
 *
 * @param {string} heartbeatPath absolute path
 * @param {number} maxAgeMs
 * @param {number} [now]
 * @returns {{ healthy: boolean, reason: string, hint: string|null, ageMs: number|null }}
 */
function evaluate(heartbeatPath, maxAgeMs, now = Date.now()) {
  /** @type {string} */
  let raw;

  try {
    raw = fs.readFileSync(heartbeatPath, 'utf8').trim();
  } catch (err) {
    const code = err?.code ?? null;

    /**
     * A missing file has two very different causes, and the message distinguishes them
     * because the remedies differ:
     *
     *   The bot has not started, or has shut down cleanly — shutdown removes the file
     *   deliberately, so a stopped process reports unhealthy rather than leaving behind a
     *   heartbeat that will never advance again.
     *
     *   The path is wrong, which is what happens when HEARTBEAT_PATH or the working
     *   directory differ between the bot and the probe.
     */
    if (code === 'ENOENT') {
      return {
        healthy: false,
        reason: 'no heartbeat file',
        hint: 'the bot is not running, has shut down cleanly, or HEARTBEAT_PATH differs from the value it was started with',
        ageMs: null,
      };
    }

    /**
     * A permissions failure means the bot may be perfectly healthy while the probe cannot
     * see its file. Reporting this identically to ENOENT would send an operator to restart
     * a working process.
     */
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        healthy: false,
        reason: 'the heartbeat file is not readable',
        hint: 'the probe is running as a different user than the bot; check file and directory ownership',
        ageMs: null,
      };
    }

    /**
     * A directory at the file path is a specific Docker mistake: binding a host path that
     * does not exist onto a file target creates a directory instead.
     */
    if (code === 'EISDIR') {
      return {
        healthy: false,
        reason: 'the heartbeat path is a directory, not a file',
        hint: 'a volume mount has created a directory here; mount the parent directory instead of the file',
        ageMs: null,
      };
    }

    return {
      healthy: false,
      reason: `the heartbeat file could not be read (${code ?? err?.message ?? 'unknown error'})`,
      hint: null,
      ageMs: null,
    };
  }

  /**
   * A zero-length read is possible when the probe lands between the truncate and the write
   * of a non-atomic writeFileSync. Reported as unhealthy rather than crashing, and the next
   * probe thirty seconds later will almost certainly succeed.
   */
  if (raw === '') {
    return {
      healthy: false,
      reason: 'the heartbeat file is empty',
      hint: 'likely read midway through a write; this resolves on the next check',
      ageMs: null,
    };
  }

  const timestamp = Number(raw);

  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return {
      healthy: false,
      reason: `the heartbeat file does not contain a timestamp (read ${JSON.stringify(raw.slice(0, 40))})`,
      hint: 'the file may have been overwritten by something other than the bot',
      ageMs: null,
    };
  }

  const ageMs = now - timestamp;

  if (ageMs < -CLOCK_SKEW_TOLERANCE_MS) {
    return {
      healthy: false,
      reason: `the heartbeat is ${Math.round(-ageMs / 1000)}s in the future`,
      hint: 'the system clock has changed, or the file was written on another host',
      ageMs,
    };
  }

  if (ageMs > maxAgeMs) {
    const missed = Math.floor(ageMs / WRITE_INTERVAL_MS);

    return {
      healthy: false,
      reason: `the heartbeat is ${Math.round(ageMs / 1000)}s old, past the ${Math.round(maxAgeMs / 1000)}s limit`,
      hint: `${missed} write interval(s) missed; the event loop is blocked or the process has died without cleaning up`,
      ageMs,
    };
  }

  return {
    healthy: true,
    // A negative age within tolerance is clamped, so a small clock skew does not print "-1s".
    reason: `the heartbeat is ${Math.max(0, Math.round(ageMs / 1000))}s old`,
    hint: null,
    ageMs,
  };
}

/**
 * Reports the verdict and exits.
 *
 * @param {ReturnType<typeof evaluate>} result
 * @param {object} context
 * @param {string} context.heartbeatPath
 * @param {number} context.maxAgeMs
 * @param {boolean} context.verbose
 * @param {boolean} context.json
 * @returns {never}
 */
function report(result, { heartbeatPath, maxAgeMs, verbose, json }) {
  if (json) {
    const payload = JSON.stringify({
      status: result.healthy ? 'healthy' : 'unhealthy',
      reason: result.reason,
      hint: result.hint,
      ageMs: result.ageMs,
      maxAgeMs,
      path: heartbeatPath,
      checkedAt: new Date().toISOString(),
    });

    // JSON goes to stdout in both cases: a consumer parsing it needs one stream.
    process.stdout.write(`${payload}\n`);
    process.exit(result.healthy ? EXIT_HEALTHY : EXIT_UNHEALTHY);
  }

  if (result.healthy) {
    /**
     * Quiet by default. Under Docker this runs every sixty seconds, and a line per
     * successful check would bury anything worth reading in the container log.
     */
    if (verbose) {
      process.stdout.write(
        `healthy: ${result.reason} (path=${heartbeatPath} limit=${Math.round(maxAgeMs / 1000)}s)\n`,
      );
    }
    process.exit(EXIT_HEALTHY);
  }

  const detail = [`path=${heartbeatPath}`];
  if (result.hint) detail.push(result.hint);

  process.stderr.write(`unhealthy: ${result.reason} — ${detail.join('; ')}\n`);
  process.exit(EXIT_UNHEALTHY);
}

/**
 * @returns {void}
 */
function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(EXIT_HEALTHY);
  }

  const heartbeatPath = resolveHeartbeatPath(args.heartbeatPath);
  const maxAgeMs = resolveMaxAgeMs();

  const result = evaluate(heartbeatPath, maxAgeMs);

  report(result, { heartbeatPath, maxAgeMs, verbose: args.verbose, json: args.json });
}

try {
  main();
} catch (err) {
  /**
   * A probe must never hang and never exit ambiguously, whatever goes wrong inside it. An
   * unexpected failure here is reported as unhealthy rather than crashing with a stack
   * trace a supervisor cannot interpret.
   */
  process.stderr.write(`unhealthy: the health check itself failed: ${err?.message ?? String(err)}\n`);
  process.exit(EXIT_UNHEALTHY);
}
