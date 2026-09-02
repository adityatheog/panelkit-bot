// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/utils/format.js.
 *
 * Every function in that module is total: it accepts anything and returns a printable
 * string. These tests exercise that property deliberately, because the values being
 * formatted come from a panel that omits fields for servers which have never booted, and
 * returns partial payloads when a node is briefly unreachable.
 *
 * Three properties are asserted throughout:
 *
 *   Missing is not zero. A null memory reading must render as "Unknown", never as "0 MB". The
 *   second is a factual claim the bot cannot support, and a user comparing two servers needs
 *   to distinguish "idle" from "not reported".
 *
 *   Unit conventions are encoded once. Pterodactyl mixes units in the same payload — usage in
 *   bytes, configured limits in megabytes, uptime in milliseconds — and these tests pin which
 *   function expects which, so a caller passing the wrong one fails here rather than
 *   displaying a figure that is wrong by a factor of 1,048,576.
 *
 *   Zero means unlimited for limits, and offline for uptime. Both are Pterodactyl
 *   conventions rather than arithmetic, so both are asserted explicitly.
 *
 * No credentials, no network, no filesystem.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  formatAbsoluteTimestamp,
  formatAllocation,
  formatBytes,
  formatCpuLimit,
  formatDuration,
  formatLimitMb,
  formatMegabytes,
  formatPercent,
  formatServerStatus,
  formatState,
  formatStateWithIcon,
  formatTimestamp,
  formatUptime,
  formatUsageAgainstLimit,
  pluralise,
  truncate,
  UNKNOWN,
} from '../src/utils/format.js';

/** Values the panel legitimately returns in place of a measurement. */
const MISSING_VALUES = Object.freeze([null, undefined, '', 'not a number', NaN, {}, []]);

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * 1024 * 1024;
const TB = 1024 * 1024 * 1024 * 1024;

describe('formatBytes', () => {
  test('scales through every unit', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(KB), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(MB), '1.0 MB');
    assert.equal(formatBytes(1.5 * MB), '1.5 MB');
    assert.equal(formatBytes(GB), '1.00 GB');
    assert.equal(formatBytes(2.5 * GB), '2.50 GB');
    assert.equal(formatBytes(TB), '1.00 TB');
  });

  test('renders exactly zero as bytes rather than megabytes', () => {
    /**
     * A zeroed network counter reading "0 MB" implies a rounded-down measurement. "0 B" is
     * unambiguous: nothing has been transferred.
     */
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes('0'), '0 B');
  });

  test('returns Unknown for a missing or unusable value', () => {
    for (const value of MISSING_VALUES) {
      assert.equal(formatBytes(value), UNKNOWN, `should be Unknown for ${JSON.stringify(value)}`);
    }
  });

  test('returns Unknown for a negative value', () => {
    // A counter cannot be negative; if one is, the reading is wrong rather than small.
    assert.equal(formatBytes(-1), UNKNOWN);
    assert.equal(formatBytes(-MB), UNKNOWN);
  });

  test('accepts numeric strings, since JSON payloads sometimes carry them', () => {
    assert.equal(formatBytes('1048576'), '1.0 MB');
    assert.equal(formatBytes('512'), '512 B');
  });

  test('handles a value at the boundary between units', () => {
    assert.equal(formatBytes(KB - 1), '1023 B');
    assert.equal(formatBytes(MB - 1), '1024.0 KB');
    assert.equal(formatBytes(GB - 1), '1024.0 MB');
  });
});

describe('formatMegabytes', () => {
  test('converts bytes to megabytes with one decimal', () => {
    /**
     * Takes bytes, not megabytes. This is the usage-side formatter; formatLimitMb is the
     * limit-side one, and confusing them is wrong by a factor of 1,048,576.
     */
    assert.equal(formatMegabytes(MB), '1.0 MB');
    assert.equal(formatMegabytes(5 * MB), '5.0 MB');
    assert.equal(formatMegabytes(384.2 * MB), '384.2 MB');
    assert.equal(formatMegabytes(0), '0.0 MB');
  });

  test('returns Unknown for a missing or negative value', () => {
    for (const value of MISSING_VALUES) {
      assert.equal(formatMegabytes(value), UNKNOWN);
    }
    assert.equal(formatMegabytes(-1), UNKNOWN);
  });
});

