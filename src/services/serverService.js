// Coded by Aditya | GitHub- @adityatheog

/**
 * Server provisioning, control and file operations.
 *
 * This service is where authorisation actually happens. Every method that touches
 * a user's server resolves the chain
 *
 *   Discord user id -> local database row -> Pterodactyl resource
 *
 * through requireOwnedServer(), which queries with `WHERE identifier = ? AND
 * discord_id = ?`. A server identifier supplied by a user is never passed to the
 * panel until that lookup has returned a row. This is the single gate: if a future
 * method forgets to call it, that method has no authorisation at all, which is why
 * it is one function rather than a repeated inline comparison.
 *
 * A missing server and someone else's server produce the same error message. The
 * alternative leaks whether a given identifier exists, which turns the 8-character
 * identifier space into something worth probing.
 *
 * Like accountService, this file contains no Discord.js types. It takes and returns
 * plain data so both command surfaces share one implementation and the whole
 * service can be tested against a mocked panel with no credentials.
 */

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

/** Cap on concurrent panel reads when enriching a server list with live state. */
const LIST_STATE_CONCURRENCY = 10;

/** Panel statuses that mean "the log file is not there", as opposed to a real fault. */
const MISSING_FILE_STATUSES = Object.freeze(new Set([400, 404, 422]));

export class ServerService {
  /**
   * @param {object} deps
   * @param {ReturnType<import('../database/db.js').createDatabase>} deps.db
   * @param {import('./pterodactyl.js').PterodactylService} deps.panel
   * @param {Readonly<object>} deps.config validated config.json
   * @param {Readonly<object>} deps.env validated environment
   * @param {ReturnType<typeof createLockManager>} [deps.locks]
   */
  constructor({ db, panel, config, env, locks = createLockManager() }) {
    this.db = db;
    this.panel = panel;
    this.config = config;
    this.env = env;
    this.locks = locks;
  }

  // ==========================================================================
  // Authorisation and lookups
  // ==========================================================================

  /**
   * The authorisation gate for every user-triggered server operation.
   *
   * @param {string} discordId
   * @param {unknown} rawIdentifier a user-supplied server identifier
   * @returns {object} the local server row
   * @throws {import('../utils/errors.js').ValidationError} when the identifier is malformed
   * @throws {AuthorizationError} when the server does not exist or belongs to someone else
   */
  requireOwnedServer(discordId, rawIdentifier) {
    const identifier = assertValidIdentifier(rawIdentifier);
    const server = this.db.getOwnedServer(identifier, discordId);

    if (!server) {
      // Deliberately indistinguishable from "does not exist": no enumeration.
      throw new AuthorizationError('That server does not exist or does not belong to you.');
    }

    return server;
  }

  /**
   * Lists the user's servers from the local database.
   *
   * @param {string} discordId
   * @returns {object[]}
   */
  listServers(discordId) {
    return this.db.getUserServers(discordId);
  }

  /**
   * Server types that are fully configured and may be offered to users.
   *
   * @returns {Array<{ key: string, label: string }>}
   */
  listEggChoices() {
    return availableEggKeys(this.config).map((key) => ({
      key,
      label: this.config.eggs[key].label,
    }));
  }

  /**
   * Builds a link to a server on the panel.
   *
   * @param {string} identifier
   * @returns {string}
   */
  panelUrlFor(identifier) {
    return buildPanelServerUrl(this.env.panelUrl, identifier);
  }

  /**
   * Container images offered for a server's egg type.
   *
   * @param {{ egg_type: string }} server a local server row
   * @returns {Array<{ label: string, image: string }>}
   */
  imageChoicesFor(server) {
    const eggConfig = this.config.eggs[server.egg_type];
    return Object.entries(eggConfig?.images ?? {}).map(([label, image]) => ({ label, image }));
  }

  // ==========================================================================
  // Provisioning
  // ==========================================================================

  /**
   * Builds the environment map for a new server.
   *
   * The egg declares which variables it needs and their defaults; config.json may
   * override any of them. A required variable with no value on either side is a
   * configuration error reported before the server is created, because the panel
   * would otherwise answer with an opaque 422.
   *
   * @param {object} eggConfig a validated egg entry from config.json
   * @returns {Promise<{ environment: Record<string, string>, egg: object }>}
   * @throws {ConfigError} when a required variable has no value
   */
  async #buildEnvironment(eggConfig) {
    const egg = await this.panel.getEgg(eggConfig.nestId, eggConfig.eggId);

