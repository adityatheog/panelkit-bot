import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..');

const EXPECTED_TREE = Object.freeze({
  Account: ['account create', 'account delete', 'account info', 'account reset'],
  Admin: ['create', 'admin prune', 'admin servers', 'admin suspend', 'admin unsuspend', 'admin user'],
  Files: ['files backup'],
  General: ['ping', 'plans', 'help'],
  Server: [
    'server create',
    'server delete',
    'server info',
    'server list',
    'server logs',
    'server manage',
    'server power',
    'server rename',
    'server subuser add',
    'server subuser remove',
    'server usage',
  ],
});

const EXPECTED_COMMAND_COUNT = 25;
const EXPECTED_CATEGORY_COUNT = 5;

const REQUIRED_FILES = Object.freeze([

  'package.json',
  'config.json',
  '.env.example',
  '.gitignore',

  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'SECURITY.md',
  'CHANGELOG.md',
  'CODE_OF_CONDUCT.md',

  'Dockerfile',
  '.dockerignore',
  'docker-compose.yml',
  'ecosystem.config.cjs',
  'deploy/panelkit.service',
  '.github/workflows/ci.yml',

  'scripts/check.js',
  'scripts/init-db.js',
  'scripts/verify-project.js',
  'scripts/healthcheck.js',

  'src/index.js',
  'src/deploy-commands.js',

  'src/commands/registry.js',

  'src/config/config.js',
  'src/config/env.js',

  'src/core/context.js',
  'src/core/cooldowns.js',
  'src/core/messageRouter.js',
  'src/core/reply.js',

  'src/database/db.js',

  'src/help/helpController.js',
  'src/help/helpMenu.js',

  'src/interactions/dashboard.js',
  'src/interactions/router.js',

  'src/services/accountService.js',
  'src/services/adminService.js',
  'src/services/pterodactyl.js',
  'src/services/retry.js',
  'src/services/serverService.js',

  'src/utils/embeds.js',
  'src/utils/errors.js',
  'src/utils/format.js',
  'src/utils/locks.js',
  'src/utils/logger.js',
  'src/utils/permissions.js',
  'src/utils/security.js',
  'src/utils/sessions.js',
  'src/utils/validation.js',
]);

const REQUIRED_TESTS = Object.freeze([
  'tests/accountService.test.js',
  'tests/adminService.test.js',
  'tests/config.test.js',
  'tests/context.test.js',
  'tests/cooldowns.test.js',
  'tests/database.test.js',
  'tests/env.test.js',
  'tests/errors.test.js',
  'tests/format.test.js',
  'tests/helpMenu.test.js',
  'tests/locks.test.js',
  'tests/permissions.test.js',
  'tests/pterodactyl.test.js',
  'tests/registry.test.js',
  'tests/retry.test.js',
  'tests/security.test.js',
  'tests/serverService.test.js',
  'tests/sessions.test.js',
  'tests/validation.test.js',
]);

const EXPECTED_ENV_KEYS = Object.freeze([
  'DISCORD_TOKEN',
  'CLIENT_ID',
  'GUILD_ID',
  'DEFAULT_PREFIX',
  'PANEL_URL',
  'PANEL_APP_KEY',
  'PANEL_CLIENT_KEY',
  'ADMIN_USER_IDS',
  'ADMIN_ROLE_IDS',
  'ACCOUNT_AGE_DAYS',
  'FREE_SERVER_LIMIT',
  'STARTING_CREDITS',
  'DATABASE_PATH',
  'PANEL_TIMEOUT_MS',
  'PANEL_MAX_RETRIES',
  'VERIFY_PANEL_ON_STARTUP',
  'LOG_LEVEL',
  'HEARTBEAT_PATH',
  'NODE_ENV',
]);

const ENV_KEYS_WITH_DEFAULTS = Object.freeze(
  new Set([
    'DEFAULT_PREFIX',
    'ACCOUNT_AGE_DAYS',
    'FREE_SERVER_LIMIT',
    'STARTING_CREDITS',
    'DATABASE_PATH',
    'PANEL_TIMEOUT_MS',
    'PANEL_MAX_RETRIES',
    'VERIFY_PANEL_ON_STARTUP',
    'LOG_LEVEL',
    'HEARTBEAT_PATH',
    'NODE_ENV',
  ]),
);

