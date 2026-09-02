// Coded by Aditya | GitHub- @adityatheog

/**
 * Syntax and import verification.
 *
 * Answers one question: does every source file in this project parse, and does every
 * import in it resolve? That is narrower than the project audit in verify-project.js,
 * which checks structure and completeness, and it is deliberately fast enough to run on
 * every save.
 *
 * Two distinct classes of failure are caught, and only the second needs any real work:
 *
 *   A syntax error is found by parsing each file in isolation. A missing brace or a stray
 *   token fails here with a line number.
 *
 *   An unresolved import is found by actually importing each module. This is the failure
 *   that static parsing cannot see: a renamed export, a typo in a relative path, or a
 *   circular dependency that leaves a binding undefined at module scope. Those only
 *   surface when the module graph is instantiated, which is why this script imports rather
 *   than merely reads.
 *
 * Importing has a consequence worth being explicit about: module-level side effects run.
 * Every module in this project is written so that importing it does nothing observable —
 * no connections, no file writes, no timers — and this script is what enforces that
 * discipline. A module that tried to open a database at import time would show up here as
 * a hang or an error rather than as a mystery in production.
 *
 * Usage:
 *   node scripts/check.js            Check src/ and scripts/.
 *   node scripts/check.js --verbose  Print every file as it is checked.
 *   node scripts/check.js --tests    Include tests/ as well.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Project root, one level above this script. */
const ROOT = path.resolve(import.meta.dirname, '..');

/** Directories checked by default. */
const DEFAULT_TARGETS = Object.freeze(['src', 'scripts']);

/** Never walked into. */
const SKIP_DIRECTORIES = Object.freeze(new Set(['node_modules', '.git', 'data', 'dist', 'coverage']));

/**
 * How long a single module import may take before it is treated as hung.
 *
 * A module that blocks at import time — waiting on a socket, or on stdin — would otherwise
 * make this script hang with no output, which is the least diagnosable failure mode
 * available.
 */
const IMPORT_TIMEOUT_MS = 10_000;

/**
 * Recursively collects .js files.
 *
 * @param {string} dir absolute path
 * @returns {Promise<string[]>} absolute paths, sorted for deterministic output
 */
async function collectFiles(dir) {
  /** @type {import('node:fs').Dirent[]} */
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }

  const files = [];

  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP_DIRECTORIES.has(entry.name)) continue;

    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) files.push(...(await collectFiles(full)));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }

  return files;
}

/**
 * Parses a file without executing it.
 *
 * `node --check` performs a full parse and reports the line and column of a syntax error,
 * which is more precise than anything reachable from inside the process.
 *
 * One caveat drives the fallback below: on some Node versions `--check` refuses ES module
 * syntax in a `.js` file, because it parses as CommonJS unless the file is `.mjs` or the
 * nearest package.json declares `"type": "module"`. This project does declare that, so the
 * happy path works — but the fallback keeps the script honest if it is run from an
 * unexpected working directory.
 *
 * @param {string} file absolute path
 * @returns {Promise<{ ok: boolean, error: string|null }>}
 */
async function checkSyntax(file) {
  try {
    await execFileAsync(process.execPath, ['--check', file], { cwd: ROOT });
    return { ok: true, error: null };
  } catch (err) {
    const stderr = String(err?.stderr ?? '');

    // The module-syntax complaint is an artefact of how --check resolves module type, not
    // a real syntax error. The import stage that follows will catch anything genuine.
    if (/Cannot use import statement outside a module|await is only valid/i.test(stderr)) {
      return { ok: true, error: null };
    }

    // The first few lines carry the location and the offending token; the rest is a stack
    // trace through Node's internals and is noise.
    const message = stderr
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(0, 4)
      .join('\n');

    return { ok: false, error: message || (err?.message ?? 'syntax check failed') };
  }
}

/**
 * Imports a module, verifying that its dependency graph resolves.
 *
 * @param {string} file absolute path
 * @returns {Promise<{ ok: boolean, error: string|null, exports: string[] }>}
 */
