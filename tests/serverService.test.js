import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  getServerService,
  initServerService,
  LIST_STATE_CONCURRENCY,
  MISSING_FILE_STATUSES,
  ServerService,
  setServerServiceForTests,
} from '../src/services/serverService.js';
import { createDatabase } from '../src/database/db.js';
import { validateConfig } from '../src/config/config.js';
import { createLockManager } from '../src/utils/locks.js';
import {
  AppError,
  AuthorizationError,
  ConfigError,
  NotFoundError,
  ValidationError,
} from '../src/utils/errors.js';

const OWNER = '111111111111111111';
const STRANGER = '222222222222222222';

const CONFIG = validateConfig({
  colors: { primary: '#2B2D31', error: '#ED4245' },
  eggs: {
    nodejs: {
      label: 'Node.js',
      eggId: 15,
      nestId: 5,
      dockerImage: 'ghcr.io/example/node:20',
      startup: 'node index.js',
      logPaths: ['/logs/latest.log', '/output.log'],
      images: { 'Node 20': 'ghcr.io/example/node:20', 'Node 22': 'ghcr.io/example/node:22' },
    },
    python: {
      label: 'Python',
      eggId: 16,
      nestId: 5,
      dockerImage: 'ghcr.io/example/python:3.12',
      startup: 'python main.py',
    },
    unconfigured: { eggId: 0, nestId: 0, dockerImage: '' },
  },
  deploy: { locationId: 3, dedicatedIp: false, portRange: [] },
  defaults: {
    limits: { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 },
    featureLimits: { databases: 1, allocations: 1, backups: 1 },
  },
  subuser: { defaultPermissions: ['control.console', 'control.start', 'file.read'] },
  backups: { maxInlineBytes: 1024 },
});

const ENV = Object.freeze({
  prefix: 'kx!',
  panelUrl: 'https://panel.example.test',
  freeServerLimit: 1,
});

function mockPanel(overrides = {}) {
  const calls = [];
  let nextServerId = 500;

  return {
    calls,

    names: () => calls.map(([name]) => name),

    called: (name) => calls.some(([called]) => called === name),

    async getEgg(nestId, eggId) {
      calls.push(['getEgg', nestId, eggId]);
      return {
        id: Number(eggId),
        name: 'Node.js',
        dockerImage: 'ghcr.io/example/node:20',
        dockerImages: {},
        startup: 'node index.js',
        variables: [
          { name: 'Startup file', envVariable: 'STARTUP_FILE', defaultValue: 'index.js', required: true, rules: 'required|string' },
          { name: 'Optional', envVariable: 'OPTIONAL', defaultValue: '', required: false, rules: 'nullable|string' },
        ],
      };
    },

    async createServer(payload) {
      calls.push(['createServer', payload]);
      nextServerId += 1;
      return { id: nextServerId, identifier: 'a1b2c3d4', uuid: 'uuid-value', name: payload.name };
    },

    async deleteServer(id, options) {
      calls.push(['deleteServer', id, options]);
      return true;
    },

    async getClientServer(identifier) {
      calls.push(['getClientServer', identifier]);
      return {
        identifier,
        uuid: 'uuid-value',
        name: 'Test Server',
        description: '',
        node: 'node-1',
        isInstalling: false,
        isSuspended: false,
        isTransferring: false,
        limits: { memory: 1024, disk: 5120, cpu: 100 },
        featureLimits: { databases: 1, allocations: 1, backups: 1 },
        allocations: [{ id: 1, ip: '192.0.2.10', port: 25_565, alias: null, primary: true }],
      };
    },

    async getResources(identifier) {
      calls.push(['getResources', identifier]);
      return {
        state: 'running',
        isSuspended: false,
        uptimeMs: 60_000,
        cpuPercent: 12.5,
        memoryBytes: 512 * 1024 * 1024,
        diskBytes: 1024 * 1024 * 1024,
        networkRxBytes: 2048,
        networkTxBytes: 4096,
      };
    },

    async sendPowerSignal(identifier, signal) {
      calls.push(['sendPowerSignal', identifier, signal]);
      return signal;
    },

    async renameServer(identifier, name) {
      calls.push(['renameServer', identifier, name]);
      return true;
    },

    async reinstallServer(identifier) {
      calls.push(['reinstallServer', identifier]);
      return true;
    },

    async updateServerImage(panelServerId, image) {
      calls.push(['updateServerImage', panelServerId, image]);
      return true;
    },

    async getFileContents(identifier, filePath) {
      calls.push(['getFileContents', identifier, filePath]);
      return 'log line one\nlog line two\n';
    },

    async listSubusers(identifier) {
      calls.push(['listSubusers', identifier]);
      return [
        { uuid: '11111111-2222-3333-4444-555555555555', email: 'existing@example.test', username: 'existing', permissions: [] },
      ];
    },

    async createSubuser(identifier, email, permissions) {
      calls.push(['createSubuser', identifier, email, permissions]);
      return { uuid: '99999999-8888-7777-6666-555555555555', email, username: 'newsubuser' };
    },

    async deleteSubuser(identifier, uuid) {
      calls.push(['deleteSubuser', identifier, uuid]);
      return true;
    },

    async listFiles(identifier, directory) {
      calls.push(['listFiles', identifier, directory]);
      return [
        { name: 'server.jar', size: 1024, isFile: true, mode: '', modifiedAt: '' },
        { name: 'plugins', size: 0, isFile: false, mode: '', modifiedAt: '' },
      ];
    },

    async compressFiles(identifier, payload) {
      calls.push(['compressFiles', identifier, payload]);
      return { name: 'archive-2026-09-02.tar.gz', size: 512 };
    },

    async deleteFiles(identifier, payload) {
      calls.push(['deleteFiles', identifier, payload]);
      return true;
    },

    async getDownloadUrl(identifier, filePath) {
      calls.push(['getDownloadUrl', identifier, filePath]);
      return 'https://node.example.test/download?token=signed';
    },

    async fetchSignedFile(url, maxBytes) {
      calls.push(['fetchSignedFile', url, maxBytes]);
      return Buffer.from('archive-bytes');
    },

    ...overrides,
  };
}

