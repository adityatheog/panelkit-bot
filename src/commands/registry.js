// Coded by Aditya | GitHub- @adityatheog

/**
 * The command registry: one source of truth for the entire command tree.
 *
 * A command is declared exactly once, in a file under commands/definitions/, with a
 * canonical space-separated name. That single declaration produces all three
 * surfaces:
 *
 *   prefix invocation   kx!server subuser add a1b2c3d4 friend@example.com
 *   slash invocation    /server subuser add server:a1b2c3d4 email:friend@…
 *   help entry          • **server subuser add** — Add a sub-user to your server
 *
 * Nothing is registered twice, so the surfaces cannot drift apart. Adding a command
 * means adding one file; the routers, the deploy script and the help menu pick it up
 * without modification.
 *
 * Name mapping onto Discord's structure:
 *
 *   "ping"                     ->  /ping
 *   "account create"           ->  /account create              (subcommand)
 *   "server subuser add"       ->  /server subuser add          (group + subcommand)
 *
 * Discord permits at most command -> group -> subcommand, so a canonical name may
 * not exceed three words. That is enforced here rather than discovered as an opaque
 * 400 from the API during deployment.
 *
 * This module validates aggressively and at load time. Every constraint Discord
 * imposes — name patterns, description lengths, option counts, required-before-
 * optional ordering — is checked before a payload is built, because a rejected
 * bulk registration tells you only that *something* in the array was invalid.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SlashCommandBuilder } from 'discord.js';
import { ConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

/**
 * Descriptions for slash parents and groups.
 *
 * Discord requires a description on every command and group, but a parent such as
 * `account` is not itself a command and has no definition file to take one from.
 * These fill that gap and appear in the Discord command picker.
 */
const PARENT_DESCRIPTIONS = Object.freeze({
  account: 'Manage your panel account',
  admin: 'Administrative panel tools',
  files: 'Server file tools',
  server: 'Manage your servers',
  'server subuser': 'Manage sub-users on your server',
});

/** Canonical names: one to three lowercase, hyphen-friendly words. */
const NAME_RE = /^[a-z0-9-]+( [a-z0-9-]+){0,2}$/;

/** Discord's own pattern for a command, group or subcommand segment. */
const SEGMENT_RE = /^[a-z0-9-]{1,32}$/;

/** Discord's pattern for an option name. */
const OPTION_NAME_RE = /^[a-z0-9_-]{1,32}$/;

/** Option types this project supports. Each maps to a discord.js builder method. */
const OPTION_TYPES = Object.freeze(['string', 'integer', 'user']);

/** Discord limits, checked here so deployment cannot fail on them. */
const DISCORD_LIMITS = Object.freeze({
  description: 100,
  optionsPerCommand: 25,
  subcommandsPerGroup: 25,
  groupsPerCommand: 25,
  choicesPerOption: 25,
  commandsGlobal: 100,
});

/** Sort weight for commands that do not declare `order`. */
const DEFAULT_ORDER = 100;

/**
 * Recursively collects .js files, sorted for deterministic load order.
 *
 * Determinism matters: the slash payload's element order affects nothing
 * functionally, but a stable order makes the deploy script's output diffable and
 * keeps test assertions meaningful.
 *
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collectFiles(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw new ConfigError(`Could not read the command directory at ${dir}.`, { cause: err?.message });
  }

  const files = [];
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of sorted) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }

  return files;
}

/**
 * Validates one option declaration.
 *
 * @param {unknown} option
 * @param {string} commandName
 * @param {number} index
 * @param {Set<string>} seenNames
 * @returns {void}
 * @throws {ConfigError}
 */