    /** @type {Record<string, string>} */
    const environment = {};
    /** @type {string[]} */
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

    // Some eggs read variables their install script defines but the egg does not
    // declare, so operator overrides are passed through even when undeclared.
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

  /**
   * Provisions a server on the panel and records it locally.
   *
   * Serialised per user. Without the lock two concurrent requests both read the
   * pre-create count, both pass the limit check, and the user ends up with more
   * servers than FREE_SERVER_LIMIT allows.
   *
   * @param {object} input
   * @param {string} input.discordId
   * @param {unknown} input.eggKey
   * @param {unknown} input.name
   * @param {boolean} [input.bypassLimit] internal only; set by adminService, never from user input
   * @returns {Promise<object>} the stored server row
   */
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

      // Validate before any panel call, so bad input costs nothing.
      const key = assertValidEggKey(eggKey, allowedKeys);
      const safeName = assertValidServerName(name);
      const eggConfig = this.config.eggs[key];

      const { environment, egg } = await this.#buildEnvironment(eggConfig);

      const created = await this.panel.createServer({
        name: safeName,
        panelUserId: user.panel_id,
        eggId: eggConfig.eggId,
        // config.json wins so an operator can pin an image the egg does not default to.
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
        /**
         * The server exists on the panel but the bot has no record of it, so no
         * command can reach it. Deliberately not rolled back: deleting a server
         * that may already be installing risks destroying data, and the panel is
         * the authoritative store. The log line carries everything needed to
         * either insert the row by hand or delete the server in the panel.
         */
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

  /**
   * Deletes a server from the panel and removes the local record.
   *
   * A 404 from the panel is treated as success: the server is already gone, and the
   * local row must be cleaned up regardless, otherwise it blocks the user's limit
   * forever with a phantom entry.
   *
   * @param {{ discordId: string, identifier: unknown }} input
   * @returns {Promise<object>} the row that was removed
   */
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

  // ==========================================================================
  // Power and monitoring
  // ==========================================================================

  /**
   * Sends a power signal.
   *
   * The server's state is checked first. The panel rejects power actions during
   * installation, suspension and transfer with a bare 409, which tells the user
   * nothing; reading the flags first produces a message that explains the wait.
   *
   * @param {{ discordId: string, identifier: unknown, signal: unknown }} input
   * @returns {Promise<{ server: object, signal: string, previousState: string }>}
   */
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

  /**
   * Reads live resource usage.
   *
   * @param {{ discordId: string, identifier: unknown }} input
   * @returns {Promise<{ server: object, resources: object }>}
   */
  async usage({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const resources = await this.panel.getResources(server.identifier);
    return { server, resources };
  }

  /**
   * Lists the user's servers with live state attached.
   *
   * State lookups run concurrently but bounded, and failures degrade to 'unknown'
   * rather than failing the command: a list of servers is still useful when one
   * node is unreachable.
   *
   * @param {string} discordId
   * @param {{ max?: number }} [options]
   * @returns {Promise<Array<object & { state: string }>>}
   */
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

  /**
   * Reads full detail for one server.
   *
   * The two panel reads are independent, so Promise.allSettled is used rather than
   * Promise.all: a server that has never started returns no resources but still has
   * useful configuration to show. Both failing means the server is genuinely
   * unreachable, and the first error propagates.
   *
   * @param {{ discordId: string, identifier: unknown }} input
   * @returns {Promise<{ record: object, panel: object|null, resources: object|null, allocations: object[] }>}
   */
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

  // ==========================================================================
  // Settings
  // ==========================================================================

  /**
   * Renames a server on the panel and locally.
   *
   * The panel is updated first. If the local update then failed, the two would
   * disagree on the name — cosmetic and self-correcting on the next rename, which
   * is why this is not wrapped in a rollback.
   *
   * @param {{ discordId: string, identifier: unknown, name: unknown }} input
   * @returns {Promise<{ server: object, name: string, previousName: string }>}
   */
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

  /**
   * Reinstalls a server. Destructive: files are wiped and the install script reruns.
   *
   * Confirmation is the caller's responsibility; the dashboard requires an explicit
   * confirm button before reaching this method.
   *
   * @param {{ discordId: string, identifier: unknown }} input
   * @returns {Promise<object>}
   */
  async reinstall({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);

    const state = await this.panel.getClientServer(server.identifier);
    if (state.isInstalling) throw new ValidationError('That server is already installing.');
    if (state.isSuspended) throw new ValidationError('That server is suspended. Contact an administrator.');

    await this.panel.reinstallServer(server.identifier);

    logger.warn('Server reinstall started', { discordId, identifier: server.identifier });

    return server;
  }

  /**
   * Changes a server's container image.
   *
   * The image must be on the config.json allowlist for that egg type. Free-form
   * image strings are never accepted, so a user cannot run an arbitrary container.
   *
   * @param {{ discordId: string, identifier: unknown, image: unknown }} input
   * @returns {Promise<{ server: object, image: string }>}
   */
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

  // ==========================================================================
  // Logs
  // ==========================================================================

  /**
   * Reads the newest available log file for a server.
   *
   * Pterodactyl serves live console output over a websocket only; there is no REST
   * endpoint for it. This reads a log *file* through the documented file-manager
   * endpoint, trying each path configured for the egg type in order.
   *
   * A missing file (400, 404 or 422) means "try the next path". Any other status is
   * a real fault and propagates immediately rather than being masked as "no logs".
   *
   * @param {{ discordId: string, identifier: unknown }} input
   * @returns {Promise<{ server: object, path: string, content: string }>}
   * @throws {NotFoundError} when no configured path yielded content
   */
  async logs({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);

    const eggConfig = this.config.eggs[server.egg_type];
    const paths = eggConfig?.logPaths ?? ['/logs/latest.log'];

    /** @type {unknown} */
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
        if (err?.status && !MISSING_FILE_STATUSES.has(err.status)) throw err;
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

  // ==========================================================================
  // Sub-users
  // ==========================================================================

  /**
   * Lists a server's sub-users.
   *
   * @param {{ discordId: string, identifier: unknown }} input
   * @returns {Promise<{ server: object, subusers: object[] }>}
   */
  async subusers({ discordId, identifier }) {
    const server = this.requireOwnedServer(discordId, identifier);
    const subusers = await this.panel.listSubusers(server.identifier);
    return { server, subusers };
  }

  /**
   * Grants a panel account access to the user's server.
   *
   * Serialised per server so two concurrent adds cannot both pass the duplicate
   * check. The permission set comes from config.json and is validated at startup;
   * destructive server-level permissions are rejected there.
   *
   * @param {{ discordId: string, identifier: unknown, email: unknown }} input
   * @returns {Promise<{ server: object, subuser: object, permissions: readonly string[] }>}
   */
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

  /**
   * Revokes a sub-user's access.
   *
   * The sub-user is resolved by email, so no internal UUID is ever accepted from a
   * user. That keeps panel identifiers out of the command surface entirely.
   *
   * @param {{ discordId: string, identifier: unknown, email: unknown }} input
   * @returns {Promise<{ server: object, email: string, username: string }>}
   */
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

  // ==========================================================================
  // Backups
  // ==========================================================================

  /**
   * Archives the server's files and prepares them for delivery.
   *
   * Small archives are downloaded so they can be attached to a DM, then deleted
   * from the server to avoid filling the user's disk quota with backups they did
   * not ask to keep. Larger archives are left in place and delivered as a signed
   * link, because attaching them would exceed Discord's upload limit.
   *
   * The returned downloadUrl is a credential: it grants file access with no header.
   * Callers must deliver it by DM only and must never log it.
   *
   * @param {{ discordId: string, identifier: unknown }} input
   * @returns {Promise<{ server: object, archiveName: string, size: number, inline: boolean, buffer?: Buffer, downloadUrl?: string }>}
   */
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

        // Best-effort cleanup. A failure here costs the user disk space, not data,
        // so it is logged rather than surfaced.
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

/** @type {ServerService|null} */
let instance = null;

/**
 * Creates the shared service.
 *
 * @param {ConstructorParameters<typeof ServerService>[0]} deps
 * @returns {ServerService}
 */
export function initServerService(deps) {
  instance = new ServerService(deps);
  return instance;
}

/**
 * @returns {ServerService}
 * @throws {AppError} when called before initServerService
 */
export function getServerService() {
  if (!instance) {
    throw new AppError('The server service is not initialised.', { code: 'SERVICE_NOT_READY' });
  }
  return instance;
}

/**
 * Injects a mock. Test-only.
 *
 * @param {unknown} mock
 */
export function setServerServiceForTests(mock) {
  instance = /** @type {ServerService} */ (mock);
}

export { LIST_STATE_CONCURRENCY, MISSING_FILE_STATUSES };
