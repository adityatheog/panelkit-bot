import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  AdminService,
  ALREADY_IN_STATE,
  getAdminService,
  initAdminService,
  MAX_BULK_SERVERS,
  setAdminServiceForTests,
} from '../src/services/adminService.js';
import { AccountService } from '../src/services/accountService.js';
import { ServerService } from '../src/services/serverService.js';
import { createDatabase } from '../src/database/db.js';
import { validateConfig } from '../src/config/config.js';
import { createLockManager } from '../src/utils/locks.js';
import { AppError, NotFoundError, ValidationError } from '../src/utils/errors.js';

const ACTOR = '999999999999999999';
const TARGET = '111111111111111111';
const OTHER = '222222222222222222';

const DAY_MS = 86_400_000;

const NEW_TARGET = Object.freeze({ id: TARGET, createdTimestamp: Date.now() - 2 * DAY_MS });

const CONFIG = validateConfig({
  colors: { primary: '#2B2D31', error: '#ED4245' },
  account: { emailDomain: 'panelkit.local', usernameLength: 10, passwordLength: 16 },
  eggs: {
    nodejs: {
      label: 'Node.js',
      eggId: 15,
      nestId: 5,
      dockerImage: 'ghcr.io/example/node:20',
      startup: 'node index.js',
    },
  },
  deploy: { locationId: 3 },
  defaults: {
    limits: { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 },
    featureLimits: { databases: 1, allocations: 1, backups: 1 },
  },
});

const ENV = Object.freeze({
  prefix: 'kx!',
  panelUrl: 'https://panel.example.test',
  accountAgeDays: 90,
  freeServerLimit: 1,
  startingCredits: 0,
});

function mockPanel(overrides = {}) {
  const calls = [];
  let nextUserId = 7;
  let nextServerId = 500;

  return {
    calls,

    names: () => calls.map(([name]) => name),

    countOf: (name) => calls.filter(([called]) => called === name).length,

    called: (name) => calls.some(([called]) => called === name),

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
        lastName: TARGET,
        admin: false,
        createdAt: '2026-01-01T00:00:00+00:00',
      };
    },

    async deleteUser(id) {
      calls.push(['deleteUser', id]);
      return true;
    },

    async getEgg(nestId, eggId) {
      calls.push(['getEgg', nestId, eggId]);
      return {
        id: Number(eggId),
        name: 'Node.js',
        dockerImage: 'ghcr.io/example/node:20',
        dockerImages: {},
        startup: 'node index.js',
        variables: [],
      };
    },

    async createServer(payload) {
      calls.push(['createServer', payload]);
      nextServerId += 1;
      return {
        id: nextServerId,
        identifier: `a1b2c3${String(nextServerId).slice(-2)}`,
        uuid: 'uuid-value',
        name: payload.name,
      };
    },

    async getApplicationServer(id) {
      calls.push(['getApplicationServer', id]);
      return {
        id: Number(id),
        identifier: 'a1b2c3d4',
        uuid: 'uuid-value',
        name: 'Test Server',
        description: '',
        eggId: 15,
        nodeId: 1,
        userId: 7,
        suspended: false,
        limits: {},
        featureLimits: {},
        container: { startupCommand: 'node .', image: 'node:20', installed: true, environment: {} },
      };
    },

    async deleteServer(id) {
      calls.push(['deleteServer', id]);
      return true;
    },

    async listAllServers({ page = 1, perPage = 15 } = {}) {
      calls.push(['listAllServers', page, perPage]);
      return {
        servers: [
          { id: 501, identifier: 'a1b2c3d4', name: 'Tracked', ownerId: 7, nodeId: 1, suspended: false },
          { id: 502, identifier: 'zzzzzzzz', name: 'By Hand', ownerId: 99, nodeId: 1, suspended: true },
        ],
        pagination: { total: 2, count: 2, perPage, currentPage: page, totalPages: 1 },
      };
    },

    async listServersForUser(panelUserId) {
      calls.push(['listServersForUser', panelUserId]);
      return [{ id: 501, identifier: 'a1b2c3d4', name: 'Tracked', suspended: false }];
    },

    async suspendServer(id) {
      calls.push(['suspendServer', id]);
      return true;
    },

    async unsuspendServer(id) {
      calls.push(['unsuspendServer', id]);
      return true;
    },

    ...overrides,
  };
}

function setup({ panel = mockPanel(), env = ENV, config = CONFIG } = {}) {
  const db = createDatabase(':memory:');
  const locks = createLockManager();

  const accountService = new AccountService({ db, panel, config, env, locks });
  const serverService = new ServerService({ db, panel, config, env, locks });

  const service = new AdminService({ db, panel, config, env, accountService, serverService });

  return { db, panel, service, accountService, serverService };
}

