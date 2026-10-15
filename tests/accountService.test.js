import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { AccountService, initAccountService, getAccountService, setAccountServiceForTests, MAX_CREDENTIAL_ATTEMPTS } from '../src/services/accountService.js';
import { createDatabase } from '../src/database/db.js';
import { validateConfig } from '../src/config/config.js';
import { createLockManager } from '../src/utils/locks.js';
import { ServerService } from '../src/services/serverService.js';
import { AppError, NotFoundError, ValidationError } from '../src/utils/errors.js';

const OWNER = '111111111111111111';
const OTHER = '222222222222222222';

const DAY_MS = 86_400_000;

const OLD_ACCOUNT = Object.freeze({ id: OWNER, createdTimestamp: Date.now() - 200 * DAY_MS });

const NEW_ACCOUNT = Object.freeze({ id: OTHER, createdTimestamp: Date.now() - 3 * DAY_MS });

const CONFIG = validateConfig({
  colors: { primary: '#2B2D31', error: '#ED4245' },
  account: { emailDomain: 'panelkit.local', usernameLength: 10, passwordLength: 16 },
  eggs: { nodejs: { eggId: 15, nestId: 5, dockerImage: 'node:20', startup: 'node .' } },
  deploy: { locationId: 1 },
});

const ENV = Object.freeze({
  prefix: 'kx!',
  accountAgeDays: 90,
  freeServerLimit: 1,
  startingCredits: 0,
});

function mockPanel(overrides = {}) {
  const calls = [];
  let nextUserId = 7;

  return {
    calls,

    names: () => calls.map(([name]) => name),

    async createUser(payload) {
      calls.push(['createUser', payload]);
      nextUserId += 1;
      return { id: nextUserId, username: payload.username, email: payload.email };
    },

    async getApplicationUser(id) {
      calls.push(['getApplicationUser', id]);
      return {
        id: Number(id),
        username: 'abcdefghij',
        email: 'abcdefghij@panelkit.local',
        firstName: 'Discord',
        lastName: OWNER,
        admin: false,
        createdAt: '2026-01-01T00:00:00+00:00',
      };
    },

    async updateUserPassword(id, password) {
      calls.push(['updateUserPassword', id, password]);
      return true;
    },

    async deleteUser(id) {
      calls.push(['deleteUser', id]);
      return true;
    },

    async deleteServer(id) {
      calls.push(['deleteServer', id]);
      return true;
    },

    ...overrides,
  };
}

function setup({ panel = mockPanel(), env = ENV, config = CONFIG } = {}) {
  const db = createDatabase(':memory:');
  const locks = createLockManager();

  return { db, panel, locks, service: new AccountService({ db, panel, config, env, locks }) };
}

function seedServer(db, discordId, { identifier = 'a1b2c3d4', panelServerId = 501 } = {}) {
  return db.createServer({
    discordId,
    panelServerId,
    identifier,
    name: 'Test Server',
    eggType: 'nodejs',
  });
}

describe('getAccount and hasAccount', () => {
  test('report the absence of an account', () => {
    const { service, db } = setup();

    try {
      assert.equal(service.getAccount(OWNER), null);
      assert.equal(service.hasAccount(OWNER), false);
    } finally {
      db.close();
    }
  });

  test('report a stored account', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      assert.equal(service.hasAccount(OWNER), true);
      assert.equal(service.getAccount(OWNER).discord_id, OWNER);
    } finally {
      db.close();
    }
  });
});

