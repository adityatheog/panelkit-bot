// Coded by Aditya | GitHub- @adityatheog

/**
 * Authorisation for privileged commands.
 *
 * Admin commands in this bot can suspend other people's servers, provision
 * accounts on their behalf and enumerate every server on the panel. That is a
 * meaningful amount of power, so the decision of who holds it is made here, in
 * one place, and evaluated in both routers before a handler ever runs.
 *
 * Resolution order:
 *
 *   1. ADMIN_USER_IDS contains the invoking user id                -> allow
 *   2. ADMIN_ROLE_IDS intersects the member's roles                -> allow
 *   3. Neither list is configured, and the member holds the Discord
 *      "Administrator" permission                                  -> allow
 *   4. Otherwise                                                   -> deny
 *
 * Step 3 is a bootstrap convenience, not a policy. Once an operator configures
 * either allowlist, that list becomes authoritative and a guild administrator who
 * is not on it is refused. This matters because a bot invited to a public server
 * would otherwise grant panel-wide control to every moderator with the
 * Administrator permission in that server.
 *
 * src/index.js emits a startup warning while the bot is running in fallback mode,
 * using describeAdminConfiguration() below.
 */

import { PermissionFlagsBits, PermissionsBitField } from 'discord.js';

/** Machine-readable reason an admin check succeeded, recorded in the audit log line. */
export const ADMIN_SOURCES = Object.freeze({
  USER_ALLOWLIST: 'user-allowlist',
  ROLE_ALLOWLIST: 'role-allowlist',
  DISCORD_ADMINISTRATOR: 'discord-administrator-fallback',
  NONE: 'none',
});

/**
 * Extracts the member's role ids.
 *
 * Two shapes reach this function. A cached guild yields a GuildMember, whose
 * `roles.cache` is a Collection keyed by role id. An interaction from a guild the
 * bot has not cached yields an APIInteractionGuildMember, whose `roles` is a plain
 * array of id strings. Handling only the first shape would silently deny access
 * in the second case, which is difficult to reproduce and easy to misdiagnose.
 *
 * @param {unknown} member
 * @returns {string[]}
 */
function extractRoleIds(member) {
  if (!member || typeof member !== 'object') return [];

  const roles = member.roles;
  if (!roles) return [];

  // APIInteractionGuildMember: roles is string[].
  if (Array.isArray(roles)) return roles.map(String);

  // GuildMember: roles.cache is a Collection<Snowflake, Role>.
  const cache = roles.cache;
  if (cache && typeof cache.keys === 'function') return [...cache.keys()].map(String);

  return [];
}

/**
 * Resolves the member's permissions into a bitfield that can be queried.
 *
 * GuildMember exposes a PermissionsBitField; the raw API shape exposes a decimal
 * string. Both are normalised here so callers never branch on the member shape.
 *
 * @param {unknown} member
 * @returns {PermissionsBitField|null}
 */
