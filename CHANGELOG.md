<!-- Coded by Aditya | GitHub- @adityatheog -->

# Changelog

All notable changes to PanelKit are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## What counts as breaking

Because this is a self-hosted bot rather than a library, a major version bump means something an **operator** must act on, not an API signature change. Specifically:

- A change to `.env` that requires editing an existing file (a new required variable, a renamed one, a changed default that alters behaviour)
- A change to `config.json` that an existing file will not validate against
- A database migration that cannot be rolled back
- A removed or renamed command, which requires `npm run deploy`
- A minimum Node version increase
- A change to the Pterodactyl API permissions the bot requires

Anything an operator can pull and restart without reading is a minor or patch release.

---

## [Unreleased]

Changes below are unreleased and do not denote a new tagged release. Historical release details and dependency versions remain under their original release heading.

### Added

- `admin prune`: find and re-verify stale local server records before removing them. It removes only local tracking rows after confirmed panel absence, not live panel servers. Together with the existing commands, the registry now exposes 25 commands in 5 categories. Re-register slash commands with `npm run deploy` to make it available.
- Command-level regression coverage for DM-only logs and repeated, expired or evicted destructive confirmations. The credentialless suite now contains 20 test files.

### Changed

- Updated exact dependency pins: `discord.js` 14.27.0, `better-sqlite3` 12.10.0 and `axios` 1.20.0. `dotenv` remains 16.4.5; install from the committed lockfile with `npm ci`.
- CI verifies Node 20, 22 and 24. Node 20.11 remains the compatibility floor, but Node 20 is end-of-life; use maintained Node 22 or 24 in production.
- Docker build and runtime stages use Node 22.23.3 Bookworm Slim and require the lockfile. `NODE_IMAGE` permits the same pinned official image from the ECR Public mirror when Docker Hub is rate-limited. Rebuild the image after updating; do not reuse native modules built for a different runtime.
- README, contributor, security and conduct guidance aligned with current versions, tests, privacy boundaries and deployment behaviour. Source authorship comments are not required; MIT and Contributor Covenant attribution remain preserved.

### Fixed

- Independent callers now queue behind a lock rather than being mistaken for recursive acquisition. Re-entrancy is checked within the caller's async context, and released leases do not permanently block detached descendants.
- Account deletion shares server-owner locks with provisioning and server deletion. It reports servers already removed when a later panel deletion fails, retaining local records for a retry rather than claiming a rollback.
- Panel ownership reconciliation uses bounded pagination of `/servers` and local `attributes.user` filtering instead of unsupported `filter[owner_id]`. Invalid collections/page metadata and more than 100 pages fail explicitly.
- Credit grants, spending and administrative adjustments reject fractional or unsafe integers rather than silently truncating them.
- Help and structural assertions now match the 25-command registry.

### Security

- `server logs` revalidates ownership and probes DM delivery before fetching. Attachments are delivered only in DMs, never as a channel fallback. Ordinary API responses are capped at 8 MiB and log downloads at 32 MiB.
- Account/server deletion confirmations are single-use. Account deletion also checks the panel account ID shown in the prompt, preventing an old confirmation from deleting a replacement account.
- Dependency updates address the vulnerability findings from the baseline audit. Continue running `npm audit`; a clean scan is not a guarantee against future advisories.

### Upgrade actions

Back up SQLite using `node scripts/init-db.js --backup <path>`, stop the bot and update the checkout. Run `npm ci` and `npm run verify` for a host installation, or rebuild with `docker compose up -d --build`. Register the updated slash payload with `npm run deploy` (or `docker compose run --rm bot npm run deploy`), checking the guild/global scope, and restart only one bot instance. No new required environment variables, config schema or database migration were introduced by these changes. Open menus do not survive a restart.

---

## [1.0.0] — 2026-09-02

First release: 24 commands across 5 categories, both a prefix and a slash surface, 19 test files that run without credentials, and three supported deployment paths. The counts and versions in this section describe the original release; see `Unreleased` for the current branch.

### Added

#### Commands

24 commands, each working identically as `kx!command` and `/command`.

**Account** — `account create`, `account delete`, `account info`, `account reset`

Panel accounts are generated with a random username and a cryptographically random password, delivered by direct message and stored nowhere. `account delete` requires confirmation and names every server that will be destroyed. `account reset` probes DM deliverability *before* changing the password, so a closed inbox cannot lock a user out of a working account.

**Admin** — `create`, `admin servers`, `admin suspend`, `admin unsuspend`, `admin user`

Gated behind `ADMIN_USER_IDS` or `ADMIN_ROLE_IDS`, checked in both routers before any handler runs. Every action writes an audit line naming the actor, the target and which rule granted access. `admin servers` and `admin user` cross-reference the panel against the bot's own records and report discrepancies.

