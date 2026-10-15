import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertValidDiscordId } from '../utils/validation.js';

const MAX_BULK_SERVERS = 50;

const ALREADY_IN_STATE = 409;

export class AdminService {

  constructor({ db, panel, config, env, accountService, serverService }) {
    this.db = db;
    this.panel = panel;
    this.config = config;
    this.env = env;
    this.accountService = accountService;
    this.serverService = serverService;
  }

  async listAllServers({ page = 1, perPage = 15 } = {}) {
    const result = await this.panel.listAllServers({ page, perPage });

    const servers = result.servers.map((server) => {
      const owner = this.db.getUserByPanelId(server.ownerId);
      return {
        ...server,
        discordId: owner ? owner.discord_id : null,
        panelUsername: owner ? owner.username : null,
        managedByBot: owner !== null,
      };
    });

    return { servers, pagination: result.pagination };
  }

  async lookupUser(targetDiscordId) {
    const discordId = assertValidDiscordId(targetDiscordId);

    const user = this.db.getUser(discordId);
    if (!user) {
      throw new NotFoundError('That Discord user has no panel account recorded by this bot.');
    }

    let panelReachable = true;
    let panelUser = null;
    try {
      panelUser = await this.panel.getApplicationUser(user.panel_id);
    } catch (err) {
      logger.warn('Panel account lookup failed during admin inspection', {
        panelUserId: user.panel_id,
        status: err?.status,
        code: err?.code,
      });
      panelReachable = false;
    }

    const localServers = this.db.getUserServers(discordId);

    let panelServers = null;
    if (panelReachable) {
      try {
        panelServers = await this.panel.listServersForUser(user.panel_id);
      } catch (err) {
        logger.warn('Could not list panel servers during admin inspection', {
          panelUserId: user.panel_id,
          code: err?.code,
        });
      }
    }

    const knownIdentifiers = new Set(localServers.map((server) => server.identifier));
    const untracked = (panelServers ?? []).filter((server) => !knownIdentifiers.has(server.identifier));

    return {
      discordId: user.discord_id,
      username: user.username,
      email: user.email,
      panelId: user.panel_id,
      credits: user.credits,
      createdAt: user.created_at,
      panelReachable,
      panelAdmin: panelUser ? panelUser.admin : false,
      servers: localServers,
      untrackedServers: untracked,
      serverLimit: this.env.freeServerLimit,
    };
  }

  async getStatistics() {
    const local = this.db.getStats();

    let panelTotal = null;
    let reachable = true;
    try {
      const result = await this.panel.listAllServers({ page: 1, perPage: 1 });
      panelTotal = result.pagination.total;
    } catch {
      reachable = false;
    }

    return { local, panel: { total: panelTotal, reachable } };
  }

  async setSuspended(targetDiscordId, suspended, { actorId = 'unknown' } = {}) {
    const discordId = assertValidDiscordId(targetDiscordId);

    if (!this.db.getUser(discordId)) {
      throw new NotFoundError('That Discord user has no panel account recorded by this bot.');
    }

    const servers = this.db.getUserServers(discordId);
    if (servers.length === 0) {
      throw new NotFoundError('That user has no servers recorded by this bot.');
    }
    if (servers.length > MAX_BULK_SERVERS) {
      throw new ValidationError(
        `That user owns ${servers.length} servers, which exceeds the bulk limit of ${MAX_BULK_SERVERS}. Suspend them individually in the panel.`,
      );
    }

    let changed = 0;
    let skipped = 0;

    const failed = [];

    for (const server of servers) {
      try {
        if (suspended) await this.panel.suspendServer(server.panel_server_id);
        else await this.panel.unsuspendServer(server.panel_server_id);
        changed += 1;
      } catch (err) {
        if (err?.status === ALREADY_IN_STATE) {
          skipped += 1;
          continue;
        }
        if (err?.status === 404) {

          logger.warn('Server absent from the panel during bulk suspension', {
            identifier: server.identifier,
            panelServerId: server.panel_server_id,
          });
          skipped += 1;
          continue;
        }

        failed.push(server.identifier);
        logger.error('Suspension change failed', {
          identifier: server.identifier,
          panelServerId: server.panel_server_id,
          suspended,
          status: err?.status,
          code: err?.code,
        });
      }
    }

    logger.warn('ADMIN ACTION: bulk suspension change', {
      actorId,
      targetDiscordId: discordId,
      suspended,
      total: servers.length,
      changed,
      skipped,
      failed: failed.length,
    });

    return { changed, skipped, failed, total: servers.length };
  }

