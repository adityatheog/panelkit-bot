import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SlashCommandBuilder } from 'discord.js';
import { ConfigError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const PARENT_DESCRIPTIONS = Object.freeze({
  account: 'Manage your panel account',
  admin: 'Administrative panel tools',
  files: 'Server file tools',
  server: 'Manage your servers',
  'server subuser': 'Manage sub-users on your server',
});

const NAME_RE = /^[a-z0-9-]+( [a-z0-9-]+){0,2}$/;

const SEGMENT_RE = /^[a-z0-9-]{1,32}$/;

const OPTION_NAME_RE = /^[a-z0-9_-]{1,32}$/;

const OPTION_TYPES = Object.freeze(['string', 'integer', 'user']);

const DISCORD_LIMITS = Object.freeze({
  description: 100,
  optionsPerCommand: 25,
  subcommandsPerGroup: 25,
  groupsPerCommand: 25,
  choicesPerOption: 25,
  commandsGlobal: 100,
});

const DEFAULT_ORDER = 100;

async function collectFiles(dir) {

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

  const greedyIndex = options.findIndex((option) => option.greedy === true);
  if (greedyIndex !== -1 && greedyIndex !== options.length - 1) {
    throw new ConfigError(
      `Command "${name}" declares a greedy option that is not last. A greedy option absorbs all remaining input.`,
    );
  }

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

function restrictToGuild(builder) {
  try {
    if (typeof builder.setContexts === 'function') {

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

function parentDescription(key) {
  return PARENT_DESCRIPTIONS[key] ?? `${key} commands`;
}

export function buildSlashBody(commands) {

  const roots = new Map();

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
    const root = roots.get(rootName);

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

    if (root.subcommands.some((entry) => entry.leaf === parts[1])) {
      throw new ConfigError(
        `"${command.name}" needs "${parts[1]}" to be a subcommand group, but it is already a subcommand of "${rootName}".`,
      );
    }
    if (!root.groups.has(parts[1])) root.groups.set(parts[1], []);

    const group = root.groups.get(parts[1]);
    if (group.some((entry) => entry.leaf === parts[2])) {
      throw new ConfigError(`Duplicate subcommand "${command.name}".`);
    }
    group.push({ leaf: parts[2], command });
  }

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

export function slashLeaves(body) {
  const leaves = new Set();

  for (const command of body) {
    const options = Array.isArray(command.options) ? command.options : [];

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

function byOrderThenName(a, b) {
  const orderA = Number.isInteger(Number(a.order)) ? Number(a.order) : DEFAULT_ORDER;
  const orderB = Number.isInteger(Number(b.order)) ? Number(b.order) : DEFAULT_ORDER;
  if (orderA !== orderB) return orderA - orderB;
  return a.name.localeCompare(b.name);
}

export function createRegistry(commands) {

  const byName = new Map();

  for (const command of commands) {
    if (byName.has(command.name)) {
      throw new ConfigError(`Duplicate command name "${command.name}".`);
    }
    byName.set(command.name, command);
  }

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

    all: visible,

    every: commands,

    byName,

    categories,

    counts: Object.freeze({ commands: visible.length, categories: categoryNames.length }),

    get(name) {
      return byName.get(String(name ?? '').trim().toLowerCase()) ?? null;
    },

    getVisible(name) {
      const command = byName.get(String(name ?? '').trim().toLowerCase());
      return command && command.hidden !== true ? command : null;
    },

    category(name) {
      return categories.find((entry) => entry.name === name) ?? null;
    },

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

    slashBody() {
      return buildSlashBody(commands);
    },

    slashLeaves() {
      return slashLeaves(buildSlashBody(commands));
    },
  };
}

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

      throw new ConfigError(`Could not load the command definition ${relative}: ${err?.message ?? 'import failed'}`);
    }

    const command = module.default ?? module;
    validateDefinition(command, relative);
    commands.push(command);
  }

  const registry = createRegistry(commands);

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

export function auditRegistry(registry, { expectedCommands = 25, expectedCategories = 5 } = {}) {
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
