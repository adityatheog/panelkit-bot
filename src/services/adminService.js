// Coded by Aditya | GitHub- @adityatheog

/**
 * Administrative operations.
 *
 * Every method here can act on resources belonging to other people: suspending
 * someone's servers, reading their account details, provisioning on their behalf.
 * Authorisation is therefore not decided in this file — it is decided in the
 * routers, before any handler runs, by src/utils/permissions.js. A method reached
 * from here has already been authorised, and every one of them writes an audit line
 * naming the actor.
 *
 * That split is deliberate. Checking permission inside each service method would
 * mean a new admin command could be written without the check and nothing would
 * notice. Gating at the single point where commands are dispatched makes the check
 * structural: a command marked `adminOnly` cannot execute without it.
 *
 * Two boundaries this service respects:
 *
 *   It reuses accountService and serverService rather than reimplementing their
 *   logic, so admin provisioning gets the same rollback handling, credential
 *   generation and locking as self-service provisioning. Only the policy differs.
 *
 *   It reports per-item outcomes for bulk operations instead of aborting on the
 *   first failure. Suspending eight of a user's ten servers and naming the two that
 *   failed is more useful than an all-or-nothing result, because suspension is
 *   reversible and partial application is recoverable.
 */

import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { assertValidDiscordId } from '../utils/validation.js';

/** Upper bound on servers touched by one bulk operation, to keep a command bounded. */
const MAX_BULK_SERVERS = 50;

/** Panel status meaning the server is already in the requested suspension state. */
const ALREADY_IN_STATE = 409;

export class AdminService {
  /**
   * @param {object} deps
   * @param {ReturnType<import('../database/db.js').createDatabase>} deps.db
   * @param {import('./pterodactyl.js').PterodactylService} deps.panel
   * @param {Readonly<object>} deps.config
   * @param {Readonly<object>} deps.env
   * @param {import('./accountService.js').AccountService} deps.accountService
   * @param {import('./serverService.js').ServerService} deps.serverService
   */
  constructor({ db, panel, config, env, accountService, serverService }) {
    this.db = db;
    this.panel = panel;
    this.config = config;
    this.env = env;
    this.accountService = accountService;
    this.serverService = serverService;
  }

  // ==========================================================================
  // Inspection
  // ==========================================================================