describe('createAccount: the account age policy', () => {
  test('refuses an account younger than the threshold', async () => {
    const { service, panel, db } = setup();

    try {
      await assert.rejects(
        () => service.createAccount(NEW_ACCOUNT),
        (err) => err instanceof ValidationError && /90 days old/.test(err.message),
      );
    } finally {
      db.close();
    }

    assert.deepEqual(panel.names(), [], 'the panel must not be contacted for an ineligible account');
  });

  test('reports how long the user must wait', () => {

    const { service, db } = setup();

    try {
      return assert
        .rejects(
          () => service.createAccount({ id: OTHER, createdTimestamp: Date.now() - 80 * DAY_MS }),
          (err) => /Try again in 10 days/.test(err.message),
        )
        .finally(() => db.close());
    } catch (err) {
      db.close();
      throw err;
    }
  });

  test('accepts an account at exactly the threshold', async () => {
    const { service, db } = setup();

    try {
      await assert.doesNotReject(() =>
        service.createAccount({ id: OWNER, createdTimestamp: Date.now() - 90 * DAY_MS - 1000 }),
      );
    } finally {
      db.close();
    }
  });

  test('skips the check when the threshold is zero', async () => {

    const { service, db } = setup({ env: { ...ENV, accountAgeDays: 0 } });

    try {
      await assert.doesNotReject(() => service.createAccount({ id: OWNER, createdTimestamp: Date.now() }));
    } finally {
      db.close();
    }
  });

  test('fails closed on an unusable creation timestamp', async () => {

    const { service, panel, db } = setup();

    try {
      for (const createdTimestamp of [undefined, null, NaN, 0]) {
        await assert.rejects(
          () => service.createAccount({ id: OWNER, createdTimestamp }),
          ValidationError,
          `should refuse a timestamp of ${JSON.stringify(createdTimestamp)}`,
        );
      }
    } finally {
      db.close();
    }

    assert.deepEqual(panel.names(), []);
  });
});

