// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/services/pterodactyl.js.
 *
 * This module is the only place in the project that knows Pterodactyl's HTTP contracts, so the
 * questions worth asking are about the wire: which credential went to which endpoint, what happened
 * to the response envelope, and what the client did when the panel misbehaved.
 *
 * Those cannot be answered by mocking axios. Replacing the transport verifies that the code calls a
 * function, not that it produces a correct request — and the failures this file exists to catch are
 * precisely the ones that live in the request itself: a key sent to the wrong API, a header
 * forwarded across a redirect, a PATCH that omits fields the panel then clears.
 *
 * So these tests run a real HTTP server on an ephemeral loopback port and point the service at it.
 * No network egress, no credentials, no mocking library — and every assertion is against what
 * actually crossed the socket.
 *
 * Five properties get the most attention:
 *
 *   Credential separation. The Application key must reach /api/application and nothing else; the
 *   Client key must reach /api/client and nothing else.
 *
 *   No header forwarding. Redirects are refused outright, because axios follows them by default and
 *   carries the Authorization header to whatever host the panel names.
 *
 *   PATCH read-back. Pterodactyl's PATCH replaces the whole record, so a partial update silently
 *   clears the omitted fields. This is the most damaging mistake available in the API.
 *
 *   Retry asymmetry. A GET may be replayed after an ambiguous failure; a POST may not.
 *
 *   Signed URLs are not panel URLs. fetchSignedFile talks to a node, so the panel bearer token must
 *   not accompany it.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import test, { afterEach, describe } from 'node:test';

import {
  getPterodactyl,
  initPterodactyl,
  MAX_PER_PAGE,
  PterodactylService,
  setPterodactylForTests,
} from '../src/services/pterodactyl.js';
import { AppError, NotFoundError, ValidationError } from '../src/utils/errors.js';

const APP_KEY = 'ptla_testapplicationkey0000000000000000';
const CLIENT_KEY = 'ptlc_testclientkey00000000000000000000';

/** Servers started during a test, torn down afterwards. */
const openServers = new Set();

afterEach(async () => {
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
        }),
    ),
  );
  openServers.clear();
});

/**
 * Starts a panel double on an ephemeral loopback port.
 *
 * The handler receives the recorded request and returns `{ status, body, headers }`. Every request is
 * recorded in order, which is what lets the tests assert on paths, headers and payloads rather than
 * on call counts alone.
 *
 * @param {(request: { method: string, path: string, query: URLSearchParams, headers: Record<string, string>, body: string }) => { status?: number, body?: unknown, headers?: Record<string, string>, raw?: string }} handler
 * @returns {Promise<{ origin: string, requests: Array<object> }>}
 */
async function startPanel(handler) {
  /** @type {Array<object>} */
  const requests = [];

  const server = http.createServer((incoming, response) => {
    const chunks = [];

    incoming.on('data', (chunk) => chunks.push(chunk));
    incoming.on('end', () => {
      const url = new URL(incoming.url, 'http://localhost');

      const request = {
        method: incoming.method,
        path: url.pathname,
        query: url.searchParams,
        headers: incoming.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(request);

      let result;
      try {
        result = handler(request) ?? {};
      } catch (err) {
        response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ errors: [{ detail: err.message }] }));
        return;
      }

      const status = result.status ?? 200;
      const headers = { 'Content-Type': 'application/json', ...(result.headers ?? {}) };

      response.writeHead(status, headers);

      if (result.raw !== undefined) response.end(result.raw);
      else if (result.body === undefined) response.end();
      else response.end(JSON.stringify(result.body));
    });
  });

  openServers.add(server);

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, requests };
}

/**
 * Builds a service pointed at a panel double.
 *
 * @param {string} origin
 * @param {{ maxRetries?: number, timeoutMs?: number }} [options]
 * @returns {PterodactylService}
 */
function service(origin, { maxRetries = 1, timeoutMs = 5000 } = {}) {
  return new PterodactylService({
    panelUrl: origin,
    appKey: APP_KEY,
    clientKey: CLIENT_KEY,
    timeoutMs,
    maxRetries,
  });
}

/** Wraps a payload in Pterodactyl's single-object envelope. */
function single(attributes) {
  return { object: 'resource', attributes };
}

/** Wraps a payload in Pterodactyl's list envelope. */
function list(items, pagination = {}) {
  return {
    object: 'list',
    data: items.map((attributes) => single(attributes)),
    meta: {
      pagination: {
        total: items.length,
        count: items.length,
        per_page: 50,
        current_page: 1,
        total_pages: 1,
        ...pagination,
      },
    },
  };
}

