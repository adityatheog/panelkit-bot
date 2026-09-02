// Coded by Aditya | GitHub- @adityatheog

/**
 * Tests for src/help/helpMenu.js.
 *
 * The help menu has a specified visual design, and these tests assert it character by
 * character rather than checking that rendering succeeded. That precision is deliberate: the
 * layout is a contract, and a change to truncation width or bullet format would otherwise pass
 * silently while producing a different menu than the one specified.
 *
 * Four properties are pinned:
 *
 *   The exact rendered strings. Title, header line, command lines and footer are compared to
 *   literals, so a reformatting change fails here with a visible diff.
 *
 *   Pagination behaviour. Account fits one page and shows no buttons; Server needs two and
 *   shows Previous and Next with the unavailable direction disabled. Page size 8 is the value
 *   that produces exactly that split.
 *
 *   Component structure. Two select menus with the specified placeholders, in the specified
 *   order, with pagination below both — and every custom id session-scoped, since that is what
 *   prevents a stale component from acting.
 *
 *   Graceful degradation. An unknown category and an out-of-range page are clamped rather than
 *   throwing, because both can arrive from a menu on a message that outlived a restart.
 *
 * No credentials, no network. The real command definitions are loaded from disk.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { describe } from 'node:test';

import { loadRegistry } from '../src/commands/registry.js';
import {
  buildCommandDetailView,
  buildCommandLines,
  buildFooterText,
  buildHeaderLine,
  buildHelpView,
  CATEGORY_PLACEHOLDER,
  COMMAND_PLACEHOLDER,
  commandsForPage,
  DEFAULT_DESCRIPTION_MAX,
  DEFAULT_PAGE_SIZE,
  HELP_NS,
  MAX_SELECT_OPTIONS,
  pageCount,
  prefixForm,
  slashForm,
  truncateDescription,
} from '../src/help/helpMenu.js';
import { LIMITS } from '../src/utils/embeds.js';

const SRC_DIR = path.resolve(import.meta.dirname, '..', 'src');

/** The documented default prefix. */
const PREFIX = 'kx!';

/** A fixed session id, so component custom ids are predictable. */
const SESSION = 'testsession';

/** Loaded once: importing every definition is the slowest part of this suite. */
const registry = await loadRegistry(SRC_DIR);

/**
 * Renders a view with the project's real configuration values.
 *
 * @param {string} categoryName
 * @param {number} [page]
 * @param {object} [overrides]
 * @returns {ReturnType<typeof buildHelpView>}
 */
function view(categoryName, page = 0, overrides = {}) {
  return buildHelpView({
    registry,
    prefix: PREFIX,
    categoryName,
    page,
    sessionId: SESSION,
    pageSize: DEFAULT_PAGE_SIZE,
    descriptionMax: DEFAULT_DESCRIPTION_MAX,
    ...overrides,
  });
}

/**
 * Extracts the component rows as plain JSON.
 *
 * @param {ReturnType<typeof buildHelpView>} rendered
 * @returns {object[]}
 */
function rows(rendered) {
  return rendered.components.map((row) => row.toJSON());
}

