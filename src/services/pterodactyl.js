import axios from 'axios';
import { AppError, NotFoundError, normalizeApiError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertValidIdentifier, assertValidPowerSignal, assertValidUuid } from '../utils/validation.js';
import { describeFailure, withRetry } from './retry.js';

const MAX_PER_PAGE = 100;

const MAX_PAGES = 100;
const MAX_API_BYTES = 8 * 1024 * 1024;
const MAX_FILE_BYTES = 32 * 1024 * 1024;

export class PterodactylService {

  #app;

  #client;

  #panelUrl;

  #maxAttempts;

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

    const shared = {
      timeout: Math.max(1000, Number(timeoutMs) || 15_000),
      maxRedirects: 0,
      maxContentLength: MAX_API_BYTES,

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

  get panelUrl() {
    return this.#panelUrl;
  }

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

      if (!Array.isArray(body?.data)) {
        throw new AppError('The panel returned an invalid server collection.', { code: 'PTERO_BAD_RESPONSE' });
      }
      const meta = body?.meta?.pagination ?? {};
      pagination = {
        total: Number(meta.total ?? 0),
        count: Number(meta.count ?? 0),
        perPage: Number(meta.per_page ?? size),
        currentPage: Number(meta.current_page ?? page),
        totalPages: Number(meta.total_pages ?? 1),
      };

      if (pagination.currentPage !== page || !Number.isSafeInteger(pagination.totalPages) ||
          pagination.totalPages < page) {
        throw new AppError('The panel returned invalid pagination.', { code: 'PTERO_BAD_RESPONSE' });
      }

      collected.push(...(Array.isArray(body?.data) ? body.data : []));

      if (collected.length >= maxItems) break;
      if (pagination.currentPage >= pagination.totalPages) break;
      if (page === MAX_PAGES) {
        throw new AppError('The panel has too many server pages to reconcile safely.', { code: 'PTERO_PAGE_LIMIT' });
      }
    }

    return { data: collected.slice(0, Number.isFinite(maxItems) ? maxItems : undefined), pagination };
  }

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

  async deleteUser(panelUserId) {
    await this.#request('app', { method: 'DELETE', url: `/users/${Number(panelUserId)}` }, 'deleteUser');
    return true;
  }

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

  async deleteServer(panelServerId, { force = false } = {}) {
    const suffix = force ? '/force' : '';
    await this.#request(
      'app',
      { method: 'DELETE', url: `/servers/${Number(panelServerId)}${suffix}` },
      force ? 'deleteServerForce' : 'deleteServer',
    );
    return true;
  }

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

  async listServersForUser(panelUserId) {
    const ownerId = Number(panelUserId);
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
      throw new AppError('Invalid panel user id.', { code: 'PTERO_BAD_USER_ID' });
    }
    const { data } = await this.#paginateApp('/servers', {
      perPage: MAX_PER_PAGE,
      label: 'listServersForUser',
    });

    return data.filter((entry) => Number(entry?.attributes?.user) === ownerId).map((entry) => {
      const attributes = entry?.attributes ?? {};
      return {
        id: Number(attributes.id),
        identifier: String(attributes.identifier ?? ''),
        name: String(attributes.name ?? ''),
        suspended: Boolean(attributes.suspended),
      };
    });
  }

  async suspendServer(panelServerId) {
    await this.#request('app', { method: 'POST', url: `/servers/${Number(panelServerId)}/suspend` }, 'suspendServer', {
      allowRetry: false,
    });
    return true;
  }

  async unsuspendServer(panelServerId) {
    await this.#request('app', { method: 'POST', url: `/servers/${Number(panelServerId)}/unsuspend` }, 'unsuspendServer', {
      allowRetry: false,
    });
    return true;
  }

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

  async reinstallServer(identifier) {
    const id = assertValidIdentifier(identifier);

    await this.#request('client', { method: 'POST', url: `/servers/${id}/settings/reinstall` }, 'reinstallServer', {
      allowRetry: false,
    });

    return true;
  }

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

  async deleteSubuser(identifier, subuserUuid) {
    const id = assertValidIdentifier(identifier);
    const uuid = assertValidUuid(subuserUuid);

    await this.#request('client', { method: 'DELETE', url: `/servers/${id}/users/${uuid}` }, 'deleteSubuser');
    return true;
  }

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

  async getFileContents(identifier, filePath) {
    const id = assertValidIdentifier(identifier);

    if (typeof filePath !== 'string' || !filePath.startsWith('/') || filePath.includes('\0') || filePath.split('/').includes('..')) {
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
        maxContentLength: MAX_FILE_BYTES,
        transformResponse: [(raw) => raw],
      },
      'getFileContents',
    );

    return typeof body === 'string' ? body : String(body ?? '');
  }

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

  async getDownloadUrl(identifier, filePath) {
    const id = assertValidIdentifier(identifier);

    if (typeof filePath !== 'string' || !filePath.startsWith('/') || filePath.includes('\0') || filePath.split('/').includes('..')) {
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

  async verifyApplicationKey() {
    const body = await this.#request('app', { method: 'GET', url: '/users', params: { per_page: 1 } }, 'verifyApplicationKey');
    return { ok: true, users: Number(body?.meta?.pagination?.total ?? 0) };
  }

  async verifyClientKey() {
    const body = await this.#request('client', { method: 'GET', url: '/', params: { per_page: 1 } }, 'verifyClientKey');
    return { ok: true, servers: Number(body?.meta?.pagination?.total ?? 0) };
  }

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

let instance = null;

export function initPterodactyl(options) {
  instance = new PterodactylService(options);
  return instance;
}

export function getPterodactyl() {
  if (!instance) {
    throw new AppError('The Pterodactyl service has not been initialised.', { code: 'PTERO_NOT_READY' });
  }
  return instance;
}

export function setPterodactylForTests(mock) {
  instance = mock;
}

export { MAX_FILE_BYTES, MAX_PAGES, MAX_PER_PAGE };
