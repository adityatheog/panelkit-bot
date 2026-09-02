// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/database/db.js.
 *
 * This module is the project's only source of SQL, which makes it the place where two
 * security properties either hold or do not:
 *
 *   Authorisation is expressed in SQL. getOwnedServer, updateServer and deleteServer all
 *   carry `AND discord_id = ?`, so a foreign caller matches zero rows. These tests assert the
 *   negative cases — a foreign id finding nothing, a foreign rename changing nothing — because
 *   those are what a regression would break, and a happy-path test would still pass.
 *
 *   Every statement is parameterised. An injection payload must be stored and retrieved as
 *   literal data, and the surrounding tables must survive it.
 *
 * The credits tests deserve particular attention. spendCredits puts the balance check inside
 * the WHERE clause rather than reading and then writing, which is what prevents a
 * double-spend. That property is asserted directly.
 *
 * Every test uses an in-memory database, so the suite needs no filesystem, leaves nothing
 * behind, and runs each case against a clean schema.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { createDatabase, SCHEMA_VERSION } from '../src/database/db.js';
import { AppError, DatabaseError } from '../src/utils/errors.js';

/** Two distinct Discord ids, used throughout to exercise ownership boundaries. */
const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';

/**
 * Opens a fresh in-memory database.
 *
 * @returns {ReturnType<typeof createDatabase>}
 */
function freshDb() {
  return createDatabase(':memory:');
}

/**
 * Inserts a user with predictable values.
 *
 * @param {ReturnType<typeof createDatabase>} db
 * @param {{ discordId?: string, panelId?: number, credits?: number }} [overrides]
 * @returns {object} the stored row
 */
function seedUser(db, { discordId = OWNER, panelId = 1, credits = 0 } = {}) {
  return db.createUser({
    discordId,
    panelId,
    email: `user${panelId}@example.test`,
    username: `user${panelId}`,
    credits,
  });
}

/**
 * Inserts a server owned by the given user.
 *
 * @param {ReturnType<typeof createDatabase>} db
 * @param {{ discordId?: string, panelServerId?: number, identifier?: string, name?: string, eggType?: string }} [overrides]
 * @returns {object} the stored row
 */
function seedServer(
  db,
  { discordId = OWNER, panelServerId = 501, identifier = 'a1b2c3d4', name = 'Test Server', eggType = 'nodejs' } = {},
) {
  return db.createServer({ discordId, panelServerId, identifier, name, eggType });
}

