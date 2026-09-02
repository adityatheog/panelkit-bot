// Coded by Aditya | GitHub- @adityatheog

/**
 * config.json loading and validation.
 *
 * The split between `.env` and `config.json` is deliberate: `.env` holds secrets
 * and per-deployment values, while `config.json` holds the operator's catalogue —
 * which server types exist, what they cost, which container images are offered,
 * how the help menu paginates. It is committed, reviewable and editable without
 * touching source code.
 *
 * The validation model distinguishes two kinds of wrongness:
 *
 *   Structural errors throw. A malformed colour, a non-object egg, a bad log path
 *   or an invalid permission string means the file cannot be interpreted, and
 *   guessing would produce confusing failures later at provisioning time.
 *
 *   Unfilled placeholders do not throw. A fresh clone ships eggs with `eggId: 0`
 *   and `deploy.locationId: 0` because inventing real panel IDs would be a lie.
 *   Those entries are marked `configured: false`, hidden from users, and named in
 *   a startup warning. The bot boots and tells the operator exactly what to fill
 *   in, which is far more useful than refusing to start.
 *
 * Every value is normalised here so consumers never re-parse or re-default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../utils/errors.js';

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const EGG_KEY_RE = /^[a-z0-9_-]{1,32}$/;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;
const PERMISSION_RE = /^[a-z]+\.[a-z-]+$/;
const DOCKER_IMAGE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/:@]*$/;

/** Bounds that keep a typo from producing pathological behaviour. */
const BOUNDS = Object.freeze({
  usernameLength: { min: 3, max: 48, fallback: 10 },
  passwordLength: { min: 12, max: 64, fallback: 16 },
  helpPageSize: { min: 1, max: 25, fallback: 8 },
  helpDescriptionMax: { min: 20, max: 200, fallback: 51 },
  cooldownSeconds: { min: 0, max: 86_400 },
  maxInlineBytes: { min: 0, max: 25 * 1024 * 1024 },
});

/**
 * Reads an integer within bounds, silently falling back when absent or invalid.
 *
 * Used for cosmetic and tuning values where a bad number should degrade to the
 * default rather than block startup.
 *
 * @param {unknown} value
 * @param {{ min: number, max: number, fallback: number }} bounds
 * @returns {number}
 */
function boundedInt(value, bounds) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return bounds.fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

/**
 * Reads a non-negative integer, falling back when absent or invalid.
 *
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function intOr(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Validates a hex colour. Colours are structural: an invalid one throws, because
 * silently substituting a default hides an obvious typo.
 *
 * @param {unknown} value
 * @param {string} name
 * @param {string} [fallback] when provided, an absent value uses it instead of throwing
 * @returns {string}
 * @throws {ConfigError}
 */
function requireHexColor(value, name, fallback) {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;

  if (!HEX_COLOR_RE.test(String(value ?? ''))) {
    throw new ConfigError(`config.json: colors.${name} must be a 6-digit hex colour such as #2B2D31.`);
  }
  return String(value);
}

/**
 * Validates the identity block, which carries all user-visible branding.
 *
 * @param {unknown} raw
 * @returns {{ name: string, shortName: string, supportUrl: string, footerText: string }}
 * @throws {ConfigError}
 */
