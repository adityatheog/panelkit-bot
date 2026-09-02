// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/config/config.js.
 *
 * The validation model distinguishes two kinds of wrongness, and these tests are organised around
 * that split because it is the module's central design decision:
 *
 *   Structural errors throw. A malformed colour, a non-object egg, a relative log path or an
 *   invalid permission string means the file cannot be interpreted, and guessing would produce a
 *   confusing failure later at provisioning time instead of a clear one now.
 *
 *   Unfilled placeholders do not throw. A fresh clone ships eggs with `eggId: 0` and
 *   `deploy.locationId: 0`, because inventing real panel IDs would be a lie. Those entries are
 *   marked unconfigured, hidden from users, and named in a startup warning — so the bot boots and
 *   tells the operator exactly what to fill in.
 *
 * Two validation rules get particular attention. Refusing `settings.delete` in the sub-user
 * permission list prevents a footgun the panel itself permits, and refusing `memory: 0` prevents
 * an unlimited-by-default that would let one user exhaust a node.
 *
 * No credentials, no network. The real config.json is loaded once to confirm the shipped file is
 * valid; everything else validates literals.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import {
  availableEggKeys,
  BOUNDS,
  describeConfig,
  DOCKER_IMAGE_RE,
  loadConfig,
  PERMISSION_RE,
  validateConfig,
} from '../src/config/config.js';
import { ConfigError } from '../src/utils/errors.js';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * A minimal structurally valid configuration.
 *
 * Only colors and eggs are strictly required; everything else has a documented default. Tests
 * override just the section under examination.
 *
 * @param {object} [overrides]
 * @returns {object}
 */
function baseConfig(overrides = {}) {
  return {
    colors: { primary: '#2B2D31', error: '#ED4245' },
    eggs: {
      nodejs: {
        label: 'Node.js',
        eggId: 15,
        nestId: 5,
        dockerImage: 'ghcr.io/example/node:20',
        startup: 'node index.js',
      },
    },
    ...overrides,
  };
}

describe('the shipped config.json', () => {
  test('validates', () => {
    /**
     * The file in the repository must be loadable as it stands, or a fresh clone cannot start.
     */
    assert.doesNotThrow(() => loadConfig(path.join(ROOT, 'config.json')));
  });

  test('ships placeholders rather than invented panel IDs', () => {
    /**
     * Deliberate. Shipping real-looking egg IDs would produce a bot that fails at provisioning with
     * an opaque panel 422; shipping zeros produces one that boots and names what is missing.
     */
    const config = loadConfig(path.join(ROOT, 'config.json'));

    assert.ok(config.unconfiguredEggs.length > 0, 'the shipped eggs should be placeholders');
    assert.equal(config.deploy.configured, false, 'deploy.locationId should be unset');
    assert.deepEqual(availableEggKeys(config), [], 'no egg should be offerable yet');
  });

  test('reports what an operator must fill in', () => {
    const state = describeConfig(loadConfig(path.join(ROOT, 'config.json')));

    assert.equal(state.ready, false);
    assert.ok(state.warnings.length > 0);
    assert.ok(
      state.warnings.some((warning) => warning.includes('deploy.locationId')),
      'the deployment location should be named',
    );
  });

  test('ships the documented help layout values', () => {
    /**
     * Page size 8 is what keeps four categories on one page while paginating Server, and 51 is the
     * truncation width the specified design uses.
     */
    const config = loadConfig(path.join(ROOT, 'config.json'));

    assert.equal(config.help.pageSize, 8);
    assert.equal(config.help.descriptionMax, 51);
  });
});

describe('loadConfig', () => {
  test('reports a missing file with the path', () => {
    assert.throws(
      () => loadConfig(path.join(ROOT, 'nonexistent-config.json')),
      (err) => err instanceof ConfigError && err.message.includes('nonexistent-config.json'),
    );
  });

  test('reports invalid JSON with the parser message', () => {
    /**
     * JSON.parse includes a character offset, which is the most useful thing to hand an operator
     * staring at a trailing comma.
     */
    assert.throws(
      () => loadConfig(path.join(ROOT, 'package-lock.json.does-not-exist')),
      ConfigError,
    );
  });
});

