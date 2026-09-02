// Coded by Aditya | GitHub- @adityatheog

/**
 * Project audit.
 *
 * Answers a broader question than scripts/check.js: is this project complete and
 * internally consistent? Where check.js verifies that files parse and imports resolve,
 * this verifies structure — that every expected file exists, that the command tree matches
 * what the documentation claims, that both invocation surfaces are wired, that the
 * configuration validates, that the database initialises, and that nothing looks like a
 * committed secret or an unfinished placeholder.
 *
 * It runs without credentials. Every check is either static or uses an in-memory database,
 * so it is safe in CI and safe to run against a fresh clone before anything is configured.
 * Placeholder values in config.json are expected on a fresh clone and are reported as
 * information rather than as failures.
 *
 * The design goal is that "audited for missing files, placeholders, dependency issues and
 * startup problems" is something a reader can verify in one command rather than take on
 * trust. Every check reports independently, so one run surfaces every problem instead of
 * stopping at the first.
 *
 * Exit code 0 means every check passed. Exit code 1 means at least one failed.
 *
 * Usage:
 *   node scripts/verify-project.js            Run every check.
 *   node scripts/verify-project.js --quiet     Print only failures and the summary.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Project root, one level above this script. */
const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The documented command tree.
 *
 * Duplicated here deliberately. The point of the audit is to check the implementation
 * against an independent statement of what it should be — deriving this from the registry
 * would make the assertion vacuous.
 */
const EXPECTED_TREE = Object.freeze({
  Account: ['account create', 'account delete', 'account info', 'account reset'],
  Admin: ['create', 'admin servers', 'admin suspend', 'admin unsuspend', 'admin user'],
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

const EXPECTED_COMMAND_COUNT = 24;
const EXPECTED_CATEGORY_COUNT = 5;

/** Files without which the project is incomplete. */
const REQUIRED_FILES = Object.freeze([
  'package.json',
  'config.json',
  '.env.example',
  '.gitignore',
  'README.md',
  'LICENSE',
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
  'scripts/check.js',
  'scripts/init-db.js',
  'scripts/verify-project.js',
]);

/** Every environment variable the code reads, which .env.example must document. */
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

/** Variables in .env.example that legitimately carry a default value. */
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

/** Markers that indicate unfinished work. */
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

/**
 * Patterns that look like committed credentials.
 *
 * Narrow on purpose: a broad "looks like a long string" rule fires on every hash and
 * teaches people to ignore the audit.
 */
const SECRET_PATTERNS = Object.freeze([
  { name: 'Pterodactyl application key', pattern: /\bptla_[A-Za-z0-9]{40,}\b/ },
  { name: 'Pterodactyl client key', pattern: /\bptlc_[A-Za-z0-9]{40,}\b/ },
  { name: 'Discord bot token', pattern: /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/ },
]);

const SKIP_DIRECTORIES = Object.freeze(new Set(['node_modules', '.git', 'data', 'dist', 'coverage']));

/** @type {Array<{ name: string, status: 'pass'|'fail'|'info', detail: string }>} */
const results = [];

/**
 * Records a check outcome.
 *
 * `info` exists for states that are correct on a fresh clone but worth reporting, such as
 * unfilled egg placeholders. Only `fail` affects the exit code.
 *
 * @param {string} name
 * @param {'pass'|'fail'|'info'} status
 * @param {string} [detail]
 */
function record(name, status, detail = '') {
  results.push({ name, status, detail });
}

/**
 * Recursively collects files matching an extension.
 *
 * @param {string} dir
 * @param {string} extension
 * @returns {Promise<string[]>}
 */
async function collect(dir, extension = '.js') {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];

  for (const entry of entries) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await collect(full, extension)));
    else if (entry.isFile() && entry.name.endsWith(extension)) files.push(full);
  }

  return files;
}

// ============================================================================
// Checks
// ============================================================================

/** Every required file is present. */
function checkRequiredFiles() {
  const missing = REQUIRED_FILES.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));

  record(
    `Required files (${REQUIRED_FILES.length})`,
    missing.length === 0 ? 'pass' : 'fail',
    missing.length > 0 ? `missing: ${missing.join(', ')}` : '',
  );
}