function seedUser(db, { discordId = TARGET, panelId = 7, credits = 0 } = {}) {
  return db.createUser({
    discordId,
    panelId,
    email: `user${panelId}@panelkit.local`,
    username: `user${panelId}`,
    credits,
  });
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

describe('listAllServers', () => {
  test('reads the panel rather than the local database', async () => {

    const { service, panel, db } = setup();

    try {
      const result = await service.listAllServers({ page: 1 });

      assert.equal(result.servers.length, 2);
      assert.ok(panel.called('listAllServers'));
    } finally {
      db.close();
    }
  });

  test('attributes a server to its Discord owner where the bot has a mapping', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      const result = await service.listAllServers({ page: 1 });
      const tracked = result.servers.find((server) => server.identifier === 'a1b2c3d4');

      assert.equal(tracked.discordId, TARGET);
      assert.equal(tracked.panelUsername, 'user7');
      assert.equal(tracked.managedByBot, true);
    } finally {
      db.close();
    }
  });

  test('marks a server the bot has no record of', async () => {

    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      const result = await service.listAllServers({ page: 1 });
      const untracked = result.servers.find((server) => server.identifier === 'zzzzzzzz');

      assert.equal(untracked.managedByBot, false);
      assert.equal(untracked.discordId, null);
      assert.equal(untracked.panelUsername, null);
    } finally {
      db.close();
    }
  });

  test('passes pagination through to the panel', async () => {
    const { service, panel, db } = setup();

    try {
      await service.listAllServers({ page: 3, perPage: 25 });

      const [, page, perPage] = panel.calls.find(([name]) => name === 'listAllServers');

      assert.equal(page, 3);
      assert.equal(perPage, 25);
    } finally {
      db.close();
    }
  });

  test('returns the panel pagination metadata unchanged', async () => {

    const { service, db } = setup();

    try {
      const result = await service.listAllServers({ page: 2, perPage: 15 });

      assert.equal(result.pagination.currentPage, 2);
      assert.equal(result.pagination.perPage, 15);
      assert.equal(result.pagination.total, 2);
    } finally {
      db.close();
    }
  });

  test('propagates a panel failure rather than reporting an empty panel', async () => {

    const panel = mockPanel({
      async listAllServers() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(() => service.listAllServers({ page: 1 }), AppError);
    } finally {
      db.close();
    }
  });
});