function setup({ panel = mockPanel(), env = ENV, config = CONFIG, seedServer = false } = {}) {
  const db = createDatabase(':memory:');
  const locks = createLockManager();

  db.createUser({ discordId: OWNER, panelId: 7, email: 'owner@panelkit.local', username: 'ownername' });
  db.createUser({ discordId: STRANGER, panelId: 8, email: 'other@panelkit.local', username: 'othername' });

  if (seedServer) {
    db.createServer({
      discordId: OWNER,
      panelServerId: 501,
      identifier: 'a1b2c3d4',
      name: 'Test Server',
      eggType: 'nodejs',
    });
  }

  return { db, panel, service: new ServerService({ db, panel, config, env, locks }) };
}

describe('requireOwnedServer', () => {
  test('returns the row for the owner', () => {
    const { service, db } = setup({ seedServer: true });

    try {
      const server = service.requireOwnedServer(OWNER, 'a1b2c3d4');

      assert.equal(server.identifier, 'a1b2c3d4');
      assert.equal(server.discord_id, OWNER);
    } finally {
      db.close();
    }
  });

  test('normalises the identifier before looking it up', () => {
    const { service, db } = setup({ seedServer: true });

    try {
      assert.ok(service.requireOwnedServer(OWNER, 'A1B2C3D4'));
      assert.ok(service.requireOwnedServer(OWNER, '  a1b2c3d4  '));
    } finally {
      db.close();
    }
  });

  test('refuses a stranger', () => {
    const { service, db } = setup({ seedServer: true });

    try {
      assert.throws(() => service.requireOwnedServer(STRANGER, 'a1b2c3d4'), AuthorizationError);
    } finally {
      db.close();
    }
  });

  test('produces an identical error for a foreign and a nonexistent server', () => {

    const { service, db } = setup({ seedServer: true });

    try {
      let foreign;
      let missing;

      try {
        service.requireOwnedServer(STRANGER, 'a1b2c3d4');
      } catch (err) {
        foreign = err;
      }

      try {
        service.requireOwnedServer(STRANGER, 'zzzzzzzz');
      } catch (err) {
        missing = err;
      }

      assert.equal(foreign.userMessage, missing.userMessage);
      assert.equal(foreign.code, missing.code);
      assert.equal(foreign.status, missing.status);
    } finally {
      db.close();
    }
  });

  test('rejects a malformed identifier before querying', () => {
    const { service, db } = setup({ seedServer: true });

    try {
      for (const bad of ['', 'short', '../../admin', 'a1b2c3d4/../x', null, {}]) {
        assert.throws(
          () => service.requireOwnedServer(OWNER, bad),
          ValidationError,
          `should reject ${JSON.stringify(bad)}`,
        );
      }
    } finally {
      db.close();
    }
  });
});

describe('authorisation across every method', () => {

  const operations = [
    ['power', (service, id) => service.power({ discordId: id, identifier: 'a1b2c3d4', signal: 'start' })],
    ['usage', (service, id) => service.usage({ discordId: id, identifier: 'a1b2c3d4' })],
    ['info', (service, id) => service.info({ discordId: id, identifier: 'a1b2c3d4' })],
    ['logs', (service, id) => service.logs({ discordId: id, identifier: 'a1b2c3d4' })],
    ['rename', (service, id) => service.rename({ discordId: id, identifier: 'a1b2c3d4', name: 'Hijacked' })],
    ['reinstall', (service, id) => service.reinstall({ discordId: id, identifier: 'a1b2c3d4' })],
    ['deleteServer', (service, id) => service.deleteServer({ discordId: id, identifier: 'a1b2c3d4' })],
    [
      'changeImage',
      (service, id) => service.changeImage({ discordId: id, identifier: 'a1b2c3d4', image: 'ghcr.io/example/node:22' }),
    ],
    ['subusers', (service, id) => service.subusers({ discordId: id, identifier: 'a1b2c3d4' })],
    [
      'addSubuser',
      (service, id) => service.addSubuser({ discordId: id, identifier: 'a1b2c3d4', email: 'friend@example.test' }),
    ],
    [
      'removeSubuser',
      (service, id) => service.removeSubuser({ discordId: id, identifier: 'a1b2c3d4', email: 'existing@example.test' }),
    ],
    ['backup', (service, id) => service.backup({ discordId: id, identifier: 'a1b2c3d4' })],
  ];

  for (const [name, invoke] of operations) {
    test(`${name} refuses a stranger without contacting the panel`, async () => {
      const { service, panel, db } = setup({ seedServer: true });

      try {
        await assert.rejects(() => invoke(service, STRANGER), AuthorizationError, `${name} should refuse`);

        assert.deepEqual(panel.names(), [], `${name} must not reach the panel for a foreign caller`);
      } finally {
        db.close();
      }
    });
  }

  test('a stranger cannot rename another user’s server', async () => {

    const { service, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.rename({ discordId: STRANGER, identifier: 'a1b2c3d4', name: 'Hijacked' }),
        AuthorizationError,
      );

      assert.equal(db.getServer('a1b2c3d4').name, 'Test Server', 'the name must be unchanged');
    } finally {
      db.close();
    }
  });

  test('a stranger cannot delete another user’s server', async () => {
    const { service, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.deleteServer({ discordId: STRANGER, identifier: 'a1b2c3d4' }),
        AuthorizationError,
      );

      assert.ok(db.getServer('a1b2c3d4'), 'the record must survive');
    } finally {
      db.close();
    }
  });
});

describe('listEggChoices', () => {
  test('offers only fully configured eggs', () => {

    const { service, db } = setup();

    try {
      const choices = service.listEggChoices();

      assert.deepEqual(
        choices.map((choice) => choice.key).sort(),
        ['nodejs', 'python'],
      );
      assert.equal(choices.find((choice) => choice.key === 'nodejs').label, 'Node.js');
    } finally {
      db.close();
    }
  });

  test('returns an empty list when nothing is configured', () => {
    const config = validateConfig({
      colors: { primary: '#2B2D31', error: '#ED4245' },
      eggs: { nodejs: { eggId: 0, nestId: 0, dockerImage: '' } },
    });

    const { service, db } = setup({ config });

    try {
      assert.deepEqual(service.listEggChoices(), []);
    } finally {
      db.close();
    }
  });
});

