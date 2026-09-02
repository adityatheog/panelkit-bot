// Coded by Aditya | GitHub- @adityatheog

/**
 * Panel account lifecycle.
 *
 * This service owns the rules around who may have a panel account, how
 * credentials are generated and delivered, and what must be true before an
 * account is removed. It deliberately contains no Discord.js types: every method
 * takes and returns plain data, which is what allows both the prefix and slash
 * surfaces to share one implementation and lets the whole file be unit tested
 * against a mocked panel with no credentials.
 *
 * Two invariants drive the design.
 *
 * The panel and the local database must not drift. A panel account with no local
 * row is invisible to the bot; a local row with no panel account produces
 * confusing 404s on every subsequent command. Both directions are handled
 * explicitly: the local row is written only after the panel call succeeds, and if
 * that write fails the panel account is deleted again.
 *
 * A destructive operation never reports success it did not achieve. Account
 * deletion removes servers first, and if any server cannot be removed the whole
 * operation aborts with nothing changed locally, rather than leaving the user
 * believing their data is gone while their servers still run.
 *
 * Generated passwords are returned to the caller exactly once, for DM delivery.
 * They are never stored, never logged, and never included in an error.
 */

import { AppError, NotFoundError, ValidationError } from '../utils/errors.js';
import { createLockManager } from '../utils/locks.js';
import { logger } from '../utils/logger.js';
import {
  buildEmail,
  daysUntilEligible,
  generatePassword,
  generateUsername,
  meetsAccountAge,
} from '../utils/security.js';

/**
 * How many times to retry credential generation on a uniqueness collision.
 *
 * A ten-character random username has a vanishing collision probability, but the
 * panel enforces uniqueness on both username and email, and a collision must
 * produce a retry rather than a failed command.
 */
const MAX_CREDENTIAL_ATTEMPTS = 5;

export class AccountService {
  /**
   * @param {object} deps
   * @param {ReturnType<import('../database/db.js').createDatabase>} deps.db
   * @param {import('./pterodactyl.js').PterodactylService} deps.panel
   * @param {Readonly<object>} deps.config validated config.json
   * @param {Readonly<object>} deps.env validated environment
   * @param {ReturnType<typeof createLockManager>} [deps.locks] shared lock manager
   */
  constructor({ db, panel, config, env, locks = createLockManager() }) {
    this.db = db;
    this.panel = panel;
    this.config = config;
    this.env = env;
    this.locks = locks;
  }

  /**
   * Returns the local account row, or null.
   *
   * Synchronous: better-sqlite3 reads do not await, and callers use this for
   * cheap existence checks before showing UI.
   *
   * @param {string} discordId
   * @returns {object|null}
   */
  getAccount(discordId) {
    return this.db.getUser(discordId);
  }

  /**
   * Whether this Discord user already has an account.
   *
   * @param {string} discordId
   * @returns {boolean}
   */
  hasAccount(discordId) {
    return this.db.getUser(discordId) !== null;
  }

  /**
   * Self-service account creation.
   *
   * Enforces the Discord account age policy before anything else, so a user who
   * fails the check never causes a panel request. The error names how many days
   * remain rather than only refusing.
   *
   * @param {{ id: string, createdTimestamp: number }} discordUser
   * @returns {Promise<{ user: object, password: string }>} the password is for DM delivery only
   * @throws {ValidationError} when the account is too new or already exists
   */
  async createAccount(discordUser) {
    if (!meetsAccountAge(discordUser.createdTimestamp, this.env.accountAgeDays)) {
      const remaining = daysUntilEligible(discordUser.createdTimestamp, this.env.accountAgeDays);
      throw new ValidationError(
        `Your Discord account must be at least ${this.env.accountAgeDays} days old to create a panel account. ` +
          `Try again in ${remaining} day${remaining === 1 ? '' : 's'}.`,
      );
    }

    return this.#provisionAccount(discordUser, { source: 'self-service' });
  }

  /**
   * Administrative account creation.
   *
   * The account age policy is an anti-abuse rule for self-service registration, so
   * it does not apply when an administrator provisions on someone's behalf. Every
   * other guarantee — duplicate prevention, rollback on failure — is identical,
   * because this path shares #provisionAccount.
   *
   * Callers must have already verified the invoker is an administrator; that check
   * lives in the routers, before any handler runs.
   *
   * @param {{ id: string, createdTimestamp: number }} discordUser the target user
   * @returns {Promise<{ user: object, password: string }>}
   */
  async createAccountForAdmin(discordUser) {
    return this.#provisionAccount(discordUser, { source: 'admin' });
  }