describe('formatLimitMb', () => {
  test('treats zero as unlimited', () => {
    /**
     * A Pterodactyl convention, not arithmetic. Rendering "0 MB" would read as a broken
     * server rather than an unrestricted one.
     */
    assert.equal(formatLimitMb(0), 'Unlimited');
    assert.equal(formatLimitMb('0'), 'Unlimited');
  });

  test('formats megabytes, promoting to gigabytes past 1024', () => {
    // Takes megabytes, since that is what the panel reports for configured limits.
    assert.equal(formatLimitMb(512), '512 MB');
    assert.equal(formatLimitMb(1023), '1023 MB');
    assert.equal(formatLimitMb(1024), '1.0 GB');
    assert.equal(formatLimitMb(2048), '2.0 GB');
    assert.equal(formatLimitMb(5120), '5.0 GB');
  });

  test('returns Unknown for a missing or negative value', () => {
    for (const value of MISSING_VALUES) {
      assert.equal(formatLimitMb(value), UNKNOWN);
    }
    assert.equal(formatLimitMb(-1), UNKNOWN);
  });
});

describe('formatCpuLimit', () => {
  test('treats zero as unlimited', () => {
    assert.equal(formatCpuLimit(0), 'Unlimited');
  });

  test('renders a percentage', () => {
    assert.equal(formatCpuLimit(100), '100%');
    assert.equal(formatCpuLimit(200), '200%');
    assert.equal(formatCpuLimit(50), '50%');
  });

  test('returns Unknown for a missing or negative value', () => {
    for (const value of MISSING_VALUES) {
      assert.equal(formatCpuLimit(value), UNKNOWN);
    }
    assert.equal(formatCpuLimit(-5), UNKNOWN);
  });
});

describe('formatPercent', () => {
  test('renders two decimal places', () => {
    assert.equal(formatPercent(0), '0.00%');
    assert.equal(formatPercent(12.3456), '12.35%');
    assert.equal(formatPercent(100), '100.00%');
  });

  test('accepts values above 100', () => {
    /**
     * cpu_absolute legitimately exceeds 100 on a multi-core allocation: a server given two
     * cores can report 200. Clamping would misreport real usage.
     */
    assert.equal(formatPercent(200), '200.00%');
    assert.equal(formatPercent(347.5), '347.50%');
  });

  test('returns Unknown for a missing or negative value', () => {
    for (const value of MISSING_VALUES) {
      assert.equal(formatPercent(value), UNKNOWN);
    }
    assert.equal(formatPercent(-1), UNKNOWN);
  });
});

describe('formatUsageAgainstLimit', () => {
  test('renders usage, limit and a percentage', () => {
    // Usage in bytes, limit in megabytes: the two units the panel actually uses.
    assert.equal(formatUsageAgainstLimit(512 * MB, 1024), '512.0 MB / 1.0 GB (50%)');
    assert.equal(formatUsageAgainstLimit(256 * MB, 1024), '256.0 MB / 1.0 GB (25%)');
    assert.equal(formatUsageAgainstLimit(0, 1024), '0.0 MB / 1.0 GB (0%)');
  });

  test('reports an unlimited denominator without a percentage', () => {
    /**
     * A percentage of unlimited is meaningless, so it is omitted rather than shown as 0%.
     */
    assert.equal(formatUsageAgainstLimit(512 * MB, 0), '512.0 MB / Unlimited');
  });

  test('omits the percentage when the limit is unknown', () => {
    for (const limit of MISSING_VALUES) {
      const result = formatUsageAgainstLimit(512 * MB, limit);
      assert.equal(result, '512.0 MB / Unlimited', `unexpected result for limit ${JSON.stringify(limit)}`);
    }
  });

  test('returns Unknown when the usage itself is unknown', () => {
    // Without a numerator there is nothing to report, regardless of the limit.
    for (const usage of MISSING_VALUES) {
      assert.equal(formatUsageAgainstLimit(usage, 1024), UNKNOWN);
    }
  });

  test('reports usage above the limit rather than clamping', () => {
    // Disk overage is real and the user needs to see it.
    assert.equal(formatUsageAgainstLimit(2048 * MB, 1024), '2048.0 MB / 1.0 GB (200%)');
  });
});