describe('construction', () => {
  test('requires a panel URL and both keys', () => {
    /**
     * Reached only through a programming error, since loadEnv validates these — but the service must
     * not construct half-configured and fail later on the first request.
     */
    for (const missing of ['panelUrl', 'appKey', 'clientKey']) {
      const options = { panelUrl: 'https://panel.example.com', appKey: APP_KEY, clientKey: CLIENT_KEY };
      delete options[missing];

      assert.throws(
        () => new PterodactylService(options),
        (err) => err instanceof AppError && err.code === 'PTERO_CONFIG',
        `should refuse a missing ${missing}`,
      );
    }
  });

  test('reports which parts were missing without echoing them', () => {
    let caught;

    try {
      new PterodactylService({ panelUrl: 'https://panel.example.com', appKey: APP_KEY, clientKey: '' });
    } catch (err) {
      caught = err;
    }

    assert.equal(caught.details.appKey, true, 'presence is reported');
    assert.equal(caught.details.clientKey, false);
    assert.ok(!JSON.stringify(caught.details).includes(APP_KEY), 'the key value must not appear');
  });

  test('strips a trailing slash from the panel URL', () => {
    assert.equal(service('https://panel.example.com/').panelUrl, 'https://panel.example.com');
    assert.equal(service('https://panel.example.com///').panelUrl, 'https://panel.example.com');
  });

  test('clamps a nonsensical retry count to at least one attempt', () => {
    // Zero attempts would mean every call fails without contacting the panel.
    assert.doesNotThrow(() => service('https://panel.example.com', { maxRetries: 0 }));
    assert.doesNotThrow(() => service('https://panel.example.com', { maxRetries: NaN }));
  });
});

describe('credential separation', () => {
  test('sends the Application key to the application API', async () => {
    const panel = await startPanel(() => ({ body: single({ id: 7, username: 'u', email: 'u@example.test' }) }));

    await service(panel.origin).getApplicationUser(7);

    const [request] = panel.requests;

    assert.equal(request.path, '/api/application/users/7');
    assert.equal(request.headers.authorization, `Bearer ${APP_KEY}`);
  });

  test('sends the Client key to the client API', async () => {
    /**
     * Mixing the two is the most common Pterodactyl integration mistake, and the symptom is a 403 from
     * an endpoint that looks correct.
     */
    const panel = await startPanel(() => ({ body: single({ identifier: 'a1b2c3d4', name: 'Test' }) }));

    await service(panel.origin).getClientServer('a1b2c3d4');

    const [request] = panel.requests;

    assert.equal(request.path, '/api/client/servers/a1b2c3d4');
    assert.equal(request.headers.authorization, `Bearer ${CLIENT_KEY}`);
  });

  test('never sends the Client key to an application endpoint', async () => {
    const panel = await startPanel((request) => {
      if (request.path.startsWith('/api/application')) {
        assert.equal(request.headers.authorization, `Bearer ${APP_KEY}`);
      }
      return { body: single({ id: 1, identifier: 'a1b2c3d4', egg: 15, container: {} }) };
    });

    const client = service(panel.origin);

    await client.getApplicationUser(1);
    await client.getApplicationServer(1);

    for (const request of panel.requests) {
      assert.ok(request.path.startsWith('/api/application'), 'these calls belong to the application API');
      assert.equal(request.headers.authorization, `Bearer ${APP_KEY}`);
    }
  });

  test('identifies itself with a User-Agent', async () => {
    // Panel operators reading their access log should be able to attribute the traffic.
    const panel = await startPanel(() => ({ body: single({ id: 1, username: 'u', email: 'u@x.test' }) }));

    await service(panel.origin).getApplicationUser(1);

    assert.match(panel.requests[0].headers['user-agent'], /PanelKit/);
  });
});

describe('redirects are refused', () => {
  test('does not follow a redirect, so the Authorization header cannot leak', async () => {
    /**
     * The security property behind maxRedirects: 0. Axios follows redirects by default and forwards the
     * Authorization header, so a panel that redirected an API path to another host would hand over the
     * Application key. Refusing turns that into an error.
     */
    const panel = await startPanel((request) => {
      if (request.path === '/api/application/users/7') {
        return { status: 302, headers: { Location: 'http://127.0.0.1:1/stolen' }, body: {} };
      }
      return { status: 200, body: single({ id: 7, username: 'u', email: 'u@x.test' }) };
    });

    await assert.rejects(
      () => service(panel.origin).getApplicationUser(7),
      (err) => err instanceof AppError,
    );

    assert.equal(panel.requests.length, 1, 'the redirect must not have been followed');
  });
});