describe('truncateDescription', () => {
  test('leaves a description at or under the limit unchanged', () => {
    /**
     * No ellipsis is appended when nothing was cut. A description exactly at the limit must
     * render identically to a shorter one.
     */
    assert.equal(truncateDescription('Check the bot latency'), 'Check the bot latency');
    assert.equal(truncateDescription('x'.repeat(51), 51), 'x'.repeat(51));
    assert.equal(truncateDescription(''), '');
  });

  test('cuts to exactly the limit and appends three dots', () => {
    /**
     * The visible result is limit + 3 characters. Slicing to limit - 3 would keep the total at
     * the limit but produce a different string than the specified design, so the behaviour is
     * pinned rather than left to preference.
     */
    const result = truncateDescription('x'.repeat(60), 51);

    assert.equal(result.length, 54);
    assert.equal(result, `${'x'.repeat(51)}...`);
  });

  test('reproduces the specified truncated descriptions', () => {
    /**
     * These two are the design's own examples. If the truncation width drifted, the rendered
     * menu would no longer match the specification.
     */
    assert.equal(
      truncateDescription('Create a Pterodactyl panel account linked to your Discord account'),
      'Create a Pterodactyl panel account linked to your D...',
    );
    assert.equal(
      truncateDescription('Delete your Pterodactyl panel account and all associated servers'),
      'Delete your Pterodactyl panel account and all assoc...',
    );
  });

  test('trims surrounding whitespace before measuring', () => {
    assert.equal(truncateDescription('  padded  '), 'padded');
  });

  test('tolerates a missing description', () => {
    assert.equal(truncateDescription(null), '');
    assert.equal(truncateDescription(undefined), '');
  });

  test('falls back to the default limit for a nonsensical one', () => {
    assert.equal(truncateDescription('x'.repeat(60), 0).length, 54);
    assert.equal(truncateDescription('x'.repeat(60), NaN).length, 54);
  });
});

describe('pageCount', () => {
  test('computes pages for the configured page size', () => {
    assert.equal(pageCount(4, 8), 1, 'Account: four commands');
    assert.equal(pageCount(5, 8), 1, 'Admin: five commands');
    assert.equal(pageCount(8, 8), 1, 'exactly one full page');
    assert.equal(pageCount(9, 8), 2);
    assert.equal(pageCount(11, 8), 2, 'Server: eleven commands');
    assert.equal(pageCount(17, 8), 3);
  });

  test('never returns fewer than one page', () => {
    // An empty category must still render "Page 1 of 1" rather than "Page 1 of 0".
    assert.equal(pageCount(0, 8), 1);
    assert.equal(pageCount(-5, 8), 1);
  });

  test('falls back to the default page size for a nonsensical one', () => {
    assert.equal(pageCount(11, 0), 2);
    assert.equal(pageCount(11, NaN), 2);
  });
});

describe('commandsForPage', () => {
  const commands = Array.from({ length: 11 }, (_unused, index) => ({ name: `c${index}` }));

  test('slices the requested page', () => {
    assert.deepEqual(
      commandsForPage(commands, 0, 8).map((command) => command.name),
      ['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'],
    );
    assert.deepEqual(
      commandsForPage(commands, 1, 8).map((command) => command.name),
      ['c8', 'c9', 'c10'],
    );
  });

  test('returns an empty array for an out-of-range page', () => {
    // Clamping is buildHelpView's responsibility, not this function's.
    assert.deepEqual(commandsForPage(commands, 5, 8), []);
  });

  test('does not mutate the input', () => {
    commandsForPage(commands, 0, 8);
    assert.equal(commands.length, 11);
  });

  test('tolerates a missing list', () => {
    assert.deepEqual(commandsForPage(null, 0, 8), []);
    assert.deepEqual(commandsForPage(undefined, 0, 8), []);
  });
});

describe('buildHeaderLine', () => {
  test('reports counts and prefix in the specified format', () => {
    /**
     * The exact string from the design. Bullet separators and spacing are part of the contract.
     */
    assert.equal(buildHeaderLine({ registry, prefix: 'kx!' }), '24 commands • 5 categories • prefix: kx!');
  });

  test('reflects the configured prefix', () => {
    assert.equal(buildHeaderLine({ registry, prefix: '!' }), '24 commands • 5 categories • prefix: !');
    assert.equal(buildHeaderLine({ registry, prefix: 'bot ' }), '24 commands • 5 categories • prefix: bot ');
  });

  test('counts only visible commands', () => {
    /**
     * A hidden command retained for backwards compatibility must not inflate the number a user
     * sees, or the header would disagree with the menu below it.
     */
    assert.equal(registry.counts.commands, 24);
    assert.ok(registry.every.length >= registry.counts.commands);
  });
});

