// Coded by Aditya | GitHub- @adityatheog

/**
 * SQLite persistence layer.
 *
 * This is the only module in the project that contains SQL. Everything else calls
 * the methods returned by createDatabase(), which means parameter binding,
 * ownership scoping and transaction boundaries are enforced in one auditable place
 * rather than scattered across command handlers.
 *
 * Design decisions worth knowing:
 *
 * 1. Every statement is prepared once at open time and bound by parameter. No SQL
 *    is ever built by concatenation, so user input cannot alter a query.
 *
 * 2. Ownership is expressed in SQL, not in JavaScript. getOwnedServer,
 *    updateServer and deleteServer all carry `AND discord_id = ?`, so a foreign
 *    caller matches zero rows instead of relying on a caller-side comparison that
 *    a future refactor could omit.
 *
 * 3. better-sqlite3 is synchronous. That is a feature here: a read-modify-write
 *    sequence inside one function cannot interleave with another request, and
 *    transactions are genuinely atomic without async bookkeeping. Cross-request
 *    races that span an await are handled separately by src/utils/locks.js.
 *
 * 4. Schema changes go through the migrations array below and are applied inside a
 *    transaction, tracked by SQLite's own `user_version`. No separate migration
 *    table, no manual setup step: opening the database brings it to the current
 *    version or fails without partially applying anything.
 *
 * The panel remains the source of truth for server state. This database stores the
 * Discord-to-panel mapping and local metadata, which is why it must be backed up:
 * losing it disconnects users from servers that still exist on the panel.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { AppError, normalizeDatabaseError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/** Current schema version. Must equal migrations.length. */
export const SCHEMA_VERSION = 1;

/**
 * Ordered schema migrations.
 *
 * Index 0 takes the database from version 0 (empty) to version 1. To evolve the
 * schema, append a new function and raise SCHEMA_VERSION; never edit an existing
 * entry, because deployed databases have already applied it.
 *
 * @type {ReadonlyArray<{ version: number, description: string, up: (db: import('better-sqlite3').Database) => void }>}
 */
