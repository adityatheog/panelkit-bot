// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/utils/validation.js.
 *
 * Validation is the boundary between untrusted input and everything that touches the panel
 * or the database, so these tests are written adversarially. Each validator is checked
 * against the values an attacker or a confused user would actually supply — path traversal
 * in an identifier, mention syntax in a server name, an object with a hostile toString —
 * rather than only against obviously wrong input.
 *
 * The rejection cases matter more than the acceptance cases here. A validator that accepts
 * valid input but also accepts `../../etc/passwd` passes a naive happy-path test and fails
 * in production.
 *
 * No credentials, no network, no filesystem: these are pure functions.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  assertAbsolutePath,
  assertAllowedDockerImage,
  assertOneOf,
  assertValidDiscordId,
  assertValidEggKey,
  assertValidEmail,
  assertValidIdentifier,
  assertValidInteger,
  assertValidPermission,
  assertValidPowerSignal,
  assertValidServerName,
  assertValidUserReference,
  assertValidUuid,
  isValidIdentifier,
  parseSnowflakeList,
  POWER_SIGNALS,
  sanitiseForDisplay,
  SERVER_NAME_MAX,
  SERVER_NAME_MIN,
} from '../src/utils/validation.js';
import { ValidationError } from '../src/utils/errors.js';