describe('schema and lifecycle', () => {
  test('creates the schema at the current version', () => {
    const db = freshDb();

    try {
      const migration = db.migrationInfo();

      assert.equal(migration.from, 0, 'a new database starts at version 0');
      assert.equal(migration.to, SCHEMA_VERSION);
      assert.equal(migration.applied.length, 1, 'the initial migration should have run');
      assert.equal(db.getStats().schemaVersion, SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  test('enforces foreign keys', () => {
    /**
     * SQLite disables foreign keys by default for backwards compatibility. Without the pragma,
     * ON DELETE CASCADE would silently not fire and orphaned server rows would accumulate.
     */
    const db = freshDb();

    try {
      assert.equal(db.connection.pragma('foreign_keys', { simple: true }), 1);
    } finally {
      db.close();
    }
  });

  test('ping confirms the connection is usable', () => {
    const db = freshDb();

    try {
      assert.equal(db.ping(), true);
    } finally {
      db.close();
    }
  });

  test('reports aggregate statistics', () => {
    const db = freshDb();

    try {
      assert.deepEqual(db.getStats(), { users: 0, servers: 0, serversByEgg: {}, schemaVersion: SCHEMA_VERSION });

      seedUser(db);
      seedServer(db, { identifier: 'aaaaaaaa', panelServerId: 1, eggType: 'nodejs' });
      seedServer(db, { identifier: 'bbbbbbbb', panelServerId: 2, eggType: 'nodejs' });
      seedServer(db, { identifier: 'cccccccc', panelServerId: 3, eggType: 'python' });

      const stats = db.getStats();

      assert.equal(stats.users, 1);
      assert.equal(stats.servers, 3);
      assert.deepEqual(stats.serversByEgg, { nodejs: 2, python: 1 });
    } finally {
      db.close();
    }
  });

  test('closing twice does not throw', () => {
    // Shutdown may run after an error path has already closed the handle.
    const db = freshDb();

    db.close();
    assert.doesNotThrow(() => db.close());
  });
});

describe('user CRUD', () => {
  test('stores and retrieves a user', () => {
    const db = freshDb();

    try {
      const created = seedUser(db, { credits: 25 });

      assert.equal(created.discord_id, OWNER);
      assert.equal(created.panel_id, 1);
      assert.equal(created.username, 'user1');
      assert.equal(created.credits, 25);
      assert.ok(created.created_at, 'created_at should be populated by the default');

      const fetched = db.getUser(OWNER);
      assert.deepEqual(fetched, created);
    } finally {
      db.close();
    }
  });

  test('returns null for an unknown user rather than throwing', () => {
    const db = freshDb();

    try {
      assert.equal(db.getUser(STRANGER), null);
      assert.equal(db.getUserByPanelId(999), null);
      assert.equal(db.getUserByEmail('nobody@example.test'), null);
    } finally {
      db.close();
    }
  });

  test('lowercases the email on insert and on lookup', () => {
    /**
     * Sub-user management matches by email, and the panel treats addresses
     * case-insensitively. Storing mixed case would make a lookup miss.
     */
    const db = freshDb();

    try {
      db.createUser({
        discordId: OWNER,
        panelId: 1,
        email: 'MixedCase@Example.TEST',
        username: 'user1',
      });

      assert.equal(db.getUser(OWNER).email, 'mixedcase@example.test');
      assert.ok(db.getUserByEmail('MIXEDCASE@EXAMPLE.TEST'), 'lookup should be case-insensitive');
    } finally {
      db.close();
    }
  });

  test('rejects a duplicate Discord id as a conflict', () => {
    /**
     * A duplicate is the expected outcome of a race between two concurrent account creations,
     * not a broken database, so it must surface as DB_CONFLICT rather than a generic fault.
     */
    const db = freshDb();

    try {
      seedUser(db);

      assert.throws(
        () => seedUser(db, { panelId: 2 }),
        (err) => err instanceof AppError && err.code === 'DB_CONFLICT',
      );
    } finally {
      db.close();
    }
  });

  test('rejects a duplicate panel id, email or username', () => {
    // All three are UNIQUE, because each identifies the same panel account.
    const db = freshDb();

    try {
      seedUser(db, { discordId: OWNER, panelId: 1 });

      assert.throws(
        () => db.createUser({ discordId: STRANGER, panelId: 1, email: 'other@example.test', username: 'other' }),
        (err) => err.code === 'DB_CONFLICT',
        'panel_id must be unique',
      );

      assert.throws(
        () => db.createUser({ discordId: STRANGER, panelId: 2, email: 'user1@example.test', username: 'other' }),
        (err) => err.code === 'DB_CONFLICT',
        'email must be unique',
      );

      assert.throws(
        () => db.createUser({ discordId: STRANGER, panelId: 3, email: 'other@example.test', username: 'user1' }),
        (err) => err.code === 'DB_CONFLICT',
        'username must be unique',
      );
    } finally {
      db.close();
    }
  });

  test('resolves a panel id back to a Discord user', () => {
    /**
     * The reverse lookup adminService uses to attribute a panel server to a Discord user.
     */
    const db = freshDb();

    try {
      seedUser(db, { panelId: 42 });

      assert.equal(db.getUserByPanelId(42).discord_id, OWNER);
      assert.equal(db.getUserByPanelId('42').discord_id, OWNER, 'a numeric string should work');
    } finally {
      db.close();
    }
  });

  test('lists users with bounded pagination', () => {
    const db = freshDb();

    try {
      for (let index = 1; index <= 5; index += 1) {
        seedUser(db, { discordId: `1111111111111111${index}1`, panelId: index });
      }

      assert.equal(db.listUsers({ limit: 3, offset: 0 }).length, 3);
      assert.equal(db.listUsers({ limit: 3, offset: 3 }).length, 2);

      // A hostile limit is clamped rather than honoured.
      assert.ok(db.listUsers({ limit: 10_000 }).length <= 100);
      assert.ok(db.listUsers({ limit: -1 }).length >= 1);
      assert.ok(db.listUsers({ offset: -5 }).length >= 1);
    } finally {
      db.close();
    }
  });
});

describe('server CRUD', () => {
  test('stores and retrieves a server', () => {
    const db = freshDb();

    try {
      seedUser(db);
      const created = seedServer(db);

      assert.equal(created.identifier, 'a1b2c3d4');
      assert.equal(created.discord_id, OWNER);
      assert.equal(created.panel_server_id, 501);
      assert.equal(created.egg_type, 'nodejs');
      assert.ok(created.server_id > 0, 'the autoincrement key should be populated');

      assert.deepEqual(db.getServer('a1b2c3d4'), created);
      assert.deepEqual(db.getServerByPanelId(501), created);
    } finally {
      db.close();
    }
  });

  test('refuses to record a server for a user who does not exist', () => {
    /**
     * The insert runs inside a transaction that verifies the owner first, so this surfaces as
     * an actionable message rather than as a raw foreign key violation.
     */
    const db = freshDb();

    try {
      assert.throws(
        () => seedServer(db, { discordId: STRANGER }),
        (err) => err instanceof AppError && err.code === 'DB_NO_OWNER',
      );
    } finally {
      db.close();
    }
  });

  test('rejects a duplicate identifier or panel server id', () => {
    const db = freshDb();

    try {
      seedUser(db);
      seedServer(db);

      assert.throws(
        () => seedServer(db, { panelServerId: 502 }),
        (err) => err.code === 'DB_CONFLICT',
        'identifier must be unique',
      );

      assert.throws(
        () => seedServer(db, { identifier: 'zzzzzzzz' }),
        (err) => err.code === 'DB_CONFLICT',
        'panel_server_id must be unique',
      );
    } finally {
      db.close();
    }
  });

  test('counts and lists a user’s servers in insertion order', () => {
    const db = freshDb();

    try {
      seedUser(db);

      assert.equal(db.countUserServers(OWNER), 0);
      assert.deepEqual(db.getUserServers(OWNER), []);

      seedServer(db, { identifier: 'aaaaaaaa', panelServerId: 1, name: 'First' });
      seedServer(db, { identifier: 'bbbbbbbb', panelServerId: 2, name: 'Second' });

      assert.equal(db.countUserServers(OWNER), 2);
      assert.deepEqual(
        db.getUserServers(OWNER).map((server) => server.name),
        ['First', 'Second'],
      );
    } finally {
      db.close();
    }
  });

  test('updates a server name', () => {
    const db = freshDb();

    try {
      seedUser(db);
      seedServer(db);

      assert.equal(db.updateServer({ identifier: 'a1b2c3d4', discordId: OWNER, name: 'Renamed' }), true);
      assert.equal(db.getServer('a1b2c3d4').name, 'Renamed');
    } finally {
      db.close();
    }
  });

  test('reports false when an update matches nothing', () => {
    // The boolean return is how serverService distinguishes a no-op from a success.
    const db = freshDb();

    try {
      seedUser(db);

      assert.equal(db.updateServer({ identifier: 'zzzzzzzz', discordId: OWNER, name: 'Nope' }), false);
      assert.equal(db.deleteServer('zzzzzzzz', OWNER), false);
    } finally {
      db.close();
    }
  });
});

describe('ownership scoping', () => {
  test('getOwnedServer returns a row only for the owner', () => {
    /**
     * The authorisation query. serverService.requireOwnedServer is built on this, and every
     * user-triggered server operation goes through it.
     */
    const db = freshDb();

    try {
      seedUser(db, { discordId: OWNER, panelId: 1 });
      seedUser(db, { discordId: STRANGER, panelId: 2 });
      seedServer(db, { discordId: OWNER });

      assert.ok(db.getOwnedServer('a1b2c3d4', OWNER), 'the owner should find their server');
      assert.equal(db.getOwnedServer('a1b2c3d4', STRANGER), null, 'a stranger must find nothing');
    } finally {
      db.close();
    }
  });

  test('a missing server and a foreign server are indistinguishable', () => {
    /**
     * Both return null, so the service layer produces an identical error for each. Anything
     * else would let the 8-character identifier space be probed for existence.
     */
    const db = freshDb();

    try {
      seedUser(db, { discordId: OWNER, panelId: 1 });
      seedUser(db, { discordId: STRANGER, panelId: 2 });
      seedServer(db, { discordId: OWNER });

      assert.equal(db.getOwnedServer('a1b2c3d4', STRANGER), null, 'foreign');
      assert.equal(db.getOwnedServer('zzzzzzzz', STRANGER), null, 'nonexistent');
    } finally {
      db.close();
    }
  });

  test('a stranger cannot rename or delete another user’s server', () => {
    /**
     * Writes are scoped in SQL, not only in JavaScript. If a future handler forgot to call
     * requireOwnedServer, the statement itself would still match zero rows.
     */
    const db = freshDb();

    try {
      seedUser(db, { discordId: OWNER, panelId: 1 });
      seedUser(db, { discordId: STRANGER, panelId: 2 });
      seedServer(db, { discordId: OWNER, name: 'Owned' });

      assert.equal(
        db.updateServer({ identifier: 'a1b2c3d4', discordId: STRANGER, name: 'Hijacked' }),
        false,
        'a foreign rename must change nothing',
      );
      assert.equal(db.deleteServer('a1b2c3d4', STRANGER), false, 'a foreign delete must remove nothing');

      const server = db.getServer('a1b2c3d4');
      assert.equal(server.name, 'Owned', 'the name must be unchanged');
      assert.equal(server.discord_id, OWNER, 'ownership must be unchanged');
    } finally {
      db.close();
    }
  });

  test('each user sees only their own servers', () => {
    const db = freshDb();

    try {
      seedUser(db, { discordId: OWNER, panelId: 1 });
      seedUser(db, { discordId: STRANGER, panelId: 2 });

      seedServer(db, { discordId: OWNER, identifier: 'aaaaaaaa', panelServerId: 1 });
      seedServer(db, { discordId: STRANGER, identifier: 'bbbbbbbb', panelServerId: 2 });

      assert.deepEqual(
        db.getUserServers(OWNER).map((server) => server.identifier),
        ['aaaaaaaa'],
      );
      assert.deepEqual(
        db.getUserServers(STRANGER).map((server) => server.identifier),
        ['bbbbbbbb'],
      );
      assert.equal(db.countUserServers(OWNER), 1);
    } finally {
      db.close();
    }
  });
});

describe('SQL injection resistance', () => {
  test('an injection payload is treated as literal data', () => {
    /**
     * Every statement is prepared and bound, so a payload matches no row and executes nothing.
     * The follow-up count proves the servers table survived.
     */
    const db = freshDb();

    try {
      seedUser(db);
      seedServer(db);

      const payloads = [
        "a1b2c3d4'; DROP TABLE servers; --",
        "' OR '1'='1",
        'a1b2c3d4" OR 1=1 --',
        "'; UPDATE users SET credits = 999999; --",
        "a1b2c3d4'); DELETE FROM users; --",
      ];

      for (const payload of payloads) {
        assert.equal(db.getServer(payload), null, `payload should match nothing: ${payload}`);
        assert.equal(db.getOwnedServer(payload, OWNER), null);
        assert.equal(db.getUser(payload), null);
      }

      assert.equal(db.countUserServers(OWNER), 1, 'the servers table must be intact');
      assert.equal(db.getUser(OWNER).credits, 0, 'the users table must be unmodified');
      assert.equal(db.getStats().servers, 1);
    } finally {
      db.close();
    }
  });

  test('a name containing SQL metacharacters round-trips intact', () => {
    // Parameter binding means the value is stored verbatim rather than interpreted.
    const db = freshDb();

    try {
      seedUser(db);

      const hostile = "Robert'); DROP TABLE servers; --";
      seedServer(db, { name: hostile });

      assert.equal(db.getServer('a1b2c3d4').name, hostile, 'the value should be stored literally');
      assert.equal(db.getStats().servers, 1, 'the table must be intact');
    } finally {
      db.close();
    }
  });
});

describe('credits', () => {
  test('reads a balance, and null for a user with no account', () => {
    /**
     * null and 0 are different answers: the first means no account, the second means an empty
     * balance. accountService.getCredits depends on the distinction.
     */
    const db = freshDb();

    try {
      seedUser(db, { credits: 25 });

      assert.equal(db.getCredits(OWNER), 25);
      assert.equal(db.getCredits(STRANGER), null);
    } finally {
      db.close();
    }
  });

  test('sets and adds credits', () => {
    const db = freshDb();

    try {
      seedUser(db, { credits: 10 });

      assert.equal(db.setCredits(OWNER, 50), true);
      assert.equal(db.getCredits(OWNER), 50);

      assert.equal(db.addCredits(OWNER, 25), true);
      assert.equal(db.getCredits(OWNER), 75);

      assert.equal(db.setCredits(STRANGER, 10), false, 'an unknown user should report false');
      assert.equal(db.addCredits(STRANGER, 10), false);
    } finally {
      db.close();
    }
  });

  test('clamps a negative balance to zero rather than storing it', () => {
    // The column carries CHECK (credits >= 0); clamping avoids a constraint error.
    const db = freshDb();

    try {
      seedUser(db, { credits: 10 });

      db.setCredits(OWNER, -100);
      assert.equal(db.getCredits(OWNER), 0);
    } finally {
      db.close();
    }
  });

  test('spendCredits deducts only when the balance covers the cost', () => {
    const db = freshDb();

    try {
      seedUser(db, { credits: 10 });

      assert.equal(db.spendCredits(OWNER, 4), true);
      assert.equal(db.getCredits(OWNER), 6);

      assert.equal(db.spendCredits(OWNER, 6), true, 'spending the exact balance should succeed');
      assert.equal(db.getCredits(OWNER), 0);
    } finally {
      db.close();
    }
  });

  test('spendCredits refuses an overdraft without altering the balance', () => {
    /**
     * The balance check lives in the WHERE clause, so the read and the write are one atomic
     * statement. A check-then-update pair would let two concurrent spends both succeed.
     */
    const db = freshDb();

    try {
      seedUser(db, { credits: 5 });

      assert.equal(db.spendCredits(OWNER, 10), false, 'an overdraft must be refused');
      assert.equal(db.getCredits(OWNER), 5, 'a refused spend must not alter the balance');
    } finally {
      db.close();
    }
  });

  test('two sequential spends cannot exceed the balance', () => {
    /**
     * The double-spend scenario, run sequentially because better-sqlite3 is synchronous and a
     * single statement cannot interleave. The property under test is that the second spend
     * sees the first one's effect.
     */
    const db = freshDb();

    try {
      seedUser(db, { credits: 10 });

      assert.equal(db.spendCredits(OWNER, 10), true);
      assert.equal(db.spendCredits(OWNER, 10), false, 'the second spend must see the first');
      assert.equal(db.getCredits(OWNER), 0);
    } finally {
      db.close();
    }
  });

  test('ignores a nonsensical amount rather than corrupting the balance', () => {
    const db = freshDb();

    try {
      seedUser(db, { credits: 10 });

      db.addCredits(OWNER, NaN);
      assert.equal(db.getCredits(OWNER), 10, 'NaN should be treated as zero');

      db.addCredits(OWNER, 1.7);
      assert.equal(db.getCredits(OWNER), 11, 'a fraction should be truncated');
    } finally {
      db.close();
    }
  });
});

describe('cascade deletion', () => {
  test('deleteUserWithServers removes both tables atomically', () => {
    const db = freshDb();

    try {
      seedUser(db);
      seedServer(db, { identifier: 'aaaaaaaa', panelServerId: 1 });
      seedServer(db, { identifier: 'bbbbbbbb', panelServerId: 2 });

      const removed = db.deleteUserWithServers(OWNER);

      assert.equal(removed.servers, 2);
      assert.equal(removed.user, 1);
      assert.equal(db.getUser(OWNER), null);
      assert.equal(db.getServer('aaaaaaaa'), null);
      assert.equal(db.getServer('bbbbbbbb'), null);
      assert.equal(db.getStats().servers, 0);
    } finally {
      db.close();
    }
  });

  test('deleting one user leaves another user’s data untouched', () => {
    const db = freshDb();

    try {
      seedUser(db, { discordId: OWNER, panelId: 1 });
      seedUser(db, { discordId: STRANGER, panelId: 2 });

      seedServer(db, { discordId: OWNER, identifier: 'aaaaaaaa', panelServerId: 1 });
      seedServer(db, { discordId: STRANGER, identifier: 'bbbbbbbb', panelServerId: 2 });

      db.deleteUserWithServers(OWNER);

      assert.equal(db.getUser(OWNER), null);
      assert.ok(db.getUser(STRANGER), 'the other user must survive');
      assert.ok(db.getServer('bbbbbbbb'), 'the other user’s server must survive');
    } finally {
      db.close();
    }
  });

  test('the foreign key cascade also removes servers on a bare user delete', () => {
    /**
     * deleteUserWithServers deletes servers explicitly, which is redundant given the cascade.
     * This asserts the cascade works independently, so the operation stays correct even if the
     * explicit statement were removed.
     */
    const db = freshDb();

    try {
      seedUser(db);
      seedServer(db);

      assert.equal(db.deleteUser(OWNER), true);
      assert.equal(db.getServer('a1b2c3d4'), null, 'ON DELETE CASCADE should have fired');
    } finally {
      db.close();
    }
  });

  test('deleting an unknown user reports no changes', () => {
    const db = freshDb();

    try {
      const removed = db.deleteUserWithServers(STRANGER);

      assert.equal(removed.user, 0);
      assert.equal(removed.servers, 0);
      assert.equal(db.deleteUser(STRANGER), false);
    } finally {
      db.close();
    }
  });
});

describe('type coercion at the boundary', () => {
  test('Discord ids are handled as strings', () => {
    /**
     * A snowflake exceeds Number.MAX_SAFE_INTEGER. Comparing them as numbers would silently
     * conflate distinct users, so the layer coerces to string on every path.
     */
    const db = freshDb();

    try {
      const large = '999999999999999999';
      seedUser(db, { discordId: large });

      assert.ok(db.getUser(large), 'a string lookup should work');
      assert.equal(typeof db.getUser(large).discord_id, 'string');
    } finally {
      db.close();
    }
  });

  test('numeric panel ids accept string input', () => {
    const db = freshDb();

    try {
      db.createUser({ discordId: OWNER, panelId: '7', email: 'a@b.test', username: 'user7' });

      assert.equal(db.getUser(OWNER).panel_id, 7, 'the value should be stored as an integer');
      assert.ok(db.getUserByPanelId(7));
    } finally {
      db.close();
    }
  });
});

describe('error normalisation', () => {
  test('a constraint violation becomes an AppError, never a raw SqliteError', () => {
    /**
     * No SQL text may reach a caller. Every statement runs inside guard(), which converts a
     * better-sqlite3 error — whose message includes the statement — into a user-safe AppError.
     */
    const db = freshDb();

    try {
      seedUser(db);

      try {
        seedUser(db, { panelId: 2 });
        assert.fail('the duplicate insert should have thrown');
      } catch (err) {
        assert.ok(err instanceof AppError, 'must be an AppError');
        assert.ok(!(err instanceof DatabaseError) || err.code === 'DB_CONFLICT');
        assert.ok(!err.userMessage.includes('INSERT'), 'SQL must not reach the message');
        assert.ok(!err.userMessage.includes('users.'), 'schema detail must not reach the message');
      }
    } finally {
      db.close();
    }
  });
});
