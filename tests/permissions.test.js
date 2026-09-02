// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/utils/permissions.js.
 *
 * Admin commands in this bot can suspend other people's servers, provision accounts on their
 * behalf and enumerate every server on the panel. This module decides who holds that power, so
 * these tests are organised around the two failure modes that matter:
 *
 *   Over-granting. The Administrator fallback exists so a fresh install is usable, but once an
 *   operator configures an allowlist that list must become authoritative. Otherwise a bot invited
 *   to a public server hands panel-wide control to every moderator with the Administrator
 *   permission there.
 *
 *   Under-granting intermittently. discord.js supplies two different member shapes depending on
 *   whether the guild is cached, and code that reads only one of them denies access sporadically
 *   in production while passing every local test.
 *
 * Both member shapes are constructed here explicitly, because the second failure is close to
 * impossible to reproduce on demand once deployed.
 *
 * No credentials, no network, no filesystem.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';
import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

import {
  ADMIN_SOURCES,
  contextIsAdmin,
  describeAdminConfiguration,
  hasAdminAllowlist,
  hasGuildPermission,
  isAdmin,
  missingChannelPermissions,
  REQUIRED_CHANNEL_PERMISSIONS,
  resolveAdmin,
  resolveContextAdmin,
} from '../src/utils/permissions.js';

const ADMIN_USER = '111111111111111111';
const ADMIN_ROLE = '333333333333333333';
const ORDINARY_USER = '222222222222222222';
const OTHER_ROLE = '444444444444444444';

/**
 * Builds an environment fragment.
 *
 * @param {{ users?: string[], roles?: string[] }} [options]
 * @returns {{ adminUserIds: readonly string[], adminRoleIds: readonly string[] }}
 */
function env({ users = [], roles = [] } = {}) {
  return Object.freeze({
    adminUserIds: Object.freeze([...users]),
    adminRoleIds: Object.freeze([...roles]),
  });
}

/**
 * Builds a GuildMember-shaped object, as discord.js supplies when the guild is cached.
 *
 * `roles.cache` is a Collection keyed by role id, and `permissions` is a PermissionsBitField.
 *
 * @param {{ roles?: string[], administrator?: boolean, permissions?: bigint[] }} [options]
 * @returns {object}
 */
function cachedMember({ roles = [], administrator = false, permissions = [] } = {}) {
  const flags = [...permissions];
  if (administrator) flags.push(PermissionFlagsBits.Administrator);

  return {
    id: ORDINARY_USER,
    roles: { cache: new Map(roles.map((id) => [id, { id }])) },
    permissions: new PermissionsBitField(flags),
  };
}

/**
 * Builds an APIInteractionGuildMember-shaped object, as Discord sends it when the guild is not
 * cached.
 *
 * `roles` is a plain array of id strings and `permissions` is a decimal string. Code that reads
 * only `member.roles.cache` silently sees no roles here.
 *
 * @param {{ roles?: string[], administrator?: boolean, permissions?: bigint[] }} [options]
 * @returns {object}
 */
function rawMember({ roles = [], administrator = false, permissions = [] } = {}) {
  const flags = [...permissions];
  if (administrator) flags.push(PermissionFlagsBits.Administrator);

  const bits = flags.reduce((total, flag) => total | flag, 0n);

  return {
    user: { id: ORDINARY_USER },
    roles: [...roles],
    permissions: bits.toString(),
  };
}

describe('hasAdminAllowlist', () => {
  test('reports whether either list is configured', () => {
    assert.equal(hasAdminAllowlist(env()), false);
    assert.equal(hasAdminAllowlist(env({ users: [ADMIN_USER] })), true);
    assert.equal(hasAdminAllowlist(env({ roles: [ADMIN_ROLE] })), true);
    assert.equal(hasAdminAllowlist(env({ users: [ADMIN_USER], roles: [ADMIN_ROLE] })), true);
  });

  test('tolerates a missing environment', () => {
    // Defensive: the startup path always supplies one, but a partial object must not throw.
    assert.equal(hasAdminAllowlist({}), false);
    assert.equal(hasAdminAllowlist(undefined), false);
  });
});