describe('lookupUser', () => {
  test('reports the local record with panel confirmation', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7, credits: 40 });
      seedServer(db, TARGET);

      const info = await service.lookupUser(TARGET);

      assert.equal(info.discordId, TARGET);
      assert.equal(info.panelId, 7);
      assert.equal(info.credits, 40);
      assert.equal(info.panelReachable, true);
      assert.equal(info.panelAdmin, false);
      assert.equal(info.servers.length, 1);
      assert.equal(info.serverLimit, 1);
      assert.ok(info.createdAt, 'the registration date should be reported');
    } finally {
      db.close();
    }
  });

  test('refuses a user the bot has no record of', async () => {
    const { service, panel, db } = setup();

    try {
      await assert.rejects(
        () => service.lookupUser(TARGET),
        (err) => err instanceof NotFoundError && /no panel account recorded/.test(err.message),
      );

      assert.deepEqual(panel.names(), [], 'the panel must not be contacted for an unknown user');
    } finally {
      db.close();
    }
  });

  test('refuses a malformed Discord id', async () => {
    const { service, db } = setup();

    try {
      for (const bad of ['', 'not-a-snowflake', '123', null]) {
        await assert.rejects(
          () => service.lookupUser(bad),
          ValidationError,
          `should refuse ${JSON.stringify(bad)}`,
        );
      }
    } finally {
      db.close();
    }
  });

  test('reports servers the panel knows about that the bot does not', async () => {

    const panel = mockPanel({
      async listServersForUser(panelUserId) {
        this.calls.push(['listServersForUser', panelUserId]);
        return [
          { id: 501, identifier: 'a1b2c3d4', name: 'Tracked', suspended: false },
          { id: 502, identifier: 'orphaned', name: 'Orphan', suspended: false },
        ];
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'a1b2c3d4', panelServerId: 501 });

      const info = await service.lookupUser(TARGET);

      assert.equal(info.untrackedServers.length, 1);
      assert.equal(info.untrackedServers[0].identifier, 'orphaned');
    } finally {
      db.close();
    }
  });

  test('reports no discrepancy when the two agree', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'a1b2c3d4', panelServerId: 501 });

      const info = await service.lookupUser(TARGET);

      assert.deepEqual(info.untrackedServers, []);
    } finally {
      db.close();
    }
  });

  test('survives a panel outage, reporting it and skipping reconciliation', async () => {

    const panel = mockPanel({
      async getApplicationUser() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET);

      const info = await service.lookupUser(TARGET);

      assert.equal(info.panelReachable, false);
      assert.equal(info.servers.length, 1, 'the local data is still returned');
      assert.deepEqual(info.untrackedServers, [], 'reconciliation is skipped rather than guessed');
      assert.ok(!panel.called('listServersForUser'), 'no cross-check against an unreachable panel');
    } finally {
      db.close();
    }
  });

  test('survives a failed server cross-check without failing the lookup', async () => {

    const panel = mockPanel({
      async listServersForUser() {
        throw new AppError('forbidden', { code: 'PANEL_HTTP_403', status: 403 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      const info = await service.lookupUser(TARGET);

      assert.equal(info.panelReachable, true);
      assert.deepEqual(info.untrackedServers, []);
    } finally {
      db.close();
    }
  });

  test('reports panel administrator status', async () => {

    const panel = mockPanel({
      async getApplicationUser(id) {
        this.calls.push(['getApplicationUser', id]);
        return {
          id: Number(id),
          username: 'admin',
          email: 'admin@panelkit.local',
          firstName: 'Discord',
          lastName: TARGET,
          admin: true,
          createdAt: '2026-01-01T00:00:00+00:00',
        };
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      assert.equal((await service.lookupUser(TARGET)).panelAdmin, true);
    } finally {
      db.close();
    }
  });

  test('never includes a password', async () => {

    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      const info = await service.lookupUser(TARGET);

      assert.ok(!('password' in info));
      assert.ok(!JSON.stringify(info).toLowerCase().includes('password'));
    } finally {
      db.close();
    }
  });
});

describe('getStatistics', () => {
  test('combines local counts with the panel total', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET);

      const stats = await service.getStatistics();

      assert.equal(stats.local.users, 1);
      assert.equal(stats.local.servers, 1);
      assert.equal(stats.panel.total, 2);
      assert.equal(stats.panel.reachable, true);
    } finally {
      db.close();
    }
  });

  test('reports the panel as unreachable rather than failing', async () => {

    const panel = mockPanel({
      async listAllServers() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      const stats = await service.getStatistics();

      assert.equal(stats.panel.reachable, false);
      assert.equal(stats.panel.total, null);
      assert.equal(stats.local.users, 0);
    } finally {
      db.close();
    }
  });

  test('requests a single record, to keep the probe cheap', async () => {
    const { service, panel, db } = setup();

    try {
      await service.getStatistics();

      const [, , perPage] = panel.calls.find(([name]) => name === 'listAllServers');

      assert.equal(perPage, 1, 'the total comes from pagination metadata, not from the rows');
    } finally {
      db.close();
    }
  });
});

describe('setSuspended: preconditions', () => {
  test('refuses a user the bot has no record of', async () => {
    const { service, panel, db } = setup();

    try {
      await assert.rejects(
        () => service.setSuspended(TARGET, true, { actorId: ACTOR }),
        (err) => err instanceof NotFoundError && /no panel account recorded/.test(err.message),
      );

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('refuses a user with no servers', async () => {

    const { service, panel, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      await assert.rejects(
        () => service.setSuspended(TARGET, true, { actorId: ACTOR }),
        (err) => err instanceof NotFoundError && /no servers/.test(err.message),
      );

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('refuses a malformed Discord id', async () => {
    const { service, db } = setup();

    try {
      await assert.rejects(() => service.setSuspended('not-a-snowflake', true, {}), ValidationError);
    } finally {
      db.close();
    }
  });

  test('refuses a bulk operation beyond the ceiling', async () => {

    const { service, panel, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      for (let index = 0; index <= MAX_BULK_SERVERS; index += 1) {
        seedServer(db, TARGET, {
          identifier: `bulk${String(index).padStart(4, '0')}`,
          panelServerId: 1000 + index,
        });
      }

      await assert.rejects(
        () => service.setSuspended(TARGET, true, { actorId: ACTOR }),
        (err) => err instanceof ValidationError && new RegExp(String(MAX_BULK_SERVERS)).test(err.message),
      );

      assert.deepEqual(panel.names(), [], 'nothing should be attempted');
    } finally {
      db.close();
    }
  });

  test('the bulk ceiling is a real bound', () => {
    assert.ok(MAX_BULK_SERVERS > 1);
    assert.ok(MAX_BULK_SERVERS <= 200);
  });
});

describe('setSuspended: suspending', () => {
  test('suspends every recorded server', async () => {
    const { service, panel, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, TARGET, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(result.total, 2);
      assert.equal(result.changed, 2);
      assert.equal(result.skipped, 0);
      assert.deepEqual(result.failed, []);

      assert.equal(panel.countOf('suspendServer'), 2);
      assert.ok(!panel.called('unsuspendServer'));
    } finally {
      db.close();
    }
  });

  test('acts on the panel server ids, not the identifiers', async () => {

    const { service, panel, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 777 });

      await service.setSuspended(TARGET, true, { actorId: ACTOR });

      const [, id] = panel.calls.find(([name]) => name === 'suspendServer');

      assert.equal(id, 777);
    } finally {
      db.close();
    }
  });

  test('touches only the target user’s servers', async () => {
    const { service, panel, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedUser(db, { discordId: OTHER, panelId: 8 });

      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, OTHER, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(result.total, 1);
      assert.equal(panel.countOf('suspendServer'), 1);

      const [, id] = panel.calls.find(([name]) => name === 'suspendServer');
      assert.equal(id, 501, 'the other user’s server must be untouched');
    } finally {
      db.close();
    }
  });
});

describe('setSuspended: unsuspending', () => {
  test('unsuspends every recorded server', async () => {
    const { service, panel, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.setSuspended(TARGET, false, { actorId: ACTOR });

      assert.equal(result.changed, 1);
      assert.ok(panel.called('unsuspendServer'));
      assert.ok(!panel.called('suspendServer'), 'the inverse operation must not be called');
    } finally {
      db.close();
    }
  });

  test('shares its accounting with the suspend direction', async () => {

    const panel = mockPanel({
      async unsuspendServer(id) {
        this.calls.push(['unsuspendServer', id]);
        if (id === 502) throw new AppError('conflict', { code: 'PANEL_HTTP_409', status: ALREADY_IN_STATE });
        return true;
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, TARGET, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.setSuspended(TARGET, false, { actorId: ACTOR });

      assert.equal(result.changed, 1);
      assert.equal(result.skipped, 1, 'already active counts as skipped');
      assert.deepEqual(result.failed, []);
    } finally {
      db.close();
    }
  });
});

describe('setSuspended: per-item outcomes', () => {
  test('counts a 409 as skipped rather than failed', async () => {

    const panel = mockPanel({
      async suspendServer(id) {
        this.calls.push(['suspendServer', id]);
        throw new AppError('already suspended', { code: 'PANEL_HTTP_409', status: ALREADY_IN_STATE });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(result.changed, 0);
      assert.equal(result.skipped, 1);
      assert.deepEqual(result.failed, []);
    } finally {
      db.close();
    }
  });

  test('counts a 404 as skipped, since there is nothing to suspend', async () => {

    const panel = mockPanel({
      async suspendServer(id) {
        this.calls.push(['suspendServer', id]);
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(result.skipped, 1);
      assert.deepEqual(result.failed, []);
    } finally {
      db.close();
    }
  });

  test('continues past a failure and names the servers that failed', async () => {

    const panel = mockPanel({
      async suspendServer(id) {
        this.calls.push(['suspendServer', id]);
        if (id === 502) throw new AppError('internal error', { code: 'PANEL_HTTP_500', status: 500 });
        return true;
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, TARGET, { identifier: 'bbbbbbbb', panelServerId: 502 });
      seedServer(db, TARGET, { identifier: 'cccccccc', panelServerId: 503 });

      const result = await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(result.total, 3);
      assert.equal(result.changed, 2, 'the others must still have been suspended');
      assert.deepEqual(result.failed, ['bbbbbbbb']);

      assert.equal(panel.countOf('suspendServer'), 3, 'every server should have been attempted');
    } finally {
      db.close();
    }
  });

  test('reports a total failure without throwing', async () => {

    const panel = mockPanel({
      async suspendServer(id) {
        this.calls.push(['suspendServer', id]);
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, TARGET, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(result.changed, 0);
      assert.deepEqual(result.failed.sort(), ['aaaaaaaa', 'bbbbbbbb']);
    } finally {
      db.close();
    }
  });

  test('the counts always sum to the total', async () => {

    const panel = mockPanel({
      async suspendServer(id) {
        this.calls.push(['suspendServer', id]);
        if (id === 502) throw new AppError('conflict', { code: 'PANEL_HTTP_409', status: ALREADY_IN_STATE });
        if (id === 503) throw new AppError('boom', { code: 'PANEL_HTTP_500', status: 500 });
        return true;
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, TARGET, { identifier: 'bbbbbbbb', panelServerId: 502 });
      seedServer(db, TARGET, { identifier: 'cccccccc', panelServerId: 503 });

      const result = await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(result.changed + result.skipped + result.failed.length, result.total);
      assert.equal(result.changed, 1);
      assert.equal(result.skipped, 1);
      assert.equal(result.failed.length, 1);
    } finally {
      db.close();
    }
  });

  test('does not alter local records', async () => {

    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      await service.setSuspended(TARGET, true, { actorId: ACTOR });

      assert.equal(db.countUserServers(TARGET), 1);
      assert.ok(db.getServer('aaaaaaaa'));
    } finally {
      db.close();
    }
  });
});

describe('provision: the two policy bypasses', () => {
  test('skips the Discord account age policy', async () => {

    const { service, db } = setup();

    try {
      const result = await service.provision({
        target: NEW_TARGET,
        eggKey: 'nodejs',
        name: 'Their Server',
        actorId: ACTOR,
      });

      assert.equal(result.accountCreated, true);
      assert.ok(db.getUser(TARGET), 'the account must exist');
    } finally {
      db.close();
    }
  });

  test('bypasses the per-user server limit', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 401 });

      assert.equal(db.countUserServers(TARGET), 1, 'already at the limit of one');

      await service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name: 'Second', actorId: ACTOR });

      assert.equal(db.countUserServers(TARGET), 2);
    } finally {
      db.close();
    }
  });

  test('the user-facing path still refuses a second server', async () => {

    const { service, serverService, db } = setup();

    try {
      await service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name: 'First', actorId: ACTOR });

      await assert.rejects(
        () => serverService.createServer({ discordId: TARGET, eggKey: 'nodejs', name: 'Sneaky' }),
        (err) => err instanceof ValidationError && /server limit/.test(err.message),
      );

      assert.equal(db.countUserServers(TARGET), 1);
    } finally {
      db.close();
    }
  });

  test('nothing else is bypassed: an unavailable egg is still refused', async () => {

    const { service, db } = setup();

    try {
      await assert.rejects(
        () => service.provision({ target: NEW_TARGET, eggKey: 'nonexistent', name: 'Server', actorId: ACTOR }),
        ValidationError,
      );
    } finally {
      db.close();
    }
  });

  test('nothing else is bypassed: a malformed name is still refused', async () => {
    const { service, db } = setup();

    try {
      for (const name of ['ab', '@everyone', 'x'.repeat(33)]) {
        await assert.rejects(
          () => service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name, actorId: ACTOR }),
          ValidationError,
          `should refuse ${JSON.stringify(name)}`,
        );
      }
    } finally {
      db.close();
    }
  });
});

describe('provision: credentials', () => {
  test('returns a password only when an account was created', async () => {
    const { service, db } = setup();

    try {
      const result = await service.provision({
        target: NEW_TARGET,
        eggKey: 'nodejs',
        name: 'Their Server',
        actorId: ACTOR,
      });

      assert.equal(result.accountCreated, true);
      assert.equal(typeof result.password, 'string');
      assert.equal(result.password.length, 16);
    } finally {
      db.close();
    }
  });

  test('reuses an existing account without regenerating its password', async () => {

    const { service, panel, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      const result = await service.provision({
        target: NEW_TARGET,
        eggKey: 'nodejs',
        name: 'Their Server',
        actorId: ACTOR,
      });

      assert.equal(result.accountCreated, false);
      assert.equal(result.password, null, 'no password is generated for an existing account');
      assert.ok(!panel.called('createUser'), 'no second account is created');
      assert.ok(!panel.called('updateUserPassword'), 'the existing password is untouched');
    } finally {
      db.close();
    }
  });

  test('returns the stored user record either way', async () => {
    const { service, db } = setup();

    try {
      const created = await service.provision({
        target: NEW_TARGET,
        eggKey: 'nodejs',
        name: 'First',
        actorId: ACTOR,
      });

      assert.equal(created.user.discord_id, TARGET);

      const reused = await service.provision({
        target: NEW_TARGET,
        eggKey: 'nodejs',
        name: 'Second',
        actorId: ACTOR,
      });

      assert.equal(reused.user.discord_id, TARGET);
      assert.equal(reused.user.panel_id, created.user.panel_id);
    } finally {
      db.close();
    }
  });

  test('never stores the generated password', async () => {
    const { service, db } = setup();

    try {
      const result = await service.provision({
        target: NEW_TARGET,
        eggKey: 'nodejs',
        name: 'Their Server',
        actorId: ACTOR,
      });

      assert.ok(!JSON.stringify(db.getUser(TARGET)).includes(result.password));
    } finally {
      db.close();
    }
  });
});

describe('provision: ordering and failure', () => {
  test('creates the account before the server', async () => {

    const { service, panel, db } = setup();

    try {
      await service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name: 'Their Server', actorId: ACTOR });

      const names = panel.names();

      assert.ok(
        names.indexOf('createUser') < names.indexOf('createServer'),
        `unexpected order: ${names.join(', ')}`,
      );
    } finally {
      db.close();
    }
  });

  test('keeps a newly created account when the server step fails', async () => {

    const panel = mockPanel({
      async createServer() {
        throw new AppError('no allocation available', { code: 'PANEL_HTTP_400', status: 400 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(
        () => service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name: 'Their Server', actorId: ACTOR }),
        (err) => err.status === 400,
      );

      assert.ok(db.getUser(TARGET), 'the account must be kept');
      assert.ok(!panel.called('deleteUser'), 'it must not be rolled back');
    } finally {
      db.close();
    }
  });

  test('a retry after a failed server step reuses the account', async () => {

    let failNext = true;

    const panel = mockPanel({
      async createServer(payload) {
        this.calls.push(['createServer', payload]);

        if (failNext) {
          failNext = false;
          throw new AppError('no allocation available', { code: 'PANEL_HTTP_400', status: 400 });
        }

        return { id: 501, identifier: 'a1b2c3d4', uuid: 'u', name: payload.name };
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(() =>
        service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name: 'Their Server', actorId: ACTOR }),
      );

      const retry = await service.provision({
        target: NEW_TARGET,
        eggKey: 'nodejs',
        name: 'Their Server',
        actorId: ACTOR,
      });

      assert.equal(retry.accountCreated, false, 'the kept account should be reused');
      assert.equal(panel.countOf('createUser'), 1, 'only one account should ever have been created');
      assert.equal(db.countUserServers(TARGET), 1);
    } finally {
      db.close();
    }
  });

  test('propagates the account failure when the account step itself fails', async () => {
    const panel = mockPanel({
      async createUser() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(
        () => service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name: 'Their Server', actorId: ACTOR }),
        (err) => err.code === 'PANEL_NETWORK_ETIMEDOUT',
      );

      assert.equal(db.getUser(TARGET), null, 'nothing should be recorded');
      assert.ok(!panel.called('createServer'), 'the server step must not run');
    } finally {
      db.close();
    }
  });

  test('inherits the rollback when the local account write fails', async () => {

    const { service, panel, db } = setup();

    try {
      db.createUser = () => {
        throw new AppError('boom', { code: 'DB_ERROR' });
      };

      await assert.rejects(() =>
        service.provision({ target: NEW_TARGET, eggKey: 'nodejs', name: 'Their Server', actorId: ACTOR }),
      );

      assert.deepEqual(panel.names(), ['createUser', 'deleteUser']);
    } finally {
      db.close();
    }
  });

  test('refuses a malformed target id', async () => {
    const { service, panel, db } = setup();

    try {
      await assert.rejects(
        () => service.provision({ target: { id: 'not-a-snowflake' }, eggKey: 'nodejs', name: 'Server' }),
        ValidationError,
      );

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('tolerates a target with no creation timestamp', async () => {

    const { service, db } = setup();

    try {
      await assert.doesNotReject(() =>
        service.provision({ target: { id: TARGET }, eggKey: 'nodejs', name: 'Their Server', actorId: ACTOR }),
      );
    } finally {
      db.close();
    }
  });
});

describe('adjustCredits', () => {
  test('grants credits and returns the new balance', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7, credits: 10 });

      const result = service.adjustCredits({ targetDiscordId: TARGET, amount: 40, actorId: ACTOR });

      assert.equal(result.delta, 40);
      assert.equal(result.balance, 50);
      assert.equal(db.getCredits(TARGET), 50);
    } finally {
      db.close();
    }
  });

  test('deducts credits for a negative amount', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7, credits: 50 });

      const result = service.adjustCredits({ targetDiscordId: TARGET, amount: -20, actorId: ACTOR });

      assert.equal(result.delta, -20);
      assert.equal(result.balance, 30);
    } finally {
      db.close();
    }
  });

  test('refuses a deduction beyond the balance', async () => {

    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7, credits: 10 });

      assert.throws(
        () => service.adjustCredits({ targetDiscordId: TARGET, amount: -50, actorId: ACTOR }),
        (err) => err instanceof ValidationError && /Insufficient credits/.test(err.message),
      );

      assert.equal(db.getCredits(TARGET), 10, 'the balance must be unchanged');
    } finally {
      db.close();
    }
  });

  test('refuses a zero or non-numeric adjustment', async () => {

    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7, credits: 10 });

      for (const amount of [0, NaN, 'many', null]) {
        assert.throws(
          () => service.adjustCredits({ targetDiscordId: TARGET, amount, actorId: ACTOR }),
          ValidationError,
          `should refuse ${JSON.stringify(amount)}`,
        );
      }
    } finally {
      db.close();
    }
  });

  test('refuses fractional and unsafe adjustments without changing the balance', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7, credits: 10 });

      for (const amount of [5.9, -5.9, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => service.adjustCredits({ targetDiscordId: TARGET, amount, actorId: ACTOR }), ValidationError);
        assert.equal(db.getCredits(TARGET), 10);
      }
    } finally {
      db.close();
    }
  });

  test('refuses a user with no account', async () => {
    const { service, db } = setup();

    try {
      assert.throws(() => service.adjustCredits({ targetDiscordId: TARGET, amount: 10 }), NotFoundError);
    } finally {
      db.close();
    }
  });

  test('refuses a malformed Discord id', async () => {
    const { service, db } = setup();

    try {
      assert.throws(() => service.adjustCredits({ targetDiscordId: 'nope', amount: 10 }), ValidationError);
    } finally {
      db.close();
    }
  });
});