describe('createAccount: provisioning', () => {
  test('creates the panel account, then the local record', async () => {

    const { service, panel, db } = setup();

    try {
      const { user, password } = await service.createAccount(OLD_ACCOUNT);

      assert.deepEqual(panel.names(), ['createUser']);
      assert.equal(user.discord_id, OWNER);
      assert.equal(user.panel_id, 8);
      assert.equal(typeof password, 'string');
    } finally {
      db.close();
    }
  });

  test('generates credentials matching the configured shape', async () => {
    const { service, db } = setup();

    try {
      const { user, password } = await service.createAccount(OLD_ACCOUNT);

      assert.match(user.username, /^[a-z][a-z0-9]{9}$/, 'ten characters, starting with a letter');
      assert.equal(user.email, `${user.username}@panelkit.local`);
      assert.equal(password.length, 16);
    } finally {
      db.close();
    }
  });

  test('links the Discord id into the panel record', async () => {

    const { service, panel, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      const [, payload] = panel.calls.find(([name]) => name === 'createUser');

      assert.equal(payload.lastName, OWNER);
      assert.equal(payload.firstName, 'Discord');
    } finally {
      db.close();
    }
  });

  test('applies the configured starting credits', async () => {
    const { service, db } = setup({ env: { ...ENV, startingCredits: 50 } });

    try {
      const { user } = await service.createAccount(OLD_ACCOUNT);

      assert.equal(user.credits, 50);
      assert.equal(db.getCredits(OWNER), 50);
    } finally {
      db.close();
    }
  });

  test('never stores the generated password', async () => {

    const { service, db } = setup();

    try {
      const { password } = await service.createAccount(OLD_ACCOUNT);
      const stored = JSON.stringify(db.getUser(OWNER));

      assert.ok(!stored.includes(password), 'the password must not appear in the stored row');
    } finally {
      db.close();
    }
  });

  test('refuses a duplicate account', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      await assert.rejects(
        () => service.createAccount(OLD_ACCOUNT),
        (err) => err instanceof ValidationError && /already have a panel account/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('names the recovery command when refusing a duplicate', () => {

    const { service, db } = setup();

    return service
      .createAccount(OLD_ACCOUNT)
      .then(() =>
        assert.rejects(
          () => service.createAccount(OLD_ACCOUNT),
          (err) => /kx!account reset/.test(err.message),
        ),
      )
      .finally(() => db.close());
  });
});

describe('createAccount: credential collisions', () => {
  test('retries when the panel reports a taken username', async () => {

    let attempts = 0;

    const panel = mockPanel({
      async createUser(payload) {
        attempts += 1;

        if (attempts === 1) {
          throw new AppError('rejected', {
            code: 'PANEL_HTTP_422',
            status: 422,
            details: { panelDetail: 'The username has already been taken.' },
          });
        }

        return { id: 9, username: payload.username, email: payload.email };
      },
    });

    const { service, db } = setup({ panel });

    try {
      const { user } = await service.createAccount(OLD_ACCOUNT);

      assert.equal(attempts, 2, 'the collision should have been retried');
      assert.equal(user.panel_id, 9);
    } finally {
      db.close();
    }
  });

  test('retries when the panel reports a taken email', async () => {
    let attempts = 0;

    const panel = mockPanel({
      async createUser(payload) {
        attempts += 1;

        if (attempts === 1) {
          throw new AppError('rejected', {
            code: 'PANEL_HTTP_422',
            status: 422,
            details: { panelDetail: 'The email must be unique.' },
          });
        }

        return { id: 9, username: payload.username, email: payload.email };
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.doesNotReject(() => service.createAccount(OLD_ACCOUNT));
      assert.equal(attempts, 2);
    } finally {
      db.close();
    }
  });

  test('does not retry an unrelated validation error', async () => {

    let attempts = 0;

    const panel = mockPanel({
      async createUser() {
        attempts += 1;
        throw new AppError('rejected', {
          code: 'PANEL_HTTP_422',
          status: 422,
          details: { panelDetail: 'The first name field is required.' },
        });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(() => service.createAccount(OLD_ACCOUNT), (err) => err.status === 422);
      assert.equal(attempts, 1, 'an unrelated 422 must fail immediately');
    } finally {
      db.close();
    }
  });

  test('does not retry a non-422 failure', async () => {
    let attempts = 0;

    const panel = mockPanel({
      async createUser() {
        attempts += 1;
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ECONNREFUSED' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(() => service.createAccount(OLD_ACCOUNT));
      assert.equal(attempts, 1);
    } finally {
      db.close();
    }
  });

  test('gives up after the attempt limit', async () => {
    const panel = mockPanel({
      async createUser() {
        throw new AppError('rejected', {
          code: 'PANEL_HTTP_422',
          status: 422,
          details: { panelDetail: 'The username has already been taken.' },
        });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(
        () => service.createAccount(OLD_ACCOUNT),
        (err) => err instanceof AppError && err.code === 'ACCOUNT_COLLISION_EXHAUSTED',
      );
    } finally {
      db.close();
    }
  });

  test('the attempt limit is a real bound', () => {
    assert.ok(MAX_CREDENTIAL_ATTEMPTS > 1);
    assert.ok(MAX_CREDENTIAL_ATTEMPTS <= 10);
  });
});

describe('createAccount: rollback', () => {
  test('deletes the panel account when the local write fails', async () => {

    const { service, panel, db } = setup();

    try {
      db.createUser = () => {
        throw new AppError('That record already exists.', { code: 'DB_CONFLICT' });
      };

      await assert.rejects(() => service.createAccount(OLD_ACCOUNT), (err) => err.code === 'DB_CONFLICT');

      assert.deepEqual(panel.names(), ['createUser', 'deleteUser'], 'the panel account must be rolled back');
    } finally {
      db.close();
    }
  });

  test('rolls back the account that was just created', async () => {
    const { service, panel, db } = setup();

    try {
      db.createUser = () => {
        throw new AppError('boom', { code: 'DB_ERROR' });
      };

      await assert.rejects(() => service.createAccount(OLD_ACCOUNT));

      const [, deletedId] = panel.calls.find(([name]) => name === 'deleteUser');
      const [, created] = panel.calls.find(([name]) => name === 'createUser');

      assert.equal(deletedId, 8, 'the rolled-back id must be the one just created');
      assert.ok(created, 'and the create must have happened first');
    } finally {
      db.close();
    }
  });

  test('propagates the original failure rather than a rollback error', async () => {

    const { service, db } = setup();

    try {
      db.createUser = () => {
        throw new AppError('database is locked', { code: 'DB_ERROR' });
      };

      await assert.rejects(
        () => service.createAccount(OLD_ACCOUNT),
        (err) => err.code === 'DB_ERROR' && /database is locked/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('still surfaces the original failure when the rollback also fails', async () => {

    const panel = mockPanel({
      async deleteUser(id) {

        this.calls.push(['deleteUser', id]);
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      db.createUser = () => {
        throw new AppError('boom', { code: 'DB_ERROR' });
      };

      await assert.rejects(() => service.createAccount(OLD_ACCOUNT), (err) => err.code === 'DB_ERROR');

      assert.deepEqual(panel.names(), ['createUser', 'deleteUser'], 'the rollback must have been attempted');
    } finally {
      db.close();
    }
  });

  test('leaves no local record after a rollback', async () => {
    const { service, db } = setup();

    try {
      const realCreate = db.createUser.bind(db);
      let attempted = false;

      db.createUser = (payload) => {
        attempted = true;
        throw new AppError('boom', { code: 'DB_ERROR' });
      };

      await assert.rejects(() => service.createAccount(OLD_ACCOUNT));

      db.createUser = realCreate;

      assert.equal(attempted, true);
      assert.equal(db.getUser(OWNER), null, 'no partial row should remain');
    } finally {
      db.close();
    }
  });
});

describe('createAccount: concurrency', () => {
  test('two concurrent creations produce one account', async () => {

    const { service, panel, db } = setup();

    try {
      const results = await Promise.allSettled([
        service.createAccount(OLD_ACCOUNT),
        service.createAccount(OLD_ACCOUNT),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');
      const rejected = results.filter((result) => result.status === 'rejected');

      assert.equal(fulfilled.length, 1, 'exactly one creation should succeed');
      assert.equal(rejected.length, 1);
      assert.ok(rejected[0].reason instanceof ValidationError, 'the loser should be refused as a duplicate');

      assert.equal(
        panel.names().filter((name) => name === 'createUser').length,
        1,
        'only one panel account should have been created',
      );
    } finally {
      db.close();
    }
  });

  test('different users are not serialised against each other', async () => {

    const { service, db } = setup();

    try {
      const results = await Promise.all([
        service.createAccount(OLD_ACCOUNT),
        service.createAccount({ id: OTHER, createdTimestamp: Date.now() - 200 * DAY_MS }),
      ]);

      assert.equal(results.length, 2);
      assert.notEqual(results[0].user.panel_id, results[1].user.panel_id);
    } finally {
      db.close();
    }
  });
});

describe('createAccountForAdmin', () => {
  test('skips the account age policy', async () => {

    const { service, db } = setup();

    try {
      const { user } = await service.createAccountForAdmin(NEW_ACCOUNT);

      assert.equal(user.discord_id, OTHER);
    } finally {
      db.close();
    }
  });

  test('still refuses a duplicate', async () => {

    const { service, db } = setup();

    try {
      await service.createAccountForAdmin(NEW_ACCOUNT);

      await assert.rejects(
        () => service.createAccountForAdmin(NEW_ACCOUNT),
        (err) => err instanceof ValidationError && /already has a panel account/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('still rolls back on a failed local write', async () => {
    const { service, panel, db } = setup();

    try {
      db.createUser = () => {
        throw new AppError('boom', { code: 'DB_ERROR' });
      };

      await assert.rejects(() => service.createAccountForAdmin(NEW_ACCOUNT));

      assert.deepEqual(panel.names(), ['createUser', 'deleteUser']);
    } finally {
      db.close();
    }
  });
});

describe('getAccountInfo', () => {
  test('reports the stored account with its panel state', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);
      seedServer(db, OWNER);

      const info = await service.getAccountInfo(OWNER);

      assert.equal(info.discordId, OWNER);
      assert.equal(info.panelId, 8);
      assert.equal(info.credits, 0);
      assert.equal(info.serverCount, 1);
      assert.equal(info.serverLimit, 1);
      assert.equal(info.panelReachable, true);
      assert.equal(info.panelAdmin, false);
      assert.ok(info.createdAt, 'the creation date should be reported');
    } finally {
      db.close();
    }
  });

  test('refuses when no account exists, naming the command to run', async () => {
    const { service, db } = setup();

    try {
      await assert.rejects(
        () => service.getAccountInfo(OWNER),
        (err) => err instanceof NotFoundError && /kx!account create/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('survives a panel outage, reporting it', async () => {

    const panel = mockPanel({
      async getApplicationUser() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccount(OLD_ACCOUNT);

      const info = await service.getAccountInfo(OWNER);

      assert.equal(info.panelReachable, false);
      assert.equal(info.username.length, 10, 'the local data is still returned');
      assert.equal(info.panelAdmin, false);
    } finally {
      db.close();
    }
  });

  test('reports panel administrator status when the panel says so', async () => {
    const panel = mockPanel({
      async getApplicationUser(id) {
        return {
          id: Number(id),
          username: 'admin',
          email: 'admin@panelkit.local',
          firstName: 'Discord',
          lastName: OWNER,
          admin: true,
          createdAt: '2026-01-01T00:00:00+00:00',
        };
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccount(OLD_ACCOUNT);

      assert.equal((await service.getAccountInfo(OWNER)).panelAdmin, true);
    } finally {
      db.close();
    }
  });

  test('never includes a password', async () => {

    const { service, db } = setup();

    try {
      const { password } = await service.createAccount(OLD_ACCOUNT);
      const info = await service.getAccountInfo(OWNER);

      assert.ok(!JSON.stringify(info).includes(password));
      assert.ok(!('password' in info));
    } finally {
      db.close();
    }
  });
});

describe('resetPassword', () => {
  test('changes the password on the panel and returns the new one once', async () => {
    const { service, panel, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      const { user, password } = await service.resetPassword(OWNER);

      assert.equal(user.discord_id, OWNER);
      assert.equal(password.length, 16);

      const [, id, sent] = panel.calls.find(([name]) => name === 'updateUserPassword');

      assert.equal(id, 8);
      assert.equal(sent, password, 'the panel must receive the password that was returned');
    } finally {
      db.close();
    }
  });

  test('generates a different password each time', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      const first = await service.resetPassword(OWNER);
      const second = await service.resetPassword(OWNER);

      assert.notEqual(first.password, second.password);
    } finally {
      db.close();
    }
  });

  test('refuses when no account exists', async () => {
    const { service, panel, db } = setup();

    try {
      await assert.rejects(() => service.resetPassword(OWNER), NotFoundError);
      assert.deepEqual(panel.names(), [], 'the panel must not be contacted');
    } finally {
      db.close();
    }
  });

  test('propagates a panel failure without altering local state', async () => {

    const panel = mockPanel({
      async updateUserPassword() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      const before = db.getUser(OWNER);

      await assert.rejects(() => service.resetPassword(OWNER));

      assert.deepEqual(db.getUser(OWNER), before, 'the local record must be untouched');
    } finally {
      db.close();
    }
  });

  test('never stores the new password', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);
      const { password } = await service.resetPassword(OWNER);

      assert.ok(!JSON.stringify(db.getUser(OWNER)).includes(password));
    } finally {
      db.close();
    }
  });
});

describe('account and server lifecycle', () => {
  test('deletion waits for in-flight provisioning and removes the new server', async () => {
    let release;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const panel = mockPanel({
      async getEgg() { return { variables: [], startup: 'node .' }; },
      async createServer() {
        entered();
        await gate;
        return { id: 501, identifier: 'a1b2c3d4' };
      },
    });
    const { service, db, locks } = setup({ panel });
    const servers = new ServerService({ db, panel, locks, config: CONFIG, env: ENV });
    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      const creation = servers.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Test Server' });
      await ready;
      const deletion = service.deleteAccount(OWNER);
      release();
      await creation;
      const result = await deletion;
      assert.equal(result.deletedServers, 1);
      assert.ok(panel.calls.some(([name, id]) => name === 'deleteServer' && id === 501));
      assert.equal(db.getUser(OWNER), null);
      assert.equal(db.countServers(), 0);
      assert.equal(locks.size(), 0);
    } finally {
      release();
      db.close();
    }
  });

  test('provisioning after deletion begins cannot use a deleted account', async () => {
    let release;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    const panel = mockPanel({ async deleteUser() { entered(); await gate; return true; } });
    const { service, db, locks } = setup({ panel });
    const servers = new ServerService({ db, panel, locks, config: CONFIG, env: ENV });
    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      const deletion = service.deleteAccount(OWNER);
      await ready;
      const denied = assert.rejects(
        () => servers.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Test Server' }),
        NotFoundError,
      );
      release();
      await Promise.all([deletion, denied]);
      assert.equal(db.getUser(OWNER), null);
      assert.ok(!panel.names().includes('createServer'));
    } finally {
      release();
      db.close();
    }
  });

  test('a stale confirmation cannot delete a replacement account', async () => {
    const { service, db, panel } = setup();
    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      const id = db.getUser(OWNER).panel_id;
      await assert.rejects(() => service.deleteAccount(OWNER, { expectedPanelId: id + 1 }), ValidationError);
      assert.equal(db.getUser(OWNER).panel_id, id);
      assert.ok(!panel.names().includes('deleteUser'));
    } finally {
      db.close();
    }
  });

  test('partial deletion reports irreversible progress instead of claiming no changes', async () => {
    const panel = mockPanel({ async deleteServer(id) {
      if (id === 502) throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      return true;
    } });
    const { service, db } = setup({ panel });
    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER);
      seedServer(db, OWNER, { identifier: 'bbbbbbbb', panelServerId: 502 });
      await assert.rejects(() => service.deleteAccount(OWNER), (err) => {
        assert.match(err.userMessage, /1 server\(s\) were removed/);
        assert.doesNotMatch(err.userMessage, /Nothing has been changed/);
        return err.code === 'ACCOUNT_DELETE_PARTIAL';
      });
      assert.equal(db.countUserServers(OWNER), 2);
      assert.ok(db.getUser(OWNER));
    } finally {
      db.close();
    }
  });
});

describe('deleteAccount: the successful path', () => {
  test('removes servers, then the panel account, then the local rows', async () => {

    const { service, panel, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);
      seedServer(db, OWNER, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, OWNER, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.deleteAccount(OWNER);

      assert.deepEqual(panel.names(), ['createUser', 'deleteServer', 'deleteServer', 'deleteUser']);
      assert.equal(result.deletedServers, 2);
      assert.equal(result.alreadyGone, 0);

      assert.equal(db.getUser(OWNER), null);
      assert.equal(db.getServer('aaaaaaaa'), null);
      assert.equal(db.getServer('bbbbbbbb'), null);
    } finally {
      db.close();
    }
  });

  test('deletes an account with no servers', async () => {
    const { service, panel, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      const result = await service.deleteAccount(OWNER);

      assert.equal(result.deletedServers, 0);
      assert.deepEqual(panel.names(), ['createUser', 'deleteUser']);
    } finally {
      db.close();
    }
  });

  test('refuses when no account exists', async () => {
    const { service, panel, db } = setup();

    try {
      await assert.rejects(() => service.deleteAccount(OWNER), NotFoundError);
      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('leaves another user’s data untouched', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);
      await service.createAccount({ id: OTHER, createdTimestamp: Date.now() - 200 * DAY_MS });

      seedServer(db, OTHER, { identifier: 'bbbbbbbb', panelServerId: 502 });

      await service.deleteAccount(OWNER);

      assert.ok(db.getUser(OTHER), 'the other account must survive');
      assert.ok(db.getServer('bbbbbbbb'), 'the other server must survive');
    } finally {
      db.close();
    }
  });
});

describe('deleteAccount: partial failure', () => {
  test('aborts with nothing changed when a server cannot be deleted', async () => {

    const panel = mockPanel({
      async deleteServer(id) {
        this.calls.push(['deleteServer', id]);
        throw new AppError('The panel is unreachable.', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER);

      await assert.rejects(
        () => service.deleteAccount(OWNER),
        (err) => err instanceof AppError && err.code === 'ACCOUNT_DELETE_PARTIAL',
      );

      assert.ok(db.getUser(OWNER), 'the account must still exist');
      assert.ok(db.getServer('a1b2c3d4'), 'the server record must still exist');
      assert.ok(!panel.names().includes('deleteUser'), 'the panel account must not have been deleted');
    } finally {
      db.close();
    }
  });

  test('accurately reports retained records when no server could be removed', async () => {
    const panel = mockPanel({
      async deleteServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER);

      await assert.rejects(
        () => service.deleteAccount(OWNER),
        (err) => /0 server\(s\).*local records were kept/.test(err.userMessage),
      );
    } finally {
      db.close();
    }
  });

  test('names the servers that failed, in the diagnostic detail', async () => {
    const panel = mockPanel({
      async deleteServer(id) {
        if (id === 502) throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
        return true;
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, OWNER, { identifier: 'bbbbbbbb', panelServerId: 502 });

      let caught;
      try {
        await service.deleteAccount(OWNER);
      } catch (err) {
        caught = err;
      }

      assert.deepEqual(caught.details.failed, ['bbbbbbbb']);
      assert.ok(!caught.userMessage.includes('bbbbbbbb'), 'identifiers stay in the diagnostic detail');
    } finally {
      db.close();
    }
  });

  test('reports the count of failures to the user', async () => {
    const panel = mockPanel({
      async deleteServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, OWNER, { identifier: 'bbbbbbbb', panelServerId: 502 });

      await assert.rejects(
        () => service.deleteAccount(OWNER),
        (err) => /2 servers could not be removed/.test(err.userMessage),
      );
    } finally {
      db.close();
    }
  });
});

describe('deleteAccount: already-absent resources', () => {
  test('treats a 404 on a server as already deleted', async () => {

    const panel = mockPanel({
      async deleteServer() {
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER);

      const result = await service.deleteAccount(OWNER);

      assert.equal(result.alreadyGone, 1);
      assert.equal(result.deletedServers, 1, 'it still counts toward the total removed');
      assert.equal(db.getUser(OWNER), null, 'the deletion should have completed');
    } finally {
      db.close();
    }
  });

  test('treats a 404 on the panel account as already deleted', async () => {
    const panel = mockPanel({
      async deleteUser() {
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);

      await assert.doesNotReject(() => service.deleteAccount(OWNER));

      assert.equal(db.getUser(OWNER), null, 'the local rows must still be cleaned up');
    } finally {
      db.close();
    }
  });

  test('distinguishes a mix of deleted and already-absent servers', async () => {
    const panel = mockPanel({
      async deleteServer(id) {
        if (id === 502) throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
        return true;
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, OWNER, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.deleteAccount(OWNER);

      assert.equal(result.alreadyGone, 1);
      assert.equal(result.deletedServers, 2);
    } finally {
      db.close();
    }
  });
});

describe('deleteAccount: the account step fails', () => {
  test('keeps the local rows when the panel account cannot be deleted', async () => {

    const panel = mockPanel({
      async deleteUser(id) {

        this.calls.push(['deleteUser', id]);
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER);

      await assert.rejects(
        () => service.deleteAccount(OWNER),
        (err) => err instanceof AppError && err.code === 'ACCOUNT_DELETE_USER_FAILED',
      );

      assert.ok(db.getUser(OWNER), 'the mapping must survive so the user can retry');
    } finally {
      db.close();
    }
  });

  test('tells the user their servers were removed', async () => {

    const panel = mockPanel({
      async deleteUser(id) {

        this.calls.push(['deleteUser', id]);
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createAccountForAdmin(OLD_ACCOUNT);
      seedServer(db, OWNER);

      await assert.rejects(
        () => service.deleteAccount(OWNER),

        (err) => /servers were removed/.test(err.userMessage) && /again/i.test(err.userMessage),
      );
    } finally {
      db.close();
    }
  });
});

describe('deleteAccount: concurrency', () => {
  test('two concurrent deletions produce one deletion', async () => {

    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);
      seedServer(db, OWNER);

      const results = await Promise.allSettled([service.deleteAccount(OWNER), service.deleteAccount(OWNER)]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');

      assert.equal(fulfilled.length, 1, 'exactly one deletion should succeed');
      assert.ok(
        results.some((result) => result.status === 'rejected' && result.reason instanceof NotFoundError),
        'the loser should find no account',
      );
      assert.equal(db.getUser(OWNER), null);
    } finally {
      db.close();
    }
  });

  test('a creation cannot interleave with a deletion', async () => {

    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      const [deletion, creation] = await Promise.allSettled([
        service.deleteAccount(OWNER),
        service.createAccount(OLD_ACCOUNT),
      ]);

      assert.equal(deletion.status, 'fulfilled');
      assert.equal(creation.status, 'fulfilled', 'the account is recreated after deletion completes');
      assert.ok(db.getUser(OWNER), 'and the recreated account exists');
    } finally {
      db.close();
    }
  });
});

describe('credits', () => {
  test('fractional and unsafe amounts cannot alter a balance', async () => {
    const { service, db } = setup({ env: { ...ENV, startingCredits: 100 } });
    try {
      await service.createAccount(OLD_ACCOUNT);
      for (const amount of [1.9, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => service.grantCredits(OWNER, amount), ValidationError);
        assert.throws(() => service.spendCredits(OWNER, amount), ValidationError);
        assert.equal(db.getCredits(OWNER), 100);
      }
      assert.throws(() => service.grantCredits(OWNER, Number.MAX_SAFE_INTEGER), ValidationError);
      assert.equal(db.getCredits(OWNER), 100);
    } finally {
      db.close();
    }
  });

  test('reads a balance', async () => {
    const { service, db } = setup({ env: { ...ENV, startingCredits: 25 } });

    try {
      await service.createAccount(OLD_ACCOUNT);

      assert.equal(service.getCredits(OWNER), 25);
    } finally {
      db.close();
    }
  });

  test('refuses to read a balance for an account that does not exist', async () => {

    const { service, db } = setup();

    try {
      assert.throws(
        () => service.getCredits(OWNER),
        (err) => err instanceof NotFoundError && /kx!account create/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('grants credits and returns the new balance', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      assert.equal(service.grantCredits(OWNER, 100), 100);
      assert.equal(service.grantCredits(OWNER, 50), 150);
    } finally {
      db.close();
    }
  });

  test('refuses a non-positive grant', async () => {
    const { service, db } = setup();

    try {
      await service.createAccount(OLD_ACCOUNT);

      for (const amount of [0, -10, NaN, 'many']) {
        assert.throws(
          () => service.grantCredits(OWNER, amount),
          ValidationError,
          `should refuse a grant of ${JSON.stringify(amount)}`,
        );
      }
    } finally {
      db.close();
    }
  });

  test('refuses to grant to an account that does not exist', async () => {
    const { service, db } = setup();

    try {
      assert.throws(() => service.grantCredits(OWNER, 10), NotFoundError);
    } finally {
      db.close();
    }
  });

  test('spends credits when the balance covers the cost', async () => {
    const { service, db } = setup({ env: { ...ENV, startingCredits: 100 } });

    try {
      await service.createAccount(OLD_ACCOUNT);

      assert.equal(service.spendCredits(OWNER, 30), 70);
      assert.equal(service.spendCredits(OWNER, 70), 0, 'spending the exact balance should succeed');
    } finally {
      db.close();
    }
  });

  test('refuses an overdraft and reports both figures', async () => {

    const { service, db } = setup({ env: { ...ENV, startingCredits: 5 } });

    try {
      await service.createAccount(OLD_ACCOUNT);

      assert.throws(
        () => service.spendCredits(OWNER, 10),
        (err) => err instanceof ValidationError && /costs 10/.test(err.message) && /balance is 5/.test(err.message),
      );

      assert.equal(service.getCredits(OWNER), 5, 'a refused spend must not alter the balance');
    } finally {
      db.close();
    }
  });

  test('refuses a non-positive spend', async () => {
    const { service, db } = setup({ env: { ...ENV, startingCredits: 100 } });

    try {
      await service.createAccount(OLD_ACCOUNT);

      for (const amount of [0, -10, NaN]) {
        assert.throws(() => service.spendCredits(OWNER, amount), ValidationError);
      }
    } finally {
      db.close();
    }
  });

  test('refuses to spend from an account that does not exist', async () => {
    const { service, db } = setup();

    try {
      assert.throws(() => service.spendCredits(OWNER, 10), NotFoundError);
    } finally {
      db.close();
    }
  });
});

describe('the shared instance', () => {
  test('initAccountService installs a service that getAccountService returns', () => {
    const db = createDatabase(':memory:');

    try {
      const created = initAccountService({ db, panel: mockPanel(), config: CONFIG, env: ENV });

      assert.equal(getAccountService(), created);
    } finally {
      setAccountServiceForTests(null);
      db.close();
    }
  });

  test('getAccountService refuses before initialisation', () => {

    setAccountServiceForTests(null);

    assert.throws(
      () => getAccountService(),
      (err) => err instanceof AppError && err.code === 'SERVICE_NOT_READY',
    );
  });
});