describe('buildFooterText', () => {
  test('renders one-based page numbers', () => {
    assert.equal(buildFooterText({ categoryName: 'Account', page: 0, pages: 1 }), 'Account • Page 1 of 1');
    assert.equal(buildFooterText({ categoryName: 'Server', page: 1, pages: 2 }), 'Server • Page 2 of 2');
  });
});

describe('buildCommandLines', () => {
  test('renders the specified bullet format', () => {
    /**
     * A bullet, the name in bold, an em dash, then the truncated description. Each element is
     * part of the design.
     */
    const lines = buildCommandLines([{ name: 'ping', description: 'Check the bot latency' }]);

    assert.deepEqual(lines, ['• **ping** — Check the bot latency']);
  });

  test('truncates long descriptions in the list', () => {
    const lines = buildCommandLines(
      [{ name: 'account create', description: 'Create a Pterodactyl panel account linked to your Discord account' }],
      51,
    );

    assert.deepEqual(lines, ['• **account create** — Create a Pterodactyl panel account linked to your D...']);
  });

  test('tolerates a missing list', () => {
    assert.deepEqual(buildCommandLines(null), []);
  });
});

describe('the category listing view', () => {
  test('uses the specified title', () => {
    assert.equal(view('Account').embed.data.title, 'Prefix Commands');
  });

  test('renders the header, a blank line, then one line per command', () => {
    /**
     * The full description compared line by line. This is the assertion that would fail if the
     * layout were reformatted.
     */
    const lines = view('Account').embed.data.description.split('\n');

    assert.equal(lines[0], '24 commands • 5 categories • prefix: kx!');
    assert.equal(lines[1], '');
    assert.equal(lines[2], '• **account create** — Create a Pterodactyl panel account linked to your D...');
    assert.equal(lines[3], '• **account delete** — Delete your Pterodactyl panel account and all assoc...');
    assert.equal(lines[4], '• **account info** — View your panel account details');
    assert.equal(lines[5], '• **account reset** — Reset your Pterodactyl panel account password');
    assert.equal(lines.length, 6, 'Account should render exactly four command lines');
  });

  test('renders the specified footer', () => {
    assert.equal(view('Account').embed.data.footer.text, 'Account • Page 1 of 1');
  });

  test('stays within the embed description limit', () => {
    // Page size bounds this, but the limit is asserted for every category regardless.
    for (const category of registry.categories) {
      for (let page = 0; page < pageCount(category.commands.length, DEFAULT_PAGE_SIZE); page += 1) {
        const rendered = view(category.name, page);

        assert.ok(
          rendered.embed.data.description.length <= LIMITS.description,
          `${category.name} page ${page} exceeds the description limit`,
        );
      }
    }
  });
});