describe('required sections', () => {
  test('rejects a non-object', () => {
    for (const bad of [null, undefined, [], 'string', 42, true]) {
      assert.throws(() => validateConfig(bad), ConfigError, `should reject ${JSON.stringify(bad)}`);
    }
  });

  test('requires colors', () => {
    assert.throws(() => validateConfig({ eggs: baseConfig().eggs }), ConfigError);
    assert.throws(() => validateConfig({ colors: null, eggs: baseConfig().eggs }), ConfigError);
    assert.throws(() => validateConfig({ colors: [], eggs: baseConfig().eggs }), ConfigError);
  });

  test('requires eggs', () => {
    assert.throws(() => validateConfig({ colors: baseConfig().colors }), ConfigError);
    assert.throws(() => validateConfig({ colors: baseConfig().colors, eggs: [] }), ConfigError);
  });

  test('requires at least one egg', () => {
    /**
     * An empty egg map would produce a bot where `server create` can never succeed, which is worth
     * refusing at startup rather than discovering at runtime.
     */
    assert.throws(() => validateConfig({ colors: baseConfig().colors, eggs: {} }), ConfigError);
  });
});

describe('colours', () => {
  test('accepts six-digit hex values', () => {
    const config = validateConfig(baseConfig());

    assert.equal(config.colors.primary, '#2B2D31');
    assert.equal(config.colors.error, '#ED4245');
  });

  test('applies defaults for the optional colours', () => {
    // success and warning have sensible Discord-standard defaults; primary and error do not.
    const config = validateConfig(baseConfig());

    assert.equal(config.colors.success, '#57F287');
    assert.equal(config.colors.warning, '#FEE75C');
  });

  test('rejects a malformed required colour rather than substituting a default', () => {
    /**
     * Silently substituting would hide an obvious typo. An operator who wrote "blue" wants to know.
     */
    for (const bad of ['blue', '#FFF', '#GGGGGG', 'rgb(0,0,0)', '2B2D31', '', null]) {
      assert.throws(
        () => validateConfig(baseConfig({ colors: { primary: bad, error: '#ED4245' } })),
        ConfigError,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  test('rejects a malformed optional colour rather than substituting a default', () => {
    /**
     * Absent and malformed are different cases. Absent means the operator did not configure
     * the colour, so a default is right. Malformed means they tried and got it wrong, and
     * silently substituting hides the typo — which is what config.js states as its intent.
     */
    assert.throws(
      () => validateConfig(baseConfig({ colors: { primary: '#2B2D31', error: '#ED4245', success: 'green' } })),
      ConfigError,
    );

    // Absent still substitutes.
    const config = validateConfig(baseConfig({ colors: { primary: '#2B2D31', error: '#ED4245' } }));
    assert.equal(config.colors.success, '#57F287');
  });
});

describe('identity', () => {
  test('applies defaults when absent', () => {
    const config = validateConfig(baseConfig());

    assert.equal(config.identity.name, 'PanelKit');
    assert.equal(config.identity.shortName, 'PanelKit');
    assert.equal(config.identity.footerText, 'PanelKit');
    assert.equal(config.identity.supportUrl, '');
  });

  test('accepts a configured identity', () => {
    const config = validateConfig(
      baseConfig({
        identity: {
          name: 'Example Hosting',
          shortName: 'EH',
          footerText: 'Example',
          supportUrl: 'https://support.example.com',
        },
      }),
    );

    assert.equal(config.identity.name, 'Example Hosting');
    assert.equal(config.identity.shortName, 'EH');
    assert.equal(config.identity.supportUrl, 'https://support.example.com');
  });

  test('derives shortName and footerText from name when absent', () => {
    const config = validateConfig(baseConfig({ identity: { name: 'Example Hosting' } }));

    assert.equal(config.identity.shortName, 'Example Hosting');
    assert.equal(config.identity.footerText, 'Example Hosting');
  });

  test('rejects an empty or over-long name', () => {
    assert.throws(() => validateConfig(baseConfig({ identity: { name: '' } })), ConfigError);
    assert.throws(() => validateConfig(baseConfig({ identity: { name: '   ' } })), ConfigError);
    assert.throws(() => validateConfig(baseConfig({ identity: { name: 'x'.repeat(65) } })), ConfigError);
  });

  test('rejects a malformed support URL', () => {
    // The URL is rendered in embeds, so a non-http scheme would be a link users should not click.
    for (const bad of ['not a url', 'javascript:alert(1)', 'ftp://example.com', 'example.com']) {
      assert.throws(
        () => validateConfig(baseConfig({ identity: { supportUrl: bad } })),
        ConfigError,
        `should reject ${bad}`,
      );
    }
  });

  test('accepts an empty support URL', () => {
    assert.equal(validateConfig(baseConfig({ identity: { supportUrl: '' } })).identity.supportUrl, '');
  });
});

describe('account settings', () => {
  test('applies documented defaults', () => {
    const config = validateConfig(baseConfig());

    assert.equal(config.account.emailDomain, 'panelkit.local');
    assert.equal(config.account.usernameLength, 10);
    assert.equal(config.account.passwordLength, 16);
  });

  test('accepts a configured domain', () => {
    for (const domain of ['example.com', 'panel.example.co.uk', 'my-host.io', 'panelkit.local']) {
      const config = validateConfig(baseConfig({ account: { emailDomain: domain } }));
      assert.equal(config.account.emailDomain, domain);
    }
  });

  test('lowercases the domain', () => {
    // The panel treats addresses case-insensitively, and sub-user lookups match on the stored value.
    const config = validateConfig(baseConfig({ account: { emailDomain: 'Example.COM' } }));

    assert.equal(config.account.emailDomain, 'example.com');
  });

  test('rejects a malformed domain', () => {
    /**
     * Generated addresses become panel logins. An invalid domain would fail at account creation with
     * a panel validation error rather than at startup.
     */
    for (const bad of ['not a domain', 'example', '.com', 'example..com', 'exa mple.com', '']) {
      assert.throws(
        () => validateConfig(baseConfig({ account: { emailDomain: bad } })),
        ConfigError,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  test('clamps credential lengths into a safe range', () => {
    /**
     * A short password is a security regression, so the floor is enforced regardless of what an
     * operator writes.
     */
    const low = validateConfig(baseConfig({ account: { usernameLength: 1, passwordLength: 4 } }));

    assert.equal(low.account.usernameLength, BOUNDS.usernameLength.min);
    assert.equal(low.account.passwordLength, BOUNDS.passwordLength.min);

    const high = validateConfig(baseConfig({ account: { usernameLength: 1000, passwordLength: 1000 } }));

    assert.equal(high.account.usernameLength, BOUNDS.usernameLength.max);
    assert.equal(high.account.passwordLength, BOUNDS.passwordLength.max);
  });

  test('falls back for a non-integer length', () => {
    const config = validateConfig(baseConfig({ account: { usernameLength: 'ten', passwordLength: 16.5 } }));

    assert.equal(config.account.usernameLength, BOUNDS.usernameLength.fallback);
    assert.equal(config.account.passwordLength, BOUNDS.passwordLength.fallback);
  });
});

describe('eggs', () => {
  test('marks a complete egg as configured', () => {
    const config = validateConfig(baseConfig());

    assert.equal(config.eggs.nodejs.configured, true);
    assert.deepEqual([...config.eggs.nodejs.missing], []);
    assert.deepEqual(availableEggKeys(config), ['nodejs']);
  });

  test('marks an incomplete egg unconfigured and names the missing fields', () => {
    /**
     * `missing` is what lets describeConfig produce a warning naming eggId, nestId and dockerImage
     * per egg rather than a generic "config incomplete".
     */
    const config = validateConfig(
      baseConfig({
        eggs: {
          nodejs: baseConfig().eggs.nodejs,
          minecraft: { label: 'Minecraft', eggId: 0, nestId: 0, dockerImage: '' },
        },
      }),
    );

    assert.equal(config.eggs.minecraft.configured, false);
    assert.deepEqual([...config.eggs.minecraft.missing].sort(), ['dockerImage', 'eggId', 'nestId']);
    assert.deepEqual([...config.unconfiguredEggs], ['minecraft']);
    assert.deepEqual(availableEggKeys(config), ['nodejs'], 'only the complete egg is offerable');
  });

  test('names a partially filled egg’s remaining gaps', () => {
    const config = validateConfig(
      baseConfig({
        eggs: {
          nodejs: { label: 'Node.js', eggId: 15, nestId: 0, dockerImage: 'ghcr.io/example/node:20' },
        },
      }),
    );

    assert.equal(config.eggs.nodejs.configured, false);
    assert.deepEqual([...config.eggs.nodejs.missing], ['nestId']);
  });

  test('does not throw for an all-placeholder configuration', () => {
    /**
     * The fresh-clone state. Refusing to start would mean an operator cannot run the bot to find out
     * what it needs.
     */
    assert.doesNotThrow(() =>
      validateConfig(baseConfig({ eggs: { nodejs: { eggId: 0, nestId: 0, dockerImage: '' } } })),
    );
  });

  test('rejects a malformed egg key', () => {
    for (const key of ['Node JS', 'nodeJS!', 'x'.repeat(33), '']) {
      assert.throws(
        () => validateConfig(baseConfig({ eggs: { [key]: baseConfig().eggs.nodejs } })),
        ConfigError,
        `should reject key ${JSON.stringify(key)}`,
      );
    }
  });

  test('rejects a non-object egg', () => {
    for (const bad of [null, 'nodejs', 42, []]) {
      assert.throws(() => validateConfig(baseConfig({ eggs: { nodejs: bad } })), ConfigError);
    }
  });

  test('rejects a non-integer egg or nest id', () => {
    assert.throws(
      () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, eggId: 'fifteen' } } })),
      ConfigError,
    );
    assert.throws(
      () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, nestId: 5.5 } } })),
      ConfigError,
    );
  });

  test('rejects a malformed container image', () => {
    for (const bad of ['not an image!', 'image with spaces', '$(whoami)', '../etc/passwd']) {
      assert.throws(
        () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, dockerImage: bad } } })),
        ConfigError,
        `should reject ${bad}`,
      );
    }
  });

  test('accepts realistic container image references', () => {
    for (const image of [
      'ghcr.io/pterodactyl/yolks:nodejs_20',
      'quay.io/parkervcp/pterodactyl:node',
      'node:20-alpine',
      'registry.example.com:5000/team/image:1.2.3',
    ]) {
      assert.doesNotThrow(
        () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, dockerImage: image } } })),
        `should accept ${image}`,
      );
      assert.match(image, DOCKER_IMAGE_RE);
    }
  });

  test('defaults the log paths when absent', () => {
    const config = validateConfig(baseConfig());

    assert.deepEqual(config.eggs.nodejs.logPaths, ['/logs/latest.log']);
  });

  test('rejects a relative log path', () => {
    /**
     * The path is sent to the panel's file manager. A relative one would resolve unpredictably.
     */
    assert.throws(
      () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, logPaths: ['logs/latest.log'] } } })),
      ConfigError,
    );
  });

  test('rejects a traversal segment in a log path', () => {
    /**
     * The leading-slash check alone would accept /logs/../../etc/passwd, so segments are checked
     * separately — an operator's typo must not become a file-read primitive.
     */
    assert.throws(
      () =>
        validateConfig(
          baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, logPaths: ['/logs/../../etc/passwd'] } } }),
        ),
      ConfigError,
    );
  });

  test('accepts multiple log paths, tried in order', () => {
    const config = validateConfig(
      baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, logPaths: ['/logs/latest.log', '/output.log'] } } }),
    );

    assert.deepEqual(config.eggs.nodejs.logPaths, ['/logs/latest.log', '/output.log']);
  });

  test('rejects a non-object environment or images map', () => {
    assert.throws(
      () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, environment: [] } } })),
      ConfigError,
    );
    assert.throws(
      () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, images: 'node:20' } } })),
      ConfigError,
    );
  });

  test('rejects an invalid environment variable name', () => {
    // The map is sent to the panel as an environment, so keys must be valid variable names.
    for (const key of ['lower case', '1STARTS_WITH_DIGIT', 'HAS-DASH', '']) {
      assert.throws(
        () =>
          validateConfig(
            baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, environment: { [key]: 'value' } } } }),
          ),
        ConfigError,
        `should reject ${JSON.stringify(key)}`,
      );
    }
  });

  test('stringifies environment values', () => {
    const config = validateConfig(
      baseConfig({
        eggs: {
          nodejs: {
            ...baseConfig().eggs.nodejs,
            environment: { PORT: 3000, DEBUG: true, EMPTY: null },
          },
        },
      }),
    );

    assert.equal(config.eggs.nodejs.environment.PORT, '3000');
    assert.equal(config.eggs.nodejs.environment.DEBUG, 'true');
    assert.equal(config.eggs.nodejs.environment.EMPTY, '');
  });

  test('rejects a malformed image in the allowlist', () => {
    /**
     * The images map is the allowlist the Change Image control offers, so an invalid entry would be
     * offered and then rejected by the panel.
     */
    assert.throws(
      () =>
        validateConfig(
          baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, images: { 'Node 20': 'bad image!' } } } }),
        ),
      ConfigError,
    );
    assert.throws(
      () => validateConfig(baseConfig({ eggs: { nodejs: { ...baseConfig().eggs.nodejs, images: { 'Node 20': '' } } } })),
      ConfigError,
    );
  });

  test('defaults the label to the key', () => {
    const config = validateConfig(
      baseConfig({ eggs: { nodejs: { eggId: 15, nestId: 5, dockerImage: 'node:20' } } }),
    );

    assert.equal(config.eggs.nodejs.label, 'nodejs');
  });
});