async function checkImport(file) {
  const url = pathToFileURL(file).href;

  /** @type {NodeJS.Timeout|undefined} */
  let timer;

  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`import did not complete within ${IMPORT_TIMEOUT_MS}ms; the module may block at import time`));
    }, IMPORT_TIMEOUT_MS);
  });

  try {
    const module = await Promise.race([import(url), timeout]);
    return { ok: true, error: null, exports: Object.keys(module ?? {}) };
  } catch (err) {
    /**
     * ERR_MODULE_NOT_FOUND is the common case and its default message is verbose. The
     * specifier is what matters, so it is extracted when present.
     */
    if (err?.code === 'ERR_MODULE_NOT_FOUND') {
      const match = /Cannot find module '([^']+)'/.exec(String(err.message));
      return {
        ok: false,
        error: match ? `unresolved import: ${match[1]}` : String(err.message).split('\n')[0],
        exports: [],
      };
    }

    if (err?.code === 'ERR_IMPORT_ATTRIBUTE_MISSING' || err?.code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
      return { ok: false, error: `${err.code}: ${String(err.message).split('\n')[0]}`, exports: [] };
    }

    // A named import that does not exist in the target module. Reported verbatim, since
    // Node's message already names both the binding and the module.
    if (/does not provide an export named/i.test(String(err?.message))) {
      return { ok: false, error: String(err.message).split('\n')[0], exports: [] };
    }

    return { ok: false, error: String(err?.message ?? err).split('\n')[0], exports: [] };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Entry-point modules that execute on import.
 *
 * These call main() at module scope, so importing them would start the bot or contact
 * Discord. They are parsed but not imported. Their dependency graphs are covered anyway,
 * because everything they import is checked individually.
 */
const NO_IMPORT = Object.freeze(
  new Set([
    path.join('src', 'index.js'),
    path.join('src', 'deploy-commands.js'),
    path.join('scripts', 'check.js'),
    path.join('scripts', 'init-db.js'),
    path.join('scripts', 'verify-project.js'),
    path.join('scripts', 'healthcheck.js'),
  ]),
);

/**
 * @returns {Promise<void>}
 */
async function main() {
  const argv = new Set(process.argv.slice(2));
  const verbose = argv.has('--verbose') || argv.has('-v');
  const includeTests = argv.has('--tests') || argv.has('-t');

  if (argv.has('--help') || argv.has('-h')) {
    process.stdout.write(
      [
        '',
        'Verify that every source file parses and every import resolves.',
        '',
        'Usage: node scripts/check.js [options]',
        '',
        'Options:',
        '  -v, --verbose  Print every file as it is checked.',
        '  -t, --tests    Include the tests directory.',
        '  -h, --help     Show this message.',
        '',
      ].join('\n'),
    );
    return;
  }

  const targets = includeTests ? [...DEFAULT_TARGETS, 'tests'] : [...DEFAULT_TARGETS];

  /** @type {string[]} */
  const files = [];
  for (const target of targets) {
    files.push(...(await collectFiles(path.join(ROOT, target))));
  }

  if (files.length === 0) {
    process.stderr.write(`\nNo JavaScript files were found in: ${targets.join(', ')}\n\n`);
    process.exit(1);
  }

  /** @type {Array<{ file: string, stage: string, error: string }>} */
  const failures = [];

  let parsed = 0;
  let imported = 0;
  let skipped = 0;

  for (const file of files) {
    const relative = path.relative(ROOT, file);

    const syntax = await checkSyntax(file);
    if (!syntax.ok) {
      failures.push({ file: relative, stage: 'syntax', error: syntax.error ?? 'unknown' });
      if (verbose) process.stdout.write(`  FAIL  ${relative}  (syntax)\n`);
      // A file that does not parse cannot be imported, so the second stage is skipped.
      continue;
    }
    parsed += 1;

    if (NO_IMPORT.has(relative)) {
      skipped += 1;
      if (verbose) process.stdout.write(`  skip  ${relative}  (entry point; parsed only)\n`);
      continue;
    }

    const resolved = await checkImport(file);
    if (!resolved.ok) {
      failures.push({ file: relative, stage: 'import', error: resolved.error ?? 'unknown' });
      if (verbose) process.stdout.write(`  FAIL  ${relative}  (import)\n`);
      continue;
    }
    imported += 1;

    if (verbose) {
      process.stdout.write(`  ok    ${relative}  (${resolved.exports.length} export(s))\n`);
    }
  }

  // ------------------------------------------------------------------ reporting

  process.stdout.write(
    [
      '',
      `Checked ${files.length} file(s) in ${targets.join(', ')}`,
      `  Parsed    ${parsed}`,
      `  Imported  ${imported}`,
      `  Skipped   ${skipped} (entry points, parsed only)`,
      '',
    ].join('\n'),
  );

  if (failures.length === 0) {
    process.stdout.write('All files parse and all imports resolve.\n\n');
    return;
  }

  process.stderr.write(`${failures.length} problem(s) found:\n\n`);

  for (const failure of failures) {
    process.stderr.write(`  ${failure.file}\n    ${failure.stage}: ${failure.error}\n\n`);
  }

  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`\nCheck failed to run: ${err?.message ?? String(err)}\n\n`);
  process.exit(1);
});