describe('panelUrlFor', () => {
  test('builds a link under the configured panel origin', () => {
    const { service, db } = setup({ seedServer: true });

    try {
      assert.equal(service.panelUrlFor('a1b2c3d4'), 'https://panel.example.test/server/a1b2c3d4');
    } finally {
      db.close();
    }
  });

  test('refuses to build a link from a malformed identifier', () => {

    const { service, db } = setup();

    try {
      assert.throws(() => service.panelUrlFor('../../admin'), ValidationError);
      assert.throws(() => service.panelUrlFor('https://evil.example'), ValidationError);
    } finally {
      db.close();
    }
  });
});

describe('createServer: preconditions', () => {
  test('refuses a user with no panel account', async () => {
    const { service, panel, db } = setup();

    try {
      db.deleteUser(OWNER);

      await assert.rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' }),
        (err) => err instanceof NotFoundError && /kx!account create/.test(err.message),
      );

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('refuses when the user is at their limit', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Second' }),
        (err) => err instanceof ValidationError && /server limit \(1\/1\)/.test(err.message),
      );

      assert.deepEqual(panel.names(), [], 'the limit check must precede any panel request');
    } finally {
      db.close();
    }
  });

  test('names the command to free a slot', () => {
    const { service, db } = setup({ seedServer: true });

    return assert
      .rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Second' }),
        (err) => /kx!server delete/.test(err.message),
      )
      .finally(() => db.close());
  });

  test('refuses when the limit is zero', async () => {

    const { service, db } = setup({ env: { ...ENV, freeServerLimit: 0 } });

    try {
      await assert.rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' }),
        (err) => err instanceof ValidationError && /currently disabled/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('refuses when no egg is configured', async () => {
    const config = validateConfig({
      colors: { primary: '#2B2D31', error: '#ED4245' },
      eggs: { nodejs: { eggId: 0, nestId: 0, dockerImage: '' } },
      deploy: { locationId: 1 },
    });

    const { service, db } = setup({ config });

    try {
      await assert.rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' }),
        (err) => err instanceof ConfigError && /config\.json/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('refuses when the deployment location is unset', async () => {
    const config = validateConfig({
      colors: { primary: '#2B2D31', error: '#ED4245' },
      eggs: { nodejs: { eggId: 15, nestId: 5, dockerImage: 'node:20' } },
      deploy: { locationId: 0 },
    });

    const { service, panel, db } = setup({ config });

    try {
      await assert.rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' }),
        (err) => err instanceof ConfigError && /deploy\.locationId/.test(err.message),
      );

      assert.ok(!panel.called('createServer'), 'nothing should be provisioned');
    } finally {
      db.close();
    }
  });

  test('refuses an unavailable egg key', async () => {
    const { service, panel, db } = setup();

    try {
      for (const key of ['unconfigured', 'nonexistent', '', null]) {
        await assert.rejects(
          () => service.createServer({ discordId: OWNER, eggKey: key, name: 'My Server' }),
          ValidationError,
          `should refuse ${JSON.stringify(key)}`,
        );
      }

      assert.ok(!panel.called('createServer'));
    } finally {
      db.close();
    }
  });

  test('refuses a malformed name before contacting the panel', async () => {
    const { service, panel, db } = setup();

    try {
      for (const name of ['', 'ab', 'x'.repeat(33), '@everyone', '`code`']) {
        await assert.rejects(
          () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name }),
          ValidationError,
          `should refuse ${JSON.stringify(name)}`,
        );
      }

      assert.ok(!panel.called('createServer'));
    } finally {
      db.close();
    }
  });
});

describe('createServer: environment construction', () => {
  test('builds the environment from egg defaults', async () => {
    const { service, panel, db } = setup();

    try {
      await service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' });

      const [, payload] = panel.calls.find(([name]) => name === 'createServer');

      assert.equal(payload.environment.STARTUP_FILE, 'index.js');
      assert.equal(payload.environment.OPTIONAL, undefined, 'an empty optional variable is omitted');
    } finally {
      db.close();
    }
  });

  test('lets a config override win over the egg default', async () => {

    const config = validateConfig({
      colors: { primary: '#2B2D31', error: '#ED4245' },
      eggs: {
        nodejs: {
          eggId: 15,
          nestId: 5,
          dockerImage: 'node:20',
          environment: { STARTUP_FILE: 'server.js' },
        },
      },
      deploy: { locationId: 1 },
    });

    const { service, panel, db } = setup({ config });

    try {
      await service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' });

      const [, payload] = panel.calls.find(([name]) => name === 'createServer');

      assert.equal(payload.environment.STARTUP_FILE, 'server.js');
    } finally {
      db.close();
    }
  });

  test('passes through an override the egg does not declare', async () => {

    const config = validateConfig({
      colors: { primary: '#2B2D31', error: '#ED4245' },
      eggs: {
        nodejs: { eggId: 15, nestId: 5, dockerImage: 'node:20', environment: { EXTRA_FLAG: 'enabled' } },
      },
      deploy: { locationId: 1 },
    });

    const { service, panel, db } = setup({ config });

    try {
      await service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' });

      const [, payload] = panel.calls.find(([name]) => name === 'createServer');

      assert.equal(payload.environment.EXTRA_FLAG, 'enabled');
    } finally {
      db.close();
    }
  });

  test('refuses when a required variable has no value anywhere', async () => {

    const panel = mockPanel({
      async getEgg() {
        return {
          id: 15,
          dockerImage: 'node:20',
          startup: 'node .',
          variables: [
            { name: 'API key', envVariable: 'API_KEY', defaultValue: '', required: true, rules: 'required|string' },
          ],
        };
      },
    });

    const { service, db } = setup({ panel });

    try {
      await assert.rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' }),
        (err) => err instanceof ConfigError && /API_KEY/.test(err.message) && /config\.json/.test(err.message),
      );

      assert.ok(!panel.called('createServer'), 'nothing should be provisioned');
    } finally {
      db.close();
    }
  });

  test('accepts a required variable satisfied by a config override', async () => {
    const config = validateConfig({
      colors: { primary: '#2B2D31', error: '#ED4245' },
      eggs: { nodejs: { eggId: 15, nestId: 5, dockerImage: 'node:20', environment: { API_KEY: 'supplied' } } },
      deploy: { locationId: 1 },
    });

    const panel = mockPanel({
      async getEgg() {
        return {
          id: 15,
          dockerImage: 'node:20',
          startup: 'node .',
          variables: [{ envVariable: 'API_KEY', defaultValue: '', required: true, rules: 'required|string' }],
        };
      },
    });

    const { service, db } = setup({ panel, config });

    try {
      await assert.doesNotReject(() => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' }));
    } finally {
      db.close();
    }
  });

  test('prefers the configured image and startup over the egg’s', async () => {
    const { service, panel, db } = setup();

    try {
      await service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' });

      const [, payload] = panel.calls.find(([name]) => name === 'createServer');

      assert.equal(payload.dockerImage, 'ghcr.io/example/node:20');
      assert.equal(payload.startup, 'node index.js');
    } finally {
      db.close();
    }
  });

  test('falls back to the egg’s image when none is configured', async () => {

    const panel = mockPanel({
      async getEgg() {
        return {
          id: 16,
          dockerImage: 'ghcr.io/example/python:3.12',
          startup: 'python main.py',
          variables: [],
        };
      },
    });

    const { service, db } = setup({ panel });

    try {
      await service.createServer({ discordId: OWNER, eggKey: 'python', name: 'My Server' });

      const [, payload] = panel.calls.find(([name]) => name === 'createServer');

      assert.equal(payload.dockerImage, 'ghcr.io/example/python:3.12');
    } finally {
      db.close();
    }
  });
});

describe('createServer: persistence', () => {
  test('records the server after the panel provisions it', async () => {
    const { service, panel, db } = setup();

    try {
      const record = await service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' });

      assert.equal(record.identifier, 'a1b2c3d4');
      assert.equal(record.discord_id, OWNER);
      assert.equal(record.egg_type, 'nodejs');
      assert.equal(record.name, 'My Server');

      assert.ok(db.getOwnedServer('a1b2c3d4', OWNER), 'the record must be queryable');
      assert.deepEqual(panel.names(), ['getEgg', 'createServer']);
    } finally {
      db.close();
    }
  });

  test('normalises the name before storing it', async () => {
    const { service, db } = setup();

    try {
      const record = await service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: '  My   Server  ' });

      assert.equal(record.name, 'My Server');
    } finally {
      db.close();
    }
  });

  test('reports an orphaned server when the local write fails', async () => {

    const { service, panel, db } = setup();

    try {
      db.createServer = () => {
        throw new AppError('boom', { code: 'DB_ERROR' });
      };

      let caught;
      try {
        await service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'My Server' });
      } catch (err) {
        caught = err;
      }

      assert.equal(caught.code, 'SERVER_ORPHANED');
      assert.match(caught.userMessage, /a1b2c3d4/, 'the identifier must reach the user');
      assert.match(caught.userMessage, /administrator/i, 'and they must be told who to contact');

      assert.equal(caught.details.identifier, 'a1b2c3d4');
      assert.ok(caught.details.panelServerId > 0);

      assert.ok(!panel.called('deleteServer'), 'the server must not be rolled back');
    } finally {
      db.close();
    }
  });
});

