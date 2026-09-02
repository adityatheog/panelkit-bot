// Coded by Aditya | GitHub- @adityatheog

/**
 * Display formatting for panel data.
 *
 * Every function here is total: it accepts anything and returns a printable
 * string. That is deliberate. Pterodactyl omits resource fields when a server has
 * never booted, and a node that is briefly unreachable returns partial payloads.
 * A formatter that threw on `null` would turn a cosmetic gap into a failed
 * command, so unknown values render as "Unknown" and the embed still sends.
 *
 * Unit conventions in the Pterodactyl API, which these functions encode:
 *   - resource usage (memory_bytes, disk_bytes, network_*) is in BYTES
 *   - configured limits (limits.memory, limits.disk) are in MEGABYTES
 *   - uptime is in MILLISECONDS
 *   - cpu_absolute is a percentage that may exceed 100 on multi-core allocations
 */

const BYTES_PER_KB = 1024;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GB = 1024 * 1024 * 1024;
const BYTES_PER_TB = 1024 * 1024 * 1024 * 1024;

const UNKNOWN = 'Unknown';

/**
 * Coerces a value to a finite number, or null when it cannot be one.
 *
 * Empty strings are rejected explicitly because `Number('')` is 0, which would
 * silently render a missing field as a real zero measurement.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
function toFiniteNumber(raw) {
  // A number is a measurement.
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

  // A numeric string is one too: JSON payloads sometimes carry them.
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') return null;

    const value = Number(text);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Everything else is an absence, not a zero.
   *
   * Number([]) is 0 and Number(true) is 1, so a permissive implementation renders an empty
   * array as "0 B" — a factual claim about a value that was never a measurement. The panel
   * omits resource fields for a server that has never booted, and the difference between
   * "idle" and "not reported" is exactly what a user comparing two servers needs.
   */
  return null;
}

/**
 * Formats a byte count with a unit chosen for readability.
 *
 * @param {unknown} bytes
 * @returns {string} for example "512.0 KB", "1.5 GB", or "Unknown"
 */
export function formatBytes(bytes) {
  const value = toFiniteNumber(bytes);
  if (value === null || value < 0) return UNKNOWN;
  if (value === 0) return '0 B';

  if (value < BYTES_PER_KB) return `${value} B`;
  if (value < BYTES_PER_MB) return `${(value / BYTES_PER_KB).toFixed(1)} KB`;
  if (value < BYTES_PER_GB) return `${(value / BYTES_PER_MB).toFixed(1)} MB`;
  if (value < BYTES_PER_TB) return `${(value / BYTES_PER_GB).toFixed(2)} GB`;
  return `${(value / BYTES_PER_TB).toFixed(2)} TB`;
}

/**
 * Formats a byte count as megabytes, for side-by-side comparison with a limit.
 *
 * @param {unknown} bytes
 * @returns {string} for example "512.4 MB" or "Unknown"
 */
export function formatMegabytes(bytes) {
  const value = toFiniteNumber(bytes);
  if (value === null || value < 0) return UNKNOWN;
  return `${(value / BYTES_PER_MB).toFixed(1)} MB`;
}

/**
 * Formats a configured limit expressed in megabytes.
 *
 * Zero means unlimited throughout the Pterodactyl API, so it is rendered as such
 * rather than as "0 MB", which would read as a broken server.
 *
 * @param {unknown} megabytes
 * @returns {string}
 */
export function formatLimitMb(megabytes) {
  const value = toFiniteNumber(megabytes);
  if (value === null) return UNKNOWN;
  if (value === 0) return 'Unlimited';
  if (value < 0) return UNKNOWN;
  return value >= 1024 ? `${(value / 1024).toFixed(1)} GB` : `${value} MB`;
}

/**
 * Formats a CPU limit percentage. Zero means unlimited.
 *
 * @param {unknown} percent
 * @returns {string}
 */
export function formatCpuLimit(percent) {
  const value = toFiniteNumber(percent);
  if (value === null || value < 0) return UNKNOWN;
  return value === 0 ? 'Unlimited' : `${value}%`;
}

/**
 * Formats live CPU usage.
 *
 * Values above 100 are legitimate: a server allocated two cores can report 200.
 *
 * @param {unknown} percent
 * @returns {string}
 */
export function formatPercent(percent) {
  const value = toFiniteNumber(percent);
  if (value === null || value < 0) return UNKNOWN;
  return `${value.toFixed(2)}%`;
}

/**
 * Formats usage against a limit, with a percentage when the limit is finite.
 *
 * @param {unknown} usedBytes live usage in bytes
 * @param {unknown} limitMb configured limit in megabytes
 * @returns {string} for example "512.0 MB / 1.0 GB (50%)"
 */
export function formatUsageAgainstLimit(usedBytes, limitMb) {
  const used = toFiniteNumber(usedBytes);
  const limit = toFiniteNumber(limitMb);

  if (used === null || used < 0) return UNKNOWN;

  const usedText = formatMegabytes(used);
  if (limit === null || limit <= 0) return `${usedText} / Unlimited`;

  const limitBytes = limit * BYTES_PER_MB;
  const percent = Math.round((used / limitBytes) * 100);
  return `${usedText} / ${formatLimitMb(limit)} (${percent}%)`;
}

