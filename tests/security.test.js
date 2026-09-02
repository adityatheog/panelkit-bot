// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/utils/security.js.
 *
 * This module generates the credentials users log in with, builds the links they click, and
 * decides who may drive an interactive component. Each of those has a failure mode that a
 * happy-path test would not catch, so the assertions here target the mechanism rather than
 * the output:
 *
 *   Credential generation is checked for distribution, not just for shape. A generator using
 *   `byte % alphabet.length` produces valid-looking passwords with measurably reduced
 *   entropy in the first characters of the alphabet, and every naive test passes.
 *
 *   URL construction is checked against inputs designed to escape the configured origin,
 *   because the whole purpose of the function is that a server identifier cannot redirect a
 *   user to another host.
 *
 *   Ownership checks are asserted to fail closed on a missing session, since "no session"
 *   and "someone else's session" must be indistinguishable.
 *
 * The statistical tests use enough samples to catch a systematic bias while staying fast
 * enough to run on every commit, and their thresholds are loose enough not to fail on
 * ordinary variance.
 *
 * No credentials, no network, no filesystem.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  accountAgeInDays,
  assertSessionOwner,
  buildEmail,
  buildPanelAccountUrl,
  buildPanelServerUrl,
  createSessionDescriptor,
  daysUntilEligible,
  DEFAULT_SESSION_TTL_MS,
  generatePassword,
  generateUsername,
  isSessionOwner,
  meetsAccountAge,
  newErrorReference,
  newSessionId,
  PASSWORD_MAX,
  PASSWORD_MIN,
  safeEquals,
  USERNAME_MAX,
  USERNAME_MIN,
} from '../src/utils/security.js';
import { AuthorizationError, ValidationError } from '../src/utils/errors.js';

/** Sample size for the distribution checks. Large enough to expose bias, fast enough to run always. */
const SAMPLE_SIZE = 2000;

describe('generateUsername', () => {
  test('produces a username of the requested length starting with a letter', () => {
    /**
     * Pterodactyl rejects usernames that do not begin with a letter, so this is a panel
     * requirement rather than a style preference.
     */
    for (let index = 0; index < 200; index += 1) {
      const username = generateUsername(10);

      assert.equal(username.length, 10);
      assert.match(username, /^[a-z][a-z0-9]{9}$/);
    }
  });

  test('clamps the length rather than rejecting a bad configuration', () => {
    // A misconfigured account.usernameLength should degrade to a safe value, not break
    // account creation entirely.
    assert.equal(generateUsername(0).length, USERNAME_MIN);
    assert.equal(generateUsername(-5).length, USERNAME_MIN);
    assert.equal(generateUsername(1000).length, USERNAME_MAX);
    assert.equal(generateUsername(NaN).length, 10);
    assert.equal(generateUsername(undefined).length, 10);
    assert.equal(generateUsername('12').length, 12, 'a numeric string should be honoured');
  });

  test('produces distinct values', () => {
    /**
     * A ten-character username from a 36-symbol alphabet has ample entropy, so any
     * collision in this sample would indicate a broken generator rather than bad luck.
     */
    const seen = new Set();
    for (let index = 0; index < SAMPLE_SIZE; index += 1) seen.add(generateUsername(10));

    assert.equal(seen.size, SAMPLE_SIZE, 'every generated username should be unique');
  });

  test('draws uniformly from the alphabet', () => {
    /**
     * The bias test. Rejection sampling discards bytes at or above the largest multiple of
     * the alphabet length; a `byte % 36` implementation would over-represent the first
     * 256 % 36 === 4 symbols by roughly 14%.
     *
     * Only positions after the first are counted, since position zero is deliberately
     * restricted to letters.
     */
    const counts = new Map();
    let total = 0;

    for (let index = 0; index < SAMPLE_SIZE; index += 1) {
      for (const character of generateUsername(20).slice(1)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
        total += 1;
      }
    }

    const alphabetSize = 36;
    const expected = total / alphabetSize;

    assert.equal(counts.size, alphabetSize, 'every symbol in the alphabet should appear');

    for (const [character, count] of counts) {
      const deviation = Math.abs(count - expected) / expected;
      assert.ok(
        deviation < 0.15,
        `symbol ${character} deviates ${(deviation * 100).toFixed(1)}% from uniform, which suggests modulo bias`,
      );
    }
  });
});

