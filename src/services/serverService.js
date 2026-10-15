import { availableEggKeys } from '../config/config.js';
import {
  AppError,
  AuthorizationError,
  ConfigError,
  NotFoundError,
  ValidationError,
} from '../utils/errors.js';
import { createLockManager } from '../utils/locks.js';
import { logger } from '../utils/logger.js';
import { buildPanelServerUrl } from '../utils/security.js';
import {
  assertAbsolutePath,
  assertAllowedDockerImage,
  assertValidEggKey,
  assertValidEmail,
  assertValidIdentifier,
  assertValidPowerSignal,
  assertValidServerName,
} from '../utils/validation.js';

const LIST_STATE_CONCURRENCY = 10;

const MISSING_FILE_STATUSES = Object.freeze(new Set([400, 404, 422]));

export class ServerService {

  constructor({ db, panel, config, env, locks = createLockManager() }) {
    this.db = db;
    this.panel = panel;
    this.config = config;
    this.env = env;
    this.locks = locks;
  }

  requireOwnedServer(discordId, rawIdentifier) {
    const identifier = assertValidIdentifier(rawIdentifier);
    const server = this.db.getOwnedServer(identifier, discordId);

    if (!server) {

      throw new AuthorizationError('That server does not exist or does not belong to you.');
    }

    return server;
  }

  listServers(discordId) {
    return this.db.getUserServers(discordId);
  }

  listEggChoices() {
    return availableEggKeys(this.config).map((key) => ({
      key,
      label: this.config.eggs[key].label,
    }));
  }

  panelUrlFor(identifier) {
    return buildPanelServerUrl(this.env.panelUrl, identifier);
  }

  imageChoicesFor(server) {
    const eggConfig = this.config.eggs[server.egg_type];
    return Object.entries(eggConfig?.images ?? {}).map(([label, image]) => ({ label, image }));
  }

  async #buildEnvironment(eggConfig) {
    const egg = await this.panel.getEgg(eggConfig.nestId, eggConfig.eggId);

    const environment = {};

    const missing = [];

    for (const variable of egg.variables) {
      const override = eggConfig.environment[variable.envVariable];
      const value = override !== undefined && override !== null ? override : variable.defaultValue;

      if (value === null || value === undefined || String(value) === '') {
        if (variable.required) missing.push(variable.envVariable);
        continue;
      }

      environment[variable.envVariable] = String(value);
    }

    for (const [key, value] of Object.entries(eggConfig.environment)) {
      if (environment[key] === undefined && value !== null && value !== undefined && String(value) !== '') {
        environment[key] = String(value);
      }
    }

    if (missing.length > 0) {
      throw new ConfigError(
        `The "${eggConfig.label}" server type is misconfigured: the egg requires ${missing.join(', ')} but no value is set. ` +
          `An administrator must add them under eggs.${eggConfig.key}.environment in config.json.`,
      );
    }