describe('assertValidIdentifier', () => {
  test('accepts a well-formed identifier and lowercases it', () => {
    assert.equal(assertValidIdentifier('a1b2c3d4'), 'a1b2c3d4');
    assert.equal(assertValidIdentifier('A1B2C3D4'), 'a1b2c3d4');
    assert.equal(assertValidIdentifier('  a1b2c3d4  '), 'a1b2c3d4');
    assert.equal(assertValidIdentifier('12345678'), '12345678');
    assert.equal(assertValidIdentifier('abcdefgh'), 'abcdefgh');
  });

  test('rejects anything that is not exactly eight alphanumerics', () => {
    for (const bad of ['', 'a1b2c3d', 'a1b2c3d45', 'short', 'a1b2c3d!', 'a1b2 c3d', 'a1b2-c3d']) {
      assert.throws(() => assertValidIdentifier(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('rejects traversal and injection payloads', () => {
    /**
     * The identifier is interpolated into a panel URL path, so these are the values that
     * would matter if the anchors were missing from the pattern.
     */
    const hostile = [
      '../../etc',
      '..%2f..%2f',
      'a1b2c3d4/../../admin',
      'a1b2c3d4?admin=1',
      'a1b2c3d4#frag',
      "a1b2c3d4'; DROP TABLE servers; --",
      'a1b2c3d4\nX-Injected: 1',
      'https://evil.example',
    ];

    for (const bad of hostile) {
      assert.throws(() => assertValidIdentifier(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('rejects non-string values without invoking their toString', () => {
    /**
     * toSafeString returns '' for objects rather than calling String(raw), so a crafted
     * object cannot pass a check and then serialise differently downstream.
     */
    let called = false;
    const hostile = {
      toString() {
        called = true;
        return 'a1b2c3d4';
      },
    };

    assert.throws(() => assertValidIdentifier(hostile), ValidationError);
    assert.equal(called, false, 'toString must not be invoked on untrusted input');

    for (const bad of [null, undefined, {}, [], () => 'a1b2c3d4', Symbol('a1b2c3d4')]) {
      assert.throws(() => assertValidIdentifier(bad), ValidationError);
    }
  });

  test('isValidIdentifier mirrors the assertion without throwing', () => {
    assert.equal(isValidIdentifier('a1b2c3d4'), true);
    assert.equal(isValidIdentifier('A1B2C3D4'), true);
    assert.equal(isValidIdentifier('nope'), false);
    assert.equal(isValidIdentifier(null), false);
    assert.equal(isValidIdentifier({}), false);
  });
});

describe('assertValidServerName', () => {
  test('accepts valid names and collapses internal whitespace', () => {
    assert.equal(assertValidServerName('My Server'), 'My Server');
    assert.equal(assertValidServerName('  My   Server  '), 'My Server');
    assert.equal(assertValidServerName('server-1'), 'server-1');
    assert.equal(assertValidServerName('my_server.v2'), 'my_server.v2');
    assert.equal(assertValidServerName('abc'), 'abc');
    assert.equal(assertValidServerName('x'.repeat(SERVER_NAME_MAX)), 'x'.repeat(SERVER_NAME_MAX));
  });

  test('enforces the length bounds', () => {
    assert.throws(() => assertValidServerName(''), ValidationError);
    assert.throws(() => assertValidServerName('ab'), ValidationError);
    assert.throws(() => assertValidServerName('x'.repeat(SERVER_NAME_MAX + 1)), ValidationError);

    // Whitespace collapses before the length check, so this is two characters, not five.
    assert.throws(() => assertValidServerName('a    b'.replace('a    b', 'a b')), ValidationError);
  });

  test('rejects markdown and mention syntax', () => {
    /**
     * A server name is rendered inside embeds throughout the bot, including on a dashboard
     * that refreshes. A name containing @everyone or backticks would ping a channel or
     * break formatting on every render.
     */
    const hostile = [
      '@everyone',
      '@here',
      'Server @everyone',
      '<@123456789012345678>',
      '<@&987654321098765432>',
      '**bold**',
      '`code`',
      '~~strike~~',
      '||spoiler||',
      'a\\b',
      '[link](https://evil.example)',
    ];

    for (const bad of hostile) {
      assert.throws(() => assertValidServerName(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('rejects control characters and zero-width padding', () => {
    const hostile = [
      'Server\u0000name',
      'Server\u001bname',
      'Server\u200bname',
      'Server\u202ename',
      'Server\ufeffname',
      'Server\u2028name',
    ];

    for (const bad of hostile) {
      assert.throws(() => assertValidServerName(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('requires the first and last characters to be alphanumeric', () => {
    // Leading and trailing punctuation is how names are made to sort first or impersonate.
    for (const bad of ['-server', 'server-', '_server', 'server_', '.server', 'server.']) {
      assert.throws(() => assertValidServerName(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('assertValidEggKey', () => {
  const allowed = ['nodejs', 'python', 'minecraft'];

  test('accepts a configured key, case-insensitively', () => {
    assert.equal(assertValidEggKey('nodejs', allowed), 'nodejs');
    assert.equal(assertValidEggKey('NODEJS', allowed), 'nodejs');
    assert.equal(assertValidEggKey('  python  ', allowed), 'python');
  });

  test('rejects a key that is not in the allowlist', () => {
    /**
     * Membership is the real check. An unconfigured egg would otherwise be offered and then
     * fail at provisioning time with an opaque panel 422.
     */
    assert.throws(() => assertValidEggKey('bun', allowed), ValidationError);
    assert.throws(() => assertValidEggKey('', allowed), ValidationError);
    assert.throws(() => assertValidEggKey('nodejs; rm -rf /', allowed), ValidationError);
  });

  test('names the available types in the error, to be actionable', () => {
    assert.throws(
      () => assertValidEggKey('bun', allowed),
      (err) => err instanceof ValidationError && err.message.includes('nodejs'),
    );
  });

  test('rejects everything when the allowlist is empty or absent', () => {
    assert.throws(() => assertValidEggKey('nodejs', []), ValidationError);
    assert.throws(() => assertValidEggKey('nodejs', null), ValidationError);
    assert.throws(() => assertValidEggKey('nodejs', undefined), ValidationError);
  });
});

describe('assertValidPowerSignal', () => {
  test('accepts every documented signal, case-insensitively', () => {
    for (const signal of POWER_SIGNALS) {
      assert.equal(assertValidPowerSignal(signal), signal);
      assert.equal(assertValidPowerSignal(signal.toUpperCase()), signal);
    }
  });

  test('rejects anything else', () => {
    for (const bad of ['', 'delete', 'suspend', 'reinstall', 'start;stop', 'START ', null, {}]) {
      assert.throws(() => assertValidPowerSignal(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('the exported signal list matches the panel API', () => {
    // The slash command choices derive from this, so a change here changes both surfaces.
    assert.deepEqual([...POWER_SIGNALS], ['start', 'stop', 'restart', 'kill']);
  });
});

describe('assertValidDiscordId and assertValidUserReference', () => {
  test('accepts snowflakes of valid length', () => {
    assert.equal(assertValidDiscordId('123456789012345678'), '123456789012345678');
    assert.equal(assertValidDiscordId('12345678901234567'), '12345678901234567');
    assert.equal(assertValidDiscordId('12345678901234567890'), '12345678901234567890');
  });

  test('rejects malformed snowflakes', () => {
    for (const bad of ['', '123', '1234567890123456', '123456789012345678901', '1234567890123456a', '<@123>']) {
      assert.throws(() => assertValidDiscordId(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('accepts both mention forms and returns the bare id', () => {
    // The prefix surface receives mentions; the slash surface receives ids.
    assert.equal(assertValidUserReference('<@123456789012345678>'), '123456789012345678');
    assert.equal(assertValidUserReference('<@!123456789012345678>'), '123456789012345678');
    assert.equal(assertValidUserReference('123456789012345678'), '123456789012345678');
  });

  test('rejects role and channel mentions', () => {
    /**
     * A role mention is the likely mistake when a user means to target someone, and
     * accepting it would send a role id where a user id is expected.
     */
    assert.throws(() => assertValidUserReference('<@&123456789012345678>'), ValidationError);
    assert.throws(() => assertValidUserReference('<#123456789012345678>'), ValidationError);
    assert.throws(() => assertValidUserReference('@everyone'), ValidationError);
    assert.throws(() => assertValidUserReference('someone'), ValidationError);
  });
});

describe('assertValidEmail', () => {
  test('accepts deliverable addresses and lowercases them', () => {
    assert.equal(assertValidEmail('user@example.com'), 'user@example.com');
    assert.equal(assertValidEmail('User@Example.COM'), 'user@example.com');
    assert.equal(assertValidEmail('  first.last+tag@sub.example.co.uk  '), 'first.last+tag@sub.example.co.uk');
    assert.equal(assertValidEmail('a_b-c%d@example-host.org'), 'a_b-c%d@example-host.org');
  });

  test('rejects malformed addresses', () => {
    for (const bad of [
      '',
      'nope',
      'a@b',
      'a@@b.com',
      '@example.com',
      'user@',
      'user@.com',
      'user name@example.com',
      'user@example',
      'user@exam ple.com',
    ]) {
      assert.throws(() => assertValidEmail(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('enforces the length ceiling', () => {
    const tooLong = `${'x'.repeat(190)}@example.com`;
    assert.throws(() => assertValidEmail(tooLong), ValidationError);
  });

  test('rejects header injection attempts', () => {
    // The address reaches the panel API, so newline injection is checked explicitly.
    for (const bad of ['user@example.com\nBcc: evil@example.com', 'user@example.com\r\nX: 1']) {
      assert.throws(() => assertValidEmail(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('assertAllowedDockerImage', () => {
  const allowed = ['ghcr.io/example/node:20', 'ghcr.io/example/node:22'];

  test('accepts an image on the allowlist', () => {
    assert.equal(assertAllowedDockerImage('ghcr.io/example/node:20', allowed), 'ghcr.io/example/node:20');
  });

  test('rejects any image not on the allowlist', () => {
    /**
     * Free-form images are never accepted: a user selecting an arbitrary container would be
     * running arbitrary code on the operator's node.
     */
    for (const bad of [
      'evil/image',
      'ghcr.io/example/node:latest',
      'ghcr.io/example/node:20 ',
      'ghcr.io/attacker/backdoor:1',
      '',
    ]) {
      assert.throws(() => assertAllowedDockerImage(bad, allowed), ValidationError, `should reject ${bad}`);
    }
  });

  test('rejects everything when nothing is configured', () => {
    assert.throws(() => assertAllowedDockerImage('ghcr.io/example/node:20', []), ValidationError);
    assert.throws(() => assertAllowedDockerImage('ghcr.io/example/node:20', null), ValidationError);
  });
});

describe('assertValidUuid', () => {
  test('accepts a UUID in either case', () => {
    const uuid = '11111111-2222-3333-4444-555555555555';
    assert.equal(assertValidUuid(uuid), uuid);
    assert.equal(assertValidUuid(uuid.toUpperCase()), uuid.toUpperCase());
  });

  test('rejects malformed references', () => {
    for (const bad of [
      '',
      '11111111-2222-3333-4444',
      '11111111222233334444555555555555',
      '11111111-2222-3333-4444-55555555555g',
      '../../admin',
    ]) {
      assert.throws(() => assertValidUuid(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('assertValidPermission', () => {
  test('accepts panel permission strings', () => {
    assert.equal(assertValidPermission('control.console'), 'control.console');
    assert.equal(assertValidPermission('file.read-content'), 'file.read-content');
    assert.equal(assertValidPermission('CONTROL.CONSOLE'), 'control.console');
  });

  test('rejects malformed permissions', () => {
    for (const bad of ['', 'control', 'control.', '.console', 'control..console', 'control console', 'control.CONSOLE!']) {
      assert.throws(() => assertValidPermission(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });
});

describe('assertAbsolutePath', () => {
  test('accepts absolute paths', () => {
    assert.equal(assertAbsolutePath('/logs/latest.log'), '/logs/latest.log');
    assert.equal(assertAbsolutePath('/'), '/');
    assert.equal(assertAbsolutePath('/output.log'), '/output.log');
    assert.equal(assertAbsolutePath('/a b/c.log'), '/a b/c.log');
  });

  test('rejects relative paths', () => {
    for (const bad of ['', 'logs/latest.log', './logs/latest.log', 'C:\\logs']) {
      assert.throws(() => assertAbsolutePath(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('rejects traversal segments even when the path is absolute', () => {
    /**
     * The leading-slash test alone would accept /logs/../../etc/passwd, which is why the
     * segments are checked separately.
     */
    for (const bad of ['/logs/../../etc/passwd', '/../secret', '/a/../../b', '/..']) {
      assert.throws(() => assertAbsolutePath(bad), ValidationError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('accepts a filename containing dots that is not a traversal', () => {
    // Only a whole ".." segment is a traversal; "..log" is a legitimate filename.
    assert.equal(assertAbsolutePath('/logs/..log'), '/logs/..log');
    assert.equal(assertAbsolutePath('/a.b/c..d.log'), '/a.b/c..d.log');
  });
});

describe('assertValidInteger', () => {
  test('accepts integers within bounds, including string forms', () => {
    assert.equal(assertValidInteger('5', { name: 'page', min: 1, max: 10 }), 5);
    assert.equal(assertValidInteger(5, { name: 'page', min: 1, max: 10 }), 5);
    assert.equal(assertValidInteger('  7  ', { name: 'page', min: 1, max: 10 }), 7);
    assert.equal(assertValidInteger('1', { name: 'page', min: 1, max: 10 }), 1);
    assert.equal(assertValidInteger('10', { name: 'page', min: 1, max: 10 }), 10);
  });

  test('rejects out-of-range and non-integer values', () => {
    for (const bad of ['0', '11', '1.5', 'abc', '', 'Infinity', 'NaN', '1e3']) {
      assert.throws(
        () => assertValidInteger(bad, { name: 'page', min: 1, max: 10 }),
        ValidationError,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  test('names the option in the error message', () => {
    assert.throws(
      () => assertValidInteger('abc', { name: 'page' }),
      (err) => err instanceof ValidationError && err.message.includes('`page`'),
    );
  });
});

describe('assertOneOf', () => {
  test('matches case-insensitively and returns the canonical value', () => {
    assert.equal(assertOneOf('start', ['start', 'stop'], { name: 'action' }), 'start');
    assert.equal(assertOneOf('START', ['start', 'stop'], { name: 'action' }), 'start');
  });

  test('rejects a value outside the list and enumerates the options', () => {
    assert.throws(
      () => assertOneOf('kill', ['start', 'stop'], { name: 'action' }),
      (err) => err instanceof ValidationError && err.message.includes('start, stop'),
    );
    assert.throws(() => assertOneOf('start', [], { name: 'action' }), ValidationError);
  });
});

describe('sanitiseForDisplay', () => {
  test('neutralises mention syntax without discarding the text', () => {
    /**
     * Display-only sanitisation, for panel-supplied values that never passed through the
     * strict validators. A server renamed directly in the panel can contain anything.
     */
    assert.ok(!sanitiseForDisplay('@everyone').includes('@everyone'));
    assert.ok(!sanitiseForDisplay('@here').includes('@here'));
    assert.ok(sanitiseForDisplay('@everyone').includes('everyone'), 'the text should survive, defanged');

    const mention = sanitiseForDisplay('<@123456789012345678>');
    assert.ok(mention.includes('\u200b'), 'a zero-width space should break the mention');
  });

  test('strips markdown control characters', () => {
    assert.equal(sanitiseForDisplay('**bold**'), 'bold');
    assert.equal(sanitiseForDisplay('`code`'), 'code');
    assert.equal(sanitiseForDisplay('~~strike~~'), 'strike');
    assert.equal(sanitiseForDisplay('a\\b'), 'ab');
  });

  test('strips control and zero-width characters', () => {
    assert.equal(sanitiseForDisplay('a\u0000b'), 'ab');
    assert.equal(sanitiseForDisplay('a\u200bb'), 'ab');
    assert.equal(sanitiseForDisplay('a\u202eb'), 'ab');
  });

  test('truncates to the requested length', () => {
    const long = 'x'.repeat(500);
    assert.ok(sanitiseForDisplay(long, 64).length <= 64);
    assert.ok(sanitiseForDisplay(long, 64).endsWith('…'));
    assert.equal(sanitiseForDisplay('short', 64), 'short');
  });

  test('tolerates non-string input', () => {
    // Called on panel data, which may be null or absent.
    assert.equal(sanitiseForDisplay(null), '');
    assert.equal(sanitiseForDisplay(undefined), '');
    assert.equal(sanitiseForDisplay(42), '42');
    assert.equal(sanitiseForDisplay({}), '');
  });
});

describe('parseSnowflakeList', () => {
  test('parses a comma-separated list', () => {
    assert.deepEqual([...parseSnowflakeList('123456789012345678,987654321098765432', 'ADMIN_USER_IDS')], [
      '123456789012345678',
      '987654321098765432',
    ]);
  });

  test('tolerates whitespace and empty entries', () => {
    assert.deepEqual([...parseSnowflakeList('  123456789012345678 , , 987654321098765432 ,', 'X')], [
      '123456789012345678',
      '987654321098765432',
    ]);
  });

  test('returns an empty frozen list for empty input', () => {
    const empty = parseSnowflakeList('', 'X');
    assert.deepEqual([...empty], []);
    assert.equal(Object.isFrozen(empty), true);

    assert.deepEqual([...parseSnowflakeList(undefined, 'X')], []);
    assert.deepEqual([...parseSnowflakeList(null, 'X')], []);
  });

  test('deduplicates', () => {
    assert.deepEqual([...parseSnowflakeList('123456789012345678,123456789012345678', 'X')], [
      '123456789012345678',
    ]);
  });

  test('throws on a malformed entry, naming the variable', () => {
    /**
     * A typo in ADMIN_USER_IDS must fail at startup. Silently dropping the bad entry would
     * grant admin access to nobody, which presents as a mysterious permission failure.
     */
    assert.throws(
      () => parseSnowflakeList('123456789012345678,nope', 'ADMIN_USER_IDS'),
      (err) => err instanceof ValidationError && err.message.includes('ADMIN_USER_IDS') && err.message.includes('nope'),
    );
  });
});

describe('bounds are exported for reuse', () => {
  test('the server name bounds match what the command definitions declare', () => {
    /**
     * server rename imports these for its option minLength and maxLength. If they drifted,
     * Discord would accept a value the validator then rejects.
     */
    assert.equal(SERVER_NAME_MIN, 3);
    assert.equal(SERVER_NAME_MAX, 32);
  });
});