/** Dependencies are declared, pinned, and nothing undeclared is imported. */
async function checkDependencies() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));

  // Unpinned ranges make a build non-reproducible, which matters for a bot handling
  // credentials.
  const unpinned = Object.entries(manifest.dependencies ?? {})
    .filter(([, version]) => /^[\^~><*]|latest/.test(String(version)))
    .map(([name, version]) => `${name}@${version}`);

  record(
    'Dependencies are pinned',
    unpinned.length === 0 ? 'pass' : 'fail',
    unpinned.length > 0 ? `unpinned: ${unpinned.join(', ')}` : `${declared.size} pinned`,
  );

  // Every bare specifier imported anywhere must be declared or built into Node.
  const files = [...(await collect(path.join(ROOT, 'src'))), ...(await collect(path.join(ROOT, 'scripts')))];
  const undeclared = new Set();

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');

    for (const match of source.matchAll(/(?:from|import)\s+['"]([^'".][^'"]*)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;

      // Strip a subpath, so "discord.js/foo" is checked as "discord.js".
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];

      if (!declared.has(packageName)) undeclared.add(packageName);
    }
  }

  record(
    'No undeclared imports',
    undeclared.size === 0 ? 'pass' : 'fail',
    undeclared.size > 0 ? `not in package.json: ${[...undeclared].join(', ')}` : '',
  );

  // A declared dependency nobody imports is dead weight.
  const importedNames = new Set();
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s+['"]([^'".][^'"]*)['"]/g)) {
      const specifier = match[1];
      if (specifier.startsWith('node:')) continue;
      importedNames.add(specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]);
    }
  }

  const unused = [...declared].filter((name) => !importedNames.has(name));
  record(
    'No unused dependencies',
    unused.length === 0 ? 'pass' : 'info',
    unused.length > 0 ? `declared but not imported: ${unused.join(', ')}` : '',
  );
}

/** No secrets are committed, and .gitignore covers the files that would carry them. */
async function checkSecrets() {
  /** @type {string[]} */
  const problems = [];

  if (fs.existsSync(path.join(ROOT, '.env'))) {
    problems.push('.env exists in the working tree; confirm it is git-ignored and never committed');
  }

  const gitignore = fs.existsSync(path.join(ROOT, '.gitignore'))
    ? fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8')
    : '';

  for (const required of ['.env', 'node_modules', 'data/']) {
    if (!gitignore.includes(required)) problems.push(`.gitignore does not cover ${required}`);
  }

  // Scan tracked source and config for credential-shaped strings.
  const files = [
    ...(await collect(path.join(ROOT, 'src'))),
    ...(await collect(path.join(ROOT, 'scripts'))),
    ...(await collect(path.join(ROOT, 'tests'))),
    path.join(ROOT, 'config.json'),
    path.join(ROOT, '.env.example'),
  ].filter((file) => fs.existsSync(file));

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');

    for (const { name, pattern } of SECRET_PATTERNS) {
      if (pattern.test(source)) {
        problems.push(`${path.relative(ROOT, file)} contains what looks like a ${name}`);
      }
    }
  }

  record('No committed secrets', problems.length === 0 ? 'pass' : 'fail', problems.join('; '));
}

/** .env.example documents every variable the code reads, with no real values. */
function checkEnvExample() {
  const source = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

  const documented = new Set();
  /** @type {string[]} */
  const withValues = [];

  for (const line of source.split('\n')) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (!match) continue;

    const [, key, value] = match;
    documented.add(key);

    // A value on a secret-bearing key means a real credential may have been committed.
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

/** config.json validates, and unfilled placeholders are reported. */
async function checkConfig() {
  try {
    const { loadConfig, describeConfig } = await import(
      pathToFileURL(path.join(ROOT, 'src/config/config.js')).href
    );

    const config = loadConfig(path.join(ROOT, 'config.json'));
    record('config.json validates', 'pass', `identity: ${config.identity.name}`);

    const state = describeConfig(config);

    // Expected on a fresh clone: shipping invented panel IDs would be worse.
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
      state.ready ? 'ready' : 'not ready until eggs and deploy.locationId are filled in',
    );
  } catch (err) {
    record('config.json validates', 'fail', err?.message ?? String(err));
  }
}