describe('createServer: concurrency and the limit', () => {
  test('two concurrent creations cannot both pass the limit', async () => {

    const panel = mockPanel({
      async createServer(payload) {
        this.calls.push(['createServer', payload]);

        await new Promise((resolve) => setTimeout(resolve, 5));
        return { id: 500 + this.calls.length, identifier: `a1b2c3d${this.calls.length}`, uuid: 'u', name: payload.name };
      },
    });

    const { service, db } = setup({ panel });

    try {
      const results = await Promise.allSettled([
        service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'First' }),
        service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Second' }),
      ]);

      const fulfilled = results.filter((result) => result.status === 'fulfilled');

      assert.equal(fulfilled.length, 1, 'exactly one creation should succeed');
      assert.equal(db.countUserServers(OWNER), 1, 'and the limit must hold');
      assert.equal(
        panel.names().filter((name) => name === 'createServer').length,
        1,
        'only one server should have been provisioned',
      );
    } finally {
      db.close();
    }
  });

  test('different users are not serialised against each other', async () => {

    const { service, panel, db } = setup();

    try {
      const results = await Promise.allSettled([
        service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Mine' }),
        service.createServer({ discordId: STRANGER, eggKey: 'nodejs', name: 'Theirs' }),
      ]);

      assert.equal(
        panel.names().filter((name) => name === 'createServer').length,
        2,
        'both users should have reached the panel',
      );
      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    } finally {
      db.close();
    }
  });

  test('bypassLimit permits provisioning beyond the limit', async () => {

    const panel = mockPanel({
      async createServer(payload) {
        this.calls.push(['createServer', payload]);
        return { id: 500 + this.calls.length, identifier: `a1b2c3d${this.calls.length}`, uuid: 'u', name: payload.name };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.doesNotReject(() =>
        service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Extra', bypassLimit: true }),
      );

      assert.equal(db.countUserServers(OWNER), 2);
    } finally {
      db.close();
    }
  });

  test('bypassLimit still requires a panel account', async () => {

    const { service, db } = setup();

    try {
      db.deleteUser(OWNER);

      await assert.rejects(
        () => service.createServer({ discordId: OWNER, eggKey: 'nodejs', name: 'Extra', bypassLimit: true }),
        NotFoundError,
      );
    } finally {
      db.close();
    }
  });
});