describe('resolveAdmin: the user allowlist', () => {
  test('grants access to a listed user id', () => {
    const result = resolveAdmin({
      member: cachedMember(),
      userId: ADMIN_USER,
      env: env({ users: [ADMIN_USER] }),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.source, ADMIN_SOURCES.USER_ALLOWLIST);
  });

  test('refuses a user not on the list', () => {
    const result = resolveAdmin({
      member: cachedMember(),
      userId: ORDINARY_USER,
      env: env({ users: [ADMIN_USER] }),
    });

    assert.equal(result.allowed, false);
    assert.equal(result.source, ADMIN_SOURCES.NONE);
  });

  test('matches an id exactly, without numeric coercion', () => {
    /**
     * A Discord snowflake exceeds Number.MAX_SAFE_INTEGER, so any numeric comparison risks
     * conflating distinct users. The check is a string membership test.
     */
    const configured = env({ users: ['111111111111111111'] });

    assert.equal(resolveAdmin({ member: cachedMember(), userId: '111111111111111111', env: configured }).allowed, true);
    assert.equal(resolveAdmin({ member: cachedMember(), userId: '111111111111111110', env: configured }).allowed, false);
    assert.equal(resolveAdmin({ member: cachedMember(), userId: '11111111111111111', env: configured }).allowed, false);
  });

  test('refuses an empty user id', () => {
    // Reached only through a malformed interaction, but an empty id must never match.
    assert.equal(resolveAdmin({ member: cachedMember(), userId: '', env: env({ users: [ADMIN_USER] }) }).allowed, false);
    assert.equal(
      resolveAdmin({ member: cachedMember(), userId: undefined, env: env({ users: [ADMIN_USER] }) }).allowed,
      false,
    );
  });
});

describe('resolveAdmin: the role allowlist', () => {
  test('grants access through a listed role on a cached member', () => {
    const result = resolveAdmin({
      member: cachedMember({ roles: [ADMIN_ROLE] }),
      userId: ORDINARY_USER,
      env: env({ roles: [ADMIN_ROLE] }),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.source, ADMIN_SOURCES.ROLE_ALLOWLIST);
  });

  test('grants access through a listed role on an uncached member', () => {
    /**
     * The shape that breaks naive implementations. Discord sends `roles` as a plain string array
     * when the guild is not cached, so code reading only `member.roles.cache` sees no roles and
     * denies access — intermittently, and only in production.
     */
    const result = resolveAdmin({
      member: rawMember({ roles: [ADMIN_ROLE] }),
      userId: ORDINARY_USER,
      env: env({ roles: [ADMIN_ROLE] }),
    });

    assert.equal(result.allowed, true, 'the raw API member shape must be handled');
    assert.equal(result.source, ADMIN_SOURCES.ROLE_ALLOWLIST);
  });

  test('refuses a member holding only unlisted roles', () => {
    for (const member of [cachedMember({ roles: [OTHER_ROLE] }), rawMember({ roles: [OTHER_ROLE] })]) {
      assert.equal(resolveAdmin({ member, userId: ORDINARY_USER, env: env({ roles: [ADMIN_ROLE] }) }).allowed, false);
    }
  });

  test('grants access when any one of several roles matches', () => {
    const result = resolveAdmin({
      member: cachedMember({ roles: [OTHER_ROLE, ADMIN_ROLE] }),
      userId: ORDINARY_USER,
      env: env({ roles: [ADMIN_ROLE] }),
    });

    assert.equal(result.allowed, true);
  });

  test('refuses a member with no roles at all', () => {
    for (const member of [cachedMember(), rawMember()]) {
      assert.equal(resolveAdmin({ member, userId: ORDINARY_USER, env: env({ roles: [ADMIN_ROLE] }) }).allowed, false);
    }
  });

  test('skips the role check entirely when no roles are configured', () => {
    // Avoids iterating a member's roles for nothing on every admin command.
    const result = resolveAdmin({
      member: cachedMember({ roles: [ADMIN_ROLE] }),
      userId: ORDINARY_USER,
      env: env({ users: [ADMIN_USER] }),
    });

    assert.equal(result.allowed, false);
  });
});

describe('resolveAdmin: the Administrator fallback', () => {
  test('grants access to a guild administrator when no allowlist is configured', () => {
    /**
     * The bootstrap path. A fresh install with an empty .env must still be administrable, or the
     * operator cannot configure the allowlist they are being asked for.
     */
    const result = resolveAdmin({
      member: cachedMember({ administrator: true }),
      userId: ORDINARY_USER,
      env: env(),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.source, ADMIN_SOURCES.DISCORD_ADMINISTRATOR);
  });

  test('handles the fallback on an uncached member', () => {
    // `permissions` arrives as a decimal string rather than a PermissionsBitField.
    const result = resolveAdmin({
      member: rawMember({ administrator: true }),
      userId: ORDINARY_USER,
      env: env(),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.source, ADMIN_SOURCES.DISCORD_ADMINISTRATOR);
  });

  test('refuses a non-administrator in fallback mode', () => {
    for (const member of [
      cachedMember({ administrator: false }),
      cachedMember({ permissions: [PermissionFlagsBits.ManageGuild, PermissionFlagsBits.BanMembers] }),
      rawMember({ administrator: false }),
    ]) {
      assert.equal(resolveAdmin({ member, userId: ORDINARY_USER, env: env() }).allowed, false);
    }
  });

  test('requires Administrator specifically, not merely elevated permissions', () => {
    /**
     * Manage Guild and Ban Members are held by moderators who have no business suspending panel
     * servers, so the fallback is deliberately narrow.
     */
    const member = cachedMember({
      permissions: [
        PermissionFlagsBits.ManageGuild,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.BanMembers,
        PermissionFlagsBits.KickMembers,
      ],
    });

    assert.equal(resolveAdmin({ member, userId: ORDINARY_USER, env: env() }).allowed, false);
  });
});

describe('resolveAdmin: an allowlist is authoritative', () => {
  test('a configured allowlist refuses a guild administrator who is not on it', () => {
    /**
     * The property that makes this bot safe to invite to a public server. Without it, every
     * moderator holding Administrator in any guild the bot joins would gain panel-wide control.
     */
    const result = resolveAdmin({
      member: cachedMember({ administrator: true }),
      userId: ORDINARY_USER,
      env: env({ users: [ADMIN_USER] }),
    });

    assert.equal(result.allowed, false, 'an explicit allowlist must not fall through');
    assert.equal(result.source, ADMIN_SOURCES.NONE);
  });

  test('holds even when only a role list is configured', () => {
    const result = resolveAdmin({
      member: cachedMember({ administrator: true, roles: [OTHER_ROLE] }),
      userId: ORDINARY_USER,
      env: env({ roles: [ADMIN_ROLE] }),
    });

    assert.equal(result.allowed, false);
  });

  test('holds for the uncached member shape too', () => {
    const result = resolveAdmin({
      member: rawMember({ administrator: true }),
      userId: ORDINARY_USER,
      env: env({ users: [ADMIN_USER] }),
    });

    assert.equal(result.allowed, false);
  });

  test('a listed user is granted access regardless of their Discord permissions', () => {
    // The allowlist is the authority in both directions: an ordinary member on it qualifies.
    const result = resolveAdmin({
      member: cachedMember({ administrator: false }),
      userId: ADMIN_USER,
      env: env({ users: [ADMIN_USER] }),
    });

    assert.equal(result.allowed, true);
    assert.equal(result.source, ADMIN_SOURCES.USER_ALLOWLIST);
  });

  test('the user list takes precedence over the role list in the reported source', () => {
    /**
     * The source is logged, so an audit line should name the most specific rule that granted
     * access.
     */
    const result = resolveAdmin({
      member: cachedMember({ roles: [ADMIN_ROLE] }),
      userId: ADMIN_USER,
      env: env({ users: [ADMIN_USER], roles: [ADMIN_ROLE] }),
    });

    assert.equal(result.source, ADMIN_SOURCES.USER_ALLOWLIST);
  });
});

describe('resolveAdmin: direct messages and malformed input', () => {
  test('refuses a null member in fallback mode', () => {
    /**
     * A direct message has no member and therefore no permissions. Failing closed is correct: admin
     * commands are guild-only, and the routers gate that separately.
     */
    assert.equal(resolveAdmin({ member: null, userId: ORDINARY_USER, env: env() }).allowed, false);
    assert.equal(resolveAdmin({ member: undefined, userId: ORDINARY_USER, env: env() }).allowed, false);
  });

  test('grants a listed user even without a member object', () => {
    // The user allowlist does not depend on guild state.
    assert.equal(resolveAdmin({ member: null, userId: ADMIN_USER, env: env({ users: [ADMIN_USER] }) }).allowed, true);
  });

  test('tolerates a member with no roles or permissions fields', () => {
    for (const member of [{}, { roles: null }, { permissions: null }, { roles: {}, permissions: {} }]) {
      assert.doesNotThrow(() => resolveAdmin({ member, userId: ORDINARY_USER, env: env() }));
      assert.equal(resolveAdmin({ member, userId: ORDINARY_USER, env: env() }).allowed, false);
    }
  });

  test('tolerates an unparseable permissions string', () => {
    // A malformed bitfield must fail closed rather than throw inside a router.
    const member = { roles: [], permissions: 'not a number' };

    assert.equal(resolveAdmin({ member, userId: ORDINARY_USER, env: env() }).allowed, false);
  });

  test('tolerates a missing environment', () => {
    assert.doesNotThrow(() => resolveAdmin({ member: cachedMember(), userId: ORDINARY_USER, env: undefined }));
    assert.equal(resolveAdmin({ member: cachedMember(), userId: ORDINARY_USER, env: {} }).allowed, false);
  });
});

describe('isAdmin', () => {
  test('is the boolean form of resolveAdmin', () => {
    assert.equal(isAdmin({ member: cachedMember(), userId: ADMIN_USER, env: env({ users: [ADMIN_USER] }) }), true);
    assert.equal(isAdmin({ member: cachedMember(), userId: ORDINARY_USER, env: env({ users: [ADMIN_USER] }) }), false);
    assert.equal(isAdmin({ member: cachedMember({ administrator: true }), userId: ORDINARY_USER, env: env() }), true);
  });
});

describe('context helpers', () => {
  /**
   * Builds a minimal execution context.
   *
   * @param {object} member
   * @param {string} userId
   * @param {object} environment
   * @returns {object}
   */
  function ctx(member, userId, environment) {
    return { member, user: { id: userId }, env: environment };
  }

  test('resolveContextAdmin reads the member, user and env from a context', () => {
    const result = resolveContextAdmin(ctx(cachedMember(), ADMIN_USER, env({ users: [ADMIN_USER] })));

    assert.equal(result.allowed, true);
    assert.equal(result.source, ADMIN_SOURCES.USER_ALLOWLIST);
  });

  test('contextIsAdmin is the boolean form', () => {
    assert.equal(contextIsAdmin(ctx(cachedMember(), ADMIN_USER, env({ users: [ADMIN_USER] }))), true);
    assert.equal(contextIsAdmin(ctx(cachedMember(), ORDINARY_USER, env({ users: [ADMIN_USER] }))), false);
  });

  test('tolerates a partial context', () => {
    // Both routers construct the context before calling this, but a partial object must not throw.
    assert.doesNotThrow(() => contextIsAdmin({}));
    assert.equal(contextIsAdmin({}), false);
    assert.equal(contextIsAdmin({ user: {}, env: env() }), false);
  });
});

describe('hasGuildPermission', () => {
  test('reports a permission the member holds', () => {
    const member = cachedMember({ permissions: [PermissionFlagsBits.ManageGuild] });

    assert.equal(hasGuildPermission(member, PermissionFlagsBits.ManageGuild), true);
    assert.equal(hasGuildPermission(member, PermissionFlagsBits.BanMembers), false);
  });

  test('handles the uncached member shape', () => {
    const member = rawMember({ permissions: [PermissionFlagsBits.ManageGuild] });

    assert.equal(hasGuildPermission(member, PermissionFlagsBits.ManageGuild), true);
  });

  test('treats Administrator as implying every permission', () => {
    // Discord's own semantics, which PermissionsBitField implements.
    const member = cachedMember({ administrator: true });

    assert.equal(hasGuildPermission(member, PermissionFlagsBits.ManageGuild), true);
    assert.equal(hasGuildPermission(member, PermissionFlagsBits.BanMembers), true);
  });

  test('fails closed for a missing member', () => {
    /**
     * A direct message carries no permissions. Guild-only commands are gated by the routers, so
     * returning false here is correct rather than merely convenient.
     */
    assert.equal(hasGuildPermission(null, PermissionFlagsBits.ManageGuild), false);
    assert.equal(hasGuildPermission(undefined, PermissionFlagsBits.ManageGuild), false);
    assert.equal(hasGuildPermission({}, PermissionFlagsBits.ManageGuild), false);
  });
});

describe('missingChannelPermissions', () => {
  /**
   * Builds a channel whose permissionsFor returns a fixed set.
   *
   * @param {bigint[]} granted
   * @returns {object}
   */
  function channel(granted) {
    const bitfield = new PermissionsBitField(granted);

    return {
      id: '555555555555555555',
      permissionsFor: () => bitfield,
    };
  }

  const allRequired = REQUIRED_CHANNEL_PERMISSIONS.map(([, flag]) => flag);

  test('reports nothing when every required permission is granted', () => {
    assert.deepEqual(missingChannelPermissions(channel(allRequired), cachedMember()), []);
  });

  test('names a missing Embed Links', () => {
    /**
     * The failure this function exists for. Without Embed Links, Discord silently drops every embed
     * reply and users report that the bot ignores them — with nothing in the logs to explain it.
     */
    const granted = allRequired.filter((flag) => flag !== PermissionFlagsBits.EmbedLinks);

    assert.deepEqual(missingChannelPermissions(channel(granted), cachedMember()), ['EmbedLinks']);
  });

  test('names every missing permission', () => {
    const missing = missingChannelPermissions(channel([PermissionFlagsBits.ViewChannel]), cachedMember());

    assert.deepEqual(missing.sort(), ['EmbedLinks', 'ReadMessageHistory', 'SendMessages']);
  });

  test('reports nothing rather than throwing when the channel cannot be inspected', () => {
    /**
     * A direct message channel has no permissionsFor, and a deleted channel can throw from it.
     * Neither is a reason to fail a command.
     */
    assert.deepEqual(missingChannelPermissions(null, cachedMember()), []);
    assert.deepEqual(missingChannelPermissions({}, cachedMember()), []);
    assert.deepEqual(missingChannelPermissions(channel(allRequired), null), []);

    const throwing = {
      permissionsFor() {
        throw new Error('Unknown Channel');
      },
    };
    assert.deepEqual(missingChannelPermissions(throwing, cachedMember()), []);
  });

  test('reports nothing when permissionsFor returns null', () => {
    // discord.js returns null when the member cannot be resolved for that channel.
    const unresolvable = { permissionsFor: () => null };

    assert.deepEqual(missingChannelPermissions(unresolvable, cachedMember()), []);
  });

  test('the required set covers what a prefix reply needs', () => {
    const names = REQUIRED_CHANNEL_PERMISSIONS.map(([name]) => name);

    assert.deepEqual(names.sort(), ['EmbedLinks', 'ReadMessageHistory', 'SendMessages', 'ViewChannel']);
  });
});

describe('describeAdminConfiguration', () => {
  test('reports allowlist mode with counts and no warning', () => {
    const described = describeAdminConfiguration(env({ users: [ADMIN_USER], roles: [ADMIN_ROLE] }));

    assert.equal(described.mode, 'allowlist');
    assert.equal(described.users, 1);
    assert.equal(described.roles, 1);
    assert.equal(described.warning, null);
  });

  test('reports allowlist mode when only one list is configured', () => {
    assert.equal(describeAdminConfiguration(env({ users: [ADMIN_USER] })).mode, 'allowlist');
    assert.equal(describeAdminConfiguration(env({ roles: [ADMIN_ROLE] })).mode, 'allowlist');
  });

  test('reports fallback mode with a warning naming both variables', () => {
    /**
     * src/index.js logs this at startup. It must name what to set and say why, since the fallback
     * is the state an operator most needs to know they are in.
     */
    const described = describeAdminConfiguration(env());

    assert.equal(described.mode, 'fallback');
    assert.equal(described.users, 0);
    assert.equal(described.roles, 0);
    assert.ok(described.warning, 'fallback mode must warn');
    assert.match(described.warning, /ADMIN_USER_IDS/);
    assert.match(described.warning, /ADMIN_ROLE_IDS/);
    assert.match(described.warning, /Administrator/);
  });

  test('tolerates a missing environment', () => {
    assert.equal(describeAdminConfiguration({}).mode, 'fallback');
    assert.equal(describeAdminConfiguration(undefined).mode, 'fallback');
  });
});

describe('ADMIN_SOURCES', () => {
  test('every source is a distinct stable string', () => {
    /**
     * The routers log these, so they become part of the operational record and must not collide.
     */
    const values = Object.values(ADMIN_SOURCES);

    assert.equal(new Set(values).size, values.length);
    for (const value of values) {
      assert.equal(typeof value, 'string');
      assert.ok(value.length > 0);
    }
  });
});