const PLACEHOLDER_PATTERNS = Object.freeze([
  /\bTODO\b/,
  /\bFIXME\b/,
  /\bXXX\b/,
  /\bHACK\b/,
  /implement this yourself/i,
  /not implemented/i,
  /placeholder function/i,
  /add your code here/i,
  /the rest is similar/i,
]);

const SECRET_PATTERNS = Object.freeze([
  { name: 'Pterodactyl application key', pattern: /\bptla_[A-Za-z0-9]{40,}\b/ },
  { name: 'Pterodactyl client key', pattern: /\bptlc_[A-Za-z0-9]{40,}\b/ },
  { name: 'Discord bot token', pattern: /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/ },
]);

const SKIP_DIRECTORIES = Object.freeze(new Set(['node_modules', '.git', 'data', 'dist', 'coverage', 'logs']));

const SELF_EXECUTING = Object.freeze(
  new Set([
    path.join('src', 'index.js'),
    path.join('src', 'deploy-commands.js'),
  ]),
);

const results = [];

function record(name, status, detail = '') {
  results.push({ name, status, detail });
}

async function collect(dir, extension = '.js') {

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full, extension)));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(full);
  }

  return files;
}

function summarise(problems, limit = 8) {
  if (problems.length === 0) return '';
  if (problems.length <= limit) return problems.join('; ');

  return `${problems.slice(0, limit).join('; ')} … and ${problems.length - limit} more`;
}

function stripComments(source) {

  const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, '');

  return withoutBlocks.replace(/(^|[^:\\])\/\/.*$/gm, (match, prefix) => prefix);
}

function checkRequiredFiles() {
  const expected = [...REQUIRED_FILES, ...REQUIRED_TESTS];
  const missing = expected.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));

  record(
    `Required files present (${expected.length})`,
    missing.length === 0 ? 'pass' : 'fail',
    missing.length > 0 ? `missing: ${summarise(missing)}` : '',
  );
}

function checkManifest() {

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  } catch (err) {
    record('package.json is valid', 'fail', err?.message ?? String(err));
    return;
  }

  const problems = [];

  if (manifest.type !== 'module') {
    problems.push('"type" must be "module"; the source is ESM throughout');
  }

  const engines = String(manifest.engines?.node ?? '');
  if (!/20\.11|>=\s*2[0-9]/.test(engines)) {
    problems.push(`engines.node is "${engines}"; it must require at least 20.11 for import.meta.dirname`);
  }

  const main = String(manifest.main ?? '');
  if (main !== '' && !fs.existsSync(path.join(ROOT, main))) {
    problems.push(`main points at ${main}, which does not exist`);
  }

  for (const [name, command] of Object.entries(manifest.scripts ?? {})) {
    for (const match of String(command).matchAll(/node\s+(?:--[\w-]+(?:=\S+)?\s+)*([\w./-]+\.js)/g)) {
      const target = match[1];
      if (!fs.existsSync(path.join(ROOT, target))) {
        problems.push(`script "${name}" runs ${target}, which does not exist`);
      }
    }
  }

  record('package.json is consistent', problems.length === 0 ? 'pass' : 'fail', summarise(problems));
}