function validateIdentity(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const name = String(source.name ?? 'PanelKit').trim();
  if (name === '') throw new ConfigError('config.json: identity.name must not be empty.');
  if (name.length > 64) throw new ConfigError('config.json: identity.name must be 64 characters or fewer.');

  const supportUrl = String(source.supportUrl ?? '').trim();
  if (supportUrl !== '') {
    let parsed;
    try {
      parsed = new URL(supportUrl);
    } catch {
      throw new ConfigError('config.json: identity.supportUrl must be a valid URL or an empty string.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new ConfigError('config.json: identity.supportUrl must use http or https.');
    }
  }

  return {
    name,
    shortName: String(source.shortName ?? name).trim().slice(0, 32),
    supportUrl,
    footerText: String(source.footerText ?? name).trim().slice(0, 64),
  };
}

/**
 * Validates the account block, which governs generated credentials.
 *
 * @param {unknown} raw
 * @returns {{ emailDomain: string, usernameLength: number, passwordLength: number }}
 * @throws {ConfigError}
 */
function validateAccount(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const emailDomain = String(source.emailDomain ?? 'panelkit.local').trim().toLowerCase();
  if (!DOMAIN_RE.test(emailDomain)) {
    throw new ConfigError(
      'config.json: account.emailDomain must be a valid domain name, for example panelkit.local or example.com.',
    );
  }

  return {
    emailDomain,
    usernameLength: boundedInt(source.usernameLength, BOUNDS.usernameLength),
    passwordLength: boundedInt(source.passwordLength, BOUNDS.passwordLength),
  };
}

/**
 * Validates one egg definition.
 *
 * `configured` is the important output. An egg missing any of eggId, nestId or
 * dockerImage cannot provision a server, so it is excluded from the create menu
 * rather than offered and then failing with a panel 422.
 *
 * @param {string} key
 * @param {unknown} raw
 * @returns {object}
 * @throws {ConfigError}
 */
function validateEgg(key, raw) {
  if (!EGG_KEY_RE.test(key)) {
    throw new ConfigError(
      `config.json: egg key "${key}" must be 1-32 characters of lowercase letters, digits, "-" or "_".`,
    );
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`config.json: eggs.${key} must be an object.`);
  }

  if (raw.environment !== undefined && (typeof raw.environment !== 'object' || Array.isArray(raw.environment))) {
    throw new ConfigError(`config.json: eggs.${key}.environment must be an object of VARIABLE -> value.`);
  }
  if (raw.images !== undefined && (typeof raw.images !== 'object' || Array.isArray(raw.images))) {
    throw new ConfigError(`config.json: eggs.${key}.images must be an object of label -> image.`);
  }

  const eggId = Number(raw.eggId);
  const nestId = Number(raw.nestId);
  const dockerImage = String(raw.dockerImage ?? '').trim();

  if (raw.eggId !== undefined && !Number.isInteger(eggId)) {
    throw new ConfigError(`config.json: eggs.${key}.eggId must be an integer.`);
  }
  if (raw.nestId !== undefined && !Number.isInteger(nestId)) {
    throw new ConfigError(`config.json: eggs.${key}.nestId must be an integer.`);
  }
  if (dockerImage !== '' && !DOCKER_IMAGE_RE.test(dockerImage)) {
    throw new ConfigError(`config.json: eggs.${key}.dockerImage is not a valid container image reference.`);
  }

  const logPaths =
    Array.isArray(raw.logPaths) && raw.logPaths.length > 0 ? raw.logPaths.map((entry) => String(entry)) : ['/logs/latest.log'];

  for (const logPath of logPaths) {
    if (!logPath.startsWith('/')) {
      throw new ConfigError(
        `config.json: eggs.${key}.logPaths entries must be absolute paths starting with "/", got "${logPath}".`,
      );
    }
    if (logPath.split('/').includes('..')) {
      throw new ConfigError(`config.json: eggs.${key}.logPaths entries must not contain ".." segments.`);
    }
  }

  const images = {};
  for (const [label, image] of Object.entries(raw.images ?? {})) {
    const value = String(image).trim();
    if (value === '' || !DOCKER_IMAGE_RE.test(value)) {
      throw new ConfigError(`config.json: eggs.${key}.images["${label}"] is not a valid container image reference.`);
    }
    images[String(label).slice(0, 100)] = value;
  }

  const environment = {};
  for (const [name, value] of Object.entries(raw.environment ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ConfigError(
        `config.json: eggs.${key}.environment key "${name}" must be a valid environment variable name.`,
      );
    }
    environment[name] = value === null || value === undefined ? '' : String(value);
  }

  const hasEggId = Number.isInteger(eggId) && eggId > 0;
  const hasNestId = Number.isInteger(nestId) && nestId > 0;
  const configured = hasEggId && hasNestId && dockerImage !== '';

  /** Names the specific fields an operator still has to fill in. */
  const missing = [];
  if (!hasEggId) missing.push('eggId');
  if (!hasNestId) missing.push('nestId');
  if (dockerImage === '') missing.push('dockerImage');

  return {
    key,
    label: String(raw.label ?? key).trim().slice(0, 80) || key,
    eggId: hasEggId ? eggId : 0,
    nestId: hasNestId ? nestId : 0,
    dockerImage,
    startup: String(raw.startup ?? '').trim(),
    environment,
    logPaths,
    images,
    configured,
    missing: Object.freeze(missing),
  };
}