describe('pagination', () => {
  test('single-page categories render two select menus and no buttons', () => {
    /**
     * The specified design omits the pagination row entirely for a one-page category, rather than
     * rendering both buttons disabled.
     */
    for (const name of ['Account', 'Admin', 'Files', 'General']) {
      const rendered = view(name);

      assert.equal(rendered.pages, 1, `${name} should fit one page`);
      assert.equal(rendered.components.length, 2, `${name} should render exactly two rows`);
    }
  });

  test('the Server category paginates with Previous and Next below both selects', () => {
    /**
     * Eleven commands at a page size of eight. Page size 8 is chosen precisely so that Server is
     * the only category that paginates.
     */
    const first = view('Server', 0);

    assert.equal(first.pages, 2);
    assert.equal(first.components.length, 3, 'two selects plus the pagination row');

    const [categoryRow, commandRow, buttonRow] = rows(first);

    assert.equal(categoryRow.components[0].type, 3, 'row 1 is a string select');
    assert.equal(commandRow.components[0].type, 3, 'row 2 is a string select');
    assert.equal(buttonRow.components[0].type, 2, 'row 3 is a button');

    assert.deepEqual(
      buttonRow.components.map((component) => component.label),
      ['Previous', 'Next'],
    );
  });

  test('disables the unavailable direction rather than hiding it', () => {
    /**
     * Both buttons always render so the row does not shift position as a user pages through.
     */
    const first = rows(view('Server', 0))[2].components;

    // paginationRow always calls setDisabled, so the key is present in the JSON either way —
    // discord.js does not omit it when false.
    assert.equal(first[0].disabled, true, 'Previous is disabled on the first page');
    assert.equal(first[1].disabled, false, 'Next is enabled on the first page');

    const last = rows(view('Server', 1))[2].components;

    assert.equal(last[0].disabled, false, 'Previous is enabled on the last page');
    assert.equal(last[1].disabled, true, 'Next is disabled on the last page');
  });

  test('the footer tracks the page', () => {
    assert.equal(view('Server', 0).embed.data.footer.text, 'Server • Page 1 of 2');
    assert.equal(view('Server', 1).embed.data.footer.text, 'Server • Page 2 of 2');
  });

  test('paging covers every command exactly once', () => {
    /**
     * The property that matters more than any individual page: no command is dropped between
     * pages or duplicated across them.
     */
    const expected = registry.category('Server').commands.map((command) => command.name);
    const seen = [];

    for (let page = 0; page < view('Server').pages; page += 1) {
      const lines = view('Server', page).embed.data.description.split('\n').slice(2);

      for (const line of lines) {
        const match = /\*\*(.+?)\*\*/.exec(line);
        if (match) seen.push(match[1]);
      }
    }

    assert.deepEqual(seen, expected);
    assert.equal(new Set(seen).size, expected.length, 'no duplicates across pages');
  });

  test('clamps an out-of-range page instead of rendering nothing', () => {
    /**
     * A page index can arrive from a message that outlived a configuration change, and repeated
     * Next presses accumulate in the session before the clamped value is written back.
     */
    const high = view('Server', 99);

    assert.equal(high.page, 1, 'clamped to the last page');
    assert.equal(high.embed.data.footer.text, 'Server • Page 2 of 2');

    const low = view('Server', -5);

    assert.equal(low.page, 0, 'clamped to the first page');
  });
});

describe('the category select menu', () => {
  test('uses the specified placeholder', () => {
    assert.equal(rows(view('Account'))[0].components[0].placeholder, CATEGORY_PLACEHOLDER);
    assert.equal(CATEGORY_PLACEHOLDER, 'Select a category');
  });

  test('lists every category with its command count', () => {
    const select = rows(view('Account'))[0].components[0];

    assert.deepEqual(
      select.options.map((option) => option.value),
      ['Account', 'Admin', 'Files', 'General', 'Server'],
    );

    const files = select.options.find((option) => option.value === 'Files');
    assert.equal(files.description, '1 command', 'singular for one command');

    const account = select.options.find((option) => option.value === 'Account');
    assert.equal(account.description, '4 commands', 'plural for several');
  });

  test('marks exactly the active category as default', () => {
    /**
     * Without this the menu would show its placeholder after a page change, losing the user's
     * sense of where they are.
     */
    const select = rows(view('Files'))[0].components[0];
    const defaults = select.options.filter((option) => option.default);

    assert.equal(defaults.length, 1);
    assert.equal(defaults[0].value, 'Files');
  });

  test("stays within Discord's option limit", () => {
    assert.ok(rows(view('Account'))[0].components[0].options.length <= MAX_SELECT_OPTIONS);
  });
});

describe('the command detail select menu', () => {
  test('uses the specified placeholder', () => {
    assert.equal(rows(view('Account'))[1].components[0].placeholder, COMMAND_PLACEHOLDER);
    assert.equal(COMMAND_PLACEHOLDER, 'Select a command to view details');
  });

  test('offers only the commands on the visible page', () => {
    /**
     * Keeping the menu aligned with the list above it also guarantees the option count cannot
     * exceed Discord's limit, since it is bounded by the page size.
     */
    const second = rows(view('Server', 1))[1].components[0];

    assert.deepEqual(
      second.options.map((option) => option.value),
      ['server subuser add', 'server subuser remove', 'server usage'],
    );
    assert.ok(second.options.length <= MAX_SELECT_OPTIONS);
  });

  test('carries the truncated description as the option description', () => {
    const select = rows(view('Account'))[1].components[0];
    const option = select.options.find((entry) => entry.value === 'account create');

    assert.ok(option.description.length <= 100, "must fit Discord's option description limit");
  });
});