async function checkDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));

  const unpinned = Object.entries(manifest.dependencies ?? {})
    .filter(([, version]) => /^[\^~><*]|latest/.test(String(version)))
    .map(([name, version]) => `${name}@${version}`);

  record(
    'Dependencies are pinned',
    unpinned.length === 0 ? 'pass' : 'fail',
    unpinned.length > 0 ? `unpinned: ${unpinned.join(', ')}` : `${declared.size} pinned`,
  );

  const files = [
    ...(await collect(path.join(ROOT, 'src'))),
    ...(await collect(path.join(ROOT, 'scripts'))),
    ...(await collect(path.join(ROOT, 'tests'))),
  ];

  const imported = new Set();

  for (const file of files) {

    const source = stripComments(fs.readFileSync(file, 'utf8'));

    for (const match of source.matchAll(/(?:from|import)\s+['"]([^'".\/][^'"]*)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;

      if (/\s/.test(specifier)) continue;

      imported.add(
        specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0],
      );
    }
  }

  const undeclared = [...imported].filter((name) => !declared.has(name));
  record(
    'No undeclared imports',
    undeclared.length === 0 ? 'pass' : 'fail',
    undeclared.length > 0 ? `not in package.json: ${undeclared.join(', ')}` : '',
  );

  const unused = [...declared].filter((name) => !imported.has(name));
  record(
    'No unused dependencies',
    unused.length === 0 ? 'pass' : 'info',
    unused.length > 0 ? `declared but not imported: ${unused.join(', ')}` : '',
  );

  const hasLockfile =
    fs.existsSync(path.join(ROOT, 'package-lock.json')) || fs.existsSync(path.join(ROOT, 'npm-shrinkwrap.json'));

  record(
    'Lockfile present',
    hasLockfile ? 'pass' : 'info',
    hasLockfile ? '' : 'no package-lock.json; run npm install and commit it, or CI cannot cache or use npm ci',
  );
}

async function checkImportsResolve() {
  const files = await collect(path.join(ROOT, 'src'));
  const problems = [];
  let checked = 0;

  const cache = new Map();

  async function load(absolute) {
    if (cache.has(absolute)) return cache.get(absolute);

    let result;
    try {
      result = await import(pathToFileURL(absolute).href);
    } catch (err) {
      result = err instanceof Error ? err : new Error(String(err));
    }

    cache.set(absolute, result);
    return result;
  }

  for (const file of files) {
    const relativeFile = path.relative(ROOT, file);
    const source = fs.readFileSync(file, 'utf8');

    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/g)) {
      const names = match[1]
        .split(',')
        .map((entry) => entry.trim().split(/\s+as\s+/)[0].trim())
        .filter((entry) => entry !== '');

      if (names.length === 0) continue;

      const target = path.resolve(path.dirname(file), match[2]);

      if (!fs.existsSync(target)) {
        problems.push(`${relativeFile} imports from ${match[2]}, which does not exist`);
        continue;
      }

      if (SELF_EXECUTING.has(path.relative(ROOT, target))) continue;

      const module = await load(target);

      if (module instanceof Error) {
        problems.push(`${relativeFile} imports from ${match[2]}, which failed to load: ${module.message}`);
        continue;
      }

      for (const name of names) {
        checked += 1;

        if (!(name in module)) {
          problems.push(`${relativeFile} imports { ${name} } from ${match[2]}, which does not export it`);
        }
      }
    }
  }

  record(
    `Named imports resolve (${checked} across ${files.length} files)`,
    problems.length === 0 ? 'pass' : 'fail',
    summarise(problems),
  );
}

async function checkSecrets() {

  const problems = [];

  if (fs.existsSync(path.join(ROOT, '.env'))) {
    problems.push('.env exists in the working tree; confirm it is git-ignored and never committed');
  }

  const gitignorePath = path.join(ROOT, '.gitignore');
  const gitignore = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';

  for (const required of ['.env', 'node_modules', 'data/']) {
    if (!gitignore.includes(required)) problems.push(`.gitignore does not cover ${required}`);
  }

  const files = [
    ...(await collect(path.join(ROOT, 'src'))),
    ...(await collect(path.join(ROOT, 'scripts'))),
    ...(await collect(path.join(ROOT, 'tests'))),
    path.join(ROOT, 'config.json'),
    path.join(ROOT, '.env.example'),
    path.join(ROOT, 'docker-compose.yml'),
    path.join(ROOT, 'ecosystem.config.cjs'),
  ].filter((file) => fs.existsSync(file));

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');

    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(source)) {
        problems.push(`${path.relative(ROOT, file)} contains what looks like a ${name}`);
      }
    }
  }

  record('No committed secrets', problems.length === 0 ? 'pass' : 'fail', summarise(problems));
}