/**
 * Validates the deploy block used for automatic allocation.
 *
 * @param {unknown} raw
 * @returns {{ locationId: number, dedicatedIp: boolean, portRange: string[], configured: boolean }}
 * @throws {ConfigError}
 */
function validateDeploy(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const locationId = Number(source.locationId);
  if (source.locationId !== undefined && !Number.isInteger(locationId)) {
    throw new ConfigError('config.json: deploy.locationId must be an integer.');
  }

  const portRange = Array.isArray(source.portRange) ? source.portRange.map((entry) => String(entry).trim()) : [];
  for (const range of portRange) {
    if (!/^\d{1,5}(-\d{1,5})?$/.test(range)) {
      throw new ConfigError(`config.json: deploy.portRange entry "${range}" must be a port or a port range like 25565-25570.`);
    }
  }

  const valid = Number.isInteger(locationId) && locationId > 0;

  return {
    locationId: valid ? locationId : 0,
    dedicatedIp: Boolean(source.dedicatedIp),
    portRange,
    configured: valid,
  };
}

/**
 * Validates the default resource limits applied to new servers.
 *
 * @param {unknown} raw
 * @returns {{ limits: object, featureLimits: object }}
 * @throws {ConfigError}
 */
function validateDefaults(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const limitsRaw = source.limits && typeof source.limits === 'object' ? source.limits : {};
  const featureRaw = source.featureLimits && typeof source.featureLimits === 'object' ? source.featureLimits : {};

  const limits = {
    memory: intOr(limitsRaw.memory, 1024),
    swap: Number.isInteger(Number(limitsRaw.swap)) ? Number(limitsRaw.swap) : 0,
    disk: intOr(limitsRaw.disk, 5120),
    io: intOr(limitsRaw.io, 500),
    cpu: intOr(limitsRaw.cpu, 100),
  };

  if (limits.memory === 0) {
    throw new ConfigError('config.json: defaults.limits.memory must be greater than 0; a server with no memory cannot start.');
  }
  if (limits.disk === 0) {
    throw new ConfigError('config.json: defaults.limits.disk must be greater than 0; a server with no disk cannot install.');
  }
  if (limits.io < 10 || limits.io > 1000) {
    throw new ConfigError('config.json: defaults.limits.io must be between 10 and 1000 (Pterodactyl block IO weight).');
  }

  return {
    limits,
    featureLimits: {
      databases: intOr(featureRaw.databases, 1),
      allocations: intOr(featureRaw.allocations, 1),
      backups: intOr(featureRaw.backups, 1),
    },
  };
}

/**
 * Validates per-command cooldowns.
 *
 * @param {unknown} raw
 * @returns {{ defaultSeconds: number, perCommand: Record<string, number> }}
 * @throws {ConfigError}
 */
function validateCooldowns(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};

  const defaultSeconds = intOr(source.defaultSeconds, 3);
  if (defaultSeconds > BOUNDS.cooldownSeconds.max) {
    throw new ConfigError(`config.json: cooldowns.defaultSeconds must be at most ${BOUNDS.cooldownSeconds.max}.`);
  }

  const perCommandRaw = source.perCommand && typeof source.perCommand === 'object' ? source.perCommand : {};
  const perCommand = {};

  for (const [name, seconds] of Object.entries(perCommandRaw)) {
    /**
     * Only a number is a cooldown.
     *
     * Number(null) is 0 and Number(true) is 1, both integers within bounds — so a null value
     * would silently become a cooldown of zero, leaving the command it was meant to throttle
     * unthrottled with no error and no warning.
     */
    const value = typeof seconds === 'number' ? seconds : Number.NaN;

    if (!Number.isInteger(value) || value < BOUNDS.cooldownSeconds.min || value > BOUNDS.cooldownSeconds.max) {
      throw new ConfigError(
        `config.json: cooldowns.perCommand["${name}"] must be an integer between ${BOUNDS.cooldownSeconds.min} and ${BOUNDS.cooldownSeconds.max}.`,
      );
    }
    perCommand[String(name).trim().toLowerCase()] = value;
  }

  return { defaultSeconds, perCommand };
}

