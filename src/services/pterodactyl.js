// Coded by Aditya | GitHub- @adityatheog

/**
 * Pterodactyl API client.
 *
 * This is the only module in the project that knows Pterodactyl's HTTP contracts.
 * Every other file receives normalised plain objects, which means panel version
 * differences, response envelopes and retry policy stay contained here.
 *
 * The panel exposes two separate APIs, and mixing them is the most common
 * integration mistake:
 *
 *   Application API  /api/application  Administrative. Authenticated with
 *                                      PANEL_APP_KEY. Creates and deletes users
 *                                      and servers, reads nests and eggs,
 *                                      suspends servers.
 *
 *   Client API       /api/client       Per-server, acting as the key's owner.
 *                                      Authenticated with PANEL_CLIENT_KEY. Power
 *                                      actions, live resources, rename, reinstall,
 *                                      sub-users, file operations.
 *
 * Two axios instances are held privately, each with its own key, and no method
 * reaches for the wrong one. Response shapes are unwrapped from the panel's
 * `{ object, attributes }` envelope and returned in camelCase, so a panel schema
 * change is a one-line edit here rather than a search across command files.
 *
 * A note on console logs: Pterodactyl serves live console output over a websocket
 * only. There is no REST endpoint for it. Log retrieval therefore reads a log
 * *file* through the documented file-manager endpoint, with per-egg paths from
 * config.json. That is a real integration, not a stub, but it is not the live
 * console — see README limitations.
 */

import axios from 'axios';
import { AppError, NotFoundError, normalizeApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertValidIdentifier, assertValidPowerSignal, assertValidUuid } from '../utils/validation.js';
import { describeFailure, withRetry } from './retry.js';

/** Panel pagination caps per_page at 100. */
const MAX_PER_PAGE = 100;

/** Guard against a runaway pagination loop if the panel reports inconsistent metadata. */
const MAX_PAGES = 100;

export class PterodactylService {
  /** @type {import('axios').AxiosInstance} */
  #app;

  /** @type {import('axios').AxiosInstance} */
  #client;

  /** @type {string} */
  #panelUrl;

  /** @type {number} */
  #maxAttempts;

  /**
   * @param {object} options
   * @param {string} options.panelUrl normalised panel root, without a trailing slash
   * @param {string} options.appKey PANEL_APP_KEY
   * @param {string} options.clientKey PANEL_CLIENT_KEY
   * @param {number} [options.timeoutMs]
   * @param {number} [options.maxRetries] total attempts per request, including the first
   */
  constructor({ panelUrl, appKey, clientKey, timeoutMs = 15_000, maxRetries = 3 }) {
    if (!panelUrl || !appKey || !clientKey) {
      throw new AppError('The Pterodactyl service is misconfigured.', {
        code: 'PTERO_CONFIG',
        details: {
          panelUrl: Boolean(panelUrl),
          appKey: Boolean(appKey),
          clientKey: Boolean(clientKey),
        },
      });
    }

    this.#panelUrl = String(panelUrl).replace(/\/+$/, '');
    this.#maxAttempts = Math.max(1, Math.trunc(Number(maxRetries) || 1));

    const commonHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'PanelKit-Bot (+https://github.com/adityatheog/panelkit-bot)',
    };

    /**
     * maxRedirects is 0 deliberately. A redirect would forward the Authorization
     * header to whatever host the panel names, so a misconfigured or compromised
     * panel could exfiltrate the API key. A redirect surfaces as an error instead.
     */
    const shared = {
      timeout: Math.max(1000, Number(timeoutMs) || 15_000),
      maxRedirects: 0,
      // The panel answers 4xx with a JSON error envelope worth reading, so let
      // every status through and classify it in one place.
      validateStatus: (status) => status >= 200 && status < 300,
    };