function validateOption(option, commandName, index, seenNames) {
  const where = `option ${index} of "${commandName}"`;

  if (!option || typeof option !== 'object' || Array.isArray(option)) {
    throw new ConfigError(`${where} must be an object.`);
  }

  const name = String(option.name ?? '');
  if (!OPTION_NAME_RE.test(name)) {
    throw new ConfigError(
      `${where} has an invalid name "${name}". Discord option names must be 1-32 characters of lowercase letters, digits, "-" or "_".`,
    );
  }
  if (seenNames.has(name)) {
    throw new ConfigError(`"${commandName}" declares the option "${name}" more than once.`);
  }
  seenNames.add(name);

  const description = String(option.description ?? '');
  if (description === '') {
    throw new ConfigError(`${where} is missing a description. Discord requires one on every option.`);
  }
  if (description.length > DISCORD_LIMITS.description) {
    throw new ConfigError(
      `${where} has a description of ${description.length} characters; Discord allows at most ${DISCORD_LIMITS.description}.`,
    );
  }

  const type = String(option.type ?? 'string');
  if (!OPTION_TYPES.includes(type)) {
    throw new ConfigError(`${where} has an unsupported type "${type}". Supported types: ${OPTION_TYPES.join(', ')}.`);
  }

  if (option.choices !== undefined) {
    if (type !== 'string') {
      throw new ConfigError(`${where} declares choices, which this project supports only on string options.`);
    }
    if (!Array.isArray(option.choices) || option.choices.length === 0) {
      throw new ConfigError(`${where} declares choices but they are not a non-empty array.`);
    }
    if (option.choices.length > DISCORD_LIMITS.choicesPerOption) {
      throw new ConfigError(
        `${where} declares ${option.choices.length} choices; Discord allows at most ${DISCORD_LIMITS.choicesPerOption}.`,
      );
    }
    for (const choice of option.choices) {
      if (!choice || typeof choice !== 'object' || choice.value === undefined) {
        throw new ConfigError(`${where} has a choice without a value.`);
      }
    }
  }

  if (option.greedy === true && type !== 'string') {
    throw new ConfigError(`${where} is marked greedy, which only applies to string options on the prefix surface.`);
  }

  if (type === 'integer') {
    for (const bound of ['min', 'max']) {
      if (option[bound] !== undefined && !Number.isInteger(Number(option[bound]))) {
        throw new ConfigError(`${where} has a non-integer ${bound} bound.`);
      }
    }
    if (option.min !== undefined && option.max !== undefined && Number(option.min) > Number(option.max)) {
      throw new ConfigError(`${where} has min greater than max.`);
    }
  }

  if (type === 'string') {
    for (const bound of ['minLength', 'maxLength']) {
      if (option[bound] !== undefined && !Number.isInteger(Number(option[bound]))) {
        throw new ConfigError(`${where} has a non-integer ${bound}.`);
      }
    }
  }
}

/**
 * Validates one command definition.
 *
 * @param {unknown} command
 * @param {string} file relative path, for error messages
 * @returns {void}
 * @throws {ConfigError}
 */
function validateDefinition(command, file) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new ConfigError(`${file} does not export a command object as its default export.`);
  }

  const name = String(command.name ?? '');
  if (name === '') throw new ConfigError(`${file} is missing a "name".`);

  if (!NAME_RE.test(name)) {
    throw new ConfigError(
      `Command name "${name}" (${file}) must be one to three space-separated words of lowercase letters, digits or hyphens. ` +
        'Discord supports at most command -> group -> subcommand.',
    );
  }

  for (const segment of name.split(' ')) {
    if (!SEGMENT_RE.test(segment)) {
      throw new ConfigError(`Command name "${name}" (${file}) has an invalid segment "${segment}".`);
    }
  }

  if (!command.category || typeof command.category !== 'string') {
    throw new ConfigError(`Command "${name}" is missing a "category".`);
  }

  const description = String(command.description ?? '');
  if (description === '') throw new ConfigError(`Command "${name}" is missing a "description".`);
  if (description.length > DISCORD_LIMITS.description) {
    throw new ConfigError(
      `Command "${name}" has a description of ${description.length} characters; Discord allows at most ${DISCORD_LIMITS.description}.`,
    );
  }

  if (typeof command.execute !== 'function') {
    throw new ConfigError(`Command "${name}" has no execute function.`);
  }

  if (command.order !== undefined && !Number.isInteger(Number(command.order))) {
    throw new ConfigError(`Command "${name}" has a non-integer "order".`);
  }

  if (command.aliases !== undefined) {
    if (!Array.isArray(command.aliases)) {
      throw new ConfigError(`Command "${name}" has a non-array "aliases".`);
    }
    for (const alias of command.aliases) {
      if (!NAME_RE.test(String(alias))) {
        throw new ConfigError(`Command "${name}" has an invalid alias "${alias}".`);
      }
    }
  }

  const options = command.options ?? [];
  if (!Array.isArray(options)) {
    throw new ConfigError(`Command "${name}" has a non-array "options".`);
  }
  if (options.length > DISCORD_LIMITS.optionsPerCommand) {
    throw new ConfigError(
      `Command "${name}" declares ${options.length} options; Discord allows at most ${DISCORD_LIMITS.optionsPerCommand}.`,
    );
  }

  const seenNames = new Set();
  options.forEach((option, index) => validateOption(option, name, index, seenNames));

  // A greedy option consumes the rest of the prefix input, so anything declared
  // after it could never receive a value.
  const greedyIndex = options.findIndex((option) => option.greedy === true);
  if (greedyIndex !== -1 && greedyIndex !== options.length - 1) {
    throw new ConfigError(
      `Command "${name}" declares a greedy option that is not last. A greedy option absorbs all remaining input.`,
    );
  }

  // A required option after an optional one is unresolvable positionally on the
  // prefix surface, and Discord rejects the same ordering outright.
  let seenOptional = false;
  for (const option of options) {
    if (option.required) {
      if (seenOptional) {
        throw new ConfigError(
          `Command "${name}" declares the required option "${option.name}" after an optional one. Required options must come first.`,
        );
      }
    } else {
      seenOptional = true;
    }
  }
}