/**
 * Validates the sub-user permission set granted by `server subuser add`.
 *
 * @param {unknown} raw
 * @returns {{ defaultPermissions: readonly string[] }}
 * @throws {ConfigError}
 */
function validateSubuser(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const list = Array.isArray(source.defaultPermissions) ? source.defaultPermissions : [];

  const permissions = [];
  for (const entry of list) {
    const value = String(entry).trim().toLowerCase();
    if (!PERMISSION_RE.test(value)) {
      throw new ConfigError(
        `config.json: subuser.defaultPermissions contains an invalid entry "${entry}". Expected a form like control.console or file.read-content.`,
      );
    }
    permissions.push(value);
  }

  // A sub-user granted delete rights on the owner's server is a real hazard, so
  // the destructive server-level permissions are refused outright.
  const forbidden = permissions.filter((permission) =>
    ['settings.delete', 'server.delete', 'admin.websocket.errors'].includes(permission),
  );
  if (forbidden.length > 0) {
    throw new ConfigError(
      `config.json: subuser.defaultPermissions must not include ${forbidden.join(', ')}; sub-users must not be able to destroy the owner's server.`,
    );
  }

  return { defaultPermissions: Object.freeze([...new Set(permissions)]) };
}

/**
 * Validates the hosting plan catalogue shown by the `plans` command.
 *
 * @param {unknown} raw
 * @returns {readonly object[]}
 * @throws {ConfigError}
 */
function validatePlans(raw) {
  const list = Array.isArray(raw) ? raw : [];

  return Object.freeze(
    list.map((plan, index) => {
      if (!plan || typeof plan !== 'object' || Array.isArray(plan)) {
        throw new ConfigError(`config.json: plans[${index}] must be an object.`);
      }
      const name = String(plan.name ?? '').trim();
      if (name === '') throw new ConfigError(`config.json: plans[${index}].name is required.`);

      return Object.freeze({
        name: name.slice(0, 100),
        price: String(plan.price ?? 'Contact an administrator').trim().slice(0, 100),
        ram: intOr(plan.ram, 0),
        disk: intOr(plan.disk, 0),
        cpu: intOr(plan.cpu, 0),
        servers: intOr(plan.servers, 1),
        description: String(plan.description ?? '').trim().slice(0, 400),
      });
    }),
  );
}

/**
 * Validates a parsed config object and returns the frozen, normalised form.
 *
 * Exported separately from loadConfig so tests can validate literals without
 * touching the filesystem.
 *
 * @param {unknown} raw
 * @returns {Readonly<object>}
 * @throws {ConfigError}
 */