describe('response envelope unwrapping', () => {
  test('unwraps a single resource into camelCase', async () => {
    /**
     * Callers receive plain objects, so a panel schema change is a one-line edit here rather than a
     * search across command files.
     */
    const panel = await startPanel(() => ({
      body: single({
        id: 42,
        username: 'abcdefghij',
        email: 'abcdefghij@panelkit.local',
        first_name: 'Discord',
        last_name: '111111111111111111',
        root_admin: false,
        created_at: '2026-01-01T00:00:00+00:00',
      }),
    }));

    const user = await service(panel.origin).getApplicationUser(42);

    assert.deepEqual(user, {
      id: 42,
      username: 'abcdefghij',
      email: 'abcdefghij@panelkit.local',
      firstName: 'Discord',
      lastName: '111111111111111111',
      admin: false,
      createdAt: '2026-01-01T00:00:00+00:00',
    });
  });

  test('unwraps a list with its pagination metadata', async () => {
    const panel = await startPanel(() => ({
      body: list(
        [
          { id: 1, identifier: 'aaaaaaaa', name: 'One', user: 7, node: 1, suspended: false },
          { id: 2, identifier: 'bbbbbbbb', name: 'Two', user: 8, node: 1, suspended: true },
        ],
        { total: 40, per_page: 15, current_page: 2, total_pages: 3 },
      ),
    }));

    const result = await service(panel.origin).listAllServers({ page: 2, perPage: 15 });

    assert.equal(result.servers.length, 2);
    assert.equal(result.servers[0].identifier, 'aaaaaaaa');
    assert.equal(result.servers[1].suspended, true);
    assert.deepEqual(result.pagination, {
      total: 40,
      count: 2,
      perPage: 15,
      currentPage: 2,
      totalPages: 3,
    });
  });

  test('reports a missing resource as not found rather than returning undefined', async () => {
    /**
     * A 200 with an empty body would otherwise propagate `undefined` into a command and surface as a
     * property access on nothing.
     */
    const panel = await startPanel(() => ({ status: 200, body: {} }));

    await assert.rejects(() => service(panel.origin).getApplicationUser(7), NotFoundError);
    await assert.rejects(() => service(panel.origin).getClientServer('a1b2c3d4'), NotFoundError);
  });

  test('refuses a create response that omits the identifier', async () => {
    /**
     * Without the identifier the bot cannot record or reach the server, so this is a bad response
     * rather than a success.
     */
    const panel = await startPanel(() => ({ body: single({ id: 501 }) }));

    await assert.rejects(
      () =>
        service(panel.origin).createServer({
          name: 'Test',
          panelUserId: 7,
          eggId: 15,
          dockerImage: 'node:20',
          startup: 'node .',
          environment: {},
          limits: { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 },
          featureLimits: { databases: 1, allocations: 1, backups: 1 },
          deploy: { locationId: 1, dedicatedIp: false, portRange: [] },
        }),
      (err) => err instanceof AppError && err.code === 'PTERO_BAD_RESPONSE',
    );
  });
});

describe('resource readings', () => {
  test('reports absent metrics as null rather than zero', async () => {
    /**
     * The panel omits resource fields for a server that has never booted. Reporting zero would be a
     * measurement the bot cannot support, and the formatters render null as "Unknown".
     */
    const panel = await startPanel(() => ({
      body: single({ current_state: 'offline', is_suspended: false, resources: {} }),
    }));

    const resources = await service(panel.origin).getResources('a1b2c3d4');

    assert.equal(resources.state, 'offline');
    assert.equal(resources.uptimeMs, 0);
    assert.equal(resources.cpuPercent, null);
    assert.equal(resources.memoryBytes, null);
    assert.equal(resources.diskBytes, null);
    assert.equal(resources.networkRxBytes, null);
    assert.equal(resources.networkTxBytes, null);
  });

  test('passes through a genuine zero reading', async () => {
    // A running server with no network traffic really has transferred zero bytes.
    const panel = await startPanel(() => ({
      body: single({
        current_state: 'running',
        resources: { uptime: 5000, cpu_absolute: 0, memory_bytes: 0, network_rx_bytes: 0 },
      }),
    }));

    const resources = await service(panel.origin).getResources('a1b2c3d4');

    assert.equal(resources.cpuPercent, 0, 'zero is a reading, not an absence');
    assert.equal(resources.memoryBytes, 0);
    assert.equal(resources.networkRxBytes, 0);
  });

  test('parses allocations defensively', async () => {
    /**
     * The include payload differs between panel versions, so a missing relationship must yield an empty
     * list rather than throwing.
     */
    const withAllocations = await startPanel(() => ({
      body: single({
        identifier: 'a1b2c3d4',
        name: 'Test',
        relationships: {
          allocations: {
            data: [
              single({ id: 1, ip: '192.0.2.10', port: 25_565, ip_alias: 'play.example.com', is_default: true }),
              single({ id: 2, ip: '192.0.2.10', port: 25_566, ip_alias: null, is_default: false }),
            ],
          },
        },
      }),
    }));

    const server = await service(withAllocations.origin).getClientServer('a1b2c3d4');

    assert.equal(server.allocations.length, 2);
    assert.equal(server.allocations[0].alias, 'play.example.com');
    assert.equal(server.allocations[0].primary, true);
    assert.equal(server.allocations[1].alias, null);

    const without = await startPanel(() => ({ body: single({ identifier: 'a1b2c3d4', name: 'Test' }) }));

    assert.deepEqual((await service(without.origin).getClientServer('a1b2c3d4')).allocations, []);
  });

  test('requests allocations in the include', async () => {
    const panel = await startPanel(() => ({ body: single({ identifier: 'a1b2c3d4', name: 'Test' }) }));

    await service(panel.origin).getClientServer('a1b2c3d4');

    assert.equal(panel.requests[0].query.get('include'), 'allocations');
  });
});