**Files** — `files backup`

Archives the server root and delivers it by DM: attached when small, as a signed link when not. Neither the archive nor the link ever reaches a channel, because server configuration files routinely contain database passwords and API tokens.

**General** — `ping`, `plans`, `help`

The only three that work in direct messages. `help` opens a paginated browser with a category selector and per-command detail, rendered from the command registry so it cannot drift from what the bot implements.

**Server** — `server create`, `server delete`, `server info`, `server list`, `server logs`, `server manage`, `server power`, `server rename`, `server subuser add`, `server subuser remove`, `server usage`

`server manage` opens an interactive dashboard with live status, power controls, rename, container image switching and reinstall. `server create` reads the egg's own variables from the panel and merges operator overrides, so a required variable with no value is reported as a configuration error before anything is created.

#### Architecture

**A single command registry.** Each command is declared once with a canonical space-separated name, and that declaration produces the prefix invocation, the nested slash invocation and the help entry. `server subuser add` maps onto Discord's command → group → subcommand nesting. Adding a command means adding one file.

**A surface-agnostic execution context.** Commands receive `ctx` and never touch a `Message` or a `ChatInputCommandInteraction`, which is what allows one `execute` to serve both surfaces. The context tracks interaction acknowledgement state, so a command can call `defer()` then `respond()` unconditionally and get correct behaviour on both.

**One module per boundary.** All Pterodactyl HTTP in `services/pterodactyl.js`, all SQL in `database/db.js`. A panel schema change or a query change is a one-line edit rather than a search across command files.

**Per-key async locks.** Node returns to the event loop at every `await`, so a limit check followed by a panel call is a race. Provisioning, deletion, sub-user changes and backups run inside `utils/locks.js`.

**Server-side component sessions.** A Discord custom ID is `namespace:action:sessionId`; everything identifying the target lives in process memory keyed by a 72-bit random token. A button cannot be edited to act on another user's server, because the server is not named in the button.

#### Security

- Ownership resolved in SQL (`WHERE identifier = ? AND discord_id = ?`), so a foreign caller matches zero rows regardless of calling code
- Missing and foreign servers produce an identical error, so the 8-character identifier space cannot be probed
- Admin allowlists are authoritative once set; the Discord Administrator fallback exists only to make a fresh install administrable, and warns loudly while active
- Credentials generated with `crypto.randomBytes` using rejection sampling, avoiding the modulo bias of `byte % alphabet.length`
- Passwords and signed URLs delivered by DM only, never logged, never shown to administrators
- Logger redacts by key name *and* by value shape, recursively — panel key prefixes, Discord token shapes and `Bearer` values are masked even inside a plain string
- `maxRedirects: 0` on both axios instances, so a panel cannot forward the `Authorization` header to another host
- Signed download URLs fetched without the panel bearer token, since they point at a node
- Non-idempotent requests never replayed after an ambiguous failure; HTTP 429 is the one safe exception
- Input allowlisted by anchored patterns on **both** surfaces, because Discord's client-side constraints are a convenience rather than a boundary
- Container images restricted to a config allowlist; the dashboard sends an index rather than an image string
- `settings.delete` refused in `subuser.defaultPermissions`, so a sub-user can never delete the owner's server
- Destructive actions require single-use confirmation, deleted before the work begins rather than after

#### Operations

- Environment validation that reports every problem in one error and never echoes a secret
- `config.json` validation that throws on structural errors but treats unfilled placeholders as unconfigured, so a fresh clone boots and reports what to fill in
- Migration runner keyed on SQLite's `user_version`, applied inside a transaction per version, refusing to run against a newer schema than it understands
- Per-user, per-command cooldowns recorded only when a command is allowed to proceed
- Retry with exponential backoff and full jitter, honouring `Retry-After`
- Structured JSON logging to stdout and stderr, with a `child()` for subsystem tagging
- Graceful shutdown that stops timers, closes the gateway connection, checkpoints the WAL and removes the heartbeat file
- File-based liveness probe, so the bot exposes no network port for monitoring
- Startup warning when `CLIENT_ID` does not match the authenticated bot — the cause of "slash commands exist but nothing happens"

#### Tooling

- `npm run syntax` — parses every source file and imports every module, catching a renamed export or a broken relative path
- `npm run audit` — structural completeness: expected files, the command tree, both surfaces wired, config validity, schema application, no placeholders, no committed secrets
- `npm test` — 19 files with `node:test`, no framework, no credentials
- `npm run verify` — all three, and what CI runs
- `scripts/init-db.js` — create, migrate, inspect read-only, or back up via SQLite's online backup API
- `scripts/healthcheck.js` — the liveness probe, importing nothing from `src/`

