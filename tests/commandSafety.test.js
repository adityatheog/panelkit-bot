import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test, { describe } from 'node:test';
import logsCommand from '../src/commands/definitions/server/logs.js';
import accountDelete from '../src/commands/definitions/account/delete.js';
import serverDelete from '../src/commands/definitions/server/delete.js';
import suspendCommand from '../src/commands/definitions/admin/suspend.js';
import unsuspendCommand from '../src/commands/definitions/admin/unsuspend.js';
import { deleteSession } from '../src/utils/sessions.js';

const OWNER = '111111111111111111';
const server = { identifier: 'a1b2c3d4', name: 'Test Server', egg_type: 'nodejs' };

test('failed bulk suspension requests never claim the servers were already in the requested state', async () => {
  for (const command of [suspendCommand, unsuspendCommand]) {
    const ctx = context();
    ctx.args.user = '222222222222222222';
    ctx.adminService = { async setSuspended() { return { total: 1, changed: 0, skipped: 0, failed: ['a1b2c3d4'] }; } };
    await command.execute(ctx);
    const message = ctx.responses[0].embeds[0].data.description;
    assert.match(message, /No servers were .* by this request/);
    assert.doesNotMatch(message, /the servers were already/);
    assert.equal(ctx.responses[0].embeds[1].data.title, 'Partially Applied');
  }
});

function context() {
  const responses = [];
  const direct = [];
  const collector = new EventEmitter();
  collector.stop = () => {};
  return {
    responses, direct, collector,
    env: { prefix: 'kx!', panelUrl: 'https://panel.example.test', freeServerLimit: 1 },
    config: { eggs: { nodejs: { label: 'Node.js' } }, logs: { maxUploadBytes: 1024 } },
    args: { server: server.identifier },
    user: { id: OWNER, async send(payload) { direct.push(payload); return {}; } },
    async defer() {},
    async respond(payload) { responses.push(payload); },
    async anchorMessage() { return { createMessageComponentCollector: () => collector }; },
    serverService: {
      requireOwnedServer: () => server,
      panelUrlFor: () => 'https://panel.example.test/server/a1b2c3d4',
      listServers: () => [server],
      async info() { return { panel: {}, resources: null }; },
      async logs() { return { server, path: '/logs/latest.log', content: 'private log fixture' }; },
    },
    accountService: { getAccount: () => ({ panel_id: 7, username: 'test', email: 'test@example.test' }) },
  };
}

describe('sensitive log delivery', () => {
  test('sends attachments only through direct messages', async () => {
    const ctx = context();
    await logsCommand.execute(ctx);
    assert.equal(ctx.direct.length, 2);
    assert.equal(ctx.direct[1].files.length, 1);
    assert.equal(ctx.direct[1].files[0].attachment.toString(), 'private log fixture');
    assert.ok(ctx.responses.every((payload) => !payload.files));
    assert.ok(ctx.responses.every((payload) => !JSON.stringify(payload).includes('private log fixture')));
  });

  test('a closed inbox prevents even the log fetch', async () => {
    const ctx = context();
    let fetched = false;
    ctx.user.send = async () => { throw Object.assign(new Error('closed'), { code: 50007 }); };
    ctx.serverService.logs = async () => { fetched = true; };
    await logsCommand.execute(ctx);
    assert.equal(fetched, false);
    assert.ok(ctx.responses.every((payload) => !payload.files));
  });

  test('an inbox closing after the probe never falls back to channel delivery', async () => {
    const ctx = context();
    let sent = 0;
    ctx.user.send = async () => {
      if (++sent === 2) throw new Error('closed');
      return {};
    };
    await logsCommand.execute(ctx);
    assert.equal(sent, 2);
    assert.ok(ctx.responses.every((payload) => !payload.files));
    assert.match(ctx.responses.at(-1).embeds[0].data.description, /nothing was posted/);
  });

  test('ownership is verified before probing an inbox', async () => {
    const ctx = context();
    ctx.serverService.requireOwnedServer = () => { throw new Error('denied'); };
    await assert.rejects(() => logsCommand.execute(ctx), /denied/);
    assert.equal(ctx.direct.length, 0);
  });

  test('keeps the recent log tail within the upload limit', async () => {
    const ctx = context();
    ctx.serverService.logs = async () => ({ server, path: '/logs/latest.log', content: `${'older line\n'.repeat(200)}recent tail\n` });
    await logsCommand.execute(ctx);
    const attachment = ctx.direct[1].files[0].attachment;
    assert.ok(attachment.length <= 1024);
    assert.ok(attachment.toString().endsWith('recent tail\n'));
    assert.ok(ctx.responses.every((payload) => !payload.files));
  });
});

describe('destructive confirmation claims', () => {
  for (const command of [accountDelete, serverDelete]) {
    test(`${command.name} executes only once and ignores foreign clicks`, async () => {
      const ctx = context();
      const calls = [];
      ctx.accountService.deleteAccount = async (...args) => { calls.push(args); return { deletedServers: 1, alreadyGone: 0 }; };
      ctx.serverService.deleteServer = async (...args) => { calls.push(args); return server; };
      await command.execute(ctx);
      const customId = ctx.responses[0].components[0].components[0].data.custom_id;
      const listener = ctx.collector.listeners('collect')[0];
      const interaction = {
        customId, user: { id: OWNER },
        async update() {}, async editReply() {}, async deferUpdate() {}, async reply() {},
      };
      await listener({ ...interaction, user: { id: '222222222222222222' } });
      assert.equal(calls.length, 0);
      await Promise.all([listener(interaction), listener(interaction)]);
      assert.equal(calls.length, 1);
      if (command === accountDelete) {
        assert.deepEqual(calls[0], [OWNER, { expectedPanelId: 7 }]);
      } else {
        assert.equal(calls[0][0].discordId, OWNER);
      }
    });

    test(`${command.name} refuses a confirmation whose session expired`, async () => {
      const ctx = context();
      let called = false;
      ctx.accountService.deleteAccount = async () => { called = true; };
      ctx.serverService.deleteServer = async () => { called = true; };
      await command.execute(ctx);
      const customId = ctx.responses[0].components[0].components[0].data.custom_id;
      deleteSession(customId.split(':').at(-1));
      await ctx.collector.listeners('collect')[0]({ customId, user: { id: OWNER }, async deferUpdate() {} });
      assert.equal(called, false);
    });
  }
});