describe('component custom ids', () => {
  test('every component is session-scoped', () => {
    /**
     * The session id is the final segment of every custom id, and the session store is what
     * authorises an action. A component without it could not be resolved, and one belonging to an
     * expired session resolves to nothing — which is how stale components are refused.
     */
    for (const name of ['Account', 'Server']) {
      for (const row of rows(view(name))) {
        for (const component of row.components) {
          assert.ok(component.custom_id, 'every component should carry a custom id');
          assert.ok(
            component.custom_id.endsWith(`:${SESSION}`),
            `${component.custom_id} is not session-scoped`,
          );
          assert.ok(component.custom_id.startsWith(`${HELP_NS}:`), `${component.custom_id} lacks the namespace`);
        }
      }
    }
  });

  test('uses distinct action segments', () => {
    const ids = rows(view('Server')).flatMap((row) => row.components.map((component) => component.custom_id));

    assert.deepEqual(ids.sort(), [
      `${HELP_NS}:category:${SESSION}`,
      `${HELP_NS}:command:${SESSION}`,
      `${HELP_NS}:next:${SESSION}`,
      `${HELP_NS}:prev:${SESSION}`,
    ]);
  });

  test("stays within Discord's custom id length limit", () => {
    for (const row of rows(view('Server'))) {
      for (const component of row.components) {
        assert.ok(component.custom_id.length <= 100, `${component.custom_id} is too long`);
      }
    }
  });
});

describe('the disabled rendering', () => {
  test('deactivates every control for the timeout state', () => {
    /**
     * On expiry the controls are disabled rather than removed, so the menu visibly expires
     * instead of leaving live-looking buttons that would be refused.
     */
    for (const row of rows(view('Server', 0, { disabled: true }))) {
      for (const component of row.components) {
        assert.equal(component.disabled, true, `${component.custom_id} should be disabled`);
      }
    }
  });
});

describe('degraded input', () => {
  test('falls back to the first category for an unknown name', () => {
    /**
     * A category name can arrive from a select menu on a message that outlived a configuration
     * change. Falling back beats throwing inside a component handler.
     */
    for (const name of ['Nonexistent', '', null, undefined]) {
      const rendered = view(name);
      assert.equal(rendered.category.name, 'Account', `should fall back for ${JSON.stringify(name)}`);
    }
  });
});

describe('invocation forms', () => {
  test('renders the prefix form with bracketed arguments', () => {
    /**
     * Angle brackets for required, square for optional. The convention is shared with the slash
     * form so the detail view reads consistently.
     */
    const power = registry.getVisible('server power');
    assert.equal(prefixForm(power, PREFIX), 'kx!server power <server> <action>');

    const manage = registry.getVisible('server manage');
    assert.equal(prefixForm(manage, PREFIX), 'kx!server manage [server]');

    const ping = registry.getVisible('ping');
    assert.equal(prefixForm(ping, PREFIX), 'kx!ping');
  });

  test('renders the slash form for a nested command', () => {
    assert.equal(
      slashForm(registry.getVisible('server subuser add')),
      '/server subuser add <server> <email>',
    );
  });

  test('returns null for a command that opts out of the slash surface', () => {
    assert.equal(slashForm({ name: 'legacy', slash: false, options: [] }), null);
  });
});