function checkEnvExample() {
  const examplePath = path.join(ROOT, '.env.example');

  if (!fs.existsSync(examplePath)) {
    record('.env.example documents every variable', 'fail', 'the file does not exist');
    return;
  }

  const source = fs.readFileSync(examplePath, 'utf8');

  const documented = new Set();

  const withValues = [];

  for (const line of source.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;

    const [, key, value] = match;
    documented.add(key);

    if (value.trim() !== '' && !ENV_KEYS_WITH_DEFAULTS.has(key)) {
      withValues.push(key);
    }
  }

  const missing = EXPECTED_ENV_KEYS.filter((key) => !documented.has(key));

  record(
    `.env.example documents every variable (${EXPECTED_ENV_KEYS.length})`,
    missing.length === 0 ? 'pass' : 'fail',
    missing.length > 0 ? `undocumented: ${missing.join(', ')}` : '',
  );

  record(
    '.env.example carries no secret values',
    withValues.length === 0 ? 'pass' : 'fail',
    withValues.length > 0 ? `has a value: ${withValues.join(', ')}` : '',
  );
}

async function checkConfig() {
  try {
    const { loadConfig, describeConfig } = await import(
      pathToFileURL(path.join(ROOT, 'src/config/config.js')).href
    );

    const config = loadConfig(path.join(ROOT, 'config.json'));
    record('config.json validates', 'pass', `identity: ${config.identity.name}`);

    const state = describeConfig(config);

    record(
      'Egg configuration',
      'info',
      state.availableEggs > 0
        ? `${state.availableEggs} of ${state.eggs} egg(s) configured`
        : `no eggs configured yet; ${config.unconfiguredEggs.join(', ')} need panel IDs`,
    );

    record(
      'Provisioning readiness',
      'info',
      state.ready ? 'ready' : 'not ready until at least one egg and deploy.locationId are filled in',
    );

    const { loadRegistry } = await import(pathToFileURL(path.join(ROOT, 'src/commands/registry.js')).href);
    const registry = await loadRegistry(path.join(ROOT, 'src'));

    const unknownCooldowns = Object.keys(config.cooldowns.perCommand).filter((name) => !registry.get(name));

    record(
      'Cooldown keys name real commands',
      unknownCooldowns.length === 0 ? 'pass' : 'fail',
      unknownCooldowns.length > 0 ? `no such command: ${unknownCooldowns.join(', ')}` : '',
    );
  } catch (err) {
    record('config.json validates', 'fail', err?.message ?? String(err));
  }
}

async function checkEnvValidation() {
  try {
    const { loadEnv, normalizePanelUrl, describeEnv } = await import(
      pathToFileURL(path.join(ROOT, 'src/config/env.js')).href
    );

    let rejected = false;
    try {
      loadEnv({});
    } catch {
      rejected = true;
    }
    record('Missing environment variables are rejected', rejected ? 'pass' : 'fail');

    const token = 'PLACEHOLDER.FOR.AUDIT';
    const appKey = 'ptla_auditplaceholder0000000000000000';
    const clientKey = 'ptlc_auditplaceholder0000000000000000';

    const env = loadEnv({
      DISCORD_TOKEN: token,
      CLIENT_ID: '123456789012345678',
      PANEL_URL: 'https://panel.example.com/api/application/',
      PANEL_APP_KEY: appKey,
      PANEL_CLIENT_KEY: clientKey,
    });

    const problems = [];
    if (env.panelUrl !== 'https://panel.example.com') problems.push(`PANEL_URL normalised to ${env.panelUrl}`);
    if (env.prefix !== 'kx!') problems.push(`default prefix is ${env.prefix}, expected kx!`);
    if (env.accountAgeDays !== 90) problems.push(`ACCOUNT_AGE_DAYS default is ${env.accountAgeDays}`);
    if (env.freeServerLimit !== 1) problems.push(`FREE_SERVER_LIMIT default is ${env.freeServerLimit}`);
    if (env.logLevel !== 'info') problems.push(`LOG_LEVEL default is ${env.logLevel}`);

    record('Environment defaults and normalisation', problems.length === 0 ? 'pass' : 'fail', summarise(problems));

    const normalised =
      normalizePanelUrl('https://panel.example.com/') === 'https://panel.example.com' &&
      normalizePanelUrl('https://panel.example.com/api') === 'https://panel.example.com' &&
      normalizePanelUrl('https://panel.example.com/api/client') === 'https://panel.example.com';

    record('Panel URL normalisation', normalised ? 'pass' : 'fail');

    const described = JSON.stringify(describeEnv(env));
    const leaks = [];

    for (const [label, secret] of [
      ['DISCORD_TOKEN', token],
      ['PANEL_APP_KEY', appKey],
      ['PANEL_CLIENT_KEY', clientKey],
    ]) {
      if (described.includes(secret) || described.includes(secret.slice(0, 12))) {
        leaks.push(label);
      }
    }

    record(
      'describeEnv leaks no credential fragment',
      leaks.length === 0 ? 'pass' : 'fail',
      leaks.length > 0 ? `leaked: ${leaks.join(', ')}` : '',
    );
  } catch (err) {
    record('Environment validation', 'fail', err?.message ?? String(err));
  }
}