describe('egg variables', () => {
  test('detects a required variable from its validation rules', async () => {
    /**
     * The `required` keyword in the rules string is what lets serverService report a missing mandatory
     * variable as a configuration error before any server is created.
     */
    const panel = await startPanel(() => ({
      body: single({
        id: 15,
        name: 'Node.js',
        docker_image: 'ghcr.io/example/node:20',
        docker_images: { 'Node 20': 'ghcr.io/example/node:20' },
        startup: 'node {{STARTUP_FILE}}',
        relationships: {
          variables: {
            data: [
              single({ name: 'Startup file', env_variable: 'STARTUP_FILE', default_value: 'index.js', rules: 'required|string' }),
              single({ name: 'Optional', env_variable: 'OPTIONAL', default_value: '', rules: 'nullable|string' }),
              single({ name: 'Trailing', env_variable: 'TRAILING', default_value: 'x', rules: 'string|required' }),
            ],
          },
        },
      }),
    }));

    const egg = await service(panel.origin).getEgg(5, 15);

    assert.equal(egg.id, 15);
    assert.equal(egg.dockerImage, 'ghcr.io/example/node:20');
    assert.equal(egg.variables.length, 3);

    assert.equal(egg.variables[0].required, true, 'a leading required rule');
    assert.equal(egg.variables[1].required, false, 'nullable is not required');
    assert.equal(egg.variables[2].required, true, 'a trailing required rule');
  });

  test('does not mistake a rule containing the word for a required rule', async () => {
    /**
     * `required_if` and `required_with` are distinct Laravel rules that do not make a variable
     * unconditionally mandatory. Matching them would report a configuration error for a valid egg.
     */
    const panel = await startPanel(() => ({
      body: single({
        id: 15,
        startup: 'node .',
        relationships: {
          variables: {
            data: [single({ env_variable: 'MAYBE', default_value: '', rules: 'required_if:OTHER,1|string' })],
          },
        },
      }),
    }));

    const egg = await service(panel.origin).getEgg(5, 15);

    assert.equal(egg.variables[0].required, false);
  });

  test('normalises a null default value to an empty string', async () => {
    // serverService compares against '' to decide whether a value is present.
    const panel = await startPanel(() => ({
      body: single({
        id: 15,
        startup: 'node .',
        relationships: { variables: { data: [single({ env_variable: 'EMPTY', default_value: null, rules: 'nullable' })] } },
      }),
    }));

    const egg = await service(panel.origin).getEgg(5, 15);

    assert.equal(egg.variables[0].defaultValue, '');
  });

  test('reports a missing egg with actionable text', async () => {
    const panel = await startPanel(() => ({ status: 404, body: { errors: [{ detail: 'Not found' }] } }));

    await assert.rejects(
      () => service(panel.origin).getEgg(5, 999),
      (err) => err instanceof AppError && /could not find/i.test(err.userMessage),
    );
  });
});

describe('PATCH read-back', () => {
  test('resubmits every user field when changing a password', async () => {
    /**
     * The most damaging mistake available in this API. PATCH /users/{id} replaces the whole record, so
     * sending only { password } clears the email and username — silently, with a 200 response.
     */
    const panel = await startPanel((request) => {
      if (request.method === 'GET') {
        return {
          body: single({
            id: 7,
            username: 'abcdefghij',
            email: 'abcdefghij@panelkit.local',
            first_name: 'Discord',
            last_name: '111111111111111111',
          }),
        };
      }
      return { body: single({ id: 7 }) };
    });

    await service(panel.origin).updateUserPassword(7, 'NewPassword123');

    assert.equal(panel.requests.length, 2, 'the current record must be read first');
    assert.equal(panel.requests[0].method, 'GET');
    assert.equal(panel.requests[1].method, 'PATCH');

    const payload = JSON.parse(panel.requests[1].body);

    assert.equal(payload.email, 'abcdefghij@panelkit.local', 'the email must be preserved');
    assert.equal(payload.username, 'abcdefghij', 'the username must be preserved');
    assert.equal(payload.first_name, 'Discord');
    assert.equal(payload.last_name, '111111111111111111');
    assert.equal(payload.password, 'NewPassword123');
  });

  test('resubmits the startup block when changing a container image', async () => {
    /**
     * Same hazard on the server side. PATCH /servers/{id}/startup requires the full block, so guessing
     * the egg, startup command or environment would silently rewrite the server's configuration.
     */
    const panel = await startPanel((request) => {
      if (request.method === 'GET') {
        return {
          body: single({
            id: 501,
            identifier: 'a1b2c3d4',
            egg: 15,
            container: {
              startup_command: 'node index.js --port {{SERVER_PORT}}',
              image: 'ghcr.io/example/node:20',
              environment: { STARTUP_FILE: 'index.js', SERVER_PORT: '25565' },
            },
          }),
        };
      }
      return { body: single({ id: 501 }) };
    });

    await service(panel.origin).updateServerImage(501, 'ghcr.io/example/node:22');

    const payload = JSON.parse(panel.requests[1].body);

    assert.equal(payload.image, 'ghcr.io/example/node:22', 'only the image changes');
    assert.equal(payload.startup, 'node index.js --port {{SERVER_PORT}}', 'the startup command is preserved');
    assert.equal(payload.egg, 15, 'the egg is preserved');
    assert.deepEqual(payload.environment, { STARTUP_FILE: 'index.js', SERVER_PORT: '25565' });
    assert.equal(payload.skip_scripts, false);
  });
});