describe('findStaleServers', () => {
  test('reports a local record whose panel server is gone', async () => {

    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        if (id === 502) throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
        return { id: Number(id), identifier: 'a1b2c3d4', eggId: 15, container: {} };
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, TARGET, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.findStaleServers();

      assert.equal(result.checked, 2);
      assert.equal(result.stale.length, 1);
      assert.equal(result.stale[0].identifier, 'bbbbbbbb');
      assert.equal(result.stale[0].discordId, TARGET);
      assert.equal(result.stale[0].panelServerId, 502);
    } finally {
      db.close();
    }
  });

  test('reports nothing when every record resolves', async () => {
    const { service, db } = setup();

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.findStaleServers();

      assert.equal(result.checked, 1);
      assert.deepEqual(result.stale, []);
    } finally {
      db.close();
    }
  });

  test('treats only a 404 as evidence of absence', async () => {

    for (const status of [400, 403, 409, 500, 502, 503]) {
      const panel = mockPanel({
        async getApplicationServer(id) {
          this.calls.push(['getApplicationServer', id]);
          throw new AppError('failed', { code: `PANEL_HTTP_${status}`, status });
        },
      });

      const { service, db } = setup({ panel });

      try {
        seedUser(db, { discordId: TARGET, panelId: 7 });
        seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

        const result = await service.findStaleServers();

        assert.deepEqual(result.stale, [], `status ${status} must not be read as absence`);
      } finally {
        db.close();
      }
    }
  });

  test('treats a network failure as inconclusive', async () => {
    const panel = mockPanel({
      async getApplicationServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      assert.deepEqual((await service.findStaleServers()).stale, []);
    } finally {
      db.close();
    }
  });

  test('spans several users', async () => {
    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedUser(db, { discordId: OTHER, panelId: 8 });

      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, OTHER, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.findStaleServers();

      assert.equal(result.stale.length, 2);
      assert.deepEqual(result.stale.map((entry) => entry.discordId).sort(), [TARGET, OTHER].sort());
    } finally {
      db.close();
    }
  });

  test('bounds how many records it checks', async () => {

    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        return { id: Number(id), identifier: 'x', eggId: 15, container: {} };
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });

      for (let index = 0; index < 10; index += 1) {
        seedServer(db, TARGET, {
          identifier: `sweep${String(index).padStart(3, '0')}`,
          panelServerId: 600 + index,
        });
      }

      const result = await service.findStaleServers({ limit: 4 });

      assert.equal(result.checked, 4);
      assert.equal(panel.countOf('getApplicationServer'), 4);
    } finally {
      db.close();
    }
  });

  test('reports nothing for an empty database', async () => {
    const { service, panel, db } = setup();

    try {
      const result = await service.findStaleServers();

      assert.equal(result.checked, 0);
      assert.deepEqual(result.stale, []);
      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });
});