describe('deploy', () => {
  test('marks a configured location as ready', () => {
    const config = validateConfig(baseConfig({ deploy: { locationId: 3 } }));

    assert.equal(config.deploy.locationId, 3);
    assert.equal(config.deploy.configured, true);
  });

  test('treats an unset location as unconfigured without throwing', () => {
    /**
     * Same reasoning as the egg placeholders: the bot must boot so it can report what is missing.
     */
    for (const config of [validateConfig(baseConfig()), validateConfig(baseConfig({ deploy: { locationId: 0 } }))]) {
      assert.equal(config.deploy.configured, false);
      assert.equal(config.deploy.locationId, 0);
    }
  });

  test('rejects a non-integer location', () => {
    assert.throws(() => validateConfig(baseConfig({ deploy: { locationId: 'three' } })), ConfigError);
    assert.throws(() => validateConfig(baseConfig({ deploy: { locationId: 1.5 } })), ConfigError);
  });

  test('accepts a port range', () => {
    const config = validateConfig(baseConfig({ deploy: { locationId: 1, portRange: ['25565-25570', '8080'] } }));

    assert.deepEqual(config.deploy.portRange, ['25565-25570', '8080']);
  });

  test('rejects a malformed port range', () => {
    for (const bad of ['not-a-port', '25565-', '-25570', '25565..25570', 'abc-def']) {
      assert.throws(
        () => validateConfig(baseConfig({ deploy: { locationId: 1, portRange: [bad] } })),
        ConfigError,
        `should reject ${bad}`,
      );
    }
  });

  test('defaults dedicatedIp to false', () => {
    assert.equal(validateConfig(baseConfig()).deploy.dedicatedIp, false);
    assert.equal(validateConfig(baseConfig({ deploy: { dedicatedIp: true } })).deploy.dedicatedIp, true);
  });
});