  /**
   * Lists servers across the whole panel, one page at a time.
   *
   * Reads the panel rather than the local database, so servers created outside the
   * bot are included. Owner ids are panel user ids; resolveOwners() maps the ones
   * the bot knows about back to Discord users.
   *
   * @param {{ page?: number, perPage?: number }} [options]
   * @returns {Promise<{ servers: Array<object>, pagination: object }>}
   */
  async listAllServers({ page = 1, perPage = 15 } = {}) {
    const result = await this.panel.listAllServers({ page, perPage });

    // Attach the Discord owner where the bot has a mapping. A panel server created
    // by hand has none, which is itself useful information for an operator.
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

  /**
   * Reads everything the bot knows about a Discord user.
   *
   * The panel lookup is best-effort: a panel outage must not break a diagnostic
   * command, and `panelReachable` reports the difference between "no panel account"
   * and "could not check".
   *
   * @param {unknown} targetDiscordId
   * @returns {Promise<object>}
   * @throws {NotFoundError} when the bot has no record of the user
   */
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

    // Cross-check the panel for servers the bot has no row for. A discrepancy means
    // either a server was created outside the bot or a local write was lost, and an
    // operator investigating a complaint needs to see it.
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

  /**
   * Aggregate counts for diagnostics.
   *
   * @returns {Promise<{ local: object, panel: { total: number|null, reachable: boolean } }>}
   */
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

  // ==========================================================================
  // Suspension
  // ==========================================================================

  /**
   * Suspends or unsuspends every server the bot has recorded for a user.
   *
   * Continues past individual failures and reports each outcome, because
   * suspension is reversible and a partial result is recoverable. A 409 means the
   * server is already in the requested state, which counts as skipped rather than
   * failed — the desired end state has been reached.
   *
   * @param {unknown} targetDiscordId
   * @param {boolean} suspended true to suspend, false to unsuspend
   * @param {{ actorId?: string }} [context] the administrator, for the audit line
   * @returns {Promise<{ changed: number, skipped: number, failed: string[], total: number }>}
   * @throws {NotFoundError} when the user or their servers are unknown
   */
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
    /** @type {string[]} */
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
          // Gone from the panel entirely; nothing to suspend.
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

    // Audit line: names the actor, the target and the outcome. This is the record
    // that matters if an administrator's access is ever questioned.
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

  // ==========================================================================
  // Provisioning
  // ==========================================================================

  /**
   * Creates a panel account if the target has none, then provisions a server.
   *
   * Both steps delegate to the normal services, so this inherits their rollback
   * handling, credential generation and per-user locking. Only two policies differ:
   * the Discord account age check does not apply, and the per-user server limit is
   * bypassed. Both are self-service anti-abuse rules, not panel constraints.
   *
   * The generated password is returned only when an account was actually created.
   * An existing account's password is never regenerated silently — that would lock
   * the user out of a working account.
   *
   * @param {object} input
   * @param {{ id: string, createdTimestamp: number }} input.target
   * @param {unknown} input.eggKey
   * @param {unknown} input.name
   * @param {string} [input.actorId] the administrator, for the audit line
   * @returns {Promise<{ user: object, password: string|null, accountCreated: boolean, server: object }>}
   */
  async provision({ target, eggKey, name, actorId = 'unknown' }) {
    const discordId = assertValidDiscordId(target?.id);

    let user = this.db.getUser(discordId);
    /** @type {string|null} */
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
        // Reachable only from here. No user input path sets this flag.
        bypassLimit: true,
      });
    } catch (err) {
      // The account may have just been created for a provisioning attempt that
      // failed. It is deliberately kept: the credentials were generated and will be
      // delivered, so the user has a working panel account and the administrator can
      // retry the server without a second account being made.
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

  /**
   * Adjusts a user's credit balance.
   *
   * Exposed for operators who build an economy on top of the bot. Delegates to
   * accountService so the atomic spend path is shared.
   *
   * @param {object} input
   * @param {unknown} input.targetDiscordId
   * @param {number} input.amount positive to grant, negative to deduct
   * @param {string} [input.actorId]
   * @returns {{ balance: number, delta: number }}
   */
  adjustCredits({ targetDiscordId, amount, actorId = 'unknown' }) {
    const discordId = assertValidDiscordId(targetDiscordId);
    const delta = Math.trunc(Number(amount));

    if (!Number.isFinite(delta) || delta === 0) {
      throw new ValidationError('The credit adjustment must be a non-zero whole number.');
    }

    const balance =
      delta > 0
        ? this.accountService.grantCredits(discordId, delta)
        : this.accountService.spendCredits(discordId, Math.abs(delta));

    logger.warn('ADMIN ACTION: credit adjustment', { actorId, targetDiscordId: discordId, delta, balance });

    return { balance, delta };
  }

  // ==========================================================================
  // Reconciliation
  // ==========================================================================

  /**
   * Finds servers the bot has rows for that no longer exist on the panel.
   *
   * These accumulate when a server is deleted directly in the panel: the local row
   * survives and counts against the owner's limit, so the user cannot create a
   * replacement. This reports them; removal is a separate deliberate step.
   *
   * @param {{ limit?: number }} [options]
   * @returns {Promise<{ checked: number, stale: Array<{ identifier: string, discordId: string, panelServerId: number }> }>}
   */
  async findStaleServers({ limit = MAX_BULK_SERVERS } = {}) {
    const cap = Math.max(1, Math.min(MAX_BULK_SERVERS, Number(limit) || MAX_BULK_SERVERS));

    const users = this.db.listUsers({ limit: 100, offset: 0 });
    /** @type {Array<{ identifier: string, discordId: string, panelServerId: number }>} */
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
          // Any other failure means the panel could not answer, not that the server
          // is gone. Reporting it as stale would risk deleting a live mapping.
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

  /**
   * Removes local rows for servers confirmed absent from the panel.
   *
   * Each candidate is re-verified immediately before deletion, so a server that
   * reappeared between discovery and removal is left alone.
   *
   * @param {object} input
   * @param {Array<{ identifier: string, discordId: string, panelServerId: number }>} input.stale
   * @param {string} [input.actorId]
   * @returns {Promise<{ removed: number, kept: number }>}
   */
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

/** @type {AdminService|null} */
let instance = null;

/**
 * Creates the shared service.
 *
 * @param {ConstructorParameters<typeof AdminService>[0]} deps
 * @returns {AdminService}
 */
export function initAdminService(deps) {
  instance = new AdminService(deps);
  return instance;
}

/**
 * @returns {AdminService}
 * @throws {AppError} when called before initAdminService
 */
export function getAdminService() {
  if (!instance) {
    throw new AppError('The admin service is not initialised.', { code: 'SERVICE_NOT_READY' });
  }
  return instance;
}

/**
 * Injects a mock. Test-only.
 *
 * @param {unknown} mock
 */
export function setAdminServiceForTests(mock) {
  instance = /** @type {AdminService} */ (mock);
}

export { ALREADY_IN_STATE, MAX_BULK_SERVERS };