export function validateConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError('config.json must contain a JSON object.');
  }
  if (!raw.colors || typeof raw.colors !== 'object' || Array.isArray(raw.colors)) {
    throw new ConfigError('config.json: "colors" is required and must be an object.');
  }
  if (!raw.eggs || typeof raw.eggs !== 'object' || Array.isArray(raw.eggs)) {
    throw new ConfigError('config.json: "eggs" is required and must be an object.');
  }

  const colors = {
    primary: requireHexColor(raw.colors.primary, 'primary'),
    error: requireHexColor(raw.colors.error, 'error'),
    success: requireHexColor(raw.colors.success, 'success', '#57F287'),
    warning: requireHexColor(raw.colors.warning, 'warning', '#FEE75C'),
  };

  const eggKeys = Object.keys(raw.eggs);
  if (eggKeys.length === 0) {
    throw new ConfigError('config.json: at least one egg must be defined under "eggs".');
  }

  /** @type {Record<string, object>} */
  const eggs = {};
  /** @type {string[]} */
  const unconfiguredEggs = [];

  for (const key of eggKeys) {
    const egg = validateEgg(key, raw.eggs[key]);
    eggs[key] = Object.freeze(egg);
    if (!egg.configured) unconfiguredEggs.push(key);
  }

  const helpRaw = raw.help && typeof raw.help === 'object' ? raw.help : {};

  return Object.freeze({
    identity: Object.freeze(validateIdentity(raw.identity)),
    colors: Object.freeze(colors),
    account: Object.freeze(validateAccount(raw.account)),

    help: Object.freeze({
      pageSize: boundedInt(helpRaw.pageSize, BOUNDS.helpPageSize),
      descriptionMax: boundedInt(helpRaw.descriptionMax, BOUNDS.helpDescriptionMax),
    }),

    cooldowns: Object.freeze(validateCooldowns(raw.cooldowns)),
    deploy: Object.freeze(validateDeploy(raw.deploy)),
    defaults: Object.freeze(validateDefaults(raw.defaults)),
    subuser: Object.freeze(validateSubuser(raw.subuser)),

    backups: Object.freeze({
      maxInlineBytes: boundedInt(raw.backups?.maxInlineBytes, {
        ...BOUNDS.maxInlineBytes,
        fallback: 7 * 1024 * 1024,
      }),
    }),
    logs: Object.freeze({
      maxUploadBytes: boundedInt(raw.logs?.maxUploadBytes, {
        ...BOUNDS.maxInlineBytes,
        fallback: 7 * 1024 * 1024,
      }),
    }),

    plans: validatePlans(raw.plans),
    eggs: Object.freeze(eggs),
    unconfiguredEggs: Object.freeze(unconfiguredEggs),
  });
}

/**
 * Reads and validates config.json from disk.
 *
 * @param {string} [configPath]
 * @returns {Readonly<object>}
 * @throws {ConfigError}
 */
export function loadConfig(configPath = path.resolve(process.cwd(), 'config.json')) {
  let text;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') {
      throw new ConfigError(
        `config.json was not found at ${configPath}. The repository ships one; restore it or copy it from the project root.`,
      );
    }
    throw new ConfigError(`Could not read config.json at ${configPath}.`, { cause: err?.message });
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // JSON.parse messages include a character offset, which is the most useful
    // thing to hand an operator staring at a trailing comma.
    throw new ConfigError(`config.json is not valid JSON: ${err?.message ?? 'parse failed'}`);
  }

  return validateConfig(parsed);
}

/**
 * Egg keys that are fully configured and may therefore be offered to users.
 *
 * @param {Readonly<object>} config
 * @returns {string[]}
 */
export function availableEggKeys(config) {
  return Object.values(config.eggs)
    .filter((egg) => egg.configured)
    .map((egg) => egg.key);
}

/**
 * Summarises configuration readiness for the startup log.
 *
 * @param {Readonly<object>} config
 * @returns {{ ready: boolean, eggs: number, availableEggs: number, warnings: string[] }}
 */
export function describeConfig(config) {
  const warnings = [];
  const available = availableEggKeys(config);

  for (const key of config.unconfiguredEggs) {
    const egg = config.eggs[key];
    warnings.push(
      `Egg "${key}" is incomplete (missing: ${egg.missing.join(', ')}) and is hidden from users. Fill it in under eggs.${key} in config.json.`,
    );
  }

  if (available.length === 0) {
    warnings.push('No server types are fully configured, so "server create" will refuse every request until at least one egg is completed.');
  }
  if (!config.deploy.configured) {
    warnings.push('deploy.locationId is not set, so server creation will be refused. Find the ID under Admin -> Locations in the panel.');
  }
  if (config.subuser.defaultPermissions.length === 0) {
    warnings.push('subuser.defaultPermissions is empty, so "server subuser add" will refuse every request.');
  }
  if (config.plans.length === 0) {
    warnings.push('No plans are configured, so the "plans" command will report that none are available.');
  }

  return {
    ready: available.length > 0 && config.deploy.configured,
    eggs: Object.keys(config.eggs).length,
    availableEggs: available.length,
    warnings,
  };
}

export { BOUNDS, DOCKER_IMAGE_RE, PERMISSION_RE };