describe('server creation', () => {
  test('sends the documented payload shape', async () => {
    const panel = await startPanel(() => ({
      body: single({ id: 501, identifier: 'a1b2c3d4', uuid: 'uuid-value', name: 'My Server' }),
    }));

    const created = await service(panel.origin).createServer({
      name: 'My Server',
      panelUserId: 7,
      eggId: 15,
      dockerImage: 'ghcr.io/example/node:20',
      startup: 'node index.js',
      environment: { STARTUP_FILE: 'index.js' },
      limits: { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 },
      featureLimits: { databases: 1, allocations: 1, backups: 1 },
      deploy: { locationId: 3, dedicatedIp: false, portRange: ['25565-25570'] },
    });

    assert.deepEqual(created, { id: 501, identifier: 'a1b2c3d4', uuid: 'uuid-value', name: 'My Server' });

    const payload = JSON.parse(panel.requests[0].body);

    assert.equal(payload.name, 'My Server');
    assert.equal(payload.user, 7);
    assert.equal(payload.egg, 15);
    assert.equal(payload.docker_image, 'ghcr.io/example/node:20');
    assert.deepEqual(payload.environment, { STARTUP_FILE: 'index.js' });
    assert.deepEqual(payload.limits, { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 });
    assert.deepEqual(payload.feature_limits, { databases: 1, allocations: 1, backups: 1 });
    assert.deepEqual(payload.deploy, { locations: [3], dedicated_ip: false, port_range: ['25565-25570'] });
  });

  test('creates the server stopped', async () => {
    /**
     * A freshly created server should not consume resources before its owner asks for it.
     */
    const panel = await startPanel(() => ({ body: single({ id: 501, identifier: 'a1b2c3d4' }) }));

    await service(panel.origin).createServer({
      name: 'Test',
      panelUserId: 7,
      eggId: 15,
      dockerImage: 'node:20',
      startup: 'node .',
      environment: {},
      limits: { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 },
      featureLimits: { databases: 1, allocations: 1, backups: 1 },
      deploy: { locationId: 1, dedicatedIp: false, portRange: [] },
    });

    assert.equal(JSON.parse(panel.requests[0].body).start_on_completion, false);
  });
});

describe('identifier validation precedes the request', () => {
  test('refuses an invalid identifier without contacting the panel', async () => {
    /**
     * The identifier is interpolated into a URL path. Validating first means a traversal attempt costs
     * no request and cannot reach the panel at all.
     */
    const panel = await startPanel(() => ({ body: single({ identifier: 'a1b2c3d4' }) }));
    const client = service(panel.origin);

    for (const bad of ['', 'short', '../../admin', 'a1b2c3d4/../../x', 'a1b2c3d4?x=1']) {
      await assert.rejects(() => client.getClientServer(bad), ValidationError, `should refuse ${bad}`);
      await assert.rejects(() => client.getResources(bad), ValidationError);
      await assert.rejects(() => client.sendPowerSignal(bad, 'start'), ValidationError);
    }

    assert.equal(panel.requests.length, 0, 'no request should have been made');
  });

  test('refuses an invalid power signal without contacting the panel', async () => {
    const panel = await startPanel(() => ({ status: 204 }));

    await assert.rejects(() => service(panel.origin).sendPowerSignal('a1b2c3d4', 'delete'), ValidationError);

    assert.equal(panel.requests.length, 0);
  });

  test('refuses a relative log path', async () => {
    const panel = await startPanel(() => ({ raw: 'log content' }));

    await assert.rejects(
      () => service(panel.origin).getFileContents('a1b2c3d4', 'logs/latest.log'),
      (err) => err instanceof AppError && err.code === 'PTERO_BAD_PATH',
    );

    assert.equal(panel.requests.length, 0);
  });

  test('refuses a malformed sub-user reference', async () => {
    const panel = await startPanel(() => ({ status: 204 }));

    await assert.rejects(() => service(panel.origin).deleteSubuser('a1b2c3d4', 'not-a-uuid'), ValidationError);

    assert.equal(panel.requests.length, 0);
  });
});