describe('formatUptime', () => {
  test('treats zero and negative as offline', () => {
    /**
     * The panel reports zero uptime for a stopped container. "0s" would read as a server that
     * just started.
     */
    assert.equal(formatUptime(0), 'Offline');
    assert.equal(formatUptime(-1000), 'Offline');
  });

  test('formats milliseconds into a compact duration', () => {
    // Takes milliseconds, which is what the resources endpoint returns.
    assert.equal(formatUptime(5000), '5s');
    assert.equal(formatUptime(59_000), '59s');
    assert.equal(formatUptime(60_000), '1m 0s');
    assert.equal(formatUptime(90_000), '1m 30s');
    assert.equal(formatUptime(3_600_000), '1h 0s');
    assert.equal(formatUptime(90 * 60 * 1000), '1h 30m 0s');
    assert.equal(formatUptime(86_400_000), '1d 0s');
    assert.equal(formatUptime(2 * 86_400_000 + 3_600_000), '2d 1h 0s');
  });

  test('always includes seconds, so the value is never bare', () => {
    // A server up for exactly one hour showing "1h" reads as rounded; "1h 0s" does not.
    assert.match(formatUptime(3_600_000), /\d+s$/);
    assert.match(formatUptime(86_400_000), /\d+s$/);
  });

  test('returns Offline for a missing value', () => {
    for (const value of MISSING_VALUES) {
      assert.equal(formatUptime(value), 'Offline', `should be Offline for ${JSON.stringify(value)}`);
    }
  });
});

describe('formatDuration', () => {
  test('formats a cooldown in the largest sensible unit', () => {
    assert.equal(formatDuration(1000), '1 second');
    assert.equal(formatDuration(45_000), '45 seconds');
    assert.equal(formatDuration(60_000), '1 minute');
    assert.equal(formatDuration(120_000), '2 minutes');
    assert.equal(formatDuration(3_600_000), '1 hour');
  });

  test('rounds up, so a user is never told to wait less than they must', () => {
    /**
     * Rounding down would report "0 seconds" for a 400ms remainder and invite an immediate
     * retry that is still refused.
     */
    assert.equal(formatDuration(400), '1 second');
    assert.equal(formatDuration(1400), '2 seconds');
    assert.equal(formatDuration(61_000), '2 minutes');
  });

  test('pluralises correctly', () => {
    assert.equal(formatDuration(1000), '1 second');
    assert.equal(formatDuration(2000), '2 seconds');
    assert.equal(formatDuration(60_000), '1 minute');
  });

  test('returns zero for a missing or non-positive value', () => {
    assert.equal(formatDuration(0), '0 seconds');
    assert.equal(formatDuration(-1), '0 seconds');
    for (const value of MISSING_VALUES) {
      assert.equal(formatDuration(value), '0 seconds');
    }
  });
});

describe('formatState', () => {
  test('maps every documented panel state', () => {
    assert.equal(formatState('running'), 'Running');
    assert.equal(formatState('starting'), 'Starting');
    assert.equal(formatState('stopping'), 'Stopping');
    assert.equal(formatState('offline'), 'Offline');
    assert.equal(formatState('missing'), 'Missing');
  });

  test('matches case-insensitively and ignores surrounding whitespace', () => {
    assert.equal(formatState('RUNNING'), 'Running');
    assert.equal(formatState('  running  '), 'Running');
  });

  test('returns Unknown for an unrecognised or missing state', () => {
    /**
     * A future panel version could introduce a state this build has never seen. Unknown is
     * correct; guessing would be worse.
     */
    for (const value of [...MISSING_VALUES, 'suspended', 'installing', 'weird']) {
      assert.equal(formatState(value), UNKNOWN, `should be Unknown for ${JSON.stringify(value)}`);
    }
  });
});