/**
 * Applies option declarations to a builder.
 *
 * @param {import('discord.js').SlashCommandBuilder | import('discord.js').SlashCommandSubcommandBuilder} builder
 * @param {Array<object>} options
 * @returns {typeof builder}
 */
function applyOptions(builder, options = []) {
  for (const option of options) {
    const applyCommon = (builderOption) =>
      builderOption
        .setName(option.name)
        .setDescription(option.description)
        .setRequired(Boolean(option.required));

    switch (option.type) {
      case 'integer':
        builder.addIntegerOption((builderOption) => {
          applyCommon(builderOption);
          if (option.min !== undefined) builderOption.setMinValue(Number(option.min));
          if (option.max !== undefined) builderOption.setMaxValue(Number(option.max));
          return builderOption;
        });
        break;

      case 'user':
        builder.addUserOption((builderOption) => applyCommon(builderOption));
        break;

      case 'string':
      default:
        builder.addStringOption((builderOption) => {
          applyCommon(builderOption);
          if (option.minLength !== undefined) builderOption.setMinLength(Number(option.minLength));
          if (option.maxLength !== undefined) builderOption.setMaxLength(Number(option.maxLength));
          if (option.choices) {
            builderOption.addChoices(
              ...option.choices.map((choice) => ({
                name: String(choice.name ?? choice.value),
                value: String(choice.value),
              })),
            );
          }
          return builderOption;
        });
        break;
    }
  }

  return builder;
}

/**
 * Restricts a root command to guilds.
 *
 * setContexts is the current API and setDMPermission the deprecated one. Both are
 * feature-detected so the project works across discord.js 14.x minor versions
 * without emitting deprecation warnings on either. Failure is non-fatal: the
 * routers enforce guildOnly at runtime regardless, so the worst case is that the
 * command appears in DMs and answers with the "Server Only" embed.
 *
 * @param {import('discord.js').SlashCommandBuilder} builder
 * @returns {import('discord.js').SlashCommandBuilder}
 */
function restrictToGuild(builder) {
  try {
    if (typeof builder.setContexts === 'function') {
      // InteractionContextType.Guild === 0
      builder.setContexts(0);
    } else if (typeof builder.setDMPermission === 'function') {
      builder.setDMPermission(false);
    }
  } catch (err) {
    logger.debug('Could not set guild-only context on a slash command', {
      command: builder?.name,
      message: err?.message,
    });
  }
  return builder;
}

/**
 * @param {string} key
 * @returns {string}
 */
function parentDescription(key) {
  return PARENT_DESCRIPTIONS[key] ?? `${key} commands`;
}

/**
 * Builds the Discord slash command payload from canonical names.
 *
 * Two passes. The first groups definitions by root and by group, because a
 * subcommand group cannot be emitted until every one of its leaves is known — a
 * single-pass build would have to mutate a group after adding it, which the builder
 * does not support. The second pass emits each root once, fully formed.
 *
 * @param {Array<object>} commands
 * @returns {Array<object>} JSON payloads ready for the REST API
 * @throws {ConfigError} on any structural conflict
 */
