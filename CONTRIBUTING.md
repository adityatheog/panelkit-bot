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
- [Maintaining documentation](#maintaining-documentation)
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

**`npm run verify` needs no credentials.** Checks are static or use in-memory SQLite, recording doubles and loopback HTTP servers, so you can validate a change before you have a Discord token or a panel. That is deliberate: a contribution workflow that requires production credentials is one that discourages contributions.

To actually run the bot you need a token, an application ID, a panel URL and two panel API keys — see the [README's configuration section](README.md#configuration). Set `GUILD_ID` during development so slash commands appear instantly rather than propagating for an hour, and `LOG_LEVEL=debug` to see panel request lines.

Node 20.11 or newer is the compatibility floor; use a maintained Node 22 or 24 LTS release for production. Node 20 is end-of-life.

---

## Before opening a pull request

```bash
npm run verify
```

That runs three things, and each catches a different class of problem.

**`npm run syntax`** parses source and scripts and imports non-entry-point modules, so a renamed export or a relative path that lost a `../` fails here rather than at startup. Entry points are parsed without being executed, avoiding startup or external side effects. Command definitions are loaded dynamically, so an unresolved import in one of them would otherwise first appear as a failed boot.

**`npm run audit`** checks structural completeness: every expected file present, exactly 25 commands in 5 categories, both surfaces wired, valid configuration, database schema, preserved MIT attribution, no placeholder markers and no committed secrets.

**`npm test`** runs 20 test files with `node:test`. No framework or credentials required.

CI runs these on Node 20, 22 and 24, plus a container build and secret scan. Native dependencies are installed separately for each runtime. Registry availability and version-specific behaviour can still affect CI.

`npm run audit` checks this project's structure; `npm audit` separately checks dependency advisories. There is no separate lint, type-check or build script. Syntax/import validation is included in `npm run verify`.

---

## Adding a command

A definition file in `src/commands/definitions/<category>/` produces the prefix invocation, the nested slash invocation and the help entry. The registry discovers it automatically; add tests and update the structural assertions before registering the new payload with Discord.

```js
import { bulletList, identifierFooter, successEmbed } from '../../../utils/embeds.js';
import { sanitiseForDisplay } from '../../../utils/format.js';

export default {
  name: 'server example',

  category: 'Server',

  description: 'Do something with your server',

  details:
    'A longer explanation, including anything a user needs to know before running it.',

  guildOnly: true,
  adminOnly: false,
  hidden: false,

  aliases: ['server ex'],
  examples: ['server example a1b2c3d4'],

  options: [
    {
      name: 'server',
      type: 'string',
      description: 'The 8-character server identifier',
      required: true,
      minLength: 8,
      maxLength: 8,
    },
  ],

  async execute(ctx) {
    await ctx.defer();

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

Names use one to three lowercase space-separated words; Discord supports command → group → subcommand. Use an existing category and a description of at most 100 characters; the help list truncates it using `help.descriptionMax` (51 by default). `details` appears in the full help view. `guildOnly: false` permits DMs, `adminOnly: true` applies admin authorisation, and `hidden: true` hides a command from help without disabling it.

The example acknowledges before doing work and resolves ownership before any panel request. Use service methods for mutations so ownership is revalidated at the service boundary too.

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

`scripts/verify-project.js` asserts exactly 25 visible commands in 5 categories; registry and help tests assert the same. Update the documented tree and its independent assertions together when deliberately adding or removing a command.

Update `EXPECTED_TREE` in `scripts/verify-project.js`, registry/help tests and the command counts and tables in the documentation. A hidden command still needs registry tests and a reachable slash payload.

---

## Architectural rules

Five rules. They exist because each one prevents a specific class of bug, and a change that breaks one will be asked to change.

### 1. Use `ctx` for command acknowledgement and replies

Use `ctx` rather than branching on `Message` or `ChatInputCommandInteraction`. Discord.js builders and component collectors belong to presentation code, not business logic.

```js
await ctx.defer({ ephemeral: true });
await ctx.respond({ embeds: [embed] });
await ctx.followUp({ content: 'more' });
const anchor = await ctx.anchorMessage();
await ctx.dm({ embeds: [credentials] });
```

This is what makes one `execute` serve both surfaces. Reaching for `ctx.interaction` directly means the command works on one surface and breaks on the other.

`ctx.anchorMessage()` supplies the message for a component collector. Collectors must verify session ownership, expiry and destructive confirmation state before acting.

`ctx.dm()` lets errors propagate while `ctx.respond()` swallows them, and that asymmetry is a security property: DM delivery is how passwords, signed URLs and log attachments reach a user. Probe deliverability before sensitive work and handle delivery failure with a recovery message, never with a channel fallback.

### 2. All Pterodactyl HTTP lives in `services/pterodactyl.js`

No other module issues panel HTTP requests, sets a panel `Authorization` header or reads a `{ object, attributes }` envelope. Presentation code may build links to the panel UI. API callers receive plain camelCase objects.

If you need a supported panel endpoint that does not have a wrapper yet, add a method there. Keep these contracts:

- **The Application and Client APIs are separate.** Two axios instances with different keys. Mixing them produces a 403 from an endpoint that looks correct.
- **Check the update contract per endpoint.** `updateUserPassword` and `updateServerImage` read current state and resubmit the required fields alongside the change. Do not assume a partial payload is accepted or preserves every field; verify it against the panel API and wire-level tests.
- **Owner filtering is local.** `listServersForUser` validates a positive safe-integer panel user ID, pages `/servers` and compares `attributes.user`. Do not reintroduce unsupported `filter[owner_id]`. Invalid page metadata, non-array collections and more than 100 pages must fail rather than imply absence.
- **State-changing requests veto retries.** They are not retried even on HTTP 429. Keep response limits: 8 MiB for ordinary API bodies and 32 MiB for log downloads.

### 3. All SQL lives in `database/db.js`

Prepared and parameterised, always. And ownership goes in the SQL:

```js
getOwnedServer: connection.prepare(
  'SELECT * FROM servers WHERE identifier = ? AND discord_id = ?',
),
```

Not a JavaScript comparison after an unscoped query. The scoped query returns no row for a foreign caller; it does not replace the requirement to invoke the ownership gate before panel I/O.

### 4. Authorisation goes through `requireOwnedServer`

Every user-triggered server operation. It resolves `Discord user -> local row -> panel resource` and throws `AuthorizationError` otherwise, with an error identical for a missing and a foreign server so the identifier space cannot be probed.

Refuse **before** contacting the panel. Reaching the panel first and refusing afterwards leaks existence through the panel's audit log and through timing.

### 5. Never log a secret

Pass objects to the logger, which redacts by key name and value shape:

```js
logger.error('Panel request failed', { api, label, status, code });
```

Never interpolate credentials into messages or pass raw errors to the logger; an axios error's `config` can contain the authorisation header.

Use `toLogMeta(err, context)` for errors. It builds an explicit projection rather than passing the error object, whose axios config carries the `Authorization` header.

### Additional rules

**Business logic goes in services, not in command files or routers.** A command file should read as presentation: acknowledge, call a service, render the result. If it contains a decision, that decision probably belongs in a service where it can be unit tested.

**Do not invent panel endpoints.** Document unsupported capabilities in the README's limitations section, not in new source comments or an invented API approximation. The websocket-only console constraint is one example.

**Keep lifecycle locks consistent.** Account deletion acquires `account:<discordId>` then `servers:<discordId>`; server creation/deletion share the server-owner key. Do not reverse that ordering. Re-entrant acquisition is checked in the caller's async context, not against unrelated queued callers. These locks and component sessions work within one process only.

---

## Writing tests

The 20 test files cover module boundaries and selected command flows. Add regression coverage for new behaviour; extend the relevant suite rather than assuming every module has its own file.

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

`tests/commandSafety.test.js` covers private log delivery and destructive confirmation replay/expiry. Also test partial deletion, stale panel-account bindings, concurrent callers, malformed pagination and safe-integer credit boundaries when changing those paths. Passing credentialless tests is not evidence of live Discord or Pterodactyl behaviour; report any live integration gaps explicitly.

---

## Maintaining documentation

Review every tracked Markdown file when behaviour or operator requirements change:

```bash
git ls-files '*.md'
```

- [README.md](README.md): command tables/counts, test-file count, exact dependency versions, environment/configuration and deployment instructions.
- [CONTRIBUTING.md](CONTRIBUTING.md): development commands, architecture, examples and regression expectations.
- [SECURITY.md](SECURITY.md): implemented protections, data retained, hardening and known limits. Do not describe panel operations as atomic rollbacks.
- [CHANGELOG.md](CHANGELOG.md): record changes under `Unreleased` until a release is made. Preserve historical versions, dates and dependency tables; state operator actions and slash registration requirements.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md): keep reporting links and project-specific privacy guidance current; do not silently change the Contributor Covenant or enforcement policy.

For documentation-only changes, check relative links and heading anchors, run `git diff --check` and `npm run verify`, and identify files deliberately left unchanged in the PR. Preserve the MIT licence and Contributor Covenant attribution.

---

## Code style

There is no linter, deliberately — the rules below are short enough to hold in your head, and a linter config becomes another thing to argue about.

**Formatting.** Two-space indentation, single quotes, semicolons, trailing commas in multi-line literals, roughly 120 columns. `.editorconfig` covers the basics.

**Source clarity.** Prefer descriptive names and small functions over comments. Do not add inline, block or documentation comments to maintained source. Put operational details and API contracts in dedicated documentation; remove unnecessary comments and author notes when rewriting a file.

**British English in prose**, matching the existing documentation.

**Attribution.** Preserve the MIT copyright and licence in `LICENSE`. Source authorship comments are not required; the structural audit checks the licence instead.

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

**Never paste API keys, bot tokens, generated passwords, signed download URLs or unredacted log/backup contents into an issue.** If you expose a key, token or password, revoke or reset it immediately: git history and issue edit history both retain it. Treat an exposed signed URL as a file disclosure until the URL expires or is invalidated.

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

**Do not open a public issue.** See [SECURITY.md](SECURITY.md) for private reporting.

That includes anything touching authorisation, credential handling, secret redaction or SQL construction — even if you are not sure it is exploitable. A report that turns out to be a non-issue costs a short conversation; a public disclosure of a real one cannot be undone.

---

Coded by **Aditya** — [@adityatheog](https://github.com/adityatheog)