#### Deployment

- **Dockerfile** — multi-stage so the C++ toolchain needed to compile `better-sqlite3` never reaches the runtime image; runs unprivileged, exposes no port
- **docker-compose.yml** — named volume for the database, `config.json` bind-mounted read-only so egg IDs change with a restart rather than a rebuild
- **ecosystem.config.cjs** — PM2, with credentials deliberately absent because `pm2 save` writes the environment to disk in plaintext
- **deploy/panelkit.service** — systemd, hardened with `ProtectSystem=strict` and every capability dropped
- **.github/workflows/ci.yml** — runs without secrets, so fork pull requests get the same signal

#### Documentation

`README.md` with troubleshooting organised by symptom, `SECURITY.md` with a threat model and an explicit list of what the bot does *not* protect against, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and this file.

### Known limitations

Each is a deliberate trade, documented rather than hidden.

**Live console output is unavailable.** Pterodactyl serves it over a websocket only; there is no REST endpoint. `server logs` reads a log *file* through the documented file-manager endpoint, with per-egg paths configured in `config.json`.

**Single instance only.** Component sessions and per-user locks live in process memory. Two instances would each hold half the sessions, and the locks that keep a user within `FREE_SERVER_LIMIT` would not serialise across them. Horizontal scaling would require moving both to Redis.

**Sessions do not survive a restart.** Open menus become inert, which is correct — their collectors are gone too.

**Credits are stored but not earned or spent.** The balance, `grantCredits` and an atomic `spendCredits` all exist. What credits *cost* is an operator policy decision, so no command consumes them.

**Panel-side drift is not reconciled automatically.** A server deleted directly in the panel leaves a local record holding the owner's limit slot. `admin user` and `admin servers` surface it, and `findStaleServers` / `pruneStaleServers` correct it, but nothing runs them on a schedule.

**`admin servers` shows panel user IDs for untracked servers.** A server created outside the bot has no Discord mapping to display.

**Backups are synchronous.** `files backup` compresses the server root in one operation, which is slow on a large server and subject to the panel's own limits. There is no progress reporting.

**Sub-users must already have a panel account.** Pterodactyl does not create one implicitly.

### Requirements

- Node.js 20.11 or newer (`import.meta.dirname`)
- A C++ toolchain for `better-sqlite3`, unless using Docker
- Pterodactyl Panel 1.x or newer
- The **Message Content Intent** enabled, or prefix commands are silently dead

### Dependencies

Four, pinned exactly:

| Package | Version | Why |
| --- | --- | --- |
| `discord.js` | 14.16.3 | Discord API client |
| `better-sqlite3` | 11.5.0 | Synchronous SQLite, which makes read-modify-write within one function atomic |
| `axios` | 1.7.7 | HTTP client with the timeout and redirect controls this needs |
| `dotenv` | 16.4.5 | `.env` loading |

`node:test` is the test runner and `node:crypto` generates every credential, so neither needs a package.

---

## Upgrade notes

### To 1.0.0

First release; nothing to upgrade from.

For a new installation, the two steps that are easy to miss:

1. **Enable the Message Content Intent** in the Discord Developer Portal. Without it `message.content` is empty and every prefix command silently does nothing, while slash commands keep working — which makes the cause hard to guess.

2. **Set `ADMIN_USER_IDS` or `ADMIN_ROLE_IDS`.** With both empty the bot falls back to the Discord Administrator permission, which in a shared server grants panel-wide control to every moderator holding it. The bot warns at startup while this is the case.

`config.json` ships with placeholder zeros for every egg ID and for `deploy.locationId`. That is deliberate — inventing plausible IDs would produce a bot that fails at provisioning with an opaque panel 422. Fill in at least one egg and the location before `server create` will work; the startup log names exactly what is missing.

---

## Conventions for future entries

Each release lists changes under the applicable headings, in this order: **Added**, **Changed**, **Deprecated**, **Removed**, **Fixed**, **Security**.

Three project-specific rules:

**Say what an operator must do.** An entry that describes a code change without its operational consequence is not useful to someone deciding whether to upgrade. "Added `PANEL_MAX_RETRIES`, default 3, no action needed" beats "refactored the retry policy".

**Flag anything requiring `npm run deploy`.** A command added, removed or renamed, or an option changed, needs slash commands re-registered. Because `PUT` replaces the whole scope, skipping it can leave a command registered that no longer exists.

**Security fixes name the impact, not the exploit.** Enough for an operator to judge urgency, without a working recipe for anyone who has not upgraded yet.

---

Coded by **Aditya** — [@adityatheog](https://github.com/adityatheog)
