// Coded by Aditya | GitHub- @adityatheog

/**
 * Database initialisation and inspection.
 *
 * The bot creates and migrates its database automatically on startup, so this script is
 * not required for normal operation. It exists for the cases where doing it separately
 * matters:
 *
 *   Deployment ordering. A container that mounts a volume can create and migrate the
 *   schema in an init step, so the first request is not the thing that discovers the
 *   volume is read-only.
 *
 *   Verification. `--check` reports the schema version, row counts and file location
 *   without opening a Discord connection, which is the fastest way to confirm a
 *   DATABASE_PATH points where an operator thinks it does.
 *
 *   Backups. `--backup` uses SQLite's online backup API rather than copying the file,
 *   which is the difference between a consistent snapshot and one that captures a torn
 *   write-ahead log.
 *
 *   Migration on upgrade. Running this before starting a new version applies pending
 *   migrations in a step whose output an operator can read, rather than inside startup
 *   logs.
 *
 * Every operation is idempotent. Running it against an already-current database applies
 * nothing and reports the version.
 *
 * Usage:
 *   node scripts/init-db.js              Create or migrate, then report.
 *   node scripts/init-db.js --check      Report only; do not create or migrate.
 *   node scripts/init-db.js --backup <p> Write a consistent copy to <p>.
 *   node scripts/init-db.js --path <p>   Override DATABASE_PATH.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createDatabase, SCHEMA_VERSION } from '../src/database/db.js';
import { loadDotEnv, loadEnv } from '../src/config/env.js';
import { logger, setLogLevel } from '../src/utils/logger.js';
import { formatBytes } from '../src/utils/format.js';

/**
 * Parses the command line.
 *
 * @param {string[]} argv
 * @returns {{ check: boolean, backup: string|null, dbPath: string|null, help: boolean }}
 */
function parseArgs(argv) {
  const args = argv.slice(2);

  /** @type {{ check: boolean, backup: string|null, dbPath: string|null, help: boolean }} */
  const parsed = { check: false, backup: null, dbPath: null, help: false };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case '--check':
      case '-c':
        parsed.check = true;
        break;

      case '--backup':
      case '-b':
        // Consumes the following argument as the destination.
        parsed.backup = args[index + 1] ?? null;
        index += 1;
        break;

      case '--path':
      case '-p':
        parsed.dbPath = args[index + 1] ?? null;
        index += 1;
        break;

      case '--help':
      case '-h':
        parsed.help = true;
        break;

      default:
        // An unrecognised flag is a typo, and silently ignoring it would mean an operator
        // believes an option took effect when it did not.
        if (arg.startsWith('-')) {
          process.stderr.write(`\nUnknown option: ${arg}\nRun with --help for usage.\n\n`);
          process.exit(1);
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
      'Create, migrate, inspect or back up the bot database.',
      '',
      'Usage: node scripts/init-db.js [options]',
      '',
      'Options:',
      '  -c, --check          Report the current state without creating or migrating.',
      '  -b, --backup <path>  Write a consistent copy to <path> using SQLite\'s',
      '                       online backup API. Safe while the bot is running.',
      '  -p, --path <path>    Use this database file instead of DATABASE_PATH.',
      '  -h, --help           Show this message.',
      '',
      'With no options the database is created if missing, migrated to the current',
      'schema version, and its state is reported. This is what the bot does at',
      'startup, so running it separately is optional.',
      '',
    ].join('\n'),
  );
}

/**
 * Reports what is on disk before anything is opened.
 *
 * Distinguishing "no file" from "empty file" from "existing file" matters: the second is
 * what a `touch` or a Docker volume mount with a file target produces, and it is a
 * frequent cause of confusing behaviour.
 *
 * @param {string} dbPath
 * @returns {{ exists: boolean, bytes: number, walBytes: number }}
 */
function inspectFiles(dbPath) {
  const resolved = path.resolve(dbPath);

  let bytes = 0;
  let exists = false;
  try {
    bytes = fs.statSync(resolved).size;
    exists = true;
  } catch {
    exists = false;
  }

  // The write-ahead log holds commits not yet checkpointed into the main file. A large
  // one after a clean shutdown suggests the checkpoint failed.
  let walBytes = 0;
  try {
    walBytes = fs.statSync(`${resolved}-wal`).size;
  } catch {
    walBytes = 0;
  }

  return { exists, bytes, walBytes };
}

/**
 * Prints the state of an open database.
 *
 * @param {ReturnType<typeof createDatabase>} db
 * @param {string} dbPath
 * @param {{ exists: boolean, bytes: number, walBytes: number }} before
 * @returns {void}
 */