export function buildSlashBody(commands) {
  /**
   * @type {Map<string, {
   *   name: string,
   *   standalone: object|null,
   *   subcommands: Array<{ leaf: string, command: object }>,
   *   groups: Map<string, Array<{ leaf: string, command: object }>>,
   *   guildOnly: boolean
   * }>}
   */
  const roots = new Map();

  // Pass one: group by structure.
  for (const command of commands) {
    if (command.slash === false) continue;

    const parts = command.name.split(' ');
    const rootName = parts[0];

    if (!roots.has(rootName)) {
      roots.set(rootName, {
        name: rootName,
        standalone: null,
        subcommands: [],
        groups: new Map(),
        guildOnly: false,
      });
    }
    const root = /** @type {NonNullable<ReturnType<typeof roots.get>>} */ (roots.get(rootName));

    // A root is guild-only if any command beneath it is. Discord scopes context at
    // the root, so the stricter setting wins; the routers still gate per command.
    if (command.guildOnly !== false) root.guildOnly = true;

    if (parts.length === 1) {
      if (root.subcommands.length > 0 || root.groups.size > 0) {
        throw new ConfigError(
          `"${command.name}" cannot be a standalone command because other commands are nested under "${rootName}".`,
        );
      }
      if (root.standalone) {
        throw new ConfigError(`Duplicate root command "${command.name}".`);
      }
      root.standalone = command;
      continue;
    }

    if (root.standalone) {
      throw new ConfigError(
        `"${rootName}" is already a standalone command, so "${command.name}" cannot be nested under it.`,
      );
    }

    if (parts.length === 2) {
      if (root.subcommands.some((entry) => entry.leaf === parts[1])) {
        throw new ConfigError(`Duplicate subcommand "${command.name}".`);
      }
      if (root.groups.has(parts[1])) {
        throw new ConfigError(
          `"${command.name}" conflicts with the subcommand group "${rootName} ${parts[1]}"; a name cannot be both.`,
        );
      }
      root.subcommands.push({ leaf: parts[1], command });
      continue;
    }

    // Three segments: root -> group -> subcommand.
    if (root.subcommands.some((entry) => entry.leaf === parts[1])) {
      throw new ConfigError(
        `"${command.name}" needs "${parts[1]}" to be a subcommand group, but it is already a subcommand of "${rootName}".`,
      );
    }
    if (!root.groups.has(parts[1])) root.groups.set(parts[1], []);

    const group = /** @type {Array<{ leaf: string, command: object }>} */ (root.groups.get(parts[1]));
    if (group.some((entry) => entry.leaf === parts[2])) {
      throw new ConfigError(`Duplicate subcommand "${command.name}".`);
    }
    group.push({ leaf: parts[2], command });
  }

  // Pass two: emit.
  const body = [];

  for (const root of roots.values()) {
    const builder = new SlashCommandBuilder().setName(root.name);

    if (root.standalone) {
      builder.setDescription(root.standalone.description);
      applyOptions(builder, root.standalone.options);
    } else {
      builder.setDescription(parentDescription(root.name));

      if (root.subcommands.length + root.groups.size > DISCORD_LIMITS.subcommandsPerGroup) {
        throw new ConfigError(
          `"${root.name}" has ${root.subcommands.length + root.groups.size} children; Discord allows at most ${DISCORD_LIMITS.subcommandsPerGroup}.`,
        );
      }

      for (const { leaf, command } of root.subcommands) {
        builder.addSubcommand((sub) => {
          sub.setName(leaf).setDescription(command.description);
          return applyOptions(sub, command.options);
        });
      }

      for (const [groupName, leaves] of root.groups) {
        if (leaves.length === 0) {
          throw new ConfigError(`Subcommand group "${root.name} ${groupName}" has no subcommands.`);
        }
        if (leaves.length > DISCORD_LIMITS.subcommandsPerGroup) {
          throw new ConfigError(
            `Subcommand group "${root.name} ${groupName}" has ${leaves.length} subcommands; Discord allows at most ${DISCORD_LIMITS.subcommandsPerGroup}.`,
          );
        }

        builder.addSubcommandGroup((group) => {
          group.setName(groupName).setDescription(parentDescription(`${root.name} ${groupName}`));
          for (const { leaf, command } of leaves) {
            group.addSubcommand((sub) => {
              sub.setName(leaf).setDescription(command.description);
              return applyOptions(sub, command.options);
            });
          }
          return group;
        });
      }
    }

    if (root.guildOnly) restrictToGuild(builder);

    body.push(builder.toJSON());
  }

  if (body.length > DISCORD_LIMITS.commandsGlobal) {
    throw new ConfigError(
      `The tree produces ${body.length} top-level commands; Discord allows at most ${DISCORD_LIMITS.commandsGlobal}.`,
    );
  }

  return body;
}