/**
 * Formats a server uptime given in milliseconds.
 *
 * A zero or negative uptime means the container is not running, which the panel
 * reports for stopped servers, so it renders as "Offline" rather than "0s".
 *
 * @param {unknown} milliseconds
 * @returns {string} for example "2d 3h 0s", "45s", or "Offline"
 */
export function formatUptime(milliseconds) {
  const value = toFiniteNumber(milliseconds);
  if (value === null || value <= 0) return 'Offline';

  const totalSeconds = Math.floor(value / 1000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  parts.push(`${seconds}s`);

  return parts.join(' ');
}

/**
 * Formats a short duration, used for cooldown messages.
 *
 * @param {unknown} milliseconds
 * @returns {string} for example "45 seconds" or "2 minutes"
 */
export function formatDuration(milliseconds) {
  const value = toFiniteNumber(milliseconds);
  if (value === null || value <= 0) return '0 seconds';

  const seconds = Math.ceil(value / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? '' : 's'}`;

  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.ceil(minutes / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

/** Human labels for the power states the panel reports. */
const STATE_LABELS = Object.freeze({
  running: 'Running',
  starting: 'Starting',
  stopping: 'Stopping',
  offline: 'Offline',
  missing: 'Missing',
});

/**
 * Formats a power state.
 *
 * @param {unknown} state
 * @returns {string}
 */
export function formatState(state) {
  const key = String(state ?? '').trim().toLowerCase();
  return STATE_LABELS[key] ?? UNKNOWN;
}

/**
 * Formats a state with a coloured circle, for at-a-glance scanning in a list.
 *
 * @param {unknown} state
 * @returns {string}
 */
export function formatStateWithIcon(state) {
  const key = String(state ?? '').trim().toLowerCase();
  const icons = {
    running: '🟢',
    starting: '🟡',
    stopping: '🟠',
    offline: '⚫',
    missing: '🔴',
  };
  return `${icons[key] ?? '⚪'} ${formatState(state)}`;
}

/**
 * Formats an installation or suspension state for display.
 *
 * @param {{ isInstalling?: boolean, isSuspended?: boolean, isTransferring?: boolean }|null} panelServer
 * @param {unknown} liveState the current_state field from the resources endpoint
 * @returns {string}
 */
export function formatServerStatus(panelServer, liveState) {
  if (!panelServer) return formatState(liveState);
  if (panelServer.isSuspended) return '⛔ Suspended';
  if (panelServer.isInstalling) return '⏳ Installing';
  if (panelServer.isTransferring) return '🚚 Transferring';
  return formatStateWithIcon(liveState);
}

/**
 * Formats a timestamp for an embed.
 *
 * SQLite stores `datetime('now')`, which is UTC without a zone suffix. The `Z` is
 * appended when absent so it is not misparsed as local time.
 *
 * @param {unknown} value an ISO-8601 string, epoch milliseconds, or a Date
 * @returns {string} a Discord relative timestamp, or the raw text if unparseable
 */
export function formatTimestamp(value) {
  if (value === null || value === undefined || value === '') return UNKNOWN;

  let date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'number') {
    date = new Date(value);
  } else {
    const text = String(value).trim();
    const normalised = /\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text.replace(' ', 'T')}Z`
      : text;
    date = new Date(normalised);
  }

  if (Number.isNaN(date.getTime())) return String(value);

  // Discord renders <t:seconds:R> in each viewer's own locale and timezone.
  return `<t:${Math.floor(date.getTime() / 1000)}:R>`;
}

/**
 * Formats a timestamp as an absolute date, for audit-style output.
 *
 * @param {unknown} value
 * @returns {string}
 */
export function formatAbsoluteTimestamp(value) {
  const relative = formatTimestamp(value);
  if (!relative.startsWith('<t:')) return relative;
  return relative.replace(':R>', ':f>');
}

/**
 * Truncates text to a maximum length, appending an ellipsis when cut.
 *
 * @param {unknown} text
 * @param {number} maxLength
 * @returns {string}
 */
export function truncate(text, maxLength) {
  const value = String(text ?? '');
  if (maxLength <= 0) return '';
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

/**
 * Formats a count with a correctly pluralised noun.
 *
 * @param {unknown} count
 * @param {string} singular
 * @param {string} [plural]
 * @returns {string}
 */
export function pluralise(count, singular, plural = `${singular}s`) {
  const value = toFiniteNumber(count) ?? 0;
  return `${value} ${value === 1 ? singular : plural}`;
}

/**
 * Formats a network allocation as a connection address.
 *
 * @param {{ ip?: string, port?: number, alias?: string|null }|null} allocation
 * @returns {string}
 */
export function formatAllocation(allocation) {
  if (!allocation) return UNKNOWN;
  const host = allocation.alias || allocation.ip || 'unknown';
  const port = toFiniteNumber(allocation.port);
  return port === null ? String(host) : `${host}:${port}`;
}

export { UNKNOWN };
/**
 * Re-exported from validation.js.
 *
 * sanitiseForDisplay neutralises markdown and mention syntax in text that came from
 * the panel rather than through this bot's validators — a server renamed directly in
 * the panel can contain anything. It lives in validation.js beside the strict
 * validators, but every caller is a display path, so it is re-exported here to keep
 * those imports in one place.
 */
export { sanitiseForDisplay } from './validation.js';