describe('power signals', () => {
  test('posts the signal and tolerates an empty 204 response', async () => {
    // The panel answers 204 with no body, so a client expecting JSON would fail on a success.
    const panel = await startPanel(() => ({ status: 204 }));

    const sent = await service(panel.origin).sendPowerSignal('a1b2c3d4', 'restart');

    assert.equal(sent, 'restart');
    assert.equal(panel.requests[0].path, '/api/client/servers/a1b2c3d4/power');
    assert.deepEqual(JSON.parse(panel.requests[0].body), { signal: 'restart' });
  });

  test('normalises the signal before sending it', async () => {
    const panel = await startPanel(() => ({ status: 204 }));

    await service(panel.origin).sendPowerSignal('a1b2c3d4', 'RESTART');

    assert.deepEqual(JSON.parse(panel.requests[0].body), { signal: 'restart' });
  });
});

describe('file operations', () => {
  test('reads a log file as raw text', async () => {
    /**
     * transformResponse is overridden so axios does not JSON-parse a log whose first line happens to
     * look like JSON — which would silently mangle the file.
     */
    const jsonish = '{"level":"info","msg":"started"}\n{"level":"warn","msg":"slow"}\n';
    const panel = await startPanel(() => ({ raw: jsonish }));

    const contents = await service(panel.origin).getFileContents('a1b2c3d4', '/logs/latest.log');

    assert.equal(typeof contents, 'string', 'the body must stay a string');
    assert.equal(contents, jsonish, 'the content must be byte-identical');
  });

  test('passes the file path as a query parameter', async () => {
    const panel = await startPanel(() => ({ raw: 'content' }));

    await service(panel.origin).getFileContents('a1b2c3d4', '/logs/latest.log');

    assert.equal(panel.requests[0].path, '/api/client/servers/a1b2c3d4/files/contents');
    assert.equal(panel.requests[0].query.get('file'), '/logs/latest.log');
  });

  test('refuses to compress an empty file list', async () => {
    // An empty archive request would produce a zero-byte archive the panel then rejects.
    const panel = await startPanel(() => ({ body: single({ name: 'archive.tar.gz', size: 1024 }) }));

    await assert.rejects(
      () => service(panel.origin).compressFiles('a1b2c3d4', { root: '/', files: [] }),
      (err) => err instanceof AppError && err.code === 'PTERO_NO_FILES',
    );

    assert.equal(panel.requests.length, 0);
  });

  test('treats an empty delete list as a no-op', async () => {
    // Cleanup paths call this with whatever they found; nothing to delete is success.
    const panel = await startPanel(() => ({ status: 204 }));

    assert.equal(await service(panel.origin).deleteFiles('a1b2c3d4', { root: '/', files: [] }), true);
    assert.equal(panel.requests.length, 0);
  });

  test('refuses a download response with no URL', async () => {
    const panel = await startPanel(() => ({ body: single({}) }));

    await assert.rejects(
      () => service(panel.origin).getDownloadUrl('a1b2c3d4', '/archive.tar.gz'),
      (err) => err instanceof AppError && err.code === 'PTERO_BAD_RESPONSE',
    );
  });
});

describe('fetchSignedFile', () => {
  test('does not send the panel Authorization header', async () => {
    /**
     * The signed URL points at a node, not the panel, and already carries its own signature in the
     * query string. Attaching the panel bearer token would send the API key to a different machine
     * for no benefit.
     */
    const node = await startPanel(() => ({ raw: 'archive-bytes' }));
    const panel = await startPanel(() => ({ body: single({ url: `${node.origin}/download?token=signed` }) }));

    const client = service(panel.origin);
    const url = await client.getDownloadUrl('a1b2c3d4', '/archive.tar.gz');
    const buffer = await client.fetchSignedFile(url, 1024 * 1024);

    assert.equal(buffer.toString('utf8'), 'archive-bytes');
    assert.equal(node.requests.length, 1);
    assert.equal(node.requests[0].headers.authorization, undefined, 'no bearer token may accompany a signed URL');
  });

  test('returns a Buffer', async () => {
    const node = await startPanel(() => ({ raw: 'bytes' }));

    const buffer = await service('http://127.0.0.1:1').fetchSignedFile(`${node.origin}/download`, 1024);

    assert.ok(Buffer.isBuffer(buffer));
  });

  test('rejects a non-HTTP URL', async () => {
    const client = service('http://127.0.0.1:1');

    for (const bad of ['file:///etc/passwd', 'ftp://example.com/x', 'not a url', '']) {
      await assert.rejects(
        () => client.fetchSignedFile(bad, 1024),
        (err) => err instanceof AppError && err.code === 'PTERO_BAD_URL',
        `should refuse ${bad}`,
      );
    }
  });

  test('reports an oversized archive distinctly', async () => {
    /**
     * The size limit is enforced by axios itself, so the transfer is aborted rather than buffered. The
     * distinct code lets the command explain that the archive exceeded the configured limit.
     */
    const node = await startPanel(() => ({ raw: 'x'.repeat(4096) }));

    await assert.rejects(
      () => service('http://127.0.0.1:1').fetchSignedFile(`${node.origin}/download`, 128),
      (err) => err instanceof AppError,
    );
  });
});