/**
 * Enumerates every invocable slash path in a payload.
 *
 * Used by the audit script and the tests to prove that every command in the
 * registry is actually reachable as a slash command, by walking the real payload
 * rather than trusting the definitions.
 *
 * @param {Array<object>} body output of buildSlashBody
 * @returns {Set<string>} canonical names, for example "server subuser add"
 */
export function slashLeaves(body) {
  const leaves = new Set();

  for (const command of body) {
    const options = Array.isArray(command.options) ? command.options : [];
    // ApplicationCommandOptionType: 1 = Subcommand, 2 = SubcommandGroup
    const subcommands = options.filter((option) => option.type === 1);
    const groups = options.filter((option) => option.type === 2);

    if (subcommands.length === 0 && groups.length === 0) {
      leaves.add(command.name);
    }

    for (const sub of subcommands) {
      leaves.add(`${command.name} ${sub.name}`);
    }

    for (const group of groups) {
      for (const sub of Array.isArray(group.options) ? group.options : []) {
        leaves.add(`${command.name} ${group.name} ${sub.name}`);
      }
    }
  }

  return leaves;
}

/**
 * Sorts commands by explicit order, then alphabetically.
 *
 * `order` exists because the documented layout is not purely alphabetical: the
 * Admin category leads with `create`, and General runs ping, plans, help. Commands
 * without an explicit order fall back to alphabetical within their category.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function byOrderThenName(a, b) {
  const orderA = Number.isInteger(Number(a.order)) ? Number(a.order) : DEFAULT_ORDER;
  const orderB = Number.isInteger(Number(b.order)) ? Number(b.order) : DEFAULT_ORDER;
  if (orderA !== orderB) return orderA - orderB;
  return a.name.localeCompare(b.name);
}

/**
 * Builds the registry from a list of validated definitions.
 *
 * Exported separately from loadRegistry so tests can construct a registry from
 * literals without touching the filesystem.
 *
 * @param {Array<object>} commands
 * @returns {object} the registry
 * @throws {ConfigError} on duplicate names or alias collisions
 */
export function createRegistry(commands) {
  /** @type {Map<string, object>} Lookup by canonical name and by alias. */
  const byName = new Map();

  for (const command of commands) {
    if (byName.has(command.name)) {
      throw new ConfigError(`Duplicate command name "${command.name}".`);
    }
    byName.set(command.name, command);
  }

  // Aliases are registered after every canonical name, so an alias that shadows a
  // real command is caught regardless of file load order.
  for (const command of commands) {
    for (const alias of command.aliases ?? []) {
      const key = String(alias).toLowerCase();
      if (byName.has(key)) {
        const existing = byName.get(key);
        throw new ConfigError(
          `Alias "${key}" on "${command.name}" collides with "${existing?.name}".`,
        );
      }
      byName.set(key, command);
    }
  }

  const visible = commands.filter((command) => command.hidden !== true).sort(byOrderThenName);

  const categoryNames = [...new Set(visible.map((command) => command.category))].sort();
  const categories = categoryNames.map((name) => ({
    name,
    commands: visible.filter((command) => command.category === name).sort(byOrderThenName),
  }));

  return {
    /** Every visible command, globally sorted. */
    all: visible,

    /** Every command including hidden ones, in load order. */
    every: commands,

    /** Lookup map including aliases. Prefer get() and getVisible(). */
    byName,

    /** Categories with their commands, both sorted. */
    categories,

    /** Counts used by the help header. Hidden commands are excluded. */
    counts: Object.freeze({ commands: visible.length, categories: categoryNames.length }),

    /**
     * Resolves a command by canonical name or alias, including hidden ones.
     *
     * @param {unknown} name
     * @returns {object|null}
     */
    get(name) {
      return byName.get(String(name ?? '').trim().toLowerCase()) ?? null;
    },

    /**
     * Resolves a command only if it appears in help.
     *
     * Used by the help menu so a hidden command cannot be surfaced through a
     * crafted select-menu value.
     *
     * @param {unknown} name
     * @returns {object|null}
     */
    getVisible(name) {
      const command = byName.get(String(name ?? '').trim().toLowerCase());
      return command && command.hidden !== true ? command : null;
    },

    /**
     * @param {unknown} name
     * @returns {{ name: string, commands: object[] }|null}
     */
    category(name) {
      return categories.find((entry) => entry.name === name) ?? null;
    },

    /**
     * Resolves a prefix invocation, longest match first.
     *
     * Three tokens are tried, then two, then one, so "server subuser add" wins over
     * a hypothetical "server" command. Remaining tokens are returned as positional
     * arguments.
     *
     * @param {string[]|string} tokens
     * @returns {{ command: object, rest: string[] }|null}
     */
    resolvePrefix(tokens) {
      const list = Array.isArray(tokens)
        ? tokens.map(String)
        : String(tokens ?? '')
            .split(/\s+/)
            .filter(Boolean);

      for (let size = Math.min(3, list.length); size >= 1; size -= 1) {
        const key = list.slice(0, size).join(' ').toLowerCase();
        const command = byName.get(key);
        if (command) return { command, rest: list.slice(size) };
      }

      return null;
    },

    /**
     * Builds the Discord registration payload.
     *
     * @returns {Array<object>}
     */
    slashBody() {
      return buildSlashBody(commands);
    },

    /**
     * Every canonical name reachable as a slash command.
     *
     * @returns {Set<string>}
     */
    slashLeaves() {
      return slashLeaves(buildSlashBody(commands));
    },
  };
}