    this.#app = axios.create({
      ...shared,
      baseURL: `${this.#panelUrl}/api/application`,
      headers: { ...commonHeaders, Authorization: `Bearer ${appKey}` },
    });

    this.#client = axios.create({
      ...shared,
      baseURL: `${this.#panelUrl}/api/client`,
      headers: { ...commonHeaders, Authorization: `Bearer ${clientKey}` },
    });
  }

  /** @returns {string} the normalised panel root. */
  get panelUrl() {
    return this.#panelUrl;
  }

  /**
   * Issues one request with the retry policy applied.
   *
   * @param {'app'|'client'} api which credential set to use
   * @param {import('axios').AxiosRequestConfig} config
   * @param {string} label operation name for logs
   * @param {{ allowRetry?: boolean }} [options] allowRetry false forbids replay outright
   * @returns {Promise<unknown>} the parsed response body
   * @throws {AppError} always normalised; never a raw axios error
   */
  async #request(api, config, label, { allowRetry = true } = {}) {
    const http = api === 'app' ? this.#app : this.#client;
    const method = String(config.method ?? 'get').toUpperCase();

    try {
      return await withRetry(
        async () => {
          const response = await http.request(config);
          return response.data;
        },
        {
          maxAttempts: this.#maxAttempts,
          method,
          allowRetry,
          onRetry: ({ attempt, status, code, delayMs }) => {
            logger.warn('Retrying panel request', { api, label, method, url: config.url, attempt, status, code, delayMs });
          },
        },
      );
    } catch (err) {
      const { status, code } = describeFailure(err);
      const normalized = normalizeApiError(err, label);

      // Status and code only. The axios error carries the request config, which
      // holds the Authorization header, so the raw error is never logged.
      logger.error('Panel request failed', {
        api,
        label,
        method,
        url: config.url,
        status,
        code,
        panelDetail: normalized.detail,
      });

      throw normalized.error;
    }
  }

  /**
   * Walks a paginated Application API collection.
   *
   * @param {string} url
   * @param {object} [options]
   * @param {Record<string, unknown>} [options.params]
   * @param {number} [options.perPage]
   * @param {number} [options.maxItems] stop early once this many items are collected
   * @param {string} [options.label]
   * @returns {Promise<{ data: unknown[], pagination: object }>}
   */
  async #paginateApp(url, { params = {}, perPage = 50, maxItems = Infinity, label = 'paginate' } = {}) {
    const size = Math.min(MAX_PER_PAGE, Math.max(1, Number(perPage) || 50));
    const collected = [];
    let pagination = { total: 0, count: 0, perPage: size, currentPage: 1, totalPages: 1 };

    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const body = await this.#request(
        'app',
        { method: 'GET', url, params: { ...params, page, per_page: size } },
        `${label}:page${page}`,
      );

      const meta = body?.meta?.pagination ?? {};
      pagination = {
        total: Number(meta.total ?? 0),
        count: Number(meta.count ?? 0),
        perPage: Number(meta.per_page ?? size),
        currentPage: Number(meta.current_page ?? page),
        totalPages: Number(meta.total_pages ?? 1),
      };

      collected.push(...(Array.isArray(body?.data) ? body.data : []));

      if (collected.length >= maxItems) break;
      if (pagination.currentPage >= pagination.totalPages) break;
    }

    return { data: collected.slice(0, Number.isFinite(maxItems) ? maxItems : undefined), pagination };
  }

  // ==========================================================================
  // Application API — users
  // ==========================================================================

  /**
   * Creates a panel user.
   *
   * Never retried: a replayed POST after an ambiguous failure would create a
   * second account with a different password, orphaning the first.
   *
   * @param {{ email: string, username: string, firstName: string, lastName: string, password: string }} input
   * @returns {Promise<{ id: number, username: string, email: string }>}
   */
  async createUser({ email, username, firstName, lastName, password }) {
    const body = await this.#request(
      'app',
      {
        method: 'POST',
        url: '/users',
        data: {
          email,
          username,
          first_name: firstName,
          last_name: lastName,
          password,
        },
      },
      'createUser',
      { allowRetry: false },
    );

    const attributes = body?.attributes;
    if (!attributes?.id) {
      throw new AppError('The panel did not return a user id.', { code: 'PTERO_BAD_RESPONSE', details: { label: 'createUser' } });
    }

    return { id: Number(attributes.id), username: String(attributes.username), email: String(attributes.email) };
  }

  /**
   * Reads a panel user.
   *
   * @param {number} panelUserId
   * @returns {Promise<{ id: number, username: string, email: string, firstName: string, lastName: string, admin: boolean, createdAt: string }>}
   */
  async getApplicationUser(panelUserId) {
    const body = await this.#request('app', { method: 'GET', url: `/users/${Number(panelUserId)}` }, 'getApplicationUser');

    const attributes = body?.attributes;
    if (!attributes) throw new NotFoundError('That panel account no longer exists.');

    return {
      id: Number(attributes.id),
      username: String(attributes.username ?? ''),
      email: String(attributes.email ?? ''),
      firstName: String(attributes.first_name ?? ''),
      lastName: String(attributes.last_name ?? ''),
      admin: Boolean(attributes.root_admin),
      createdAt: String(attributes.created_at ?? ''),
    };
  }

  /**
   * Changes a panel user's password.
   *
   * PATCH /users/{id} replaces the whole record: omitted fields are cleared. The
   * current values are read back first and resubmitted so only the password
   * changes. Sending just `{ password }` would blank the email and username.
   *
   * @param {number} panelUserId
   * @param {string} newPassword
   * @returns {Promise<true>}
   */
  async updateUserPassword(panelUserId, newPassword) {
    const current = await this.getApplicationUser(panelUserId);

    await this.#request(
      'app',
      {
        method: 'PATCH',
        url: `/users/${Number(panelUserId)}`,
        data: {
          email: current.email,
          username: current.username,
          first_name: current.firstName,
          last_name: current.lastName,
          password: newPassword,
        },
      },
      'updateUserPassword',
      { allowRetry: false },
    );

    return true;
  }

  /**
   * Deletes a panel user. The panel refuses while the user still owns servers.
   *
   * @param {number} panelUserId
   * @returns {Promise<true>}
   */
  async deleteUser(panelUserId) {
    await this.#request('app', { method: 'DELETE', url: `/users/${Number(panelUserId)}` }, 'deleteUser');
    return true;
  }

  // ==========================================================================
  // Application API — nests and eggs
  // ==========================================================================

  /**
   * Reads an egg together with its variables.
   *
   * The variables are what make provisioning work without hardcoding: the egg
   * declares which environment values it needs and their defaults, and
   * serverService merges config.json overrides on top. `rules` is parsed for the
   * `required` keyword so a missing mandatory variable is reported as a
   * configuration problem before any server is created.
   *
   * @param {number} nestId
   * @param {number} eggId
   * @returns {Promise<{ id: number, name: string, dockerImage: string, dockerImages: Record<string, string>, startup: string, variables: Array<{ name: string, envVariable: string, defaultValue: string, required: boolean, rules: string }> }>}
   */
  async getEgg(nestId, eggId) {
    const body = await this.#request(
      'app',
      { method: 'GET', url: `/nests/${Number(nestId)}/eggs/${Number(eggId)}`, params: { include: 'variables' } },
      'getEgg',
    );

    const attributes = body?.attributes;
    if (!attributes) throw new NotFoundError('That egg does not exist on the panel. Check eggId and nestId in config.json.');

    const variables = (attributes.relationships?.variables?.data ?? []).map((entry) => {
      const variable = entry?.attributes ?? {};
      const rules = String(variable.rules ?? '');
      return {
        name: String(variable.name ?? ''),
        envVariable: String(variable.env_variable ?? ''),
        defaultValue: variable.default_value === null || variable.default_value === undefined ? '' : String(variable.default_value),
        required: /(^|\|)required(\||$)/i.test(rules),
        rules,
      };
    });

    return {
      id: Number(attributes.id),
      name: String(attributes.name ?? ''),
      dockerImage: String(attributes.docker_image ?? ''),
      dockerImages: attributes.docker_images && typeof attributes.docker_images === 'object' ? attributes.docker_images : {},
      startup: String(attributes.startup ?? ''),
      variables,
    };
  }

  // ==========================================================================
  // Application API — servers
  // ==========================================================================

  /**
   * Provisions a server.
   *
   * Never retried, for the same reason as createUser: an ambiguous failure could
   * leave a server created on the panel with no local record, and a replay would
   * create a second one.
   *
   * `start_on_completion` is false so a freshly created server does not consume
   * resources before its owner asks for it.
   *
   * @param {object} input
   * @param {string} input.name
   * @param {number} input.panelUserId
   * @param {number} input.eggId
   * @param {string} input.dockerImage
   * @param {string} input.startup
   * @param {Record<string, string>} input.environment
   * @param {{ memory: number, swap: number, disk: number, io: number, cpu: number }} input.limits
   * @param {{ databases: number, allocations: number, backups: number }} input.featureLimits
   * @param {{ locationId: number, dedicatedIp: boolean, portRange: string[] }} input.deploy
   * @returns {Promise<{ id: number, identifier: string, uuid: string, name: string }>}
   */
  async createServer({
    name,
    panelUserId,
    eggId,
    dockerImage,
    startup,
    environment,
    limits,
    featureLimits,
    deploy,
  }) {
    const body = await this.#request(
      'app',
      {
        method: 'POST',
        url: '/servers',
        data: {
          name,
          user: Number(panelUserId),
          egg: Number(eggId),
          docker_image: dockerImage,
          startup,
          environment,
          limits: {
            memory: Number(limits.memory),
            swap: Number(limits.swap),
            disk: Number(limits.disk),
            io: Number(limits.io),
            cpu: Number(limits.cpu),
          },
          feature_limits: {
            databases: Number(featureLimits.databases),
            allocations: Number(featureLimits.allocations),
            backups: Number(featureLimits.backups),
          },
          deploy: {
            locations: [Number(deploy.locationId)],
            dedicated_ip: Boolean(deploy.dedicatedIp),
            port_range: Array.isArray(deploy.portRange) ? deploy.portRange : [],
          },
          start_on_completion: false,
          skip_scripts: false,
          oom_disabled: false,
        },
      },
      'createServer',
      { allowRetry: false },
    );

    const attributes = body?.attributes;
    if (!attributes?.id || !attributes?.identifier) {
      throw new AppError('The panel did not return valid server details.', {
        code: 'PTERO_BAD_RESPONSE',
        details: { label: 'createServer' },
      });
    }

    return {
      id: Number(attributes.id),
      identifier: String(attributes.identifier),
      uuid: String(attributes.uuid ?? ''),
      name: String(attributes.name ?? name),
    };
  }

  /**
   * Reads a server through the Application API, including its container config.
   *
   * @param {number} panelServerId
   * @returns {Promise<object>}
   */
  async getApplicationServer(panelServerId) {
    const body = await this.#request(
      'app',
      { method: 'GET', url: `/servers/${Number(panelServerId)}` },
      'getApplicationServer',
    );

    const attributes = body?.attributes;
    if (!attributes) throw new NotFoundError('That server no longer exists on the panel.');

    return {
      id: Number(attributes.id),
      identifier: String(attributes.identifier ?? ''),
      uuid: String(attributes.uuid ?? ''),
      name: String(attributes.name ?? ''),
      description: String(attributes.description ?? ''),
      eggId: Number(attributes.egg),
      nodeId: Number(attributes.node),
      userId: Number(attributes.user),
      suspended: Boolean(attributes.suspended),
      limits: attributes.limits ?? {},
      featureLimits: attributes.feature_limits ?? {},
      container: {
        startupCommand: String(attributes.container?.startup_command ?? ''),
        image: String(attributes.container?.image ?? ''),
        installed: Boolean(attributes.container?.installed),
        environment:
          attributes.container?.environment && typeof attributes.container.environment === 'object'
            ? attributes.container.environment
            : {},
      },
    };
  }

  /**
   * Changes a server's container image.
   *
   * PATCH /servers/{id}/startup requires the complete startup block, so the
   * current egg, startup command and environment are read back and resubmitted
   * with only the image replaced. Guessing those values would silently rewrite
   * the server's configuration.
   *
   * @param {number} panelServerId
   * @param {string} newImage an image from the config.json allowlist
   * @returns {Promise<true>}
   */
  async updateServerImage(panelServerId, newImage) {
    const current = await this.getApplicationServer(panelServerId);

    await this.#request(
      'app',
      {
        method: 'PATCH',
        url: `/servers/${Number(panelServerId)}/startup`,
        data: {
          startup: current.container.startupCommand,
          environment: current.container.environment,
          egg: current.eggId,
          image: newImage,
          skip_scripts: false,
        },
      },
      'updateServerImage',
      { allowRetry: false },
    );

    return true;
  }

  /**
   * Deletes a server.
   *
   * @param {number} panelServerId
   * @param {{ force?: boolean }} [options] force skips the node's confirmation, used only when a normal delete has already failed
   * @returns {Promise<true>}
   */
  async deleteServer(panelServerId, { force = false } = {}) {
    const suffix = force ? '/force' : '';
    await this.#request(
      'app',
      { method: 'DELETE', url: `/servers/${Number(panelServerId)}${suffix}` },
      force ? 'deleteServerForce' : 'deleteServer',
    );
    return true;
  }

  /**
   * Lists servers across the whole panel, one page at a time.
   *
   * @param {{ page?: number, perPage?: number }} [options]
   * @returns {Promise<{ servers: Array<object>, pagination: object }>}
   */
  async listAllServers({ page = 1, perPage = 15 } = {}) {
    const size = Math.min(MAX_PER_PAGE, Math.max(1, Number(perPage) || 15));

    const body = await this.#request(
      'app',
      { method: 'GET', url: '/servers', params: { page: Math.max(1, Number(page) || 1), per_page: size } },
      'listAllServers',
    );

    const meta = body?.meta?.pagination ?? {};

    return {
      servers: (Array.isArray(body?.data) ? body.data : []).map((entry) => {
        const attributes = entry?.attributes ?? {};
        return {
          id: Number(attributes.id),
          identifier: String(attributes.identifier ?? ''),
          name: String(attributes.name ?? ''),
          ownerId: Number(attributes.user),
          nodeId: Number(attributes.node),
          suspended: Boolean(attributes.suspended),
        };
      }),
      pagination: {
        total: Number(meta.total ?? 0),
        count: Number(meta.count ?? 0),
        perPage: Number(meta.per_page ?? size),
        currentPage: Number(meta.current_page ?? page),
        totalPages: Number(meta.total_pages ?? 1),
      },
    };
  }

  /**
   * Lists every server owned by one panel user.
   *
   * Uses the documented filter so the whole panel is not paged through to find a
   * handful of servers.
   *
   * @param {number} panelUserId
   * @returns {Promise<Array<object>>}
   */
  async listServersForUser(panelUserId) {
    const { data } = await this.#paginateApp('/servers', {
      params: { 'filter[owner_id]': Number(panelUserId) },
      perPage: MAX_PER_PAGE,
      label: 'listServersForUser',
    });

    return data.map((entry) => {
      const attributes = entry?.attributes ?? {};
      return {
        id: Number(attributes.id),
        identifier: String(attributes.identifier ?? ''),
        name: String(attributes.name ?? ''),
        suspended: Boolean(attributes.suspended),
      };
    });
  }

  /**
   * Suspends a server. The panel answers 409 when it is already suspended, which
   * adminService treats as a no-op rather than a failure.
   *
   * @param {number} panelServerId
   * @returns {Promise<true>}
   */
  async suspendServer(panelServerId) {
    await this.#request('app', { method: 'POST', url: `/servers/${Number(panelServerId)}/suspend` }, 'suspendServer', {
      allowRetry: false,
    });
    return true;
  }

  /**
   * Unsuspends a server.
   *
   * @param {number} panelServerId
   * @returns {Promise<true>}
   */
  async unsuspendServer(panelServerId) {
    await this.#request('app', { method: 'POST', url: `/servers/${Number(panelServerId)}/unsuspend` }, 'unsuspendServer', {
      allowRetry: false,
    });
    return true;
  }

  // ==========================================================================
  // Client API — server state
  // ==========================================================================

  /**
   * Reads a server as its owner sees it, including allocations.
   *
   * The installing, suspended and transferring flags are read before every power
   * action: the panel rejects those requests with an opaque 409, and checking
   * first produces a message that explains what to do.
   *
   * @param {string} identifier
   * @returns {Promise<object>}
   */
  async getClientServer(identifier) {
    const id = assertValidIdentifier(identifier);

    const body = await this.#request(
      'client',
      { method: 'GET', url: `/servers/${id}`, params: { include: 'allocations' } },
      'getClientServer',
    );

    const attributes = body?.attributes;
    if (!attributes) throw new NotFoundError('That server could not be found on the panel.');

    return {
      identifier: String(attributes.identifier ?? id),
      uuid: String(attributes.uuid ?? ''),
      name: String(attributes.name ?? ''),
      description: String(attributes.description ?? ''),
      node: String(attributes.node ?? ''),
      isInstalling: Boolean(attributes.is_installing),
      isSuspended: Boolean(attributes.is_suspended),
      isTransferring: Boolean(attributes.is_transferring),
      limits: attributes.limits ?? {},
      featureLimits: attributes.feature_limits ?? {},
      // Parsed defensively: the include payload differs between panel versions.
      allocations: (attributes.relationships?.allocations?.data ?? []).map((entry) => {
        const allocation = entry?.attributes ?? {};
        return {
          id: Number(allocation.id ?? 0),
          ip: String(allocation.ip ?? 'unknown'),
          port: Number(allocation.port ?? 0),
          alias: allocation.ip_alias === null || allocation.ip_alias === undefined ? null : String(allocation.ip_alias),
          primary: Boolean(allocation.is_default),
        };
      }),
    };
  }

  /**
   * Sends a power signal. Returns 204 with no body.
   *
   * @param {string} identifier
   * @param {'start'|'stop'|'restart'|'kill'} signal
   * @returns {Promise<string>} the signal that was sent
   */
  async sendPowerSignal(identifier, signal) {
    const id = assertValidIdentifier(identifier);
    const safeSignal = assertValidPowerSignal(signal);

    await this.#request(
      'client',
      { method: 'POST', url: `/servers/${id}/power`, data: { signal: safeSignal } },
      'sendPowerSignal',
      { allowRetry: false },
    );

    return safeSignal;
  }

  /**
   * Reads live resource usage.
   *
   * Fields are null rather than zero when the panel omits them, which happens for
   * a server that has never started. The formatters render null as "Unknown", so
   * a missing metric does not read as a real measurement of zero.
   *
   * @param {string} identifier
   * @returns {Promise<{ state: string, isSuspended: boolean, uptimeMs: number, cpuPercent: number|null, memoryBytes: number|null, diskBytes: number|null, networkRxBytes: number|null, networkTxBytes: number|null }>}
   */
  async getResources(identifier) {
    const id = assertValidIdentifier(identifier);

    const body = await this.#request('client', { method: 'GET', url: `/servers/${id}/resources` }, 'getResources');

    const attributes = body?.attributes ?? {};
    const resources = attributes.resources ?? {};

    const numberOrNull = (value) => (value === null || value === undefined ? null : Number(value));

    return {
      state: String(attributes.current_state ?? 'unknown'),
      isSuspended: Boolean(attributes.is_suspended),
      uptimeMs: Number(resources.uptime ?? 0),
      cpuPercent: numberOrNull(resources.cpu_absolute),
      memoryBytes: numberOrNull(resources.memory_bytes),
      diskBytes: numberOrNull(resources.disk_bytes),
      networkRxBytes: numberOrNull(resources.network_rx_bytes),
      networkTxBytes: numberOrNull(resources.network_tx_bytes),
    };
  }

  /**
   * Renames a server through the Client API, so the change is attributed to the
   * owner in the panel's activity log rather than to an administrator.
   *
   * @param {string} identifier
   * @param {string} name a name already validated by assertValidServerName
   * @returns {Promise<true>}
   */
  async renameServer(identifier, name) {
    const id = assertValidIdentifier(identifier);

    await this.#request(
      'client',
      { method: 'POST', url: `/servers/${id}/settings/rename`, data: { name } },
      'renameServer',
      { allowRetry: false },
    );

    return true;
  }

  /**
   * Reinstalls a server. Destructive: the install script reruns and files are lost.
   *
   * @param {string} identifier
   * @returns {Promise<true>}
   */
  async reinstallServer(identifier) {
    const id = assertValidIdentifier(identifier);

    await this.#request('client', { method: 'POST', url: `/servers/${id}/settings/reinstall` }, 'reinstallServer', {
      allowRetry: false,
    });

    return true;
  }

  // ==========================================================================
  // Client API — sub-users
  // ==========================================================================

  /**
   * Lists a server's sub-users.
   *
   * @param {string} identifier
   * @returns {Promise<Array<{ uuid: string, email: string, username: string, permissions: string[] }>>}
   */
  async listSubusers(identifier) {
    const id = assertValidIdentifier(identifier);

    const body = await this.#request('client', { method: 'GET', url: `/servers/${id}/users` }, 'listSubusers');

    return (Array.isArray(body?.data) ? body.data : []).map((entry) => {
      const attributes = entry?.attributes ?? {};
      return {
        uuid: String(attributes.uuid ?? ''),
        email: String(attributes.email ?? ''),
        username: String(attributes.username ?? ''),
        permissions: Array.isArray(attributes.permissions) ? attributes.permissions.map(String) : [],
      };
    });
  }

  /**
   * Grants a panel account access to a server.
   *
   * The target must already have a panel account; Pterodactyl does not create one
   * implicitly and answers with a validation error otherwise.
   *
   * @param {string} identifier
   * @param {string} email
   * @param {readonly string[]} permissions from config.json subuser.defaultPermissions
   * @returns {Promise<{ uuid: string, email: string, username: string }>}
   */
  async createSubuser(identifier, email, permissions) {
    const id = assertValidIdentifier(identifier);

    const body = await this.#request(
      'client',
      { method: 'POST', url: `/servers/${id}/users`, data: { email, permissions: [...permissions] } },
      'createSubuser',
      { allowRetry: false },
    );

    const attributes = body?.attributes;
    if (!attributes?.uuid) {
      throw new AppError('The panel did not return the new sub-user.', {
        code: 'PTERO_BAD_RESPONSE',
        details: { label: 'createSubuser' },
      });
    }

    return {
      uuid: String(attributes.uuid),
      email: String(attributes.email ?? email),
      username: String(attributes.username ?? ''),
    };
  }

  /**
   * Revokes a sub-user's access.
   *
   * @param {string} identifier
   * @param {string} subuserUuid
   * @returns {Promise<true>}
   */
  async deleteSubuser(identifier, subuserUuid) {
    const id = assertValidIdentifier(identifier);
    const uuid = assertValidUuid(subuserUuid);

    await this.#request('client', { method: 'DELETE', url: `/servers/${id}/users/${uuid}` }, 'deleteSubuser');
    return true;
  }

  // ==========================================================================
  // Client API — files
  // ==========================================================================

  /**
   * Lists a directory on the server.
   *
   * @param {string} identifier
   * @param {string} [directory]
   * @returns {Promise<Array<{ name: string, size: number, isFile: boolean, mode: string, modifiedAt: string }>>}
   */
  async listFiles(identifier, directory = '/') {
    const id = assertValidIdentifier(identifier);

    const body = await this.#request(
      'client',
      { method: 'GET', url: `/servers/${id}/files/list`, params: { directory } },
      'listFiles',
    );

    return (Array.isArray(body?.data) ? body.data : []).map((entry) => {
      const attributes = entry?.attributes ?? {};
      return {
        name: String(attributes.name ?? ''),
        size: Number(attributes.size ?? 0),
        isFile: Boolean(attributes.is_file),
        mode: String(attributes.mode ?? ''),
        modifiedAt: String(attributes.modified_at ?? ''),
      };
    });
  }

  /**
   * Reads a file as UTF-8 text.
   *
   * transformResponse is overridden to keep the body as a raw string. Axios would
   * otherwise attempt to JSON-parse a log file whose first line happens to look
   * like JSON, silently mangling it.
   *
   * @param {string} identifier
   * @param {string} filePath an absolute path
   * @returns {Promise<string>}
   */
  async getFileContents(identifier, filePath) {
    const id = assertValidIdentifier(identifier);

    if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
      throw new AppError('Invalid file path configured for this server type.', {
        code: 'PTERO_BAD_PATH',
        details: { filePath: String(filePath) },
      });
    }

    const body = await this.#request(
      'client',
      {
        method: 'GET',
        url: `/servers/${id}/files/contents`,
        params: { file: filePath },
        responseType: 'text',
        transformResponse: [(raw) => raw],
      },
      'getFileContents',
    );

    return typeof body === 'string' ? body : String(body ?? '');
  }

  /**
   * Creates a compressed archive of the given entries.
   *
   * @param {string} identifier
   * @param {{ root?: string, files: string[] }} input
   * @returns {Promise<{ name: string, size: number }>}
   */
  async compressFiles(identifier, { root = '/', files }) {
    const id = assertValidIdentifier(identifier);

    if (!Array.isArray(files) || files.length === 0) {
      throw new AppError('There are no files to archive on that server.', { code: 'PTERO_NO_FILES' });
    }

    const body = await this.#request(
      'client',
      { method: 'POST', url: `/servers/${id}/files/compress`, data: { root, files: files.map(String) } },
      'compressFiles',
      { allowRetry: false },
    );

    const attributes = body?.attributes;
    if (!attributes?.name) {
      throw new AppError('The panel did not return the archive details.', {
        code: 'PTERO_BAD_RESPONSE',
        details: { label: 'compressFiles' },
      });
    }

    return { name: String(attributes.name), size: Number(attributes.size ?? 0) };
  }

  /**
   * Deletes files, used to clean up a temporary archive.
   *
   * @param {string} identifier
   * @param {{ root?: string, files: string[] }} input
   * @returns {Promise<true>}
   */
  async deleteFiles(identifier, { root = '/', files }) {
    const id = assertValidIdentifier(identifier);

    if (!Array.isArray(files) || files.length === 0) return true;

    await this.#request(
      'client',
      { method: 'POST', url: `/servers/${id}/files/delete`, data: { root, files: files.map(String) } },
      'deleteFiles',
      { allowRetry: false },
    );

    return true;
  }

  /**
   * Requests a short-lived signed download URL.
   *
   * The returned URL grants file access without any header, so it is a credential:
   * it is delivered only by DM, never logged, and never posted in a channel.
   *
   * @param {string} identifier
   * @param {string} filePath
   * @returns {Promise<string>}
   */
  async getDownloadUrl(identifier, filePath) {
    const id = assertValidIdentifier(identifier);

    if (typeof filePath !== 'string' || !filePath.startsWith('/')) {
      throw new AppError('Invalid file path.', { code: 'PTERO_BAD_PATH' });
    }

    const body = await this.#request(
      'client',
      { method: 'GET', url: `/servers/${id}/files/download`, params: { file: filePath } },
      'getDownloadUrl',
    );

    const url = body?.attributes?.url;
    if (!url) {
      throw new AppError('The panel did not return a download link.', {
        code: 'PTERO_BAD_RESPONSE',
        details: { label: 'getDownloadUrl' },
      });
    }

    return String(url);
  }

  /**
   * Downloads a file from a signed URL.
   *
   * Deliberately uses a bare axios call rather than either configured instance: the
   * URL points at the node, not the panel, and already carries its own signature.
   * Sending the panel Authorization header to a node would leak the API key.
   *
   * @param {string} url a URL previously returned by getDownloadUrl
   * @param {number} maxBytes refuse anything larger, enforced by axios itself
   * @returns {Promise<Buffer>}
   */
  async fetchSignedFile(url, maxBytes) {
    let target;
    try {
      target = new URL(String(url));
    } catch {
      throw new AppError('The panel returned an unusable download link.', { code: 'PTERO_BAD_URL' });
    }

    if (!['http:', 'https:'].includes(target.protocol)) {
      throw new AppError('The panel returned an unusable download link.', { code: 'PTERO_BAD_URL' });
    }

    const limit = Math.max(1, Number(maxBytes) || 1);

    try {
      const response = await axios.get(target.toString(), {
        responseType: 'arraybuffer',
        timeout: 120_000,
        maxContentLength: limit,
        maxBodyLength: limit,
        maxRedirects: 0,
        headers: { Accept: 'application/octet-stream' },
      });

      return Buffer.from(response.data);
    } catch (err) {
      const normalized = normalizeApiError(err, 'fetchSignedFile');
      logger.error('Archive download failed', { status: normalized.status, code: normalized.code });

      if (err?.code === 'ERR_FR_MAX_CONTENT_LENGTH_EXCEEDED') {
        throw new AppError('The archive is larger than the configured limit.', {
          code: 'PTERO_FILE_TOO_LARGE',
          details: { limit },
        });
      }

      throw normalized.error;
    }
  }

  // ==========================================================================
  // Diagnostics
  // ==========================================================================

  /**
   * Verifies the panel URL and the Application API key.
   *
   * Requests a single user, which is the cheapest authenticated Application API
   * call. Called once at startup so a wrong key or URL is reported immediately
   * rather than at a user's first command.
   *
   * @returns {Promise<{ ok: true, users: number }>}
   */
  async verifyApplicationKey() {
    const body = await this.#request('app', { method: 'GET', url: '/users', params: { per_page: 1 } }, 'verifyApplicationKey');
    return { ok: true, users: Number(body?.meta?.pagination?.total ?? 0) };
  }

  /**
   * Verifies the Client API key.
   *
   * @returns {Promise<{ ok: true, servers: number }>}
   */
  async verifyClientKey() {
    const body = await this.#request('client', { method: 'GET', url: '/', params: { per_page: 1 } }, 'verifyClientKey');
    return { ok: true, servers: Number(body?.meta?.pagination?.total ?? 0) };
  }

  /**
   * Verifies both keys, reporting each independently so a partial
   * misconfiguration names the key at fault.
   *
   * @returns {Promise<{ application: { ok: boolean, error: string|null }, client: { ok: boolean, error: string|null } }>}
   */
  async verifyCredentials() {
    const result = {
      application: { ok: false, error: null },
      client: { ok: false, error: null },
    };

    try {
      await this.verifyApplicationKey();
      result.application.ok = true;
    } catch (err) {
      result.application.error = err?.userMessage ?? 'Verification failed.';
    }

    try {
      await this.verifyClientKey();
      result.client.ok = true;
    } catch (err) {
      result.client.error = err?.userMessage ?? 'Verification failed.';
    }

    return result;
  }
}

/** @type {PterodactylService|null} */
let instance = null;

/**
 * Creates the shared service.
 *
 * @param {ConstructorParameters<typeof PterodactylService>[0]} options
 * @returns {PterodactylService}
 */
export function initPterodactyl(options) {
  instance = new PterodactylService(options);
  return instance;
}

/**
 * @returns {PterodactylService}
 * @throws {AppError} when called before initPterodactyl
 */
export function getPterodactyl() {
  if (!instance) {
    throw new AppError('The Pterodactyl service has not been initialised.', { code: 'PTERO_NOT_READY' });
  }
  return instance;
}

/**
 * Injects a mock. Test-only.
 *
 * @param {unknown} mock
 */
export function setPterodactylForTests(mock) {
  instance = /** @type {PterodactylService} */ (mock);
}

export { MAX_PAGES, MAX_PER_PAGE };