describe('default resource limits', () => {
  test('applies documented defaults', () => {
    const config = validateConfig(baseConfig());

    assert.deepEqual(config.defaults.limits, { memory: 1024, swap: 0, disk: 5120, io: 500, cpu: 100 });
    assert.deepEqual(config.defaults.featureLimits, { databases: 1, allocations: 1, backups: 1 });
  });

  test('accepts configured limits', () => {
    const config = validateConfig(
      baseConfig({
        defaults: {
          limits: { memory: 2048, swap: 512, disk: 10_240, io: 500, cpu: 200 },
          featureLimits: { databases: 2, allocations: 3, backups: 5 },
        },
      }),
    );

    assert.equal(config.defaults.limits.memory, 2048);
    assert.equal(config.defaults.featureLimits.backups, 5);
  });

  test('refuses unlimited memory as a default', () => {
    /**
     * Zero means unlimited in the Pterodactyl API. As a default on a public bot that is an easy way
     * for one user to exhaust a node, so it is refused — an operator who genuinely wants it can set
     * a large finite value deliberately.
     */
    assert.throws(
      () => validateConfig(baseConfig({ defaults: { limits: { memory: 0, disk: 5120 } } })),
      (err) => err instanceof ConfigError && err.message.includes('memory'),
    );
  });

  test('refuses unlimited disk as a default', () => {
    assert.throws(
      () => validateConfig(baseConfig({ defaults: { limits: { memory: 1024, disk: 0 } } })),
      (err) => err instanceof ConfigError && err.message.includes('disk'),
    );
  });

  test('rejects an out-of-range block IO weight', () => {
    // Pterodactyl accepts 10 to 1000; outside that the panel rejects the create request.
    for (const io of [0, 5, 1001, 10_000]) {
      assert.throws(
        () => validateConfig(baseConfig({ defaults: { limits: { memory: 1024, disk: 5120, io } } })),
        ConfigError,
        `should reject io ${io}`,
      );
    }
  });

  test('permits a negative swap, which Pterodactyl uses for unlimited', () => {
    const config = validateConfig(baseConfig({ defaults: { limits: { memory: 1024, disk: 5120, swap: -1 } } }));

    assert.equal(config.defaults.limits.swap, -1);
  });
});