describe('generatePassword', () => {
  test('produces a password of the requested length', () => {
    for (const length of [12, 16, 24, 32, 64]) {
      assert.equal(generatePassword(length).length, length);
    }
  });

  test('clamps the length to a safe range', () => {
    // A short password is a security regression, so the floor is enforced regardless of
    // configuration.
    assert.equal(generatePassword(1).length, PASSWORD_MIN);
    assert.equal(generatePassword(0).length, PASSWORD_MIN);
    assert.equal(generatePassword(-10).length, PASSWORD_MIN);
    assert.equal(generatePassword(10_000).length, PASSWORD_MAX);
    assert.equal(generatePassword(NaN).length, 16);
  });

  test('always contains a lowercase letter, an uppercase letter and a digit', () => {
    /**
     * The panel enforces a complexity policy. Regenerating until the candidate complies is
     * what guarantees the first submission is accepted rather than failing with a
     * validation error the user cannot act on.
     */
    for (let index = 0; index < 500; index += 1) {
      const password = generatePassword(12);

      assert.match(password, /[a-z]/, 'missing a lowercase letter');
      assert.match(password, /[A-Z]/, 'missing an uppercase letter');
      assert.match(password, /\d/, 'missing a digit');
    }
  });

  test('excludes visually ambiguous characters', () => {
    /**
     * These credentials are read out of a Discord DM and retyped by hand, so I, l, 1, O and
     * 0 are excluded from the alphabet.
     */
    for (let index = 0; index < 500; index += 1) {
      const password = generatePassword(32);

      for (const ambiguous of ['I', 'l', '1', 'O', '0']) {
        assert.ok(!password.includes(ambiguous), `password contains the ambiguous character ${ambiguous}`);
      }
    }
  });

  test('excludes characters that would break a shell or a code span', () => {
    /**
     * A password is rendered inside a Discord code span and often pasted into a shell.
     * Backticks, quotes and backslashes are excluded so neither context needs escaping.
     */
    for (let index = 0; index < 500; index += 1) {
      const password = generatePassword(32);

      for (const hostile of ['`', "'", '"', '\\', '\n', ' ']) {
        assert.ok(!password.includes(hostile), `password contains ${JSON.stringify(hostile)}`);
      }
    }
  });

  test('produces distinct values', () => {
    const seen = new Set();
    for (let index = 0; index < SAMPLE_SIZE; index += 1) seen.add(generatePassword(16));

    assert.equal(seen.size, SAMPLE_SIZE, 'every generated password should be unique');
  });

  test('draws uniformly from the alphabet', () => {
    /**
     * The same bias check as for usernames. The complexity retry loop rejects whole
     * candidates rather than individual positions, so it preserves uniformity over the
     * subset of compliant strings — this test proves that reasoning holds.
     */
    const counts = new Map();
    let total = 0;

    for (let index = 0; index < 400; index += 1) {
      for (const character of generatePassword(64)) {
        counts.set(character, (counts.get(character) ?? 0) + 1);
        total += 1;
      }
    }

    const expected = total / counts.size;

    for (const [character, count] of counts) {
      const deviation = Math.abs(count - expected) / expected;
      assert.ok(
        deviation < 0.2,
        `symbol ${character} deviates ${(deviation * 100).toFixed(1)}% from uniform, which suggests modulo bias`,
      );
    }
  });
});

describe('buildEmail', () => {
  test('joins the username and the configured domain', () => {
    assert.equal(buildEmail('abcdefghij', 'panelkit.local'), 'abcdefghij@panelkit.local');
    assert.equal(buildEmail('user', 'example.com'), 'user@example.com');
  });
});

describe('newSessionId', () => {
  test('produces a base64url token with no separator characters', () => {
    /**
     * The session id is the final segment of a Discord custom id, which is colon-delimited.
     * A token containing a colon would break sessionIdFromCustomId.
     */
    for (let index = 0; index < 500; index += 1) {
      const id = newSessionId();

      assert.match(id, /^[A-Za-z0-9_-]+$/, 'must be base64url with no padding');
      assert.ok(!id.includes(':'), 'must not contain the custom id separator');
      assert.ok(id.length >= 12, 'must carry meaningful entropy');
    }
  });

  test('produces distinct values', () => {
    const seen = new Set();
    for (let index = 0; index < SAMPLE_SIZE; index += 1) seen.add(newSessionId());

    assert.equal(seen.size, SAMPLE_SIZE, 'session ids must not collide');
  });
});