/**
 * Loads and validates every command definition from disk.
 *
 * @param {string} baseDir the src directory
 * @returns {Promise<ReturnType<typeof createRegistry>>}
 * @throws {ConfigError} when the directory is empty or a definition is invalid
 */
export async function loadRegistry(baseDir) {
  const dir = path.join(baseDir, 'commands', 'definitions');
  const files = await collectFiles(dir);

  if (files.length === 0) {
    throw new ConfigError(
      `No command definitions were found in ${dir}. The project cannot run without commands.`,
    );
  }

  const commands = [];

  for (const file of files) {
    const relative = path.relative(dir, file);

    let module;
    try {
      module = await import(pathToFileURL(file).href);
    } catch (err) {
      // An import failure here is almost always a typo in an import path inside the
      // definition, so the underlying message is worth surfacing verbatim.
      throw new ConfigError(`Could not load the command definition ${relative}: ${err?.message ?? 'import failed'}`);
    }

    const command = module.default ?? module;
    validateDefinition(command, relative);
    commands.push(command);
  }

  const registry = createRegistry(commands);

  // Building the payload now means a structural conflict is reported at startup
  // rather than when someone runs the deploy script.
  const body = registry.slashBody();

  logger.info('Command registry loaded', {
    files: files.length,
    visible: registry.counts.commands,
    hidden: commands.length - registry.counts.commands,
    categories: registry.counts.categories,
    slashRoots: body.length,
  });

  return registry;
}

/**
 * Checks the registry against the documented command tree.
 *
 * Called by scripts/verify-project.js. Returns findings rather than throwing, so
 * the audit can report every discrepancy at once.
 *
 * @param {ReturnType<typeof createRegistry>} registry
 * @param {{ expectedCommands?: number, expectedCategories?: number }} [expectations]
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function auditRegistry(registry, { expectedCommands = 24, expectedCategories = 5 } = {}) {
  const problems = [];

  if (registry.counts.commands !== expectedCommands) {
    problems.push(
      `Expected ${expectedCommands} visible commands but found ${registry.counts.commands}.`,
    );
  }
  if (registry.counts.categories !== expectedCategories) {
    problems.push(
      `Expected ${expectedCategories} categories but found ${registry.counts.categories}: ${registry.categories.map((category) => category.name).join(', ')}.`,
    );
  }

  let leaves;
  try {
    leaves = registry.slashLeaves();
  } catch (err) {
    problems.push(`The slash payload could not be built: ${err?.message}`);
    return { ok: false, problems };
  }

  for (const command of registry.all) {
    if (command.slash !== false && !leaves.has(command.name)) {
      problems.push(`"${command.name}" is not reachable as a slash command.`);
    }
    if (!registry.resolvePrefix(command.name.split(' '))) {
      problems.push(`"${command.name}" is not reachable as a prefix command.`);
    }
  }

  return { ok: problems.length === 0, problems };
}

export { DEFAULT_ORDER, DISCORD_LIMITS, OPTION_TYPES, PARENT_DESCRIPTIONS };