function extractPermissions(member) {
  if (!member || typeof member !== 'object') return null;

  const permissions = member.permissions;
  if (permissions === null || permissions === undefined) return null;

  if (typeof permissions.has === 'function') return permissions;

  if (typeof permissions === 'string' || typeof permissions === 'bigint') {
    try {
      return new PermissionsBitField(BigInt(permissions));
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Whether either admin allowlist has been configured.
 *
 * @param {{ adminUserIds?: readonly string[], adminRoleIds?: readonly string[] }} env
 * @returns {boolean}
 */
export function hasAdminAllowlist(env) {
  const users = env?.adminUserIds ?? [];
  const roles = env?.adminRoleIds ?? [];
  return users.length > 0 || roles.length > 0;
}

/**
 * Determines whether the caller may run admin commands, and why.
 *
 * The reason is returned alongside the decision so the routers can log which rule
 * granted access. On a public bot, knowing that an action was authorised by the
 * Administrator fallback rather than by an explicit allowlist is the difference
 * between a routine log line and an incident.
 *
 * @param {object} options
 * @param {unknown} options.member GuildMember or APIInteractionGuildMember; null in DMs
 * @param {string} options.userId the invoking Discord user id
 * @param {{ adminUserIds?: readonly string[], adminRoleIds?: readonly string[] }} options.env
 * @returns {{ allowed: boolean, source: string }}
 */
export function resolveAdmin({ member, userId, env }) {
  const id = String(userId ?? '');
  const allowedUsers = env?.adminUserIds ?? [];
  const allowedRoles = env?.adminRoleIds ?? [];

  if (id !== '' && allowedUsers.includes(id)) {
    return { allowed: true, source: ADMIN_SOURCES.USER_ALLOWLIST };
  }

  if (allowedRoles.length > 0) {
    const memberRoles = extractRoleIds(member);
    if (memberRoles.some((roleId) => allowedRoles.includes(roleId))) {
      return { allowed: true, source: ADMIN_SOURCES.ROLE_ALLOWLIST };
    }
  }

  // An explicit allowlist is authoritative: do not fall back past it.
  if (hasAdminAllowlist(env)) {
    return { allowed: false, source: ADMIN_SOURCES.NONE };
  }

  // Fallback mode. A guild owner satisfies this implicitly, because Discord
  // reports the Administrator permission for the owner.
  const permissions = extractPermissions(member);
  if (permissions && permissions.has(PermissionFlagsBits.Administrator)) {
    return { allowed: true, source: ADMIN_SOURCES.DISCORD_ADMINISTRATOR };
  }

  return { allowed: false, source: ADMIN_SOURCES.NONE };
}

/**
 * Boolean form of resolveAdmin, for call sites that do not log the reason.
 *
 * @param {{ member: unknown, userId: string, env: object }} options
 * @returns {boolean}
 */
export function isAdmin(options) {
  return resolveAdmin(options).allowed;
}

/**
 * Evaluates admin access for a command execution context.
 *
 * @param {{ member: unknown, user: { id: string }, env: object }} ctx
 * @returns {{ allowed: boolean, source: string }}
 */
export function resolveContextAdmin(ctx) {
  return resolveAdmin({ member: ctx?.member, userId: ctx?.user?.id, env: ctx?.env });
}

/**
 * Boolean form of resolveContextAdmin.
 *
 * @param {object} ctx
 * @returns {boolean}
 */
export function contextIsAdmin(ctx) {
  return resolveContextAdmin(ctx).allowed;
}

/**
 * Checks a single Discord permission for a member.
 *
 * Returns false when the member shape carries no permissions, which is the case
 * in direct messages. Guild-only commands are gated separately by the routers, so
 * failing closed here is correct.
 *
 * @param {unknown} member
 * @param {bigint} flag a PermissionFlagsBits value
 * @returns {boolean}
 */
export function hasGuildPermission(member, flag) {
  const permissions = extractPermissions(member);
  return Boolean(permissions && permissions.has(flag));
}

/**
 * Permissions the bot needs in a text channel to answer a prefix command.
 *
 * Without Embed Links every embed reply is silently dropped by Discord, which
 * presents to users as the bot ignoring them. Detecting it lets the router log a
 * precise cause instead of nothing at all.
 */
const REQUIRED_CHANNEL_PERMISSIONS = Object.freeze([
  ['ViewChannel', PermissionFlagsBits.ViewChannel],
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['EmbedLinks', PermissionFlagsBits.EmbedLinks],
  ['ReadMessageHistory', PermissionFlagsBits.ReadMessageHistory],
]);

/**
 * Lists the permissions the bot is missing in a guild channel.
 *
 * @param {unknown} channel a guild text channel
 * @param {unknown} botMember the bot's GuildMember
 * @returns {string[]} human-readable permission names, empty when nothing is missing
 */
export function missingChannelPermissions(channel, botMember) {
  if (!channel || typeof channel.permissionsFor !== 'function' || !botMember) return [];

  let permissions;
  try {
    permissions = channel.permissionsFor(botMember);
  } catch {
    return [];
  }
  if (!permissions) return [];

  return REQUIRED_CHANNEL_PERMISSIONS.filter(([, flag]) => !permissions.has(flag)).map(([name]) => name);
}

/**
 * Summarises the admin configuration for the startup log.
 *
 * @param {{ adminUserIds?: readonly string[], adminRoleIds?: readonly string[] }} env
 * @returns {{ mode: 'allowlist'|'fallback', users: number, roles: number, warning: string|null }}
 */
export function describeAdminConfiguration(env) {
  const users = env?.adminUserIds?.length ?? 0;
  const roles = env?.adminRoleIds?.length ?? 0;

  if (users > 0 || roles > 0) {
    return { mode: 'allowlist', users, roles, warning: null };
  }

  return {
    mode: 'fallback',
    users,
    roles,
    warning:
      'No ADMIN_USER_IDS or ADMIN_ROLE_IDS configured. Admin commands currently fall back to the Discord "Administrator" permission, ' +
      'which grants panel-wide control to every server administrator who can see the bot. Set at least one allowlist before public use.',
  };
}

export { REQUIRED_CHANNEL_PERMISSIONS };