async function checkDatabase() {
  try {
    const { createDatabase, SCHEMA_VERSION } = await import(
      pathToFileURL(path.join(ROOT, 'src/database/db.js')).href
    );

    const db = createDatabase(':memory:');

    try {
      const owner = '111111111111111111';
      const stranger = '222222222222222222';

      db.createUser({ discordId: owner, panelId: 1, email: 'a@b.test', username: 'audit1' });
      db.createServer({
        discordId: owner,
        panelServerId: 1,
        identifier: 'a1b2c3d4',
        name: 'Audit',
        eggType: 'nodejs',
      });

      const problems = [];

      if (!db.getOwnedServer('a1b2c3d4', owner)) problems.push('the owner could not find their own server');
      if (db.getOwnedServer('a1b2c3d4', stranger) !== null) problems.push('a foreign owner matched a server');

      if (db.updateServer({ identifier: 'a1b2c3d4', discordId: stranger, name: 'Hijacked' })) {
        problems.push('a foreign owner renamed a server');
      }
      if (db.deleteServer('a1b2c3d4', stranger)) {
        problems.push('a foreign owner deleted a server');
      }
      if (db.getServer('a1b2c3d4')?.name !== 'Audit') {
        problems.push('a refused foreign write altered the record');
      }

      if (db.getServer("a1b2c3d4'; DROP TABLE servers; --") !== null) {
        problems.push('an injection string matched a row');
      }
      if (db.countUserServers(owner) !== 1) {
        problems.push('the servers table was altered by an injection attempt');
      }

      db.setCredits(owner, 5);
      if (db.spendCredits(owner, 10)) problems.push('an overdraft was permitted');
      if (db.getCredits(owner) !== 5) problems.push('a refused spend altered the balance');

      db.deleteUserWithServers(owner);
      if (db.getUser(owner) !== null) problems.push('the user survived a cascade delete');
      if (db.getServer('a1b2c3d4') !== null) problems.push('a server survived a cascade delete');

      record(
        `Database schema v${SCHEMA_VERSION}, ownership scoping and cascade`,
        problems.length === 0 ? 'pass' : 'fail',
        summarise(problems),
      );
    } finally {
      db.close();
    }
  } catch (err) {
    record('Database initialisation', 'fail', err?.message ?? String(err));
  }
}

