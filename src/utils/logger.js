// Coded by Aditya | GitHub- @adityatheog

/**
 * Structured JSON logger with automatic secret redaction.
 *
 * Every logged metadata object passes through redact() before serialisation, so
 * an accidental logger.info('request', { headers }) can never print an API key
 * or bot token. Redaction is key-name based and recursive, which means it also
 * covers values nested inside axios config objects and panel payloads.
 *
 * Output is line-delimited JSON on stdout (debug/info) and stderr (warn/error),
 * which is what Docker, systemd-journald and PM2 all expect. No log files are
 * written by the process itself; the supervisor owns log rotation.
 */

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

const LEVEL_NAMES = Object.freeze(Object.keys(LEVELS));

/**
 * Any object key matching this pattern has its value replaced before output.
 * Deliberately broad: a false positive costs one unreadable log line, while a
 * false negative leaks a credential into a log aggregator.
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|pwd|authorization|auth|apikey|api_key|appkey|app_key|clientkey|client_key|cookie|session|signature|bearer|credential|private)/i;

/** Values that look like a credential regardless of the key they are stored under. */
const SECRET_VALUE_PATTERNS = [
  /\bptl[ac]_[A-Za-z0-9]{20,}\b/g, // Pterodactyl application / client API keys
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, // Authorization header values
  /\b[A-Za-z0-9_-]{24,28}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}\b/g, // Discord bot tokens
];

const MAX_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2000;

let currentLevel = LEVELS.info;

/**
 * Sets the active log level. Unknown values are ignored so a typo in
 * LOG_LEVEL degrades to the previous level rather than silencing the logger.
 *
 * @param {string} level one of debug, info, warn, error
 * @returns {string} the level actually in effect afterwards
 */
export function setLogLevel(level) {
  const resolved = LEVELS[String(level ?? '').trim().toLowerCase()];
  if (resolved) currentLevel = resolved;
  return getLogLevel();
}

/** @returns {string} the active log level name. */
export function getLogLevel() {
  return LEVEL_NAMES.find((name) => LEVELS[name] === currentLevel) ?? 'info';
}

/** @returns {boolean} whether a message at this level would be emitted. */
export function isLevelEnabled(level) {
  const resolved = LEVELS[String(level ?? '').trim().toLowerCase()];
  return Boolean(resolved) && resolved >= currentLevel;
}

/** Masks credential-shaped substrings inside a string value. */
function scrubString(value) {
  let out = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  if (out.length > MAX_STRING_LENGTH) {
    out = `${out.slice(0, MAX_STRING_LENGTH)}…[truncated ${out.length - MAX_STRING_LENGTH} chars]`;
  }
  return out;
}

/**
 * Recursively copies a value, replacing anything credential-shaped.
 *
 * Handles the awkward cases that appear in real error metadata: Error instances
 * (whose properties are non-enumerable), Map, Set, Buffer, BigInt, circular
 * references and getters that throw.
 *
 * @param {unknown} value
 * @param {number} depth current recursion depth
 * @param {WeakSet<object>} seen objects already visited on this branch
 * @returns {unknown} a safe-to-serialise copy
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;

  const type = typeof value;

  if (type === 'string') return scrubString(value);
  if (type === 'number' || type === 'boolean') return value;
  if (type === 'bigint') return `${value}n`;
  if (type === 'symbol') return value.toString();
  if (type === 'function') return `[function ${value.name || 'anonymous'}]`;

  if (depth > MAX_DEPTH) return '[max depth]';

  if (value instanceof Error) {
    const out = {
      name: value.name,
      message: scrubString(String(value.message ?? '')),
    };
    if (value.code !== undefined) out.code = value.code;
    if (value.status !== undefined) out.status = value.status;
    return out;
  }

  if (Buffer.isBuffer(value)) return `[buffer ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof URL) return scrubString(value.toString());

  if (type === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);

    try {
      if (Array.isArray(value)) {
        const items = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, depth + 1, seen));
        if (value.length > MAX_ARRAY_ITEMS) items.push(`…${value.length - MAX_ARRAY_ITEMS} more`);
        return items;
      }

      if (value instanceof Map) {
        const out = {};
        let count = 0;
        for (const [key, val] of value) {
          if (count >= MAX_ARRAY_ITEMS) {
            out['…'] = `${value.size - MAX_ARRAY_ITEMS} more`;
            break;
          }
          const name = String(key);
          out[name] = SECRET_KEY_PATTERN.test(name) ? '[redacted]' : redact(val, depth + 1, seen);
          count += 1;
        }
        return out;
      }

      if (value instanceof Set) {
        return redact([...value].slice(0, MAX_ARRAY_ITEMS), depth + 1, seen);
      }

      const out = {};
      for (const key of Object.keys(value)) {
        if (SECRET_KEY_PATTERN.test(key)) {
          out[key] = '[redacted]';
          continue;
        }
        let child;
        try {
          child = value[key];
        } catch {
          // A throwing getter must not break logging.
          out[key] = '[unreadable]';
          continue;
        }
        out[key] = redact(child, depth + 1, seen);
      }
      return out;
    } finally {
      seen.delete(value);
    }
  }

  return String(value);
}

/**
 * Serialises one log line. Falls back to a minimal record if the metadata
 * cannot be stringified, so logging never throws into a caller.
 */
function serialise(line) {
  try {
    return JSON.stringify(line);
  } catch {
    return JSON.stringify({ ts: line.ts, level: line.level, msg: line.msg, meta: '[unserialisable]' });
  }
}

function emit(level, message, meta) {
  if (LEVELS[level] < currentLevel) return;

  const line = {
    ts: new Date().toISOString(),
    level: level.toUpperCase(),
    msg: typeof message === 'string' ? scrubString(message) : String(message),
  };
  if (meta !== undefined) line.meta = redact(meta);

  const text = `${serialise(line)}\n`;

  try {
    if (level === 'warn' || level === 'error') process.stderr.write(text);
    else process.stdout.write(text);
  } catch {
    // EPIPE when the consumer closed the stream. Dropping the line is correct;
    // crashing the bot because a log pipe went away is not.
  }
}

export const logger = Object.freeze({
  debug: (msg, meta) => emit('debug', msg, meta),
  info: (msg, meta) => emit('info', msg, meta),
  warn: (msg, meta) => emit('warn', msg, meta),
  error: (msg, meta) => emit('error', msg, meta),

  /**
   * Returns a logger that merges fixed fields into every line, for tagging a
   * subsystem or a single command invocation.
   *
   * @param {Record<string, unknown>} context
   */
  child(context) {
    const bound = redact(context);
    const withContext = (level) => (msg, meta) =>
      emit(level, msg, meta === undefined ? bound : { ...bound, ...meta });
    return Object.freeze({
      debug: withContext('debug'),
      info: withContext('info'),
      warn: withContext('warn'),
      error: withContext('error'),
      child: (extra) => logger.child({ ...context, ...extra }),
    });
  },
});

export { LEVEL_NAMES, SECRET_KEY_PATTERN };