describe('formatStateWithIcon', () => {
  test('prefixes the state with a status icon', () => {
    assert.equal(formatStateWithIcon('running'), '🟢 Running');
    assert.equal(formatStateWithIcon('starting'), '🟡 Starting');
    assert.equal(formatStateWithIcon('stopping'), '🟠 Stopping');
    assert.equal(formatStateWithIcon('offline'), '⚫ Offline');
    assert.equal(formatStateWithIcon('missing'), '🔴 Missing');
  });

  test('uses a neutral icon for an unknown state', () => {
    assert.equal(formatStateWithIcon('weird'), '⚪ Unknown');
    assert.equal(formatStateWithIcon(null), '⚪ Unknown');
  });
});

describe('formatServerStatus', () => {
  test('gives lifecycle flags precedence over live state', () => {
    /**
     * The substantive behaviour in this module. The resources endpoint reports "offline" for a
     * suspended server, an installing server and a genuinely stopped one alike — three
     * situations with entirely different remedies. Showing "Offline" to someone whose server
     * was suspended sends them to check their start command instead of asking why.
     */
    assert.equal(formatServerStatus({ isSuspended: true }, 'offline'), '⛔ Suspended');
    assert.equal(formatServerStatus({ isInstalling: true }, 'offline'), '⏳ Installing');
    assert.equal(formatServerStatus({ isTransferring: true }, 'offline'), '🚚 Transferring');
  });

  test('prioritises suspension above installation', () => {
    // A suspended server that is also installing is suspended first: that is the blocker.
    assert.equal(formatServerStatus({ isSuspended: true, isInstalling: true }, 'offline'), '⛔ Suspended');
  });

  test('falls through to live state when no flag is set', () => {
    const panel = { isSuspended: false, isInstalling: false, isTransferring: false };

    assert.equal(formatServerStatus(panel, 'running'), '🟢 Running');
    assert.equal(formatServerStatus(panel, 'offline'), '⚫ Offline');
  });

  test('falls back to the live state when the panel payload is absent', () => {
    // getClientServer can fail while getResources succeeds; the reply must still render.
    assert.equal(formatServerStatus(null, 'running'), 'Running');
    assert.equal(formatServerStatus(undefined, 'offline'), 'Offline');
    assert.equal(formatServerStatus(null, null), UNKNOWN);
  });
});

describe('formatTimestamp', () => {
  test('renders a Discord relative timestamp', () => {
    /**
     * Discord renders <t:seconds:R> in each viewer's own locale and timezone, which is why the
     * bot does not format dates itself.
     */
    const result = formatTimestamp(new Date('2026-01-01T00:00:00Z'));

    assert.match(result, /^<t:\d+:R>$/);
    assert.equal(result, `<t:${Math.floor(Date.UTC(2026, 0, 1) / 1000)}:R>`);
  });

  test('treats a SQLite datetime as UTC', () => {
    /**
     * The correctness case. SQLite's datetime('now') produces "2026-09-02 04:28:38" with no
     * zone marker, and new Date() parses that as local time. On a server running anything
     * other than UTC, account creation dates would silently drift by the offset.
     */
    const sqliteForm = '2026-01-01 12:00:00';
    const expected = Math.floor(Date.UTC(2026, 0, 1, 12, 0, 0) / 1000);

    assert.equal(formatTimestamp(sqliteForm), `<t:${expected}:R>`);
  });

  test('treats the ISO form identically to the SQLite form', () => {
    // Both spellings must resolve to the same instant.
    assert.equal(formatTimestamp('2026-01-01 12:00:00'), formatTimestamp('2026-01-01T12:00:00Z'));
  });

  test('accepts epoch milliseconds', () => {
    const millis = Date.UTC(2026, 5, 15, 8, 30, 0);
    assert.equal(formatTimestamp(millis), `<t:${Math.floor(millis / 1000)}:R>`);
  });

  test('returns Unknown for an absent value', () => {
    assert.equal(formatTimestamp(null), UNKNOWN);
    assert.equal(formatTimestamp(undefined), UNKNOWN);
    assert.equal(formatTimestamp(''), UNKNOWN);
  });

  test('returns the raw text for an unparseable value', () => {
    // Better to show what the panel sent than to claim the field is missing.
    assert.equal(formatTimestamp('not a date'), 'not a date');
    assert.equal(formatTimestamp('tomorrow'), 'tomorrow');
  });
});