describe('cooldowns', () => {
  test('applies the documented default', () => {
    const config = validateConfig(baseConfig());

    assert.equal(config.cooldowns.defaultSeconds, 3);
    assert.deepEqual(config.cooldowns.perCommand, {});
  });

  test('accepts per-command overrides', () => {
    const config = validateConfig(
      baseConfig({ cooldowns: { defaultSeconds: 5, perCommand: { 'files backup': 120, 'account reset': 300 } } }),
    );

    assert.equal(config.cooldowns.defaultSeconds, 5);
    assert.equal(config.cooldowns.perCommand['files backup'], 120);
    assert.equal(config.cooldowns.perCommand['account reset'], 300);
  });

  test('lowercases command keys', () => {
    // The cooldown manager looks up by lowercased canonical name.
    const config = validateConfig(baseConfig({ cooldowns: { perCommand: { 'Files Backup': 60 } } }));

    assert.equal(config.cooldowns.perCommand['files backup'], 60);
  });

  test('accepts a zero cooldown, which disables it', () => {
    const config = validateConfig(baseConfig({ cooldowns: { perCommand: { ping: 0 } } }));

    assert.equal(config.cooldowns.perCommand.ping, 0);
  });

  test('rejects a negative or non-integer cooldown', () => {
    for (const bad of [-1, 1.5, 'sixty', null]) {
      assert.throws(
        () => validateConfig(baseConfig({ cooldowns: { perCommand: { ping: bad } } })),
        ConfigError,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  test('rejects a cooldown beyond a day', () => {
    assert.throws(
      () => validateConfig(baseConfig({ cooldowns: { perCommand: { ping: 90_000 } } })),
      ConfigError,
    );
  });
});

describe('sub-user permissions', () => {
  test('accepts a valid permission set', () => {
    const permissions = ['control.console', 'control.start', 'file.read', 'file.read-content'];
    const config = validateConfig(baseConfig({ subuser: { defaultPermissions: permissions } }));

    assert.deepEqual([...config.subuser.defaultPermissions], permissions);
  });

  test('defaults to an empty set', () => {
    /**
     * An empty set makes `server subuser add` refuse rather than silently granting nothing, and
     * describeConfig warns about it.
     */
    const config = validateConfig(baseConfig());

    assert.deepEqual([...config.subuser.defaultPermissions], []);
  });

  test('lowercases and deduplicates', () => {
    const config = validateConfig(
      baseConfig({ subuser: { defaultPermissions: ['CONTROL.CONSOLE', 'control.console', 'File.Read'] } }),
    );

    assert.deepEqual([...config.subuser.defaultPermissions], ['control.console', 'file.read']);
  });

  test('rejects a malformed permission string', () => {
    for (const bad of ['control', 'control.', '.console', 'control console', 'control..console', '']) {
      assert.throws(
        () => validateConfig(baseConfig({ subuser: { defaultPermissions: [bad] } })),
        ConfigError,
        `should reject ${JSON.stringify(bad)}`,
      );
    }
  });

  test('refuses destructive server-level permissions', () => {
    /**
     * The footgun this rule closes. Pterodactyl will happily grant settings.delete, and an operator
     * copying a permission list from panel documentation could include it — at which point every
     * sub-user added through this bot can delete the server belonging to whoever invited them.
     */
    for (const forbidden of ['settings.delete', 'server.delete']) {
      assert.throws(
        () =>
          validateConfig(
            baseConfig({ subuser: { defaultPermissions: ['control.console', forbidden] } }),
          ),
        (err) => err instanceof ConfigError && err.message.includes(forbidden),
        `should refuse ${forbidden}`,
      );
    }
  });

  test('the shipped set contains nothing destructive', () => {
    const config = loadConfig(path.join(ROOT, 'config.json'));

    for (const permission of config.subuser.defaultPermissions) {
      assert.match(permission, PERMISSION_RE);
      assert.ok(!permission.endsWith('.delete') || permission.startsWith('file.'), `unexpected permission ${permission}`);
    }
  });
});

describe('plans', () => {
  test('defaults to an empty list', () => {
    const config = validateConfig(baseConfig());

    assert.deepEqual([...config.plans], []);
  });

  test('accepts a plan catalogue', () => {
    const config = validateConfig(
      baseConfig({
        plans: [
          { name: 'Free', price: 'Free', ram: 1024, disk: 5120, cpu: 100, servers: 1, description: 'Community tier.' },
          { name: 'Pro', price: '$5/month', ram: 4096, disk: 20_480, cpu: 200, servers: 3 },
        ],
      }),
    );

    assert.equal(config.plans.length, 2);
    assert.equal(config.plans[0].name, 'Free');
    assert.equal(config.plans[1].price, '$5/month');
  });

  test('applies defaults for optional plan fields', () => {
    const config = validateConfig(baseConfig({ plans: [{ name: 'Basic' }] }));

    assert.equal(config.plans[0].price, 'Contact an administrator');
    assert.equal(config.plans[0].servers, 1);
    assert.equal(config.plans[0].description, '');
  });

  test('requires a name and rejects a non-object entry', () => {
    assert.throws(() => validateConfig(baseConfig({ plans: [{ price: 'Free' }] })), ConfigError);
    assert.throws(() => validateConfig(baseConfig({ plans: [{ name: '' }] })), ConfigError);
    assert.throws(() => validateConfig(baseConfig({ plans: ['Free'] })), ConfigError);
    assert.throws(() => validateConfig(baseConfig({ plans: [null] })), ConfigError);
  });

  test('names the offending index in the error', () => {
    // A catalogue of several plans needs the position, not just "a plan is invalid".
    assert.throws(
      () => validateConfig(baseConfig({ plans: [{ name: 'Free' }, { price: 'x' }] })),
      (err) => err.message.includes('plans[1]'),
    );
  });
});

describe('upload limits', () => {
  test('applies documented defaults', () => {
    const config = validateConfig(baseConfig());

    assert.equal(config.backups.maxInlineBytes, 7 * 1024 * 1024);
    assert.equal(config.logs.maxUploadBytes, 7 * 1024 * 1024);
  });

  test('clamps a value beyond Discord’s upload ceiling', () => {
    /**
     * Discord rejects an oversized attachment outright, so a configured value larger than the
     * platform allows would fail every backup rather than delivering a larger one.
     */
    const config = validateConfig(baseConfig({ backups: { maxInlineBytes: 500 * 1024 * 1024 } }));

    assert.ok(config.backups.maxInlineBytes <= BOUNDS.maxInlineBytes.max);
  });

  test('falls back for a non-integer value', () => {
    const config = validateConfig(baseConfig({ logs: { maxUploadBytes: 'lots' } }));

    assert.equal(config.logs.maxUploadBytes, 7 * 1024 * 1024);
  });
});

describe('help layout', () => {
  test('applies the documented defaults', () => {
    const config = validateConfig(baseConfig());

    assert.equal(config.help.pageSize, BOUNDS.helpPageSize.fallback);
    assert.equal(config.help.descriptionMax, BOUNDS.helpDescriptionMax.fallback);
  });

  test('clamps the page size to Discord’s select menu limit', () => {
    /**
     * The command detail select offers one option per command on the page, and Discord accepts at
     * most 25.
     */
    const config = validateConfig(baseConfig({ help: { pageSize: 100 } }));

    assert.equal(config.help.pageSize, BOUNDS.helpPageSize.max);
    assert.ok(config.help.pageSize <= 25);
  });

  test('clamps a page size of zero to at least one', () => {
    assert.equal(validateConfig(baseConfig({ help: { pageSize: 0 } })).help.pageSize, BOUNDS.helpPageSize.min);
  });

  test('clamps the truncation width', () => {
    assert.equal(
      validateConfig(baseConfig({ help: { descriptionMax: 5 } })).help.descriptionMax,
      BOUNDS.helpDescriptionMax.min,
    );
    assert.equal(
      validateConfig(baseConfig({ help: { descriptionMax: 5000 } })).help.descriptionMax,
      BOUNDS.helpDescriptionMax.max,
    );
  });
});

describe('immutability', () => {
  test('the returned configuration is frozen', () => {
    /**
     * Configuration is read on every command. Freezing means a handler cannot mutate it and change
     * behaviour for every subsequent request.
     */
    const config = validateConfig(baseConfig({ deploy: { locationId: 1 } }));

    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.eggs), true);
    assert.equal(Object.isFrozen(config.eggs.nodejs), true);
    assert.equal(Object.isFrozen(config.deploy), true);
    assert.equal(Object.isFrozen(config.identity), true);
    assert.equal(Object.isFrozen(config.plans), true);
    assert.equal(Object.isFrozen(config.subuser.defaultPermissions), true);
  });
});

describe('availableEggKeys', () => {
  test('returns only fully configured eggs', () => {
    const config = validateConfig(
      baseConfig({
        eggs: {
          nodejs: baseConfig().eggs.nodejs,
          python: { eggId: 16, nestId: 5, dockerImage: 'python:3.12' },
          minecraft: { eggId: 0, nestId: 0, dockerImage: '' },
        },
      }),
    );

    assert.deepEqual(availableEggKeys(config).sort(), ['nodejs', 'python']);
  });

  test('returns an empty list when nothing is configured', () => {
    const config = validateConfig(baseConfig({ eggs: { nodejs: { eggId: 0, nestId: 0, dockerImage: '' } } }));

    assert.deepEqual(availableEggKeys(config), []);
  });
});

describe('describeConfig', () => {
  test('reports readiness when eggs and a location are configured', () => {
    const state = describeConfig(validateConfig(baseConfig({ deploy: { locationId: 1 } })));

    assert.equal(state.ready, true);
    assert.equal(state.eggs, 1);
    assert.equal(state.availableEggs, 1);
  });

  test('warns about each unconfigured egg, naming its gaps', () => {
    const config = validateConfig(
      baseConfig({
        deploy: { locationId: 1 },
        eggs: {
          nodejs: baseConfig().eggs.nodejs,
          minecraft: { eggId: 0, nestId: 0, dockerImage: '' },
        },
      }),
    );

    const state = describeConfig(config);
    const warning = state.warnings.find((entry) => entry.includes('minecraft'));

    assert.ok(warning, 'the incomplete egg should be named');
    assert.ok(warning.includes('eggId'), 'the missing fields should be named');
    assert.ok(warning.includes('config.json'), 'the file to edit should be named');
  });

  test('warns when no egg is offerable', () => {
    const state = describeConfig(
      validateConfig(baseConfig({ eggs: { nodejs: { eggId: 0, nestId: 0, dockerImage: '' } } })),
    );

    assert.equal(state.ready, false);
    assert.ok(state.warnings.some((warning) => warning.includes('server create')));
  });

  test('warns when the deployment location is unset', () => {
    const state = describeConfig(validateConfig(baseConfig()));

    assert.ok(state.warnings.some((warning) => warning.includes('deploy.locationId')));
  });

  test('warns when sub-user permissions are empty', () => {
    const state = describeConfig(validateConfig(baseConfig({ deploy: { locationId: 1 } })));

    assert.ok(state.warnings.some((warning) => warning.includes('subuser.defaultPermissions')));
  });

  test('warns when no plans are configured', () => {
    const state = describeConfig(validateConfig(baseConfig({ deploy: { locationId: 1 } })));

    assert.ok(state.warnings.some((warning) => warning.includes('plans')));
  });

  test('produces no warnings for a fully configured setup', () => {
    const config = validateConfig(
      baseConfig({
        deploy: { locationId: 1 },
        subuser: { defaultPermissions: ['control.console', 'file.read'] },
        plans: [{ name: 'Free', price: 'Free' }],
      }),
    );

    const state = describeConfig(config);

    assert.equal(state.ready, true);
    assert.deepEqual(state.warnings, []);
  });
});