function report(db, dbPath, before) {
  const stats = db.getStats();
  const migration = db.migrationInfo();
  const after = inspectFiles(dbPath);

  const lines = [
    '',
    'Database',
    `  Path            ${path.resolve(dbPath)}`,
    `  Size            ${formatBytes(after.bytes)}${after.walBytes > 0 ? ` (+ ${formatBytes(after.walBytes)} WAL)` : ''}`,
    `  Schema version  ${stats.schemaVersion}`,
    '',
    'Contents',
    `  Users           ${stats.users}`,
    `  Servers         ${stats.servers}`,
  ];

  const eggTypes = Object.entries(stats.serversByEgg);
  if (eggTypes.length > 0) {
    lines.push('', 'Servers by type');
    for (const [eggType, count] of eggTypes.sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${eggType.padEnd(14)}  ${count}`);
    }
  }

  lines.push('', 'Migrations');

  if (!before.exists) {
    lines.push(`  Created at version ${SCHEMA_VERSION}`);
  } else if (migration.applied.length > 0) {
    lines.push(`  Upgraded from version ${migration.from} to ${SCHEMA_VERSION}`);
    for (const applied of migration.applied) {
      lines.push(`    ${applied}`);
    }
  } else {
    lines.push(`  Already at version ${SCHEMA_VERSION}; nothing applied`);
  }

  lines.push('');
  process.stdout.write(lines.join('\n'));
}

/**
 * @returns {Promise<void>}
 */
async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }

  /**
   * The environment is loaded for DATABASE_PATH and LOG_LEVEL, but a full loadEnv() would
   * demand a Discord token and panel keys that this script never uses. Falling back keeps
   * the script usable during initial setup, before credentials are filled in.
   */
  loadDotEnv();

  let dbPath = args.dbPath;
  if (!dbPath) {
    try {
      const env = loadEnv();
      setLogLevel(env.logLevel);
      dbPath = env.databasePath;
    } catch {
      dbPath = process.env.DATABASE_PATH?.trim() || './data/panelkit.sqlite';
      process.stdout.write(
        `\nNote: the environment is incomplete, so DATABASE_PATH was read directly.\n      Using ${dbPath}\n`,
      );
    }
  }

  const before = inspectFiles(dbPath);

  // ---------------------------------------------------------------- check only

  if (args.check) {
    if (!before.exists) {
      process.stdout.write(
        [
          '',
          `No database exists at ${path.resolve(dbPath)}.`,
          '',
          'Run this script without --check to create it, or just start the bot:',
          'it creates and migrates the database automatically.',
          '',
        ].join('\n'),
      );
      // Not an error: a missing database on a fresh install is the expected state.
      return;
    }

    if (before.bytes === 0) {
      process.stderr.write(
        [
          '',
          `The file at ${path.resolve(dbPath)} exists but is empty.`,
          '',
          'This usually means it was created by `touch`, or that a container volume was',
          'mounted with a file target. SQLite will initialise it on first open, which is',
          'harmless, but confirm the path is what you intended.',
          '',
        ].join('\n'),
      );
    }

    /**
     * Opening applies pending migrations, which --check promises not to do. The version is
     * read directly instead, without the migration runner.
     */
    const Database = (await import('better-sqlite3')).default;
    const connection = new Database(path.resolve(dbPath), { readonly: true, fileMustExist: true });

    try {
      const version = Number(connection.pragma('user_version', { simple: true })) || 0;

      const users = connection.prepare('SELECT COUNT(*) AS count FROM users').get().count;
      const servers = connection.prepare('SELECT COUNT(*) AS count FROM servers').get().count;

      process.stdout.write(
        [
          '',
          'Database (read-only check)',
          `  Path            ${path.resolve(dbPath)}`,
          `  Size            ${formatBytes(before.bytes)}${before.walBytes > 0 ? ` (+ ${formatBytes(before.walBytes)} WAL)` : ''}`,
          `  Schema version  ${version}${version === SCHEMA_VERSION ? ' (current)' : ` (current is ${SCHEMA_VERSION})`}`,
          '',
          'Contents',
          `  Users           ${users}`,
          `  Servers         ${servers}`,
          '',
          version < SCHEMA_VERSION
            ? `Pending migrations. Run this script without --check, or start the bot, to upgrade to version ${SCHEMA_VERSION}.\n`
            : version > SCHEMA_VERSION
              ? `This database is newer than this build understands. You are running an older release against a newer database; upgrade the bot rather than downgrading the database.\n`
              : 'No migrations pending.\n',
          '',
        ].join('\n'),
      );

      // A newer schema than this build supports is a real misconfiguration, not just
      // information, so it exits non-zero for the benefit of a deployment script.
      if (version > SCHEMA_VERSION) process.exit(1);
    } catch (err) {
      process.stderr.write(
        `\nCould not read the database: ${err?.message ?? String(err)}\n\nIt may be corrupt, or not a SQLite file.\n\n`,
      );
      process.exit(1);
    } finally {
      connection.close();
    }

    return;
  }

  // ------------------------------------------------------- create and migrate

  if (!before.exists) {
    process.stdout.write(`\nCreating a new database at ${path.resolve(dbPath)}\n`);
  }

  // createDatabase creates the parent directory, applies pragmas, and runs migrations
  // inside a transaction per version.
  const db = createDatabase(dbPath);

  try {
    // Confirms the file is genuinely usable rather than merely opened.
    db.ping();

    report(db, dbPath, before);

    // ---------------------------------------------------------------- backup

    if (args.backup) {
      const destination = path.resolve(args.backup);

      if (fs.existsSync(destination)) {
        process.stderr.write(
          `\nRefusing to overwrite an existing file at ${destination}.\nChoose a different destination.\n\n`,
        );
        process.exit(1);
      }

      process.stdout.write(`Backing up to ${destination}\n`);

      /**
       * SQLite's online backup API, not a file copy. A copy taken while the bot is running
       * can capture a partially written WAL and produce an unopenable file; this produces a
       * consistent snapshot without blocking writes.
       */
      await db.backup(destination);

      const size = fs.statSync(destination).size;
      process.stdout.write(`Backup complete: ${formatBytes(size)}\n\n`);
    }
  } finally {
    // Checkpoints the WAL so the main file is self-contained afterwards, which matters
    // when a deployment archives the volume immediately after this runs.
    db.close();
  }
}

main().catch((err) => {
  logger.error('Database initialisation failed', {
    name: err?.name ?? 'Error',
    code: err?.code ?? null,
    message: err?.message ?? String(err),
  });

  process.stderr.write(`\nFailed: ${err?.message ?? String(err)}\n\n`);
  process.exit(1);
});