describe('formatAbsoluteTimestamp', () => {
  test('renders the full date form', () => {
    const result = formatAbsoluteTimestamp('2026-01-01T00:00:00Z');
    assert.match(result, /^<t:\d+:f>$/);
  });

  test('passes through an unparseable value unchanged', () => {
    assert.equal(formatAbsoluteTimestamp('not a date'), 'not a date');
    assert.equal(formatAbsoluteTimestamp(null), UNKNOWN);
  });
});

describe('truncate', () => {
  test('leaves short text unchanged', () => {
    assert.equal(truncate('short', 10), 'short');
    assert.equal(truncate('exactly10!', 10), 'exactly10!');
  });

  test('truncates with an ellipsis, respecting the limit', () => {
    /**
     * The result must not exceed the limit, since these values go into embed fields with hard
     * Discord caps.
     */
    const result = truncate('x'.repeat(50), 10);

    assert.equal(result.length, 10);
    assert.ok(result.endsWith('…'));
  });

  test('handles degenerate limits', () => {
    assert.equal(truncate('anything', 0), '');
    assert.equal(truncate('anything', -1), '');
    assert.equal(truncate('anything', 1), '…');
  });

  test('tolerates non-string input', () => {
    assert.equal(truncate(null, 10), '');
    assert.equal(truncate(undefined, 10), '');
    assert.equal(truncate(42, 10), '42');
  });
});

describe('pluralise', () => {
  test('uses the singular for exactly one', () => {
    assert.equal(pluralise(1, 'server'), '1 server');
    assert.equal(pluralise(1, 'permission'), '1 permission');
  });

  test('uses the plural for zero and for many', () => {
    assert.equal(pluralise(0, 'server'), '0 servers');
    assert.equal(pluralise(2, 'server'), '2 servers');
    assert.equal(pluralise(100, 'server'), '100 servers');
  });

  test('accepts an irregular plural', () => {
    assert.equal(pluralise(1, 'sub-user', 'sub-users'), '1 sub-user');
    assert.equal(pluralise(3, 'sub-user', 'sub-users'), '3 sub-users');
    assert.equal(pluralise(2, 'entry', 'entries'), '2 entries');
  });

  test('treats a missing count as zero', () => {
    for (const value of MISSING_VALUES) {
      assert.equal(pluralise(value, 'server'), '0 servers');
    }
  });
});

describe('formatAllocation', () => {
  test('renders host and port', () => {
    assert.equal(formatAllocation({ ip: '192.0.2.10', port: 25565 }), '192.0.2.10:25565');
  });

  test('prefers the alias over the raw address', () => {
    /**
     * An alias is what the operator wants users to connect to — a hostname rather than a bare
     * node IP.
     */
    assert.equal(
      formatAllocation({ ip: '192.0.2.10', port: 25565, alias: 'play.example.com' }),
      'play.example.com:25565',
    );
  });

  test('tolerates a missing or partial allocation', () => {
    // The panel omits the allocations relationship on some versions.
    assert.equal(formatAllocation(null), UNKNOWN);
    assert.equal(formatAllocation(undefined), UNKNOWN);
    assert.equal(formatAllocation({}), 'unknown');
    assert.equal(formatAllocation({ ip: '192.0.2.10' }), '192.0.2.10');
    assert.equal(formatAllocation({ ip: '192.0.2.10', port: null }), '192.0.2.10');
  });
});