describe('error normalisation', () => {
  test('maps a panel status to a user-safe message', async () => {
    for (const [status, pattern] of [
      [401, /API credentials/i],
      [403, /permissions/i],
      [404, /could not find/i],
      [409, /busy/i],
      [422, /egg configuration/i],
      [429, /rate limiting/i],
      [500, /internal error/i],
      [503, /temporarily unavailable/i],
    ]) {
      const panel = await startPanel(() => ({ status, body: { errors: [{ detail: 'internal detail' }] } }));

      await assert.rejects(
        () => service(panel.origin).getApplicationUser(7),
        (err) => err instanceof AppError && pattern.test(err.userMessage),
        `status ${status} should produce a matching message`,
      );
    }
  });

  test('captures the panel detail without exposing it', async () => {
    /**
     * The detail names the offending field, which is valuable to an operator and revealing to a user —
     * it can disclose egg and node configuration.
     */
    const panel = await startPanel(() => ({
      status: 422,
      body: { errors: [{ code: 'ValidationException', detail: 'The egg field is required.' }] },
    }));

    let caught;
    try {
      await service(panel.origin).getApplicationUser(7);
    } catch (err) {
      caught = err;
    }

    assert.equal(caught.details.panelDetail, 'The egg field is required.');
    assert.ok(!caught.userMessage.includes('egg field'), 'panel internals must not reach the user');
  });

  test('never places a credential in the thrown error', async () => {
    /**
     * An axios error carries the full request config, including the Authorization header. The service
     * normalises before throwing, so the raw error never escapes.
     */
    const panel = await startPanel(() => ({ status: 500, body: { errors: [{ detail: 'boom' }] } }));

    let caught;
    try {
      await service(panel.origin).getApplicationUser(7);
    } catch (err) {
      caught = err;
    }

    assert.ok(!caught.userMessage.includes(APP_KEY));
    assert.ok(!JSON.stringify(caught.details).includes(APP_KEY));
    assert.ok(!JSON.stringify(caught.toLogObject()).includes(APP_KEY));
  });

  test('reports an unreachable panel as a reachability problem', async () => {
    // Port 1 on loopback refuses connections immediately.
    await assert.rejects(
      () => service('http://127.0.0.1:1').getApplicationUser(7),
      (err) => err instanceof AppError && /could not reach the panel/i.test(err.userMessage),
    );
  });

  test('reports a timeout without hanging', async () => {
    const panel = await startPanel(() => {
      // Never respond; the client's timeout must fire.
      return new Promise(() => {});
    });

    await assert.rejects(
      () => service(panel.origin, { timeoutMs: 150 }).getApplicationUser(7),
      (err) => err instanceof AppError,
    );
  });
});

describe('retry behaviour', () => {
  test('retries a GET after a server error', async () => {
    let attempts = 0;

    const panel = await startPanel(() => {
      attempts += 1;
      if (attempts < 2) return { status: 503, body: { errors: [{ detail: 'unavailable' }] } };
      return { body: single({ id: 7, username: 'u', email: 'u@x.test' }) };
    });

    const user = await service(panel.origin, { maxRetries: 2 }).getApplicationUser(7);

    assert.equal(user.id, 7);
    assert.equal(attempts, 2, 'the read should have been replayed');
  });

  test('does not retry a create after a server error', async () => {
    /**
     * The property that prevents duplicate servers. A 502 does not tell us whether the panel executed
     * the request, so a POST must fail rather than replay.
     */
    let attempts = 0;

    const panel = await startPanel(() => {
      attempts += 1;
      return { status: 502, body: { errors: [{ detail: 'bad gateway' }] } };
    });

    await assert.rejects(() =>
      service(panel.origin, { maxRetries: 3 }).createServer({
        name: 'Test',
        panelUserId: 7,
        eggId: 15,
        dockerImage: 'node:20',
        startup: 'node .',
        environment: {},
        limits: { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 },
        featureLimits: { databases: 1, allocations: 1, backups: 1 },
        deploy: { locationId: 1, dedicatedIp: false, portRange: [] },
      }),
    );

    assert.equal(attempts, 1, 'a create must be attempted exactly once');
  });

  test('does not retry a power signal after a server error', async () => {
    // Replaying a restart would be visible to the user as a second restart.
    let attempts = 0;

    const panel = await startPanel(() => {
      attempts += 1;
      return { status: 500, body: {} };
    });

    await assert.rejects(() => service(panel.origin, { maxRetries: 3 }).sendPowerSignal('a1b2c3d4', 'restart'));

    assert.equal(attempts, 1);
  });

  test('does not retry a 404', async () => {
    // A missing resource fails identically on every attempt.
    let attempts = 0;

    const panel = await startPanel(() => {
      attempts += 1;
      return { status: 404, body: { errors: [{ detail: 'Not found' }] } };
    });

    await assert.rejects(() => service(panel.origin, { maxRetries: 3 }).getApplicationUser(7));

    assert.equal(attempts, 1);
  });

  test('honours a Retry-After header on a rate limit', async () => {
    let attempts = 0;

    const panel = await startPanel(() => {
      attempts += 1;
      if (attempts < 2) return { status: 429, headers: { 'Retry-After': '0' }, body: {} };
      return { body: single({ id: 7, username: 'u', email: 'u@x.test' }) };
    });

    const started = Date.now();
    await service(panel.origin, { maxRetries: 2 }).getApplicationUser(7);

    assert.equal(attempts, 2);
    assert.ok(Date.now() - started < 2000, 'a Retry-After of zero should not impose a long wait');
  });
});