describe('the command detail view', () => {
  test('shows both invocation forms and the full description', () => {
    /**
     * The detail view is where the untruncated description belongs, since the list above it is
     * necessarily abbreviated.
     */
    const command = registry.getVisible('server subuser add');
    const detail = buildCommandDetailView({ command, prefix: PREFIX, sessionId: SESSION, registry });

    assert.equal(detail.embed.data.title, 'Command: server subuser add');
    assert.match(detail.embed.data.description, /`kx!server subuser add <server> <email>`/);
    assert.match(detail.embed.data.description, /`\/server subuser add <server> <email>`/);
    assert.match(detail.embed.data.description, /• `server` \(required\)/);
    assert.match(detail.embed.data.description, /• `email` \(required\)/);
  });

  test('reports the access level', () => {
    const admin = buildCommandDetailView({
      command: registry.getVisible('admin suspend'),
      prefix: PREFIX,
      registry,
    });
    assert.match(admin.embed.data.description, /Access: Administrators only/);

    const user = buildCommandDetailView({
      command: registry.getVisible('server power'),
      prefix: PREFIX,
      registry,
    });
    assert.match(user.embed.data.description, /Access: Everyone/);
  });

  test('reports where the command may be used', () => {
    const anywhere = buildCommandDetailView({ command: registry.getVisible('ping'), prefix: PREFIX, registry });
    assert.match(anywhere.embed.data.description, /Servers and direct messages/);

    const guildOnly = buildCommandDetailView({
      command: registry.getVisible('server create'),
      prefix: PREFIX,
      registry,
    });
    assert.match(guildOnly.embed.data.description, /Servers only/);
  });

  test('lists aliases, or states there are none', () => {
    const withAliases = buildCommandDetailView({
      command: registry.getVisible('help'),
      prefix: PREFIX,
      registry,
    });
    assert.match(withAliases.embed.data.description, /`kx!commands`/);

    const withoutAliases = buildCommandDetailView({
      command: registry.getVisible('server rename'),
      prefix: PREFIX,
      registry,
    });
    assert.match(withoutAliases.embed.data.description, /Aliases: None/);
  });

  test('reports the cooldown when one applies', () => {
    const withCooldown = buildCommandDetailView({
      command: registry.getVisible('files backup'),
      prefix: PREFIX,
      registry,
      cooldownSeconds: 120,
    });
    assert.match(withCooldown.embed.data.description, /Cooldown: 2 minutes/);

    const withoutCooldown = buildCommandDetailView({
      command: registry.getVisible('ping'),
      prefix: PREFIX,
      registry,
      cooldownSeconds: 0,
    });
    assert.match(withoutCooldown.embed.data.description, /Cooldown: None/);
  });

  test('renders a Back button only when a session is supplied', () => {
    /**
     * The static form used by `kx!help <command>` has no listing to return to, and a Back button
     * with no session behind it would be refused with "Timed Out" on the first press.
     */
    const interactive = buildCommandDetailView({
      command: registry.getVisible('ping'),
      prefix: PREFIX,
      sessionId: SESSION,
      registry,
    });

    assert.equal(interactive.components.length, 1);

    const button = interactive.components[0].toJSON().components[0];
    assert.equal(button.label, 'Back');
    assert.equal(button.custom_id, `${HELP_NS}:back:${SESSION}`);

    const staticView = buildCommandDetailView({
      command: registry.getVisible('ping'),
      prefix: PREFIX,
      registry,
    });

    assert.deepEqual(staticView.components, []);
  });

  test('renders examples when a command declares them', () => {
    const detail = buildCommandDetailView({
      command: registry.getVisible('server power'),
      prefix: PREFIX,
      registry,
    });

    assert.match(detail.embed.data.description, /\*\*Examples\*\*/);
    assert.match(detail.embed.data.description, /`kx!server power a1b2c3d4 start`/);
  });

  test('stays within the description limit for every command', () => {
    // Some details plus a summary plus arguments plus examples can accumulate.
    for (const command of registry.all) {
      const detail = buildCommandDetailView({ command, prefix: PREFIX, sessionId: SESSION, registry });

      assert.ok(
        detail.embed.data.description.length <= LIMITS.description,
        `${command.name} detail exceeds the description limit`,
      );
    }
  });
});