const migrations = Object.freeze([
  {
    version: 1,
    description: 'initial schema: users, servers, indexes',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          discord_id  TEXT    PRIMARY KEY,
          panel_id    INTEGER NOT NULL UNIQUE,
          email       TEXT    NOT NULL UNIQUE,
          username    TEXT    NOT NULL UNIQUE,
          credits     INTEGER NOT NULL DEFAULT 0 CHECK (credits >= 0),
          created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE IF NOT EXISTS servers (
          server_id       INTEGER PRIMARY KEY AUTOINCREMENT,
          discord_id      TEXT    NOT NULL,
          panel_server_id INTEGER NOT NULL UNIQUE,
          identifier      TEXT    NOT NULL UNIQUE,
          name            TEXT    NOT NULL,
          egg_type        TEXT    NOT NULL,
          created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (discord_id) REFERENCES users (discord_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_servers_discord_id ON servers (discord_id);
        CREATE INDEX IF NOT EXISTS idx_servers_identifier  ON servers (identifier);
        CREATE INDEX IF NOT EXISTS idx_servers_panel_id    ON servers (panel_server_id);
        CREATE INDEX IF NOT EXISTS idx_users_panel_id      ON users (panel_id);
        CREATE INDEX IF NOT EXISTS idx_users_email         ON users (email);
      `);
    },
  },
]);

/**
 * Applies any outstanding migrations.
 *
 * Each migration and its version bump happen in one transaction, so an
 * interrupted upgrade leaves the database at the previous version rather than in
 * a half-migrated state.
 *
 * @param {import('better-sqlite3').Database} connection
 * @returns {{ from: number, to: number, applied: string[] }}
 */
function migrate(connection) {
  const from = Number(connection.pragma('user_version', { simple: true })) || 0;

  if (from > SCHEMA_VERSION) {
    throw new AppError(
      `The database schema is version ${from}, but this build understands version ${SCHEMA_VERSION}. ` +
        'You are running an older release against a newer database. Upgrade the bot rather than downgrading the database.',
      { code: 'DB_SCHEMA_TOO_NEW', details: { found: from, supported: SCHEMA_VERSION } },
    );
  }

  const applied = [];

  for (const migration of migrations) {
    if (migration.version <= from) continue;

    const run = connection.transaction(() => {
      migration.up(connection);
      // pragma cannot be parameterised; the value is an internal integer literal.
      connection.pragma(`user_version = ${migration.version}`);
    });

    try {
      run();
    } catch (err) {
      logger.error('Schema migration failed', {
        version: migration.version,
        description: migration.description,
        code: err?.code,
        message: err?.message,
      });
      throw normalizeDatabaseError(err, `migration v${migration.version}`);
    }

    applied.push(`v${migration.version}: ${migration.description}`);
    logger.info('Applied schema migration', { version: migration.version, description: migration.description });
  }

  return { from, to: SCHEMA_VERSION, applied };
}

/**
 * Configures connection-level pragmas.
 *
 * WAL is preferred for concurrency, but it is unavailable on some network
 * filesystems and inside certain container volume drivers. Failing to enable it is
 * not fatal, so it degrades to the default journal with a warning rather than
 * refusing to start.
 *
 * @param {import('better-sqlite3').Database} connection
 * @param {boolean} inMemory
 */
function applyPragmas(connection, inMemory) {
  // Enforces ON DELETE CASCADE. Off by default in SQLite for backwards compatibility.
  connection.pragma('foreign_keys = ON');

  // Waits instead of throwing SQLITE_BUSY when another writer holds the lock.
  connection.pragma('busy_timeout = 5000');

  if (inMemory) return;

  try {
    const mode = connection.pragma('journal_mode = WAL', { simple: true });
    if (String(mode).toLowerCase() !== 'wal') {
      logger.warn('Could not enable WAL journal mode; continuing with the default journal', { mode });
    }
  } catch (err) {
    logger.warn('Could not enable WAL journal mode; continuing with the default journal', { message: err?.message });
  }

  // Durable enough for this workload: a crash can lose the last transaction, but
  // cannot corrupt the file. Full synchronous doubles write latency for no
  // meaningful benefit given the panel is the authoritative store.
  connection.pragma('synchronous = NORMAL');
}

/**
 * Opens a database, brings the schema up to date and returns the data access API.
 *
 * @param {string} [filePath] a file path, or ':memory:' for tests
 * @returns {object} the data access layer
 * @throws {AppError} when the file cannot be opened or migrated
 */
export function createDatabase(filePath = './data/panelkit.sqlite') {
  const inMemory = filePath === ':memory:';
  const resolved = inMemory ? ':memory:' : path.resolve(filePath);

  if (!inMemory) {
    const directory = path.dirname(resolved);
    try {
      fs.mkdirSync(directory, { recursive: true });
    } catch (err) {
      throw new AppError(
        `Could not create the database directory at ${directory}. Check the path in DATABASE_PATH and its permissions.`,
        { code: 'DB_MKDIR_FAILED', details: { directory }, cause: err },
      );
    }
  }

  /** @type {import('better-sqlite3').Database} */
  let connection;
  try {
    connection = new Database(resolved);
  } catch (err) {
    throw new AppError(
      `Could not open the database at ${resolved}. Check that the path is writable and not held by another process.`,
      { code: 'DB_OPEN_FAILED', details: { path: resolved, sqlite: err?.code }, cause: err },
    );
  }

  applyPragmas(connection, inMemory);
  const migration = migrate(connection);

  // Prepared after migration so every statement sees the final schema.
  const stmt = {
    getUser: connection.prepare('SELECT * FROM users WHERE discord_id = ?'),
    getUserByPanelId: connection.prepare('SELECT * FROM users WHERE panel_id = ?'),
    getUserByEmail: connection.prepare('SELECT * FROM users WHERE email = ?'),
    createUser: connection.prepare(
      `INSERT INTO users (discord_id, panel_id, email, username, credits)
       VALUES (@discordId, @panelId, @email, @username, @credits)`,
    ),
    deleteUser: connection.prepare('DELETE FROM users WHERE discord_id = ?'),
    countUsers: connection.prepare('SELECT COUNT(*) AS count FROM users'),
    listUsers: connection.prepare('SELECT * FROM users ORDER BY created_at DESC LIMIT ? OFFSET ?'),

    getCredits: connection.prepare('SELECT credits FROM users WHERE discord_id = ?'),
    setCredits: connection.prepare('UPDATE users SET credits = ? WHERE discord_id = ?'),
    addCredits: connection.prepare('UPDATE users SET credits = credits + ? WHERE discord_id = ?'),
    spendCredits: connection.prepare('UPDATE users SET credits = credits - ? WHERE discord_id = ? AND credits >= ?'),

    getUserServers: connection.prepare('SELECT * FROM servers WHERE discord_id = ? ORDER BY server_id ASC'),
    countUserServers: connection.prepare('SELECT COUNT(*) AS count FROM servers WHERE discord_id = ?'),
    getServerByIdentifier: connection.prepare('SELECT * FROM servers WHERE identifier = ?'),
    getServerByPanelId: connection.prepare('SELECT * FROM servers WHERE panel_server_id = ?'),
    getOwnedServer: connection.prepare('SELECT * FROM servers WHERE identifier = ? AND discord_id = ?'),
    createServer: connection.prepare(
      `INSERT INTO servers (discord_id, panel_server_id, identifier, name, egg_type)
       VALUES (@discordId, @panelServerId, @identifier, @name, @eggType)`,
    ),
    updateServerName: connection.prepare('UPDATE servers SET name = ? WHERE identifier = ? AND discord_id = ?'),
    deleteServer: connection.prepare('DELETE FROM servers WHERE identifier = ? AND discord_id = ?'),
    deleteServersForUser: connection.prepare('DELETE FROM servers WHERE discord_id = ?'),
    countServers: connection.prepare('SELECT COUNT(*) AS count FROM servers'),
    countServersByEgg: connection.prepare('SELECT egg_type, COUNT(*) AS count FROM servers GROUP BY egg_type'),
  };

  /**
   * Runs a statement, converting any SQLite failure into a user-safe AppError.
   *
   * Centralising this means no call site handles raw SQLite error codes, and no
   * SQL text can reach a Discord reply.
   *
   * @template T
   * @param {string} label
   * @param {() => T} fn
   * @returns {T}
   */
  function guard(label, fn) {
    try {
      return fn();
    } catch (err) {
      logger.error('Database operation failed', { label, code: err?.code, message: err?.message });
      throw normalizeDatabaseError(err, label);
    }
  }

  /**
   * Deletes a user and every server row belonging to them, atomically.
   *
   * The explicit server delete is redundant given ON DELETE CASCADE, but it makes
   * the intent visible and keeps the operation correct even if the foreign key
   * pragma is ever disabled on a given connection.
   */
  const deleteUserCascade = connection.transaction((discordId) => {
    const servers = stmt.deleteServersForUser.run(discordId);
    const user = stmt.deleteUser.run(discordId);
    return { servers: servers.changes, user: user.changes };
  });

  /** Records a provisioned server, verifying the owner exists in the same transaction. */
  const insertServerForUser = connection.transaction((payload) => {
    const owner = stmt.getUser.get(payload.discordId);
    if (!owner) {
      throw new AppError('You need a panel account before a server can be recorded.', { code: 'DB_NO_OWNER' });
    }
    stmt.createServer.run(payload);
    return stmt.getServerByIdentifier.get(payload.identifier);
  });

  logger.info('Database ready', {
    path: inMemory ? ':memory:' : resolved,
    schemaVersion: SCHEMA_VERSION,
    migratedFrom: migration.from,
    migrationsApplied: migration.applied.length,
  });

  return {
    /** Escape hatch for scripts and tests. Application code must not use this. */
    connection,

    /** @returns {{ from: number, to: number, applied: string[] }} */
    migrationInfo: () => ({ ...migration }),

    // ------------------------------------------------------------------- users

    /**
     * @param {string} discordId
     * @returns {object|null}
     */
    getUser(discordId) {
      return guard('getUser', () => stmt.getUser.get(String(discordId)) ?? null);
    },

    /**
     * Reverse lookup, used to resolve a panel server's owner back to a Discord user.
     *
     * @param {number} panelId
     * @returns {object|null}
     */
    getUserByPanelId(panelId) {
      return guard('getUserByPanelId', () => stmt.getUserByPanelId.get(Number(panelId)) ?? null);
    },

    /**
     * @param {string} email
     * @returns {object|null}
     */
    getUserByEmail(email) {
      return guard('getUserByEmail', () => stmt.getUserByEmail.get(String(email).toLowerCase()) ?? null);
    },

    /**
     * Inserts a user record. Called only after the panel account exists, so a
     * duplicate here indicates a concurrent request and surfaces as DB_CONFLICT.
     *
     * @param {{ discordId: string, panelId: number, email: string, username: string, credits?: number }} input
     * @returns {object} the stored row
     */
    createUser({ discordId, panelId, email, username, credits = 0 }) {
      return guard('createUser', () => {
        stmt.createUser.run({
          discordId: String(discordId),
          panelId: Number(panelId),
          email: String(email).toLowerCase(),
          username: String(username),
          credits: Number(credits),
        });
        return stmt.getUser.get(String(discordId));
      });
    },

    /**
     * @param {string} discordId
     * @returns {boolean} whether a row was removed
     */
    deleteUser(discordId) {
      return guard('deleteUser', () => stmt.deleteUser.run(String(discordId)).changes > 0);
    },

    /**
     * Removes a user and all their server rows in one transaction.
     *
     * @param {string} discordId
     * @returns {{ servers: number, user: number }} rows removed from each table
     */
    deleteUserWithServers(discordId) {
      return guard('deleteUserWithServers', () => deleteUserCascade(String(discordId)));
    },

    /** @returns {number} */
    countUsers() {
      return guard('countUsers', () => Number(stmt.countUsers.get().count));
    },

    /**
     * @param {{ limit?: number, offset?: number }} [options]
     * @returns {object[]}
     */
    listUsers({ limit = 25, offset = 0 } = {}) {
      const safeLimit = Math.min(100, Math.max(1, Number(limit) || 25));
      const safeOffset = Math.max(0, Number(offset) || 0);
      return guard('listUsers', () => stmt.listUsers.all(safeLimit, safeOffset));
    },

    // ----------------------------------------------------------------- credits

    /**
     * @param {string} discordId
     * @returns {number|null} null when the user has no account
     */
    getCredits(discordId) {
      return guard('getCredits', () => {
        const row = stmt.getCredits.get(String(discordId));
        return row ? Number(row.credits) : null;
      });
    },

    /**
     * @param {string} discordId
     * @param {number} credits
     * @returns {boolean}
     */
    setCredits(discordId, credits) {
      const value = Math.max(0, Math.trunc(Number(credits) || 0));
      return guard('setCredits', () => stmt.setCredits.run(value, String(discordId)).changes > 0);
    },

    /**
     * @param {string} discordId
     * @param {number} delta
     * @returns {boolean}
     */
    addCredits(discordId, delta) {
      const value = Math.trunc(Number(delta) || 0);
      return guard('addCredits', () => stmt.addCredits.run(value, String(discordId)).changes > 0);
    },

    /**
     * Deducts credits only if the balance covers the cost.
     *
     * The balance check lives in the WHERE clause, so the read and the write are a
     * single atomic statement. A check-then-update pair could double-spend.
     *
     * @param {string} discordId
     * @param {number} amount
     * @returns {boolean} false when the balance was insufficient
     */
    spendCredits(discordId, amount) {
      const value = Math.max(0, Math.trunc(Number(amount) || 0));
      return guard('spendCredits', () => stmt.spendCredits.run(value, String(discordId), value).changes > 0);
    },

    // ----------------------------------------------------------------- servers

    /**
     * @param {string} discordId
     * @returns {object[]}
     */
    getUserServers(discordId) {
      return guard('getUserServers', () => stmt.getUserServers.all(String(discordId)));
    },

    /**
     * @param {string} discordId
     * @returns {number}
     */
    countUserServers(discordId) {
      return guard('countUserServers', () => Number(stmt.countUserServers.get(String(discordId)).count));
    },

    /**
     * Unscoped lookup. Use getOwnedServer for anything a user can trigger.
     *
     * @param {string} identifier
     * @returns {object|null}
     */
    getServer(identifier) {
      return guard('getServer', () => stmt.getServerByIdentifier.get(String(identifier)) ?? null);
    },

    /**
     * @param {number} panelServerId
     * @returns {object|null}
     */
    getServerByPanelId(panelServerId) {
      return guard('getServerByPanelId', () => stmt.getServerByPanelId.get(Number(panelServerId)) ?? null);
    },

    /**
     * The authorisation query. Returns a row only when this Discord user owns
     * this identifier, so a foreign or non-existent server is indistinguishable.
     *
     * @param {string} identifier
     * @param {string} discordId
     * @returns {object|null}
     */
    getOwnedServer(identifier, discordId) {
      return guard('getOwnedServer', () => stmt.getOwnedServer.get(String(identifier), String(discordId)) ?? null);
    },

    /**
     * Records a provisioned server.
     *
     * @param {{ discordId: string, panelServerId: number, identifier: string, name: string, eggType: string }} input
     * @returns {object} the stored row
     */
    createServer({ discordId, panelServerId, identifier, name, eggType }) {
      return guard('createServer', () =>
        insertServerForUser({
          discordId: String(discordId),
          panelServerId: Number(panelServerId),
          identifier: String(identifier),
          name: String(name),
          eggType: String(eggType),
        }),
      );
    },

    /**
     * Updates a server's stored name. Ownership-scoped, so a foreign caller
     * changes nothing and receives false.
     *
     * @param {{ identifier: string, discordId: string, name: string }} input
     * @returns {boolean}
     */
    updateServer({ identifier, discordId, name }) {
      return guard(
        'updateServer',
        () => stmt.updateServerName.run(String(name), String(identifier), String(discordId)).changes > 0,
      );
    },

    /**
     * Ownership-scoped delete.
     *
     * @param {string} identifier
     * @param {string} discordId
     * @returns {boolean}
     */
    deleteServer(identifier, discordId) {
      return guard('deleteServer', () => stmt.deleteServer.run(String(identifier), String(discordId)).changes > 0);
    },

    /** @returns {number} */
    countServers() {
      return guard('countServers', () => Number(stmt.countServers.get().count));
    },

    // --------------------------------------------------------------- lifecycle

    /**
     * Aggregate counts for the health check and admin diagnostics.
     *
     * @returns {{ users: number, servers: number, serversByEgg: Record<string, number>, schemaVersion: number }}
     */
    getStats() {
      return guard('getStats', () => {
        const serversByEgg = {};
        for (const row of stmt.countServersByEgg.all()) {
          serversByEgg[String(row.egg_type)] = Number(row.count);
        }
        return {
          users: Number(stmt.countUsers.get().count),
          servers: Number(stmt.countServers.get().count),
          serversByEgg,
          schemaVersion: SCHEMA_VERSION,
        };
      });
    },

    /**
     * Cheap liveness probe. Throws if the file has become unreadable.
     *
     * @returns {boolean}
     */
    ping() {
      return guard('ping', () => {
        connection.prepare('SELECT 1 AS ok').get();
        return true;
      });
    },

    /**
     * Copies the database to another path while the bot is running.
     *
     * Uses SQLite's online backup API, so the copy is consistent without stopping
     * writes — unlike copying the file, which can capture a torn WAL.
     *
     * @param {string} destination
     * @returns {Promise<void>}
     */
    async backup(destination) {
      const target = path.resolve(destination);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        await connection.backup(target);
        logger.info('Database backup written', { destination: target });
      } catch (err) {
        throw normalizeDatabaseError(err, 'backup');
      }
    },

    /**
     * Closes the connection.
     *
     * WAL content is checkpointed first so the main file is self-contained after
     * shutdown, which matters when a supervisor archives the volume immediately.
     */
    close() {
      try {
        if (!inMemory) connection.pragma('wal_checkpoint(TRUNCATE)');
      } catch {
        // A failed checkpoint is not worth blocking shutdown; the WAL stays valid.
      }
      try {
        connection.close();
        logger.info('Database connection closed');
      } catch (err) {
        logger.warn('Error while closing the database', { message: err?.message });
      }
    },
  };
}

/** @type {ReturnType<typeof createDatabase>|null} */
let instance = null;

/**
 * Opens the shared database, or returns the existing handle.
 *
 * @param {string} [filePath]
 * @returns {ReturnType<typeof createDatabase>}
 */
export function initDatabase(filePath) {
  if (!instance) instance = createDatabase(filePath);
  return instance;
}

/**
 * Returns the shared database handle.
 *
 * @returns {ReturnType<typeof createDatabase>}
 * @throws {AppError} when called before initDatabase
 */
export function getDb() {
  if (!instance) {
    throw new AppError('The database has not been initialised.', { code: 'DB_NOT_READY' });
  }
  return instance;
}

/**
 * Replaces or clears the shared handle. Test-only.
 *
 * @param {ReturnType<typeof createDatabase>|null} [newInstance]
 */
export function resetDatabaseForTests(newInstance = null) {
  instance = newInstance;
}