describe('pagination', () => {
  test('caps per_page at the panel maximum', async () => {
    const panel = await startPanel(() => ({ body: list([]) }));

    await service(panel.origin).listAllServers({ page: 1, perPage: 1000 });

    assert.ok(Number(panel.requests[0].query.get('per_page')) <= MAX_PER_PAGE);
  });

  test('filters servers by owner rather than paging the whole panel', async () => {
    /**
     * The documented filter, so finding a handful of servers does not require walking every page of a
     * large panel.
     */
    const panel = await startPanel(() => ({
      body: list([{ id: 1, identifier: 'aaaaaaaa', name: 'One', suspended: false }]),
    }));

    const servers = await service(panel.origin).listServersForUser(7);

    assert.equal(servers.length, 1);
    assert.equal(panel.requests[0].query.get('filter[owner_id]'), '7');
  });

  test('follows every page when listing a user’s servers', async () => {
    let page = 0;

    const panel = await startPanel(() => {
      page += 1;
      return {
        body: list([{ id: page, identifier: `aaaaaaa${page}`, name: `Server ${page}`, suspended: false }], {
          total: 3,
          current_page: page,
          total_pages: 3,
        }),
      };
    });

    const servers = await service(panel.origin).listServersForUser(7);

    assert.equal(servers.length, 3, 'every page should have been collected');
    assert.equal(panel.requests.length, 3);
  });
});

describe('deletion', () => {
  test('deletes a server normally by default', async () => {
    const panel = await startPanel(() => ({ status: 204 }));

    await service(panel.origin).deleteServer(501);

    assert.equal(panel.requests[0].method, 'DELETE');
    assert.equal(panel.requests[0].path, '/api/application/servers/501');
  });

  test('uses the force path only when asked', async () => {
    /**
     * Force skips the node's confirmation and is used only when a normal delete has already failed,
     * so it must never be the default.
     */
    const panel = await startPanel(() => ({ status: 204 }));

    await service(panel.origin).deleteServer(501, { force: true });

    assert.equal(panel.requests[0].path, '/api/application/servers/501/force');
  });
});

describe('credential verification', () => {
  test('verifies both keys independently', async () => {
    /**
     * Reporting each separately is what lets the startup warning name the key at fault, rather than
     * saying the panel is unreachable when one key is simply wrong.
     */
    const panel = await startPanel((request) => {
      if (request.path.startsWith('/api/application')) return { body: list([], { total: 12 }) };
      return { status: 401, body: { errors: [{ detail: 'Unauthenticated' }] } };
    });

    const result = await service(panel.origin).verifyCredentials();

    assert.equal(result.application.ok, true);
    assert.equal(result.application.error, null);
    assert.equal(result.client.ok, false);
    assert.match(result.client.error, /API credentials/i);
  });

  test('reports both as failed when the panel is unreachable', async () => {
    const result = await service('http://127.0.0.1:1').verifyCredentials();

    assert.equal(result.application.ok, false);
    assert.equal(result.client.ok, false);
  });

  test('never includes a key in a verification error', async () => {
    const panel = await startPanel(() => ({ status: 401, body: { errors: [{ detail: 'Unauthenticated' }] } }));

    const result = await service(panel.origin).verifyCredentials();

    assert.ok(!result.application.error.includes(APP_KEY));
    assert.ok(!result.client.error.includes(CLIENT_KEY));
  });

  test('requests a single record, to keep the probe cheap', async () => {
    // Runs on every start, so it must not page the panel.
    const panel = await startPanel(() => ({ body: list([]) }));

    await service(panel.origin).verifyApplicationKey();

    assert.equal(panel.requests[0].query.get('per_page'), '1');
  });
});

describe('the shared instance', () => {
  test('initPterodactyl installs a service that getPterodactyl returns', () => {
    const created = initPterodactyl({
      panelUrl: 'https://panel.example.com',
      appKey: APP_KEY,
      clientKey: CLIENT_KEY,
    });

    assert.equal(getPterodactyl(), created);
    assert.equal(created.panelUrl, 'https://panel.example.com');
  });

  test('getPterodactyl refuses before initialisation', () => {
    /**
     * A clear error beats a TypeError on undefined, since this would only happen through a wiring
     * mistake in the startup sequence.
     */
    setPterodactylForTests(null);

    assert.throws(
      () => getPterodactyl(),
      (err) => err instanceof AppError && err.code === 'PTERO_NOT_READY',
    );
  });

  test('setPterodactylForTests installs a double', () => {
    const double = { panelUrl: 'https://double.example.com' };

    setPterodactylForTests(double);

    assert.equal(getPterodactyl(), double);

    setPterodactylForTests(null);
  });
});