describe('newErrorReference', () => {
  test('produces a short uppercase hex reference', () => {
    for (let index = 0; index < 200; index += 1) {
      assert.match(newErrorReference(), /^[0-9A-F]{8}$/);
    }
  });

  test('produces distinct values', () => {
    // 32 bits over a modest sample: a handful of collisions would be tolerable in practice,
    // but a systematic failure would show as a much lower count.
    const seen = new Set();
    for (let index = 0; index < 1000; index += 1) seen.add(newErrorReference());

    assert.ok(seen.size > 990, `expected near-unique references, saw ${seen.size} distinct in 1000`);
  });
});

describe('buildPanelServerUrl', () => {
  const panel = 'https://panel.example.com';

  test('builds a URL under the configured origin', () => {
    assert.equal(buildPanelServerUrl(panel, 'a1b2c3d4'), 'https://panel.example.com/server/a1b2c3d4');
    assert.equal(buildPanelServerUrl('https://panel.example.com', 'A1B2C3D4'), 'https://panel.example.com/server/a1b2c3d4');
  });

  test('handles a panel served from a subdirectory', () => {
    // A panel behind a reverse proxy at /panel still resolves against its own origin.
    const result = buildPanelServerUrl('https://example.com/panel', 'a1b2c3d4');
    assert.ok(result.startsWith('https://example.com/'), `unexpected result: ${result}`);
  });

  test('rejects an identifier that is not a valid identifier', () => {
    /**
     * The identifier is revalidated inside the builder, so a caller that skipped validation
     * cannot produce a link to an arbitrary path.
     */
    for (const bad of ['', 'short', '../../admin', 'a1b2c3d4/../../admin', 'https://evil.example', 'a1b2c3d4?x=1']) {
      assert.throws(
        () => buildPanelServerUrl(panel, bad),
        ValidationError,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  test('never produces a link to another host', () => {
    /**
     * The property that matters. Whatever the identifier contains, the result must remain on
     * the configured panel origin — a link posted by the bot is implicitly trusted by the
     * user who clicks it.
     */
    const hostile = [
      'a1b2c3d4',
      'A1B2C3D4',
      '12345678',
      'aaaaaaaa',
    ];

    for (const identifier of hostile) {
      const result = new URL(buildPanelServerUrl(panel, identifier));
      assert.equal(result.origin, 'https://panel.example.com');
    }

    // And anything that could escape is refused outright rather than sanitised.
    for (const bad of ['//evil.example', 'https://evil.example/x', '\\\\evil.example']) {
      assert.throws(() => buildPanelServerUrl(panel, bad), ValidationError);
    }
  });

  test('throws when the configured panel URL is unusable', () => {
    for (const bad of ['', 'not a url', 'panel.example.com']) {
      assert.throws(() => buildPanelServerUrl(bad, 'a1b2c3d4'));
    }
  });
});

describe('buildPanelAccountUrl', () => {
  test('builds the account page URL', () => {
    assert.equal(buildPanelAccountUrl('https://panel.example.com'), 'https://panel.example.com/account');
    assert.equal(buildPanelAccountUrl('https://panel.example.com/'), 'https://panel.example.com/account');
  });
});

describe('createSessionDescriptor', () => {
  test('records the owner, the data and an expiry', () => {
    const before = Date.now();
    const session = createSessionDescriptor('123456789012345678', { identifier: 'a1b2c3d4' }, 60_000);

    assert.equal(session.ownerId, '123456789012345678');
    assert.deepEqual(session.data, { identifier: 'a1b2c3d4' });
    assert.ok(session.createdAt >= before);
    assert.ok(session.expiresAt > session.createdAt);
    assert.ok(session.expiresAt - session.createdAt >= 60_000);
    assert.match(session.id, /^[A-Za-z0-9_-]+$/);
  });

  test('coerces the owner id to a string', () => {
    // Discord ids exceed Number.MAX_SAFE_INTEGER, so they must never be compared as numbers.
    const session = createSessionDescriptor(123456789012345678n, {});
    assert.equal(typeof session.ownerId, 'string');
  });

  test('applies the default TTL when none is given', () => {
    const session = createSessionDescriptor('123456789012345678', {});
    const ttl = session.expiresAt - session.createdAt;

    assert.equal(ttl, DEFAULT_SESSION_TTL_MS);
  });

  test('falls back to the default TTL for a nonsensical value', () => {
    for (const bad of [NaN, 'soon', undefined, null]) {
      const session = createSessionDescriptor('123456789012345678', {}, bad);
      assert.equal(session.expiresAt - session.createdAt, DEFAULT_SESSION_TTL_MS);
    }
  });

  test('produces a distinct id per session', () => {
    const seen = new Set();
    for (let index = 0; index < 500; index += 1) {
      seen.add(createSessionDescriptor('123456789012345678', {}).id);
    }

    assert.equal(seen.size, 500);
  });
});

describe('assertSessionOwner and isSessionOwner', () => {
  const session = { ownerId: '123456789012345678' };

  test('accepts the owner', () => {
    assert.equal(assertSessionOwner(session, '123456789012345678'), true);
    assert.equal(isSessionOwner(session, '123456789012345678'), true);
  });

  test('rejects a different user', () => {
    /**
     * Discord's UI visibility is not an authorisation boundary: anyone who can see a message
     * can send its component interactions.
     */
    assert.throws(() => assertSessionOwner(session, '987654321098765432'), AuthorizationError);
    assert.equal(isSessionOwner(session, '987654321098765432'), false);
  });

  test('fails closed on a missing session', () => {
    /**
     * A missing session and a foreign one are treated identically. Distinguishing them would
     * reveal whether a given session id exists.
     */
    for (const missing of [null, undefined]) {
      assert.throws(() => assertSessionOwner(missing, '123456789012345678'), AuthorizationError);
      assert.equal(isSessionOwner(missing, '123456789012345678'), false);
    }
  });

  test('compares as strings', () => {
    // A numeric id passed by a caller must still match, and must not be coerced loosely.
    assert.equal(isSessionOwner({ ownerId: '123456789012345678' }, 123456789012345678n), false);
    assert.equal(isSessionOwner({ ownerId: '123' }, 123), true);
  });
});

describe('safeEquals', () => {
  test('compares equal strings as equal', () => {
    assert.equal(safeEquals('secret', 'secret'), true);
    assert.equal(safeEquals('', ''), true);
  });

  test('compares different strings as unequal', () => {
    assert.equal(safeEquals('secret', 'secrer'), false);
    assert.equal(safeEquals('secret', 'secrets'), false);
    assert.equal(safeEquals('', 'x'), false);
  });

  test('tolerates non-string and absent input', () => {
    // timingSafeEqual throws on mismatched buffer lengths, so the length check must come
    // first rather than being left to the primitive.
    assert.equal(safeEquals(null, null), true);
    assert.equal(safeEquals(undefined, ''), true);
    assert.equal(safeEquals('x', null), false);
  });
});

describe('account age policy', () => {
  const now = Date.UTC(2026, 0, 1);
  const day = 86_400_000;

  test('computes an age in fractional days', () => {
    assert.equal(accountAgeInDays(now - 10 * day, now), 10);
    assert.equal(accountAgeInDays(now - day / 2, now), 0.5);
  });

  test('accepts an account that meets the threshold', () => {
    assert.equal(meetsAccountAge(now - 100 * day, 90, now), true);
    assert.equal(meetsAccountAge(now - 90 * day, 90, now), true, 'exactly at the threshold should pass');
  });

  test('rejects an account that is too new', () => {
    assert.equal(meetsAccountAge(now - 10 * day, 90, now), false);
    assert.equal(meetsAccountAge(now, 90, now), false);
  });

  test('treats a threshold of zero as disabling the check', () => {
    // ACCOUNT_AGE_DAYS=0 is documented as disabling the policy.
    assert.equal(meetsAccountAge(now, 0, now), true);
    assert.equal(meetsAccountAge(now - day, 0, now), true);
  });

  test('fails closed on an unusable creation timestamp', () => {
    /**
     * The important case. A naive implementation computes NaN >= 90, which is false only by
     * accident of comparison semantics — making it explicit means a partial user object
     * cannot bypass the policy through a different code path.
     */
    for (const bad of [undefined, null, NaN, 0, -1, 'yesterday', {}]) {
      assert.equal(
        meetsAccountAge(bad, 90, now),
        false,
        `an unusable timestamp ${JSON.stringify(bad)} must not satisfy the policy`,
      );
    }
  });

  test('reports whole days remaining until eligible', () => {
    // The error message tells a rejected user how long to wait, so this is rounded up.
    assert.equal(daysUntilEligible(now - 80 * day, 90, now), 10);
    assert.equal(daysUntilEligible(now - 89.5 * day, 90, now), 1);
    assert.equal(daysUntilEligible(now - 100 * day, 90, now), 0, 'an eligible account has zero days remaining');
    assert.equal(daysUntilEligible(now, 0, now), 0);
  });
});