async function checkCommandTree() {
  try {
    const { loadRegistry } = await import(pathToFileURL(path.join(ROOT, 'src/commands/registry.js')).href);
    const registry = await loadRegistry(path.join(ROOT, 'src'));

    record(
      `Exactly ${EXPECTED_COMMAND_COUNT} visible commands`,
      registry.counts.commands === EXPECTED_COMMAND_COUNT ? 'pass' : 'fail',
      `found ${registry.counts.commands}`,
    );

    record(
      `Exactly ${EXPECTED_CATEGORY_COUNT} categories`,
      registry.counts.categories === EXPECTED_CATEGORY_COUNT ? 'pass' : 'fail',
      registry.categories.map((category) => category.name).join(', '),
    );

    const orderProblems = [];
    for (const [category, expected] of Object.entries(EXPECTED_TREE)) {
      const actual = registry.category(category)?.commands.map((command) => command.name) ?? [];

      if (actual.join('|') !== expected.join('|')) {
        orderProblems.push(`${category}: expected [${expected.join(', ')}], found [${actual.join(', ')}]`);
      }
    }

    record(
      'Command names and order match the documented tree',
      orderProblems.length === 0 ? 'pass' : 'fail',
      summarise(orderProblems, 2),
    );

    let leaves;
    try {
      leaves = registry.slashLeaves();
    } catch (err) {
      record('Slash payload builds', 'fail', err?.message ?? String(err));
      return;
    }

    const noSlash = registry.all
      .filter((command) => command.slash !== false && !leaves.has(command.name))
      .map((command) => command.name);

    record(
      'Every command registers as a slash command',
      noSlash.length === 0 ? 'pass' : 'fail',
      summarise(noSlash),
    );

    const noPrefix = registry.all
      .filter((command) => !registry.resolvePrefix(command.name.split(' ')))
      .map((command) => command.name);

    record(
      'Every command resolves as a prefix command',
      noPrefix.length === 0 ? 'pass' : 'fail',
      summarise(noPrefix),
    );

    const payloadProblems = [];
    const body = registry.slashBody();

    const check = (node, label) => {
      if (!/^[a-z0-9-]{1,32}$/.test(String(node.name))) payloadProblems.push(`${label}: invalid name`);
      if (!node.description) payloadProblems.push(`${label}: missing description`);
      else if (String(node.description).length > 100) payloadProblems.push(`${label}: description too long`);
    };

    for (const command of body) {
      check(command, command.name);

      for (const option of command.options ?? []) {

        if (option.type === 1 || option.type === 2) check(option, `${command.name} ${option.name}`);

        if (option.type !== 2) continue;

        for (const leaf of option.options ?? []) {
          check(leaf, `${command.name} ${option.name} ${leaf.name}`);
          if (leaf.type !== 1) payloadProblems.push(`${command.name} ${option.name} ${leaf.name}: nests too deeply`);
        }
      }
    }

    record(
      'Slash payload satisfies Discord constraints',
      payloadProblems.length === 0 ? 'pass' : 'fail',
      summarise(payloadProblems),
    );

    const adminOnly = registry.all.filter((command) => command.adminOnly).map((command) => command.name).sort();
    const expectedAdmin = [...EXPECTED_TREE.Admin].sort();

    record(
      'Admin commands are gated',
      adminOnly.join('|') === expectedAdmin.join('|') ? 'pass' : 'fail',
      adminOnly.join('|') === expectedAdmin.join('|') ? '' : `adminOnly: [${adminOnly.join(', ')}]`,
    );
  } catch (err) {
    record('Command tree', 'fail', err?.message ?? String(err));
  }
}

async function checkHelpLayout() {
  try {
    const { loadRegistry } = await import(pathToFileURL(path.join(ROOT, 'src/commands/registry.js')).href);
    const { buildHelpView, buildHeaderLine, truncateDescription } = await import(
      pathToFileURL(path.join(ROOT, 'src/help/helpMenu.js')).href
    );

    const registry = await loadRegistry(path.join(ROOT, 'src'));
    const problems = [];

    const header = buildHeaderLine({ registry, prefix: 'kx!' });
    const expectedHeader = `${EXPECTED_COMMAND_COUNT} commands • ${EXPECTED_CATEGORY_COUNT} categories • prefix: kx!`;
    if (header !== expectedHeader) problems.push(`header is "${header}"`);

    const truncated = truncateDescription('x'.repeat(60), 51);
    if (truncated !== `${'x'.repeat(51)}...`) {
      problems.push(`truncation produced ${truncated.length} characters`);
    }

    const account = buildHelpView({ registry, prefix: 'kx!', categoryName: 'Account', sessionId: 'audit' });
    if (account.embed.data.title !== 'Prefix Commands') problems.push(`title is "${account.embed.data.title}"`);
    if (account.pages !== 1) problems.push(`Account paginates into ${account.pages} pages`);
    if (account.components.length !== 2) problems.push(`Account renders ${account.components.length} rows, expected 2`);
    if (account.embed.data.footer?.text !== 'Account • Page 1 of 1') {
      problems.push(`Account footer is "${account.embed.data.footer?.text}"`);
    }

    const server = buildHelpView({ registry, prefix: 'kx!', categoryName: 'Server', sessionId: 'audit' });
    if (server.pages < 2) problems.push('Server does not paginate');
    if (server.components.length !== 3) problems.push(`Server renders ${server.components.length} rows, expected 3`);

    for (const row of [...account.components, ...server.components]) {
      for (const component of row.toJSON().components) {
        if (component.custom_id && !component.custom_id.endsWith(':audit')) {
          problems.push(`component ${component.custom_id} is not session-scoped`);
        }
      }
    }

    record('Help menu layout', problems.length === 0 ? 'pass' : 'fail', summarise(problems));
  } catch (err) {
    record('Help menu layout', 'fail', err?.message ?? String(err));
  }
}