describe('pruneStaleServers', () => {
  test('removes a record whose server is confirmed absent', async () => {
    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.pruneStaleServers({
        stale: [{ identifier: 'aaaaaaaa', discordId: TARGET, panelServerId: 501 }],
        actorId: ACTOR,
      });

      assert.equal(result.removed, 1);
      assert.equal(result.kept, 0);
      assert.equal(db.getServer('aaaaaaaa'), null, 'the record must be gone');
      assert.equal(db.countUserServers(TARGET), 0, 'and the slot freed');
    } finally {
      db.close();
    }
  });

  test('re-verifies each candidate immediately before deleting', async () => {

    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        return { id: Number(id), identifier: 'aaaaaaaa', eggId: 15, container: {} };
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.pruneStaleServers({
        stale: [{ identifier: 'aaaaaaaa', discordId: TARGET, panelServerId: 501 }],
        actorId: ACTOR,
      });

      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
      assert.ok(db.getServer('aaaaaaaa'), 'a live mapping must survive');
      assert.ok(panel.called('getApplicationServer'), 'the candidate must be re-checked');
    } finally {
      db.close();
    }
  });

  test('keeps a record when the re-check is inconclusive', async () => {

    const panel = mockPanel({
      async getApplicationServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.pruneStaleServers({
        stale: [{ identifier: 'aaaaaaaa', discordId: TARGET, panelServerId: 501 }],
        actorId: ACTOR,
      });

      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1);
      assert.ok(db.getServer('aaaaaaaa'));
    } finally {
      db.close();
    }
  });

  test('deletes only within the recorded owner', async () => {

    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedUser(db, { discordId: OTHER, panelId: 8 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      const result = await service.pruneStaleServers({
        stale: [{ identifier: 'aaaaaaaa', discordId: OTHER, panelServerId: 501 }],
        actorId: ACTOR,
      });

      assert.equal(result.removed, 0);
      assert.equal(result.kept, 1, 'a mismatched owner removes nothing');
      assert.ok(db.getServer('aaaaaaaa'), 'the real owner’s record survives');
    } finally {
      db.close();
    }
  });

  test('handles a mixed batch', async () => {
    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        if (id === 502) throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
        return { id: Number(id), identifier: 'x', eggId: 15, container: {} };
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });
      seedServer(db, TARGET, { identifier: 'bbbbbbbb', panelServerId: 502 });

      const result = await service.pruneStaleServers({
        stale: [
          { identifier: 'aaaaaaaa', discordId: TARGET, panelServerId: 501 },
          { identifier: 'bbbbbbbb', discordId: TARGET, panelServerId: 502 },
        ],
        actorId: ACTOR,
      });

      assert.equal(result.removed, 1);
      assert.equal(result.kept, 1);
      assert.ok(db.getServer('aaaaaaaa'), 'the live one survives');
      assert.equal(db.getServer('bbbbbbbb'), null, 'the absent one is pruned');
    } finally {
      db.close();
    }
  });

  test('tolerates an empty or missing batch', async () => {
    const { service, panel, db } = setup();

    try {
      assert.deepEqual(await service.pruneStaleServers({ stale: [] }), { removed: 0, kept: 0 });
      assert.deepEqual(await service.pruneStaleServers({ stale: null }), { removed: 0, kept: 0 });
      assert.deepEqual(await service.pruneStaleServers({}), { removed: 0, kept: 0 });
      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('does not touch the user account', async () => {

    const panel = mockPanel({
      async getApplicationServer() {
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      await service.pruneStaleServers({
        stale: [{ identifier: 'aaaaaaaa', discordId: TARGET, panelServerId: 501 }],
        actorId: ACTOR,
      });

      assert.ok(db.getUser(TARGET), 'the account must survive');
    } finally {
      db.close();
    }
  });
});

describe('reconciliation end to end', () => {
  test('a server deleted in the panel is found and pruned, freeing the slot', async () => {

    const panel = mockPanel({
      async getApplicationServer(id) {
        this.calls.push(['getApplicationServer', id]);
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, serverService, db } = setup({ panel });

    try {
      seedUser(db, { discordId: TARGET, panelId: 7 });
      seedServer(db, TARGET, { identifier: 'aaaaaaaa', panelServerId: 501 });

      await assert.rejects(
        () => serverService.createServer({ discordId: TARGET, eggKey: 'nodejs', name: 'Replacement' }),
        (err) => err instanceof ValidationError && /server limit/.test(err.message),
      );

      const found = await service.findStaleServers();
      assert.equal(found.stale.length, 1);

      const pruned = await service.pruneStaleServers({ stale: found.stale, actorId: ACTOR });
      assert.equal(pruned.removed, 1);

      assert.equal(db.countUserServers(TARGET), 0, 'the slot is freed');
      await assert.doesNotReject(() =>
        serverService.createServer({ discordId: TARGET, eggKey: 'nodejs', name: 'Replacement' }),
      );
    } finally {
      db.close();
    }
  });
});

describe('the shared instance', () => {
  test('initAdminService installs a service that getAdminService returns', () => {
    const db = createDatabase(':memory:');

    try {
      const panel = mockPanel();
      const locks = createLockManager();
      const accountService = new AccountService({ db, panel, config: CONFIG, env: ENV, locks });
      const serverService = new ServerService({ db, panel, config: CONFIG, env: ENV, locks });

      const created = initAdminService({
        db,
        panel,
        config: CONFIG,
        env: ENV,
        accountService,
        serverService,
      });

      assert.equal(getAdminService(), created);
    } finally {
      setAdminServiceForTests(null);
      db.close();
    }
  });

  test('getAdminService refuses before initialisation', () => {

    setAdminServiceForTests(null);

    assert.throws(
      () => getAdminService(),
      (err) => err instanceof AppError && err.code === 'SERVICE_NOT_READY',
    );
  });
});
