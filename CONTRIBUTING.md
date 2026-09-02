<!-- Coded by Aditya | GitHub- @adityatheog -->

# Contributing to PanelKit

Thanks for considering it. This document covers what you need to know to make a change that gets merged without a long review cycle.

The short version: `npm run verify` must pass, commands go in `src/commands/definitions/`, and the five architectural rules below are the ones worth respecting.

---

## Contents

- [Getting set up](#getting-set-up)
- [Before opening a pull request](#before-opening-a-pull-request)
- [Adding a command](#adding-a-command)
- [Architectural rules](#architectural-rules)
- [Writing tests](#writing-tests)
- [Code style](#code-style)
- [Commits and pull requests](#commits-and-pull-requests)
- [Reporting bugs](#reporting-bugs)
- [Requesting features](#requesting-features)
- [Security issues](#security-issues)

---

## Getting set up

```bash
git clone https://github.com/adityatheog/panelkit-bot.git
cd panelkit-bot

# better-sqlite3 compiles a native addon.
sudo apt install python3 make g++      # Debian or Ubuntu

npm ci
npm run verify
```

**`npm run verify` needs no credentials.** Every check is static or runs against an in-memory database with recording doubles, so you can validate a change before you have a Discord token or a panel. That is deliberate: a contribution workflow that requires production credentials is one that discourages contributions.

To actually run the bot you need a token, an application ID and two panel API keys — see the README's configuration section. Set `GUILD_ID` during development so slash commands appear instantly rather than propagating for an hour, and `LOG_LEVEL=debug` to see panel request lines.

Node 20.11 or newer is required; the project uses `import.meta.dirname`.

---

## Before opening a pull request

```bash
npm run verify
```

That runs three things, and each catches a different class of problem.

**`npm run syntax`** parses every source file *and imports every module*, so a renamed export or a relative path that lost a `../` fails here rather than at startup. Command definitions are loaded dynamically, so an unresolved import in one of them would otherwise first appear as a failed boot.

**`npm run audit`** checks structural completeness: every expected file present, the command tree exactly 24 commands in 5 categories in the documented order, both surfaces wired, `config.json` valid, the database schema applying, no placeholder markers, no committed secrets.

**`npm test`** runs 19 test files with `node:test`. No framework, no credentials.

CI runs the same three on Node 20 and Node 22, plus a container build and a secret scan. If `npm run verify` passes locally it will almost certainly pass in CI — the exceptions are Node-version-specific behaviour and the container build, which is why both are in the matrix.

---

## Adding a command

One file, in `src/commands/definitions/<category>/`. That single declaration produces the prefix invocation, the nested slash invocation and the help entry — there is nothing to register by hand.

```js
// Coded by Aditya | GitHub- @adityatheog

import { bulletList, identifierFooter, successEmbed } from '../../../utils/embeds.js';
import { sanitiseForDisplay } from '../../../utils/format.js';

export default {
  // One to three lowercase space-separated words. Discord supports at most
  // command -> group -> subcommand, and the registry enforces that.
  name: 'server example',

  // Must be one of the five existing categories.
  category: 'Server',

  // Shown in the help list, truncated to 51 characters. Max 100 (Discord's limit).
  description: 'Do something with your server',

  // Shown in full in the help detail view. Optional.
  details:
    'A longer explanation, including anything a user needs to know before running it.',

  guildOnly: true,      // false permits direct messages
  adminOnly: false,     // true gates behind ADMIN_USER_IDS / ADMIN_ROLE_IDS
  hidden: false,        // true excludes it from help but keeps it invocable

  aliases: ['server ex'],
  examples: ['server example a1b2c3d4'],

  options: [
    {
      name: 'server',
      type: 'string',   // string | integer | user
      description: 'The 8-character server identifier',
      required: true,
      minLength: 8,
      maxLength: 8,
    },
  ],

  /**
   * @param {object} ctx the surface-agnostic execution context
   */
  async execute(ctx) {
    // Acknowledge before any panel request. An interaction token expires three
    // seconds after arrival unless acknowledged.
    await ctx.defer();

    // The only authorisation gate. Never query the panel with a user-supplied
    // identifier that has not passed through this.
    const server = ctx.serverService.requireOwnedServer(ctx.user.id, ctx.args.server);

    await ctx.respond({
      embeds: [
        successEmbed(
          'Done',
          bulletList([['Server', sanitiseForDisplay(server.name, 64)]]),
          identifierFooter(server.identifier),
        ),
      ],
    });
  },
};
```

Then register it with Discord:

```bash
npm run deploy
```

### Option declarations

| Field | Applies to | Notes |
| --- | --- | --- |
| `type` | all | `string`, `integer` or `user`. Anything else is refused at load. |
| `required` | all | Required options must be declared **before** optional ones. Discord rejects the reverse, and positional prefix parsing cannot resolve it. |
| `default` | all | Used when an optional option is absent. |
| `minLength` / `maxLength` | string | Import the bounds from `utils/validation.js` rather than writing literals, so Discord and the validator cannot disagree. |
| `choices` | string | Derive from a shared constant where one exists — `server power` reads `POWER_SIGNALS`. Max 25. |
| `min` / `max` | integer | Inclusive. |
| `greedy` | string | Absorbs all remaining prefix tokens, so a multi-word value needs no quoting. Must be declared **last**. |

### The `order` field

Categories sort alphabetically by default. Admin leads with `create` and General runs ping, plans, help, which are not alphabetical — those use an explicit `order`. Only set it if the documented layout requires it.

### If you change the command count

`scripts/verify-project.js` asserts the tree is exactly 24 visible commands in 5 categories, and `tests/registry.test.js` and `tests/helpMenu.test.js` assert the same. That is not an obstacle to work around — it is the check that catches a command silently renamed or dropped.

Adding a command means updating `EXPECTED_TREE` and the counts in all three places, deliberately. Or mark it `hidden: true` if it should not appear in help.

---

## Architectural rules

Five rules. They exist because each one prevents a specific class of bug, and a change that breaks one will be asked to change.

### 1. Commands never touch Discord.js types

Use `ctx`, not `Message` or `ChatInputCommandInteraction`.

```js
await ctx.defer({ ephemeral: true });
await ctx.respond({ embeds: [embed] });
await ctx.followUp({ content: 'more' });
const anchor = await ctx.anchorMessage();   // for a component collector
await ctx.dm({ embeds: [credentials] });    // errors propagate deliberately
```

This is what makes one `execute` serve both surfaces. Reaching for `ctx.interaction` directly means the command works on one surface and breaks on the other.

`ctx.dm()` lets errors propagate while `ctx.respond()` swallows them, and that asymmetry is a security property: DM delivery is how passwords and signed URLs reach a user, so a caller must be able to detect failure and fall back to a message explaining recovery.

### 2. All Pterodactyl HTTP lives in `services/pterodactyl.js`

No other module constructs a panel URL, sets an `Authorization` header or reads a `{ object, attributes }` envelope. Callers receive plain camelCase objects.

If you need a panel endpoint that does not exist yet, add a method there. Two things to know:

- **The Application and Client APIs are separate.** Two axios instances with different keys. Mixing them produces a 403 from an endpoint that looks correct.
- **Pterodactyl's PATCH replaces the whole record.** `PATCH /users/{id}` with only `{ password }` clears the email and username, silently, with a 200 response. Read the current state back and resubmit it — `updateUserPassword` and `updateServerImage` both do.

### 3. All SQL lives in `database/db.js`

Prepared and parameterised, always. And ownership goes in the SQL:

```js
// Correct: a foreign caller matches zero rows regardless of calling code.
getOwnedServer: connection.prepare(
  'SELECT * FROM servers WHERE identifier = ? AND discord_id = ?',
),
```

Not a JavaScript comparison after an unscoped query. A future handler that forgets the check still gets nothing.

### 4. Authorisation goes through `requireOwnedServer`

Every user-triggered server operation. It resolves `Discord user -> local row -> panel resource` and throws `AuthorizationError` otherwise, with an error identical for a missing and a foreign server so the identifier space cannot be probed.

Refuse **before** contacting the panel. Reaching the panel first and refusing afterwards leaks existence through the panel's audit log and through timing.

### 5. Never log a secret

Pass objects to the logger, which redacts by key name and value shape:

```js
logger.error('Panel request failed', { api, label, status, code });   // yes
logger.error(`Failed with token ${token}`);                           // no
logger.error('Failed', { err });                                      // no — err.config holds the header
```

Use `toLogMeta(err, context)` for errors. It builds an explicit projection rather than passing the error object, whose axios config carries the `Authorization` header.

### And two more, briefly

**Business logic goes in services, not in command files or routers.** A command file should read as presentation: acknowledge, call a service, render the result. If it contains a decision, that decision probably belongs in a service where it can be unit tested.

**Do not invent panel endpoints.** If the documented API cannot do something, say so in a code comment and in the README's limitations section. The websocket-only console constraint is documented in exactly that way, rather than being approximated with something that looks like it works.

---

## Writing tests

Every module has a test file. New behaviour needs one.

**Assert the negative case.** This is the single most useful habit here. A test that a user can access their own server proves almost nothing; a test that a *stranger* is refused, and that no panel request was made while refusing, proves the property that matters. Look at `tests/serverService.test.js` — the authorisation block is table-driven over twelve methods for exactly this reason.

**Reproduce the bug the code prevents.** `tests/locks.test.js` runs the limit-check race twice: once unlocked, asserting it *fails*, then locked. That framing proves the test exercises a real race rather than passing vacuously against a no-op implementation.

**Use recording doubles, not mocking libraries.** The panel doubles in the service tests record every call in order, which is what lets a test assert that a refused operation reached the panel not at all. There is no mocking framework and no need for one.

**Use a real database.** `createDatabase(':memory:')` gives a real schema with real constraints, so a duplicate insert produces a genuine `SQLITE_CONSTRAINT_UNIQUE` rather than a simulated one. Always `db.close()` in a `finally`.

**Test the wire when the wire is the point.** `tests/pterodactyl.test.js` runs a real HTTP server on an ephemeral loopback port rather than mocking axios, because the defects that module can have — a key sent to the wrong API, a header forwarded across a redirect, a PATCH that omits fields — only exist in the actual request.

Run one file while iterating:

```bash
node --test tests/serverService.test.js
node --test --test-name-pattern="refuses a stranger" tests/
```

---

## Code style

There is no linter, deliberately — the rules below are short enough to hold in your head, and a linter config becomes another thing to argue about.

**Formatting.** Two-space indentation, single quotes, semicolons, trailing commas in multi-line literals, roughly 120 columns. `.editorconfig` covers the basics.

**JSDoc on exported functions.** Types and a description of what the function is for. Existing modules are the reference.

**Comments explain *why*.** Not what the code does — that is readable. The valuable comments in this project are the ones that name the failure being prevented:

```js
/**
 * PATCH /users/{id} replaces the whole record: omitted fields are cleared. The
 * current values are read back and resubmitted so only the password changes.
 * Sending just { password } would blank the email and username.
 */
```

Not:

```js
// Get the user, then update the password.
```

**British English in prose**, matching the existing documentation and comments.

**The authorship header** goes at the top of every `.js`, `.sh`, `.yml` and `.md` file:

```js
// Coded by Aditya | GitHub- @adityatheog
```

`npm run audit` checks it. JSON files are exempt, since a comment would make them invalid.

**Naming.** `camelCase` for functions and variables, `PascalCase` for classes, `SCREAMING_SNAKE_CASE` for module constants. Database columns are `snake_case` because that is what SQLite holds; the service layer maps them at the boundary.

**No new dependencies without a reason.** Four direct dependencies, pinned exactly. Node's standard library covers most of what a bot needs — `node:test` instead of a test framework, `node:crypto` instead of a uuid package.

---

## Commits and pull requests

**Commit messages** in the imperative mood, explaining why when it is not obvious:

```text
Add server subuser list command
Fix double-spend in credit deduction
Refuse settings.delete in subuser permissions

Pterodactyl accepts it, and an operator copying a permission list from
panel documentation could include it — at which point every sub-user
added through the bot can delete the owner's server.
```

Not `Updated stuff`, `fix`, or `WIP`.

**Pull request titles** under 70 characters. Put the detail in the description:

- What changed, and why
- How you tested it
- Anything deliberately left out, and why

**Keep pull requests focused.** A behaviour change plus a formatting sweep is two pull requests; the formatting hides the behaviour in the diff.

**Rebase rather than merge** to bring in `main`, so the history stays linear.

---

## Reporting bugs

Open an issue with:

- **Version** — the release, or the commit hash
- **Node version** — `node --version`
- **Panel version** — from the panel's footer
- **Deployment** — Docker, PM2, systemd, or `npm start`
- **The exact command** you ran, with arguments
- **What you expected** and **what happened**
- **Relevant log lines**, with secrets removed

The log lines are usually the most useful part. Every error carries a `code`, and genuine faults carry a reference shown to the user — search for it.

**Never paste an API key or a bot token into an issue.** If you already have, revoke it immediately: git history and issue edit history both retain it.

---

## Requesting features

Describe the problem before the solution. "I want users to see their server's IP without opening the panel" is more useful than "add an `ip` command", because it might already be answered by `server info`, or the right shape might be something neither of us has thought of.

Worth knowing what is deliberately out of scope:

**Live console streaming.** Pterodactyl serves it over a websocket only. Implementing it means holding a connection per watched server, which is a different architecture from the request-response one here.

**Multiple instances.** Sessions and locks are in process memory. Horizontal scaling means moving both to Redis.

**A credits economy.** The balance, `grantCredits` and an atomic `spendCredits` all exist. What credits *cost* is an operator policy decision, so no command consumes them.

**A web dashboard.** The panel already has one.

---

## Security issues

**Do not open a public issue.** See `SECURITY.md` for private reporting.

That includes anything touching authorisation, credential handling, secret redaction or SQL construction — even if you are not sure it is exploitable. A report that turns out to be a non-issue costs a short conversation; a public disclosure of a real one cannot be undone.

---

Coded by **Aditya** — [@adityatheog](https://github.com/adityatheog)
