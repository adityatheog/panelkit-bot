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

const MAX_CREDENTIAL_ATTEMPTS = 5;

export class AccountService {

  constructor({ db, panel, config, env, locks = createLockManager() }) {
    this.db = db;
    this.panel = panel;
    this.config = config;
    this.env = env;
    this.locks = locks;
  }

  getAccount(discordId) {
    return this.db.getUser(discordId);
  }

  hasAccount(discordId) {
    return this.db.getUser(discordId) !== null;
  }

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

  async createAccountForAdmin(discordUser) {
    return this.#provisionAccount(discordUser, { source: 'admin' });
  }

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

        logger.error('Local persistence failed after panel account creation; rolling back', {
          discordId,
          panelUserId: panelUser.id,
          reason: err?.code ?? err?.message,
        });

        try {
          await this.panel.deleteUser(panelUser.id);
          logger.info('Rolled back panel account after failed local write', { panelUserId: panelUser.id });
        } catch (rollbackErr) {

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

  async #createPanelUserWithUniqueCredentials(discordId) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_CREDENTIAL_ATTEMPTS; attempt += 1) {
      const username = generateUsername(this.config.account.usernameLength);
      const email = buildEmail(username, this.config.account.emailDomain);
      const password = generatePassword(this.config.account.passwordLength);

      if (this.db.getUserByEmail(email)) {
        lastError = new AppError('Generated credentials collided locally.', { code: 'ACCOUNT_COLLISION' });
        continue;
      }

      try {
        const panelUser = await this.panel.createUser({
          email,
          username,
          firstName: 'Discord',

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

  async deleteAccount(discordId, { expectedPanelId } = {}) {
    return this.locks.withLock(`account:${discordId}`, () =>
      this.locks.withLock(`servers:${discordId}`, async () => {
        const user = this.db.getUser(discordId);
        if (!user) throw new NotFoundError('You do not have a panel account.');
        if (expectedPanelId !== undefined && Number(expectedPanelId) !== user.panel_id) {
          throw new ValidationError('Your panel account has changed. Run account delete again to confirm.');
        }

        const servers = this.db.getUserServers(discordId);

        const failed = [];
        let alreadyGone = 0;
        let deleted = 0;

        for (const server of servers) {
          try {
            await this.panel.deleteServer(server.panel_server_id);
            deleted += 1;
          } catch (err) {
            if (err?.status === 404) {

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
              `${deleted + alreadyGone} server(s) were removed or already absent. Your account and local records were kept. ` +
              'Please try again in a few minutes, or contact an administrator.',
            { code: 'ACCOUNT_DELETE_PARTIAL', details: { failed } },
          );
        }

        try {
          await this.panel.deleteUser(user.panel_id);
        } catch (err) {
          if (err?.status !== 404) {

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
      }),
    );
  }

  getCredits(discordId) {
    const credits = this.db.getCredits(discordId);
    if (credits === null) {
      throw new NotFoundError(
        `You do not have a panel account yet. Run \`${this.env.prefix}account create\` to make one.`,
      );
    }
    return credits;
  }

  grantCredits(discordId, amount) {
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError('The credit amount must be a positive whole number.');
    }

    const current = this.db.getCredits(discordId);
    if (current !== null && !Number.isSafeInteger(current + value)) {
      throw new ValidationError('The resulting credit balance is too large.');
    }
    if (!this.db.addCredits(discordId, value)) {
      throw new NotFoundError('That user does not have a panel account.');
    }

    const balance = this.db.getCredits(discordId);
    logger.info('Credits granted', { discordId, amount: value, balance });
    return balance;
  }

  spendCredits(discordId, amount) {
    const value = Number(amount);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new ValidationError('The credit amount must be a positive whole number.');
    }

    const balance = this.db.getCredits(discordId);
    if (balance === null) throw new NotFoundError('That user does not have a panel account.');

    if (!this.db.spendCredits(discordId, value)) {
      throw new ValidationError(`Insufficient credits. This costs ${value} but the balance is ${balance}.`);
    }

    const updated = this.db.getCredits(discordId);
    logger.info('Credits spent', { discordId, amount: value, balance: updated });
    return updated;
  }
}

let instance = null;

export function initAccountService(deps) {
  instance = new AccountService(deps);
  return instance;
}

export function getAccountService() {
  if (!instance) {
    throw new AppError('The account service is not initialised.', { code: 'SERVICE_NOT_READY' });
  }
  return instance;
}

export function setAccountServiceForTests(mock) {
  instance = mock;
}

export { MAX_CREDENTIAL_ATTEMPTS };