describe('deleteServer', () => {
  test('removes the panel server and the local record', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      const removed = await service.deleteServer({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(removed.identifier, 'a1b2c3d4');
      assert.equal(db.getServer('a1b2c3d4'), null);
      assert.deepEqual(panel.names(), ['deleteServer']);
    } finally {
      db.close();
    }
  });

  test('removes the local record even when the panel reports 404', async () => {

    const panel = mockPanel({
      async deleteServer() {
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.doesNotReject(() => service.deleteServer({ discordId: OWNER, identifier: 'a1b2c3d4' }));

      assert.equal(db.getServer('a1b2c3d4'), null, 'the slot must be freed');
      assert.equal(db.countUserServers(OWNER), 0);
    } finally {
      db.close();
    }
  });

  test('keeps the local record when the panel fails for another reason', async () => {

    const panel = mockPanel({
      async deleteServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(() => service.deleteServer({ discordId: OWNER, identifier: 'a1b2c3d4' }));

      assert.ok(db.getServer('a1b2c3d4'), 'the record must survive a failed deletion');
    } finally {
      db.close();
    }
  });

  test('two concurrent deletions produce one deletion', async () => {
    const { service, db } = setup({ seedServer: true });

    try {
      const results = await Promise.allSettled([
        service.deleteServer({ discordId: OWNER, identifier: 'a1b2c3d4' }),
        service.deleteServer({ discordId: OWNER, identifier: 'a1b2c3d4' }),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.ok(
        results.some((result) => result.status === 'rejected' && result.reason instanceof AuthorizationError),
        'the loser finds no owned server',
      );
    } finally {
      db.close();
    }
  });
});

describe('power', () => {
  test('sends the signal after checking the server state', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.power({ discordId: OWNER, identifier: 'a1b2c3d4', signal: 'restart' });

      assert.equal(result.signal, 'restart');
      assert.equal(result.server.identifier, 'a1b2c3d4');
      assert.deepEqual(panel.names(), ['getClientServer', 'sendPowerSignal']);
    } finally {
      db.close();
    }
  });

  test('refuses while the server is installing', async () => {
    const panel = mockPanel({
      async getClientServer(identifier) {
        this.calls.push(['getClientServer', identifier]);
        return { identifier, isInstalling: true, isSuspended: false, isTransferring: false, allocations: [] };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.power({ discordId: OWNER, identifier: 'a1b2c3d4', signal: 'start' }),
        (err) => err instanceof ValidationError && /still installing/.test(err.message),
      );

      assert.ok(!panel.called('sendPowerSignal'));
    } finally {
      db.close();
    }
  });

  test('refuses while the server is suspended', async () => {
    const panel = mockPanel({
      async getClientServer(identifier) {
        this.calls.push(['getClientServer', identifier]);
        return { identifier, isInstalling: false, isSuspended: true, isTransferring: false, allocations: [] };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.power({ discordId: OWNER, identifier: 'a1b2c3d4', signal: 'start' }),
        (err) => err instanceof ValidationError && /suspended/.test(err.message),
      );

      assert.ok(!panel.called('sendPowerSignal'));
    } finally {
      db.close();
    }
  });

  test('refuses while the server is transferring', async () => {
    const panel = mockPanel({
      async getClientServer(identifier) {
        this.calls.push(['getClientServer', identifier]);
        return { identifier, isInstalling: false, isSuspended: false, isTransferring: true, allocations: [] };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.power({ discordId: OWNER, identifier: 'a1b2c3d4', signal: 'start' }),
        (err) => err instanceof ValidationError && /transferred/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('refuses an invalid signal', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      for (const signal of ['delete', 'suspend', '', null]) {
        await assert.rejects(
          () => service.power({ discordId: OWNER, identifier: 'a1b2c3d4', signal }),
          ValidationError,
          `should refuse ${JSON.stringify(signal)}`,
        );
      }

      assert.ok(!panel.called('sendPowerSignal'));
    } finally {
      db.close();
    }
  });

  test('normalises the signal', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      await service.power({ discordId: OWNER, identifier: 'a1b2c3d4', signal: 'RESTART' });

      const [, , signal] = panel.calls.find(([name]) => name === 'sendPowerSignal');

      assert.equal(signal, 'restart');
    } finally {
      db.close();
    }
  });
});

describe('usage and info', () => {
  test('usage returns the live resources', async () => {
    const { service, db } = setup({ seedServer: true });

    try {
      const { server, resources } = await service.usage({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(server.identifier, 'a1b2c3d4');
      assert.equal(resources.state, 'running');
      assert.equal(resources.cpuPercent, 12.5);
    } finally {
      db.close();
    }
  });

  test('info combines the local record with both panel reads', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.info({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.record.identifier, 'a1b2c3d4');
      assert.equal(result.panel.node, 'node-1');
      assert.equal(result.resources.state, 'running');
      assert.equal(result.allocations.length, 1);

      assert.ok(panel.called('getClientServer'));
      assert.ok(panel.called('getResources'));
    } finally {
      db.close();
    }
  });

  test('info tolerates missing resources', async () => {

    const panel = mockPanel({
      async getResources() {
        throw new AppError('no statistics', { code: 'PANEL_HTTP_409', status: 409 });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const result = await service.info({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.resources, null);
      assert.ok(result.panel, 'the configuration is still returned');
    } finally {
      db.close();
    }
  });

  test('info tolerates a missing configuration', async () => {
    const panel = mockPanel({
      async getClientServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const result = await service.info({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.panel, null);
      assert.deepEqual(result.allocations, []);
      assert.ok(result.resources, 'the live statistics are still returned');
    } finally {
      db.close();
    }
  });

  test('info fails only when both panel reads fail', async () => {

    const panel = mockPanel({
      async getClientServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
      async getResources() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(() => service.info({ discordId: OWNER, identifier: 'a1b2c3d4' }), AppError);
    } finally {
      db.close();
    }
  });
});

describe('listServers and listWithState', () => {
  test('lists a user’s servers from the local database', () => {
    const { service, db } = setup({ seedServer: true });

    try {
      const servers = service.listServers(OWNER);

      assert.equal(servers.length, 1);
      assert.equal(servers[0].identifier, 'a1b2c3d4');
      assert.deepEqual(service.listServers(STRANGER), []);
    } finally {
      db.close();
    }
  });

  test('attaches live state to each server', async () => {
    const { service, db } = setup({ seedServer: true });

    try {
      const servers = await service.listWithState(OWNER);

      assert.equal(servers.length, 1);
      assert.equal(servers[0].state, 'running');
    } finally {
      db.close();
    }
  });

  test('degrades a failed state read to unknown', async () => {

    const panel = mockPanel({
      async getResources() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const servers = await service.listWithState(OWNER);

      assert.equal(servers[0].state, 'unknown');
    } finally {
      db.close();
    }
  });

  test('returns an empty list without contacting the panel', async () => {
    const { service, panel, db } = setup();

    try {
      assert.deepEqual(await service.listWithState(OWNER), []);
      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('bounds the number of state lookups', async () => {

    const { service, panel, db } = setup();

    try {
      for (let index = 0; index < LIST_STATE_CONCURRENCY + 3; index += 1) {
        db.createServer({
          discordId: OWNER,
          panelServerId: 600 + index,
          identifier: `bbbbbb${String(index).padStart(2, '0')}`,
          name: `Server ${index}`,
          eggType: 'nodejs',
        });
      }

      const servers = await service.listWithState(OWNER);

      assert.equal(servers.length, LIST_STATE_CONCURRENCY + 3, 'every server is listed');
      assert.equal(
        panel.names().filter((name) => name === 'getResources').length,
        LIST_STATE_CONCURRENCY,
        'but only the capped number are queried',
      );
      assert.equal(servers[LIST_STATE_CONCURRENCY].state, 'unknown', 'the rest report unknown');
    } finally {
      db.close();
    }
  });
});

describe('rename', () => {
  test('renames on the panel and locally', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.rename({ discordId: OWNER, identifier: 'a1b2c3d4', name: 'New Name' });

      assert.equal(result.name, 'New Name');
      assert.equal(result.previousName, 'Test Server');
      assert.equal(db.getServer('a1b2c3d4').name, 'New Name');
      assert.deepEqual(panel.names(), ['renameServer']);
    } finally {
      db.close();
    }
  });

  test('refuses a no-op rename', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.rename({ discordId: OWNER, identifier: 'a1b2c3d4', name: 'Test Server' }),
        (err) => err instanceof ValidationError && /already the name/.test(err.message),
      );

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('normalises the name before comparing and storing', async () => {
    const { service, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.rename({ discordId: OWNER, identifier: 'a1b2c3d4', name: '  Test   Server  ' }),
        ValidationError,
        'the normalised form is the same name',
      );

      const result = await service.rename({ discordId: OWNER, identifier: 'a1b2c3d4', name: '  New   Name  ' });

      assert.equal(result.name, 'New Name');
    } finally {
      db.close();
    }
  });

  test('refuses a malformed name before contacting the panel', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      for (const name of ['ab', '@everyone', '`x`', 'x'.repeat(33)]) {
        await assert.rejects(
          () => service.rename({ discordId: OWNER, identifier: 'a1b2c3d4', name }),
          ValidationError,
        );
      }

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('leaves the local name unchanged when the panel fails', async () => {
    const panel = mockPanel({
      async renameServer() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(() => service.rename({ discordId: OWNER, identifier: 'a1b2c3d4', name: 'New Name' }));

      assert.equal(db.getServer('a1b2c3d4').name, 'Test Server');
    } finally {
      db.close();
    }
  });
});

describe('reinstall', () => {
  test('reinstalls after checking the state', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      const server = await service.reinstall({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(server.identifier, 'a1b2c3d4');
      assert.deepEqual(panel.names(), ['getClientServer', 'reinstallServer']);
    } finally {
      db.close();
    }
  });

  test('refuses while already installing', async () => {
    const panel = mockPanel({
      async getClientServer(identifier) {
        this.calls.push(['getClientServer', identifier]);
        return { identifier, isInstalling: true, isSuspended: false, isTransferring: false, allocations: [] };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.reinstall({ discordId: OWNER, identifier: 'a1b2c3d4' }),
        (err) => err instanceof ValidationError && /already installing/.test(err.message),
      );

      assert.ok(!panel.called('reinstallServer'));
    } finally {
      db.close();
    }
  });

  test('refuses while suspended', async () => {
    const panel = mockPanel({
      async getClientServer(identifier) {
        this.calls.push(['getClientServer', identifier]);
        return { identifier, isInstalling: false, isSuspended: true, isTransferring: false, allocations: [] };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.reinstall({ discordId: OWNER, identifier: 'a1b2c3d4' }),
        (err) => err instanceof ValidationError && /suspended/.test(err.message),
      );
    } finally {
      db.close();
    }
  });
});

describe('changeImage', () => {
  test('applies an image from the allowlist', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.changeImage({
        discordId: OWNER,
        identifier: 'a1b2c3d4',
        image: 'ghcr.io/example/node:22',
      });

      assert.equal(result.image, 'ghcr.io/example/node:22');

      const [, panelServerId, image] = panel.calls.find(([name]) => name === 'updateServerImage');

      assert.equal(panelServerId, 501);
      assert.equal(image, 'ghcr.io/example/node:22');
    } finally {
      db.close();
    }
  });

  test('refuses an image not on the allowlist', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {

      for (const image of ['ghcr.io/attacker/backdoor:1', 'node:latest', '', 'ghcr.io/example/node:21']) {
        await assert.rejects(
          () => service.changeImage({ discordId: OWNER, identifier: 'a1b2c3d4', image }),
          ValidationError,
          `should refuse ${JSON.stringify(image)}`,
        );
      }

      assert.ok(!panel.called('updateServerImage'));
    } finally {
      db.close();
    }
  });

  test('refuses when the egg type has no configured images', async () => {
    const { service, db } = setup();

    try {
      db.createServer({
        discordId: OWNER,
        panelServerId: 502,
        identifier: 'cccccccc',
        name: 'Python Server',
        eggType: 'python',
      });

      await assert.rejects(
        () => service.changeImage({ discordId: OWNER, identifier: 'cccccccc', image: 'anything' }),
        (err) => err instanceof ConfigError && /config\.json/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('imageChoicesFor lists the configured allowlist', () => {
    const { service, db } = setup({ seedServer: true });

    try {
      const server = db.getServer('a1b2c3d4');
      const choices = service.imageChoicesFor(server);

      assert.equal(choices.length, 2);
      assert.deepEqual(
        choices.map((choice) => choice.image).sort(),
        ['ghcr.io/example/node:20', 'ghcr.io/example/node:22'],
      );
    } finally {
      db.close();
    }
  });

  test('imageChoicesFor returns an empty list for an unknown egg type', () => {

    const { service, db } = setup();

    try {
      assert.deepEqual(service.imageChoicesFor({ egg_type: 'removed' }), []);
    } finally {
      db.close();
    }
  });
});

describe('logs', () => {
  test('returns the first path that yields content', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.logs({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.path, '/logs/latest.log');
      assert.equal(result.content, 'log line one\nlog line two\n');
      assert.equal(
        panel.names().filter((name) => name === 'getFileContents').length,
        1,
        'it should stop at the first success',
      );
    } finally {
      db.close();
    }
  });

  test('tries the next path when a file is absent', async () => {
    let attempts = 0;

    const panel = mockPanel({
      async getFileContents(identifier, filePath) {
        this.calls.push(['getFileContents', identifier, filePath]);
        attempts += 1;

        if (filePath === '/logs/latest.log') {
          throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
        }
        return 'fallback content';
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const result = await service.logs({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.path, '/output.log');
      assert.equal(result.content, 'fallback content');
      assert.equal(attempts, 2);
    } finally {
      db.close();
    }
  });

  test('treats every missing-file status as a reason to try the next path', async () => {
    for (const status of MISSING_FILE_STATUSES) {
      const panel = mockPanel({
        async getFileContents(identifier, filePath) {
          this.calls.push(['getFileContents', identifier, filePath]);

          if (filePath === '/logs/latest.log') {
            throw new AppError('missing', { code: `PANEL_HTTP_${status}`, status });
          }
          return 'fallback';
        },
      });

      const { service, db } = setup({ panel, seedServer: true });

      try {
        const result = await service.logs({ discordId: OWNER, identifier: 'a1b2c3d4' });

        assert.equal(result.path, '/output.log', `status ${status} should fall through`);
      } finally {
        db.close();
      }
    }
  });

  test('propagates a genuine panel fault rather than masking it', async () => {

    const panel = mockPanel({
      async getFileContents() {
        throw new AppError('internal error', { code: 'PANEL_HTTP_500', status: 500 });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.logs({ discordId: OWNER, identifier: 'a1b2c3d4' }),
        (err) => err.status === 500,
      );
    } finally {
      db.close();
    }
  });

  test('propagates network and download-size faults without misreporting a missing log', async () => {
    for (const code of ['PANEL_NETWORK_ETIMEDOUT', 'PANEL_NETWORK_ERR_BAD_RESPONSE']) {
      const panel = mockPanel({ async getFileContents() { throw new AppError('failed', { code }); } });
      const { service, db } = setup({ panel, seedServer: true });
      try {
        await assert.rejects(() => service.logs({ discordId: OWNER, identifier: 'a1b2c3d4' }), { code });
      } finally {
        db.close();
      }
    }
  });

  test('treats an empty file as no content and tries the next path', async () => {
    const panel = mockPanel({
      async getFileContents(identifier, filePath) {
        this.calls.push(['getFileContents', identifier, filePath]);
        return filePath === '/logs/latest.log' ? '' : 'later content';
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const result = await service.logs({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.path, '/output.log');
    } finally {
      db.close();
    }
  });

  test('reports every path tried when none yields content', async () => {
    const panel = mockPanel({
      async getFileContents() {
        throw new AppError('not found', { code: 'PANEL_HTTP_404', status: 404 });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.logs({ discordId: OWNER, identifier: 'a1b2c3d4' }),
        (err) =>
          err instanceof NotFoundError &&
          /\/logs\/latest\.log/.test(err.message) &&
          /\/output\.log/.test(err.message) &&
          /never have started/.test(err.message),
      );
    } finally {
      db.close();
    }
  });

  test('falls back to a default path for an unknown egg type', async () => {

    const { service, panel, db } = setup();

    try {
      db.createServer({
        discordId: OWNER,
        panelServerId: 503,
        identifier: 'dddddddd',
        name: 'Orphan',
        eggType: 'removed',
      });

      await service.logs({ discordId: OWNER, identifier: 'dddddddd' });

      const [, , filePath] = panel.calls.find(([name]) => name === 'getFileContents');

      assert.equal(filePath, '/logs/latest.log');
    } finally {
      db.close();
    }
  });
});

describe('sub-users', () => {
  test('lists a server’s sub-users', async () => {
    const { service, db } = setup({ seedServer: true });

    try {
      const { subusers } = await service.subusers({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(subusers.length, 1);
      assert.equal(subusers[0].email, 'existing@example.test');
    } finally {
      db.close();
    }
  });

  test('adds a sub-user with the configured permissions', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.addSubuser({
        discordId: OWNER,
        identifier: 'a1b2c3d4',
        email: 'friend@example.test',
      });

      assert.equal(result.subuser.email, 'friend@example.test');
      assert.deepEqual([...result.permissions], ['control.console', 'control.start', 'file.read']);

      const [, , email, permissions] = panel.calls.find(([name]) => name === 'createSubuser');

      assert.equal(email, 'friend@example.test');
      assert.deepEqual(permissions, ['control.console', 'control.start', 'file.read']);
    } finally {
      db.close();
    }
  });

  test('normalises the email before use', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      await service.addSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email: '  Friend@Example.TEST  ' });

      const [, , email] = panel.calls.find(([name]) => name === 'createSubuser');

      assert.equal(email, 'friend@example.test');
    } finally {
      db.close();
    }
  });

  test('refuses a duplicate, matching case-insensitively', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.addSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email: 'EXISTING@example.test' }),
        (err) => err instanceof ValidationError && /already a sub-user/.test(err.message),
      );

      assert.ok(!panel.called('createSubuser'));
    } finally {
      db.close();
    }
  });

  test('refuses the owner’s own address', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.addSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email: 'owner@panelkit.local' }),
        (err) => err instanceof ValidationError && /yourself/.test(err.message),
      );

      assert.ok(!panel.called('createSubuser'));
    } finally {
      db.close();
    }
  });

  test('refuses a malformed email before contacting the panel', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      for (const email of ['', 'nope', 'a@b', 'user name@example.test']) {
        await assert.rejects(
          () => service.addSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email }),
          ValidationError,
        );
      }

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('refuses when no permissions are configured', async () => {
    const config = validateConfig({
      colors: { primary: '#2B2D31', error: '#ED4245' },
      eggs: { nodejs: { eggId: 15, nestId: 5, dockerImage: 'node:20' } },
      deploy: { locationId: 1 },
      subuser: { defaultPermissions: [] },
    });

    const { service, panel, db } = setup({ config, seedServer: true });

    try {
      await assert.rejects(
        () => service.addSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email: 'friend@example.test' }),
        (err) => err instanceof ConfigError && /subuser\.defaultPermissions/.test(err.message),
      );

      assert.deepEqual(panel.names(), []);
    } finally {
      db.close();
    }
  });

  test('removes a sub-user by resolving the email to a UUID', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.removeSubuser({
        discordId: OWNER,
        identifier: 'a1b2c3d4',
        email: 'existing@example.test',
      });

      assert.equal(result.email, 'existing@example.test');
      assert.equal(result.username, 'existing');

      const [, , uuid] = panel.calls.find(([name]) => name === 'deleteSubuser');

      assert.equal(uuid, '11111111-2222-3333-4444-555555555555');
    } finally {
      db.close();
    }
  });

  test('refuses to remove an address that is not a sub-user', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      await assert.rejects(
        () => service.removeSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email: 'stranger@example.test' }),
        (err) => err instanceof NotFoundError && /not a sub-user/.test(err.message),
      );

      assert.ok(!panel.called('deleteSubuser'));
    } finally {
      db.close();
    }
  });

  test('two concurrent additions of the same email produce one sub-user', async () => {

    let created = 0;

    const panel = mockPanel({
      async listSubusers(identifier) {
        this.calls.push(['listSubusers', identifier]);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return created > 0 ? [{ uuid: '99999999-8888-7777-6666-555555555555', email: 'friend@example.test', username: 'f', permissions: [] }] : [];
      },
      async createSubuser(identifier, email, permissions) {
        this.calls.push(['createSubuser', identifier, email, permissions]);
        created += 1;
        return { uuid: '99999999-8888-7777-6666-555555555555', email, username: 'f' };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const results = await Promise.allSettled([
        service.addSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email: 'friend@example.test' }),
        service.addSubuser({ discordId: OWNER, identifier: 'a1b2c3d4', email: 'friend@example.test' }),
      ]);

      assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(created, 1, 'only one sub-user should have been created');
    } finally {
      db.close();
    }
  });
});

describe('backup', () => {
  test('archives, downloads and cleans up a small archive', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {
      const result = await service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.inline, true);
      assert.equal(result.buffer.toString('utf8'), 'archive-bytes');
      assert.equal(result.archiveName, 'archive-2026-09-02.tar.gz');

      assert.deepEqual(panel.names(), [
        'listFiles',
        'compressFiles',
        'getDownloadUrl',
        'fetchSignedFile',
        'deleteFiles',
      ]);
    } finally {
      db.close();
    }
  });

  test('compresses every entry in the server root', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      await service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' });

      const [, , payload] = panel.calls.find(([name]) => name === 'compressFiles');

      assert.deepEqual(payload.files.sort(), ['plugins', 'server.jar']);
      assert.equal(payload.root, '/');
    } finally {
      db.close();
    }
  });

  test('delivers a large archive as a link and leaves it in place', async () => {

    const panel = mockPanel({
      async compressFiles(identifier, payload) {
        this.calls.push(['compressFiles', identifier, payload]);
        return { name: 'archive-big.tar.gz', size: 50 * 1024 * 1024 };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const result = await service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.inline, false);
      assert.equal(result.downloadUrl, 'https://node.example.test/download?token=signed');
      assert.equal(result.buffer, undefined);

      assert.ok(!panel.called('fetchSignedFile'), 'an oversized archive must not be downloaded');
      assert.ok(!panel.called('deleteFiles'), 'and must not be deleted while its link is live');
    } finally {
      db.close();
    }
  });

  test('refuses to archive an empty server', async () => {
    const panel = mockPanel({
      async listFiles(identifier, directory) {
        this.calls.push(['listFiles', identifier, directory]);
        return [];
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await assert.rejects(
        () => service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' }),
        (err) => err instanceof ValidationError && /no files to archive/.test(err.message),
      );

      assert.ok(!panel.called('compressFiles'));
    } finally {
      db.close();
    }
  });

  test('still delivers the archive when cleanup fails', async () => {

    const panel = mockPanel({
      async deleteFiles() {
        throw new AppError('unreachable', { code: 'PANEL_NETWORK_ETIMEDOUT' });
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      const result = await service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' });

      assert.equal(result.inline, true);
      assert.equal(result.buffer.toString('utf8'), 'archive-bytes');
    } finally {
      db.close();
    }
  });

  test('requests the download for the archive that was created', async () => {
    const { service, panel, db } = setup({ seedServer: true });

    try {
      await service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' });

      const [, , filePath] = panel.calls.find(([name]) => name === 'getDownloadUrl');

      assert.equal(filePath, '/archive-2026-09-02.tar.gz');
    } finally {
      db.close();
    }
  });

  test('enforces the configured size limit when downloading', async () => {

    const { service, panel, db } = setup({ seedServer: true });

    try {
      await service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' });

      const [, , maxBytes] = panel.calls.find(([name]) => name === 'fetchSignedFile');

      assert.equal(maxBytes, 1024, 'the configured maxInlineBytes should be enforced');
    } finally {
      db.close();
    }
  });

  test('two concurrent backups of one server are serialised', async () => {

    let concurrent = 0;
    let maxConcurrent = 0;

    const panel = mockPanel({
      async compressFiles(identifier, payload) {
        this.calls.push(['compressFiles', identifier, payload]);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 10));
        concurrent -= 1;
        return { name: 'archive.tar.gz', size: 512 };
      },
    });

    const { service, db } = setup({ panel, seedServer: true });

    try {
      await Promise.all([
        service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' }),
        service.backup({ discordId: OWNER, identifier: 'a1b2c3d4' }),
      ]);

      assert.equal(maxConcurrent, 1, 'archiving must not overlap for one server');
    } finally {
      db.close();
    }
  });
});

describe('the shared instance', () => {
  test('initServerService installs a service that getServerService returns', () => {
    const db = createDatabase(':memory:');

    try {
      const created = initServerService({ db, panel: mockPanel(), config: CONFIG, env: ENV });

      assert.equal(getServerService(), created);
    } finally {
      setServerServiceForTests(null);
      db.close();
    }
  });

  test('getServerService refuses before initialisation', () => {
    setServerServiceForTests(null);

    assert.throws(
      () => getServerService(),
      (err) => err instanceof AppError && err.code === 'SERVICE_NOT_READY',
    );
  });
});