async function checkPlaceholders() {

  const self = path.join('scripts', 'verify-project.js');

  const files = [
    ...(await collect(path.join(ROOT, 'src'))),
    ...(await collect(path.join(ROOT, 'scripts'))),
  ].filter((file) => path.relative(ROOT, file) !== self);

  const offenders = [];

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');

    for (const pattern of PLACEHOLDER_PATTERNS) {
      if (pattern.test(source)) {
        offenders.push(`${path.relative(ROOT, file)} (${pattern.source})`);
        break;
      }
    }
  }

  record('No placeholder markers', offenders.length === 0 ? 'pass' : 'fail', summarise(offenders));
}

async function checkLicense() {
  const license = fs.readFileSync(path.join(ROOT, 'LICENSE'), 'utf8');
  record('MIT license and attribution preserved',
    /MIT License/.test(license) && /Copyright.*Aditya/.test(license) ? 'pass' : 'fail');
}

async function main() {
  const argv = new Set(process.argv.slice(2));

  if (argv.has('--help') || argv.has('-h')) {
    process.stdout.write(
      [
        '',
        'Audit the project for structural completeness and consistency.',
        '',
        'Usage: node scripts/verify-project.js [options]',
        '',
        'Options:',
        '  -q, --quiet   Print only failures and the summary.',
        '  -h, --help    Show this message.',
        '',
        'Exit codes:',
        '  0  every check passed',
        '  1  at least one check failed',
        '',
        'Needs no credentials: every check is static or uses an in-memory database.',
        '',
      ].join('\n'),
    );
    return;
  }

  const quiet = argv.has('--quiet') || argv.has('-q');

  const checks = [
    checkRequiredFiles,
    checkManifest,
    checkDependencies,
    checkImportsResolve,
    checkSecrets,
    checkEnvExample,
    checkConfig,
    checkEnvValidation,
    checkDatabase,
    checkCommandTree,
    checkHelpLayout,
    checkPlaceholders,
    checkLicense,
  ];

  for (const check of checks) {
    try {
      await check();
    } catch (err) {

      record(check.name, 'fail', `the check itself threw: ${err?.message ?? String(err)}`);
    }
  }

  const failures = results.filter((result) => result.status === 'fail');
  const width = Math.max(...results.map((result) => result.name.length));

  process.stdout.write('\nPanelKit project audit\n');
  process.stdout.write(`${'-'.repeat(Math.min(width + 12, 100))}\n`);

  for (const { name, status, detail } of results) {
    if (quiet && status !== 'fail') continue;

    const label = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO';
    process.stdout.write(`${label}  ${name.padEnd(width)}${detail ? `  ${detail}` : ''}\n`);
  }

  process.stdout.write(`${'-'.repeat(Math.min(width + 12, 100))}\n`);
  process.stdout.write(
    `${results.length - failures.length} of ${results.length} checks passed` +
      `${failures.length > 0 ? `, ${failures.length} failed` : ''}\n\n`,
  );

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`\nThe audit failed to run: ${err?.message ?? String(err)}\n\n`);
  process.exit(1);
});