  /**
   * Creates the panel account and the local record, or neither.
   *
   * Serialised per Discord user. Without the lock, two concurrent invocations both
   * pass the duplicate check, both create a panel account, and the second local
   * insert fails on the unique constraint — leaving an orphaned panel account whose
   * password was never delivered.
   *
   * @param {{ id: string, createdTimestamp: number }} discordUser
   * @param {{ source: 'self-service'|'admin' }} context
   * @returns {Promise<{ user: object, password: string }>}
   */
  async #provisionAccount(discordUser, { source }) {
    const discordId = String(discordUser.id);

    return this.locks.withLock(`account:${discordId}`, async () => {
      const existing = this.db.getUser(discordId);
      if (existing) {
        throw new ValidationError(
          source === 'admin'
            ? 'That user already has a panel account.'
            : `You already have a panel account. Use \`${this.env.prefix}account info\` to see it, or \`${this.env.prefix}account reset\` for a new password.`,
        );
      }

      const { panelUser, username, email, password } = await this.#createPanelUserWithUniqueCredentials(discordId);

      let record;
      try {
        record = this.db.createUser({
          discordId,
          panelId: panelUser.id,
          email,
          username,
          credits: this.env.startingCredits,
        });
      } catch (err) {
        // The panel account exists but is unreachable through the bot. Roll it back
        // so the panel and the database stay consistent, and so the user can retry.
        logger.error('Local persistence failed after panel account creation; rolling back', {
          discordId,
          panelUserId: panelUser.id,
          reason: err?.code ?? err?.message,
        });

        try {
          await this.panel.deleteUser(panelUser.id);
          logger.info('Rolled back panel account after failed local write', { panelUserId: panelUser.id });
        } catch (rollbackErr) {
          // Both operations failed. Log enough for an operator to clean up by hand;
          // the panel user id is the only identifier needed.
          logger.error('ORPHANED PANEL ACCOUNT: rollback failed, manual cleanup required', {
            discordId,
            panelUserId: panelUser.id,
            panelUsername: username,
            reason: rollbackErr?.userMessage ?? rollbackErr?.message,
          });
        }

        throw err;
      }

      logger.info('Panel account created', {
        discordId,
        panelUserId: panelUser.id,
        source,
        credits: this.env.startingCredits,
      });

      return { user: record, password };
    });
  }

  /**
   * Generates credentials and creates the panel user, retrying on collision.
   *
   * The panel enforces uniqueness on username and email. A 422 naming either field
   * means the random value collided, which is worth retrying; any other failure is
   * a real error and propagates immediately.
   *
   * @param {string} discordId stored as the panel user's last name, linking the two systems
   * @returns {Promise<{ panelUser: { id: number, username: string, email: string }, username: string, email: string, password: string }>}
   */
  async #createPanelUserWithUniqueCredentials(discordId) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
      const username = generateUsername(this.config.account.usernameLength);
      const email = buildEmail(username, this.config.account.emailDomain);
      const password = generatePassword(this.config.account.passwordLength);

      // Cheap local pre-check. Catches a collision with an account this bot
      // created without spending a panel request.
      if (this.db.getUserByEmail(email)) {
        lastError = new AppError('Generated credentials collided locally.', { code: 'ACCOUNT_COLLISION' });
        continue;
      }

      try {
        const panelUser = await this.panel.createUser({
          email,
          username,
          firstName: 'Discord',
          // Storing the Discord id here makes the link visible to an administrator
          // browsing the panel, which matters when reconciling by hand.
          lastName: discordId,
          password,
        });

        return { panelUser, username, email, password };
      } catch (err) {
        const isCollision =
          err?.status === 422 && /(username|email).*(taken|exist|unique)/i.test(String(err?.details?.panelDetail ?? ''));

        if (!isCollision) throw err;

        lastError = err;
        logger.warn('Generated panel credentials collided; retrying', { discordId, attempt });
      }
    }

    throw new AppError(
      'Could not generate unique account credentials. Please try again in a moment.',
      { code: 'ACCOUNT_COLLISION_EXHAUSTED', details: { attempts: MAX_CREDENTIAL_ATTEMPTS }, cause: lastError },
    );
  }

  /**
   * Reads the account with its panel state.
   *
   * The panel lookup is best-effort. A panel outage must not break a read-only
   * command, so `panelReachable` reports the failure and the local data is still
   * returned.
   *
   * @param {string} discordId
   * @returns {Promise<object>}
   * @throws {NotFoundError} when no local account exists
   */
  async getAccountInfo(discordId) {
    const user = this.db.getUser(discordId);
    if (!user) {
      throw new NotFoundError(
        `You do not have a panel account yet. Run \`${this.env.prefix}account create\` to make one.`,
      );
    }

    let panelReachable = true;
    let panelUser = null;
    try {
      panelUser = await this.panel.getApplicationUser(user.panel_id);
    } catch (err) {
      logger.warn('Could not verify panel account', { discordId, panelUserId: user.panel_id, code: err?.code });
      panelReachable = false;
    }

    return {
      discordId: user.discord_id,
      username: user.username,
      email: user.email,
      panelId: user.panel_id,
      credits: user.credits,
      createdAt: user.created_at,
      serverCount: this.db.countUserServers(discordId),
      serverLimit: this.env.freeServerLimit,
      panelReachable,
      panelAdmin: panelUser ? panelUser.admin : false,
    };
  }

  /**
   * Generates a new password on the panel.
   *
   * The old password stops working immediately, which is the point: this is the
   * recovery path when a credential DM could not be delivered. The new password is
   * returned once for delivery and is not stored.
   *
   * @param {string} discordId
   * @returns {Promise<{ user: object, password: string }>}
   * @throws {NotFoundError} when no local account exists
   */
  async resetPassword(discordId) {
    return this.locks.withLock(`account:${discordId}`, async () => {
      const user = this.db.getUser(discordId);
      if (!user) {
        throw new NotFoundError(
          `You do not have a panel account yet. Run \`${this.env.prefix}account create\` to make one.`,
        );
      }

      const password = generatePassword(this.config.account.passwordLength);
      await this.panel.updateUserPassword(user.panel_id, password);

      logger.info('Panel password reset', { discordId, panelUserId: user.panel_id });
      return { user, password };
    });
  }

  /**
   * Deletes the panel account and every server belonging to it.
   *
   * Ordering is forced by the panel: it refuses to delete a user who still owns
   * servers. The sequence is therefore servers, then the panel user, then the
   * local rows.
   *
   * Failure handling is the important part. If any server deletion fails the
   * operation aborts with nothing removed locally, because reporting a successful
   * deletion while servers still run is worse than reporting a failure. A 404 on a
   * server is treated as already deleted, since the desired end state is reached.
   *
   * @param {string} discordId
   * @returns {Promise<{ deletedServers: number, alreadyGone: number }>}
   * @throws {NotFoundError} when no local account exists
   * @throws {AppError} when the panel could not be fully cleaned up
   */
  async deleteAccount(discordId) {
    return this.locks.withLock(`account:${discordId}`, async () => {
      const user = this.db.getUser(discordId);
      if (!user) throw new NotFoundError('You do not have a panel account.');

      const servers = this.db.getUserServers(discordId);

      /** @type {string[]} */
      const failed = [];
      let alreadyGone = 0;
      let deleted = 0;

      for (const server of servers) {
        try {
          await this.panel.deleteServer(server.panel_server_id);
          deleted += 1;
        } catch (err) {
          if (err?.status === 404) {
            // Already absent from the panel; the end state is what we wanted.
            logger.warn('Server already absent from the panel; treating as deleted', {
              identifier: server.identifier,
              panelServerId: server.panel_server_id,
            });
            alreadyGone += 1;
            continue;
          }

          failed.push(server.identifier);
          logger.error('Failed to delete a server during account deletion', {
            discordId,
            identifier: server.identifier,
            panelServerId: server.panel_server_id,
            status: err?.status,
            code: err?.code,
          });
        }
      }

      if (failed.length > 0) {
        throw new AppError(
          `Your account was not deleted because ${failed.length} server${failed.length === 1 ? '' : 's'} could not be removed from the panel. ` +
            'Nothing has been changed. Please try again in a few minutes, or contact an administrator.',
          { code: 'ACCOUNT_DELETE_PARTIAL', details: { failed } },
        );
      }

      try {
        await this.panel.deleteUser(user.panel_id);
      } catch (err) {
        if (err?.status !== 404) {
          // Servers are gone but the account remains. The local rows are kept so
          // the user can retry and so the mapping is not lost.
          logger.error('Panel account deletion failed after servers were removed', {
            discordId,
            panelUserId: user.panel_id,
            status: err?.status,
            code: err?.code,
          });

          throw new AppError(
            'Your servers were removed, but your panel account could not be deleted. Please run the command again in a few minutes, or contact an administrator.',
            { code: 'ACCOUNT_DELETE_USER_FAILED', details: { panelUserId: user.panel_id }, cause: err },
          );
        }

        logger.warn('Panel account already absent; continuing with local cleanup', { panelUserId: user.panel_id });
      }

      const removed = this.db.deleteUserWithServers(discordId);

      logger.info('Panel account deleted', {
        discordId,
        panelUserId: user.panel_id,
        serversDeleted: deleted,
        serversAlreadyGone: alreadyGone,
        localRowsRemoved: removed,
      });

      return { deletedServers: deleted + alreadyGone, alreadyGone };
    });
  }

  /**
   * Reads the credits balance.
   *
   * Synchronous, because it is a single indexed local read and callers use it in
   * embed construction.
   *
   * @param {string} discordId
   * @returns {number}
   * @throws {NotFoundError} when no local account exists
   */
  getCredits(discordId) {
    const credits = this.db.getCredits(discordId);
    if (credits === null) {
      throw new NotFoundError(
        `You do not have a panel account yet. Run \`${this.env.prefix}account create\` to make one.`,
      );
    }
    return credits;
  }

  /**
   * Adds credits to an account.
   *
   * Exposed for administrative use and for whatever earning mechanism an operator
   * builds; the bot itself does not grant credits after account creation.
   *
   * @param {string} discordId
   * @param {number} amount
   * @returns {number} the new balance
   * @throws {ValidationError} when the amount is not a positive integer
   * @throws {NotFoundError} when no local account exists
   */
  grantCredits(discordId, amount) {
    const value = Math.trunc(Number(amount));
    if (!Number.isFinite(value) || value <= 0) {
      throw new ValidationError('The credit amount must be a positive whole number.');
    }

    if (!this.db.addCredits(discordId, value)) {
      throw new NotFoundError('That user does not have a panel account.');
    }

    const balance = this.db.getCredits(discordId);
    logger.info('Credits granted', { discordId, amount: value, balance });
    return /** @type {number} */ (balance);
  }

  /**
   * Deducts credits if the balance covers the cost.
   *
   * The check and the deduction are one atomic SQL statement in the database
   * layer, so two concurrent spends cannot both succeed against the same balance.
   *
   * @param {string} discordId
   * @param {number} amount
   * @returns {number} the new balance
   * @throws {ValidationError} when the amount is invalid or the balance is insufficient
   */
  spendCredits(discordId, amount) {
    const value = Math.trunc(Number(amount));
    if (!Number.isFinite(value) || value <= 0) {
      throw new ValidationError('The credit amount must be a positive whole number.');
    }

    const balance = this.db.getCredits(discordId);
    if (balance === null) throw new NotFoundError('That user does not have a panel account.');

    if (!this.db.spendCredits(discordId, value)) {
      throw new ValidationError(`Insufficient credits. This costs ${value} but the balance is ${balance}.`);
    }

    const updated = this.db.getCredits(discordId);
    logger.info('Credits spent', { discordId, amount: value, balance: updated });
    return /** @type {number} */ (updated);
  }
}

/** @type {AccountService|null} */
let instance = null;

/**
 * Creates the shared service.
 *
 * @param {ConstructorParameters<typeof AccountService>[0]} deps
 * @returns {AccountService}
 */
export function initAccountService(deps) {
  instance = new AccountService(deps);
  return instance;
}

/**
 * @returns {AccountService}
 * @throws {AppError} when called before initAccountService
 */
export function getAccountService() {
  if (!instance) {
    throw new AppError('The account service is not initialised.', { code: 'SERVICE_NOT_READY' });
  }
  return instance;
}

/**
 * Injects a mock. Test-only.
 *
 * @param {unknown} mock
 */
export function setAccountServiceForTests(mock) {
  instance = /** @type {AccountService} */ (mock);
}

export { MAX_CREDENTIAL_ATTEMPTS };