  async provision({ target, eggKey, name, actorId = 'unknown' }) {
    const discordId = assertValidDiscordId(target?.id);

    let user = this.db.getUser(discordId);

    let password = null;
    let accountCreated = false;

    if (!user) {
      const created = await this.accountService.createAccountForAdmin({
        id: discordId,
        createdTimestamp: Number(target?.createdTimestamp ?? Date.now()),
      });
      user = created.user;
      password = created.password;
      accountCreated = true;
    }

    let server;
    try {
      server = await this.serverService.createServer({
        discordId,
        eggKey,
        name,

        bypassLimit: true,
      });
    } catch (err) {

      if (accountCreated) {
        logger.warn('Admin provisioning created an account but the server failed; the account was kept', {
          actorId,
          targetDiscordId: discordId,
          panelUserId: user.panel_id,
          reason: err?.code ?? err?.message,
        });
      }
      throw err;
    }

    if (!server) {
      throw new AppError('Provisioning did not return a server record.', { code: 'ADMIN_PROVISION_FAILED' });
    }

    logger.warn('ADMIN ACTION: provisioned account and server', {
      actorId,
      targetDiscordId: discordId,
      panelUserId: user.panel_id,
      identifier: server.identifier,
      eggType: server.egg_type,
      accountCreated,
    });

    return { user, password, accountCreated, server };
  }

  adjustCredits({ targetDiscordId, amount, actorId = 'unknown' }) {
    const discordId = assertValidDiscordId(targetDiscordId);
    const delta = Number(amount);

    if (!Number.isSafeInteger(delta) || delta === 0) {
      throw new ValidationError('The credit adjustment must be a non-zero whole number.');
    }

    const balance =
      delta > 0
        ? this.accountService.grantCredits(discordId, delta)
        : this.accountService.spendCredits(discordId, Math.abs(delta));

    logger.warn('ADMIN ACTION: credit adjustment', { actorId, targetDiscordId: discordId, delta, balance });

    return { balance, delta };
  }

  async findStaleServers({ limit = MAX_BULK_SERVERS } = {}) {
    const cap = Math.max(1, Math.min(MAX_BULK_SERVERS, Number(limit) || MAX_BULK_SERVERS));

    const users = this.db.listUsers({ limit: 100, offset: 0 });

    const stale = [];
    let checked = 0;

    for (const user of users) {
      for (const server of this.db.getUserServers(user.discord_id)) {
        if (checked >= cap) break;
        checked += 1;

        try {
          await this.panel.getApplicationServer(server.panel_server_id);
        } catch (err) {
          if (err?.status === 404) {
            stale.push({
              identifier: server.identifier,
              discordId: server.discord_id,
              panelServerId: server.panel_server_id,
            });
            continue;
          }

          logger.warn('Could not verify a server during reconciliation', {
            identifier: server.identifier,
            status: err?.status,
            code: err?.code,
          });
        }
      }
      if (checked >= cap) break;
    }

    return { checked, stale };
  }

  async pruneStaleServers({ stale, actorId = 'unknown' }) {
    let removed = 0;
    let kept = 0;

    for (const entry of Array.isArray(stale) ? stale : []) {
      let absent = false;
      try {
        await this.panel.getApplicationServer(entry.panelServerId);
      } catch (err) {
        absent = err?.status === 404;
      }

      if (!absent) {
        kept += 1;
        continue;
      }

      if (this.db.deleteServer(entry.identifier, entry.discordId)) removed += 1;
      else kept += 1;
    }

    if (removed > 0) {
      logger.warn('ADMIN ACTION: pruned stale server records', { actorId, removed, kept });
    }

    return { removed, kept };
  }
}

let instance = null;

export function initAdminService(deps) {
  instance = new AdminService(deps);
  return instance;
}

export function getAdminService() {
  if (!instance) {
    throw new AppError('The admin service is not initialised.', { code: 'SERVICE_NOT_READY' });
  }
  return instance;
}

export function setAdminServiceForTests(mock) {
  instance = mock;
}

export { ALREADY_IN_STATE, MAX_BULK_SERVERS };