/** Environment validation rejects bad input and applies documented defaults. */
async function checkEnvValidation() {
  try {
    const { loadEnv, normalizePanelUrl } = await import(
      pathToFileURL(path.join(ROOT, 'src/config/env.js')).href
    );

    let rejected = false;
    try {
      loadEnv({});
    } catch {
      rejected = true;
    }
    record('Missing environment variables are rejected', rejected ? 'pass' : 'fail');

    const env = loadEnv({
      DISCORD_TOKEN: 'aaaaaaaaaaaaaaaaaaaaaaaa.bbbbbb.cccccccccccccccccccccccccccc',
      CLIENT_ID: '123456789012345678',
      PANEL_URL: 'https://panel.example.com/api/application/',
      PANEL_APP_KEY: 'ptla_example',
      PANEL_CLIENT_KEY: 'ptlc_example',
    });

    const problems = [];
    if (env.panelUrl !== 'https://panel.example.com') problems.push(`PANEL_URL normalised to ${env.panelUrl}`);
    if (env.prefix !== 'kx!') problems.push(`default prefix is ${env.prefix}, expected kx!`);
    if (env.accountAgeDays !== 90) problems.push(`ACCOUNT_AGE_DAYS default is ${env.accountAgeDays}`);
    if (env.freeServerLimit !== 1) problems.push(`FREE_SERVER_LIMIT default is ${env.freeServerLimit}`);

    record('Environment defaults and normalisation', problems.length === 0 ? 'pass' : 'fail', problems.join('; '));

    // A trailing /api suffix and a bare trailing slash must both reduce to the origin.
    const normalised =
      normalizePanelUrl('https://panel.example.com/') === 'https://panel.example.com' &&
      normalizePanelUrl('https://panel.example.com/api/client') === 'https://panel.example.com';

    record('Panel URL normalisation', normalised ? 'pass' : 'fail');
  } catch (err) {
    record('Environment validation', 'fail', err?.message ?? String(err));
  }
}

/** The database creates, migrates, enforces ownership scoping and cascades. */
async function checkDatabase() {
  try {
    const { createDatabase, SCHEMA_VERSION } = await import(
      pathToFileURL(path.join(ROOT, 'src/database/db.js')).href
    );

    const db = createDatabase(':memory:');

    try {
      db.createUser({ discordId: '111111111111111111', panelId: 1, email: 'a@b.test', username: 'audit1' });
      db.createServer({
        discordId: '111111111111111111',
        panelServerId: 1,
        identifier: 'a1b2c3d4',
        name: 'Audit',
        eggType: 'nodejs',
      });

      const problems = [];

      // The authorisation query must be ownership-scoped in SQL, not in JavaScript.
      if (!db.getOwnedServer('a1b2c3d4', '111111111111111111')) problems.push('owner lookup failed');
      if (db.getOwnedServer('a1b2c3d4', '222222222222222222') !== null) problems.push('a foreign owner matched a server');

      // Writes must be scoped too, or a foreign caller could rename or delete.
      if (db.updateServer({ identifier: 'a1b2c3d4', discordId: '222222222222222222', name: 'Hijacked' })) {
        problems.push('a foreign owner renamed a server');
      }
      if (db.deleteServer('a1b2c3d4', '222222222222222222')) {
        problems.push('a foreign owner deleted a server');
      }

      // Parameterised statements must treat SQL metacharacters as data.
      if (db.getServer("a1b2c3d4'; DROP TABLE servers; --") !== null) problems.push('injection string matched a row');
      if (db.countUserServers('111111111111111111') !== 1) problems.push('the servers table was altered by an injection attempt');

      // The atomic spend must refuse an overdraft rather than going negative.
      db.setCredits('111111111111111111', 5);
      if (db.spendCredits('111111111111111111', 10)) problems.push('an overdraft was permitted');
      if (db.getCredits('111111111111111111') !== 5) problems.push('a refused spend altered the balance');

      db.deleteUserWithServers('111111111111111111');
      if (db.getUser('111111111111111111') !== null) problems.push('the user survived a cascade delete');
      if (db.getServer('a1b2c3d4') !== null) problems.push('a server survived a cascade delete');

      record(
        `Database schema v${SCHEMA_VERSION}, ownership scoping and cascade`,
        problems.length === 0 ? 'pass' : 'fail',
        problems.join('; '),
      );
    } finally {
      db.close();
    }
  } catch (err) {
    record('Database initialisation', 'fail', err?.message ?? String(err));
  }
}