    return { environment, egg };
  }

  async createServer({ discordId, eggKey, name, bypassLimit = false }) {
    return this.locks.withLock(`servers:${discordId}`, async () => {
      const user = this.db.getUser(discordId);
      if (!user) {
        throw new NotFoundError(
          `You need a panel account first. Run \`${this.env.prefix}account create\` to make one.`,
        );
      }

      const limit = this.env.freeServerLimit;
      const owned = this.db.countUserServers(discordId);

      if (!bypassLimit) {
        if (limit === 0) {
          throw new ValidationError('Server creation is currently disabled. Contact an administrator.');
        }
        if (owned >= limit) {
          throw new ValidationError(
            `You have reached your server limit (${owned}/${limit}). ` +
              `Delete an existing server with \`${this.env.prefix}server delete\` before creating another.`,
          );
        }
      }

      const allowedKeys = availableEggKeys(this.config);
      if (allowedKeys.length === 0) {
        throw new ConfigError(
          'No server types are configured yet. An administrator must complete the eggs section of config.json.',
        );
      }
      if (!this.config.deploy.configured) {
        throw new ConfigError(
          'Automatic deployment is not configured. An administrator must set deploy.locationId in config.json.',
        );
      }

      const key = assertValidEggKey(eggKey, allowedKeys);
      const safeName = assertValidServerName(name);
      const eggConfig = this.config.eggs[key];

      const { environment, egg } = await this.#buildEnvironment(eggConfig);

      const created = await this.panel.createServer({
        name: safeName,
        panelUserId: user.panel_id,
        eggId: eggConfig.eggId,

        dockerImage: eggConfig.dockerImage || egg.dockerImage,
        startup: eggConfig.startup || egg.startup,
        environment,
        limits: this.config.defaults.limits,
        featureLimits: this.config.defaults.featureLimits,
        deploy: this.config.deploy,
      });

      try {
        const record = this.db.createServer({
          discordId,
          panelServerId: created.id,
          identifier: created.identifier,
          name: safeName,
          eggType: key,
        });

        logger.info('Server provisioned', {
          discordId,
          identifier: created.identifier,
          panelServerId: created.id,
          eggType: key,
          bypassLimit,
        });

        return record;
      } catch (err) {

        logger.error('ORPHANED SERVER: panel provisioning succeeded but the local write failed', {
          discordId,
          panelServerId: created.id,
          identifier: created.identifier,
          eggType: key,
          reason: err?.code ?? err?.message,
        });

        throw new AppError(
          `Your server was created on the panel with the ID \`${created.identifier}\`, but the bot could not record it. ` +
            'Please contact an administrator and give them that ID.',
          { code: 'SERVER_ORPHANED', details: { identifier: created.identifier, panelServerId: created.id }, cause: err },
        );
      }
    });
  }

  async deleteServer({ discordId, identifier }) {
    return this.locks.withLock(`servers:${discordId}`, async () => {
      const server = this.requireOwnedServer(discordId, identifier);

      try {
        await this.panel.deleteServer(server.panel_server_id);
      } catch (err) {
        if (err?.status !== 404) throw err;
        logger.warn('Server already absent from the panel; removing the local record', {
          identifier: server.identifier,
          panelServerId: server.panel_server_id,
        });
      }

      this.db.deleteServer(server.identifier, discordId);

      logger.info('Server deleted', {
        discordId,
        identifier: server.identifier,
        panelServerId: server.panel_server_id,
      });

      return server;
    });
  }

  async power({ discordId, identifier, signal }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const safeSignal = assertValidPowerSignal(signal);

    const state = await this.panel.getClientServer(server.identifier);

    if (state.isInstalling) {
      throw new ValidationError('That server is still installing. Try again once the installation finishes.');
    }
    if (state.isSuspended) {
      throw new ValidationError('That server is suspended and cannot be controlled. Contact an administrator.');
    }
    if (state.isTransferring) {
      throw new ValidationError('That server is being transferred to another node. Try again once it finishes.');
    }

    await this.panel.sendPowerSignal(server.identifier, safeSignal);

    logger.info('Power signal sent', { discordId, identifier: server.identifier, signal: safeSignal });

    return { server, signal: safeSignal, previousState: state.isSuspended ? 'suspended' : 'available' };
  }

  async usage({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const resources = await this.panel.getResources(server.identifier);
    return { server, resources };
  }

  async listWithState(discordId, { max = LIST_STATE_CONCURRENCY } = {}) {
    const servers = this.db.getUserServers(discordId);
    if (servers.length === 0) return [];

    const limit = Math.max(1, Math.min(LIST_STATE_CONCURRENCY, Number(max) || LIST_STATE_CONCURRENCY));
    const enriched = servers.slice(0, limit);

    const results = await Promise.allSettled(
      enriched.map((server) => this.panel.getResources(server.identifier)),
    );

    return servers.map((server, index) => {
      if (index >= enriched.length) return { ...server, state: 'unknown' };
      const result = results[index];
      return {
        ...server,
        state: result.status === 'fulfilled' ? result.value.state : 'unknown',
      };
    });
  }

  async info({ discordId, identifier }) {
    const record = this.requireOwnedServer(discordId, identifier);

    const [panelResult, resourceResult] = await Promise.allSettled([
      this.panel.getClientServer(record.identifier),
      this.panel.getResources(record.identifier),
    ]);

    if (panelResult.status === 'rejected' && resourceResult.status === 'rejected') {
      throw panelResult.reason;
    }

    const panel = panelResult.status === 'fulfilled' ? panelResult.value : null;

    return {
      record,
      panel,
      resources: resourceResult.status === 'fulfilled' ? resourceResult.value : null,
      allocations: panel?.allocations ?? [],
    };
  }

  async rename({ discordId, identifier, name }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const safeName = assertValidServerName(name);

    if (safeName === server.name) {
      throw new ValidationError('That is already the name of this server.');
    }

    await this.panel.renameServer(server.identifier, safeName);
    this.db.updateServer({ identifier: server.identifier, discordId, name: safeName });

    logger.info('Server renamed', { discordId, identifier: server.identifier });

    return { server, name: safeName, previousName: server.name };
  }

  async reinstall({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);

    const state = await this.panel.getClientServer(server.identifier);
    if (state.isInstalling) throw new ValidationError('That server is already installing.');
    if (state.isSuspended) throw new ValidationError('That server is suspended. Contact an administrator.');

    await this.panel.reinstallServer(server.identifier);

    logger.warn('Server reinstall started', { discordId, identifier: server.identifier });

    return server;
  }

  async changeImage({ discordId, identifier, image }) {
    const server = this.requireOwnedServer(discordId, identifier);

    const allowed = this.imageChoicesFor(server).map((choice) => choice.image);
    if (allowed.length === 0) {
      throw new ConfigError(
        `No alternative container images are configured for the "${server.egg_type}" server type. ` +
          `An administrator can add them under eggs.${server.egg_type}.images in config.json.`,
      );
    }

    const safeImage = assertAllowedDockerImage(image, allowed);
    await this.panel.updateServerImage(server.panel_server_id, safeImage);

    logger.info('Server image changed', { discordId, identifier: server.identifier, image: safeImage });

    return { server, image: safeImage };
  }

  async logs({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);

    const eggConfig = this.config.eggs[server.egg_type];
    const paths = eggConfig?.logPaths ?? ['/logs/latest.log'];

    let lastError = null;

    for (const rawPath of paths) {
      const logPath = assertAbsolutePath(rawPath);

      try {
        const content = await this.panel.getFileContents(server.identifier, logPath);

        if (typeof content === 'string' && content.length > 0) {
          return { server, path: logPath, content };
        }
        lastError = new NotFoundError('The log file is empty.');
      } catch (err) {
        lastError = err;
        if (!MISSING_FILE_STATUSES.has(err?.status)) throw err;
      }
    }

    logger.debug('No log file found for server', {
      identifier: server.identifier,
      eggType: server.egg_type,
      pathsTried: paths.length,
    });

    throw new NotFoundError(
      `No log file could be read for this server. Paths tried: ${paths.join(', ')}. ` +
        'The server may never have started, or its log path may differ from the configured one.',
      { cause: lastError instanceof Error ? lastError.message : null },
    );
  }

  async subusers({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const subusers = await this.panel.listSubusers(server.identifier);
    return { server, subusers };
  }

  async addSubuser({ discordId, identifier, email }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const safeEmail = assertValidEmail(email);

    const permissions = this.config.subuser.defaultPermissions;
    if (permissions.length === 0) {
      throw new ConfigError(
        'No sub-user permissions are configured. An administrator must set subuser.defaultPermissions in config.json.',
      );
    }

    const owner = this.db.getUser(discordId);
    if (owner && owner.email.toLowerCase() === safeEmail) {
      throw new ValidationError('You cannot add yourself as a sub-user; you already own this server.');
    }

    return this.locks.withLock(`subusers:${server.identifier}`, async () => {
      const existing = await this.panel.listSubusers(server.identifier);

      if (existing.some((subuser) => subuser.email.toLowerCase() === safeEmail)) {
        throw new ValidationError('That email is already a sub-user on this server.');
      }

      const subuser = await this.panel.createSubuser(server.identifier, safeEmail, permissions);

      logger.info('Sub-user added', {
        ownerDiscordId: discordId,
        identifier: server.identifier,
        permissionCount: permissions.length,
      });

      return { server, subuser, permissions };
    });
  }

  async removeSubuser({ discordId, identifier, email }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const safeEmail = assertValidEmail(email);

    return this.locks.withLock(`subusers:${server.identifier}`, async () => {
      const existing = await this.panel.listSubusers(server.identifier);
      const match = existing.find((subuser) => subuser.email.toLowerCase() === safeEmail);

      if (!match) throw new NotFoundError('That email is not a sub-user on this server.');

      await this.panel.deleteSubuser(server.identifier, match.uuid);

      logger.info('Sub-user removed', { ownerDiscordId: discordId, identifier: server.identifier });

      return { server, email: safeEmail, username: match.username };
    });
  }

  async backup({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const maxInline = this.config.backups.maxInlineBytes;

    return this.locks.withLock(`backup:${server.identifier}`, async () => {
      const entries = await this.panel.listFiles(server.identifier, '/');
      if (entries.length === 0) {
        throw new ValidationError('That server has no files to archive yet. Start it once and try again.');
      }

      const archive = await this.panel.compressFiles(server.identifier, {
        root: '/',
        files: entries.map((entry) => entry.name),
      });

      const archivePath = `/${archive.name}`;
      const downloadUrl = await this.panel.getDownloadUrl(server.identifier, archivePath);

      if (archive.size > 0 && archive.size <= maxInline) {
        const buffer = await this.panel.fetchSignedFile(downloadUrl, maxInline);

        try {
          await this.panel.deleteFiles(server.identifier, { root: '/', files: [archive.name] });
        } catch (err) {
          logger.warn('Could not remove the temporary archive from the server', {
            identifier: server.identifier,
            archive: archive.name,
            code: err?.code,
          });
        }

        logger.info('Backup delivered inline', {
          discordId,
          identifier: server.identifier,
          bytes: buffer.byteLength,
        });

        return { server, archiveName: archive.name, size: buffer.byteLength, inline: true, buffer };
      }

      logger.info('Backup prepared for link delivery', {
        discordId,
        identifier: server.identifier,
        archive: archive.name,
        bytes: archive.size,
      });

      return { server, archiveName: archive.name, size: archive.size, inline: false, downloadUrl };
    });
  }
}

let instance = null;

export function initServerService(deps) {
  instance = new ServerService(deps);
  return instance;
}

export function getServerService() {
  if (!instance) {
    throw new AppError('The server service is not initialised.', { code: 'SERVICE_NOT_READY' });
  }
  return instance;
}

export function setServerServiceForTests(mock) {
  instance = mock;
}

export { LIST_STATE_CONCURRENCY, MISSING_FILE_STATUSES };