/** The command tree matches the documented tree, on both surfaces. */
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

    // Names and order, per category. Order matters: the documented layout is not
    // alphabetical in Admin or General.
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
      orderProblems.join(' — '),
    );

    // Reachability is proven by walking the built payload, not by trusting definitions.
    const leaves = registry.slashLeaves();
    const noSlash = registry.all
      .filter((command) => command.slash !== false && !leaves.has(command.name))
      .map((command) => command.name);

    record(
      'Every command registers as a slash command',
      noSlash.length === 0 ? 'pass' : 'fail',
      noSlash.join(', '),
    );

    const noPrefix = registry.all
      .filter((command) => !registry.resolvePrefix(command.name.split(' ')))
      .map((command) => command.name);

    record(
      'Every command resolves as a prefix command',
      noPrefix.length === 0 ? 'pass' : 'fail',
      noPrefix.join(', '),
    );

    // Discord rejects the whole payload if any element is invalid, so every constraint is
    // checked here rather than at deploy time.
    const payloadProblems = [];
    for (const command of registry.slashBody()) {
      if (!/^[a-z0-9-]{1,32}$/.test(command.name)) payloadProblems.push(`invalid name: ${command.name}`);
      if (!command.description || command.description.length > 100) {
        payloadProblems.push(`invalid description on ${command.name}`);
      }
      for (const option of command.options ?? []) {
        if (option.type !== 2) continue;
        for (const sub of option.options ?? []) {
          if (sub.type !== 1) payloadProblems.push(`${command.name} ${option.name} nests too deeply`);
        }
      }
    }

    record(
      'Slash payload satisfies Discord constraints',
      payloadProblems.length === 0 ? 'pass' : 'fail',
      payloadProblems.join('; '),
    );
  } catch (err) {
    record('Command tree', 'fail', err?.message ?? String(err));
  }
}

/** The help menu renders the documented layout. */
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

    // Truncation cuts to exactly the limit and appends three dots.
    const truncated = truncateDescription('x'.repeat(60), 51);
    if (truncated.length !== 54 || !truncated.endsWith('...')) {
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

    // Every component must be session-scoped, or a stale one could act.
    for (const row of [...account.components, ...server.components]) {
      for (const component of row.toJSON().components) {
        if (component.custom_id && !component.custom_id.endsWith(':audit')) {
          problems.push(`component ${component.custom_id} is not session-scoped`);
        }
      }
    }

    record('Help menu layout', problems.length === 0 ? 'pass' : 'fail', problems.join('; '));
  } catch (err) {
    record('Help menu layout', 'fail', err?.message ?? String(err));
  }
}

/** No unfinished-work markers remain in source. */
async function checkPlaceholders() {
  const files = [...(await collect(path.join(ROOT, 'src'))), ...(await collect(path.join(ROOT, 'scripts')))];

  /** @type {string[]} */
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

  record('No placeholder markers', offenders.length === 0 ? 'pass' : 'fail', offenders.join(', '));
}

/** Every source file carries the authorship header. */
async function checkHeaders() {
  const files = [...(await collect(path.join(ROOT, 'src'))), ...(await collect(path.join(ROOT, 'scripts')))];
  const expected = '// Coded by Aditya | GitHub- @adityatheog';

  const missing = files
    .filter((file) => !fs.readFileSync(file, 'utf8').startsWith(expected))
    .map((file) => path.relative(ROOT, file));

  record(
    `Authorship header on every source file (${files.length})`,
    missing.length === 0 ? 'pass' : 'fail',
    missing.join(', '),
  );
}

// ============================================================================
// Runner
// ============================================================================

async function main() {
  const quiet = process.argv.includes('--quiet') || process.argv.includes('-q');

  const checks = [
    checkRequiredFiles,
    checkDependencies,
    checkSecrets,
    checkEnvExample,
    checkConfig,
    checkEnvValidation,
    checkDatabase,
    checkCommandTree,
    checkHelpLayout,
    checkPlaceholders,
    checkHeaders,
  ];

  for (const check of checks) {
    try {
      await check();
    } catch (err) {
      // A check that throws is itself a failure, not a reason to abandon the audit.
      record(check.name, 'fail', `the check itself threw: ${err?.message ?? String(err)}`);
    }
  }

  const failures = results.filter((result) => result.status === 'fail');
  const width = Math.max(...results.map((result) => result.name.length));

  process.stdout.write('\nPanelKit project audit\n');
  process.stdout.write(`${'-'.repeat(width + 12)}\n`);

  for (const { name, status, detail } of results) {
    if (quiet && status !== 'fail') continue;

    const label = status === 'pass' ? 'PASS' : status === 'fail' ? 'FAIL' : 'INFO';
    process.stdout.write(`${label}  ${name.padEnd(width)}${detail ? `  ${detail}` : ''}\n`);
  }

  process.stdout.write(`${'-'.repeat(width + 12)}\n`);
  process.stdout.write(
    `${results.length - failures.length} of ${results.length} checks passed${failures.length > 0 ? `, ${failures.length} failed` : ''}\n\n`,
  );

  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`\nThe audit failed to run: ${err?.message ?? String(err)}\n\n`);
  process.exit(1);
});
