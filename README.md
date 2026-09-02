<!-- Coded by Aditya | GitHub- @adityatheog -->

# PanelKit

A production-ready Discord bot that puts a Pterodactyl Panel behind Discord. Users create a panel account, provision a server, and control it with slash commands or an interactive dashboard — without ever touching the panel's admin interface.

Built with Discord.js v14, SQLite and the Pterodactyl Application and Client APIs. No framework, four dependencies, and a test suite that runs without credentials.

```
kx!server manage
┌────────────────────────────────────────────┐
│ Managing: My Server                        │
│ • Name: My Server                          │
│ • Type: Node.js                            │
│ • Identifier: `a1b2c3d4`                   │
│ • Address: play.example.com:25565          │
│                                            │
│ • State: 🟢 Running                         │
│ • Uptime: 2h 14m 3s                        │
│ • CPU: 12.40% of 100%                      │
│ • RAM: 384.2 MB / 1.0 GB (38%)             │
│ • Disk: 1.2 GB / 5.0 GB (24%)              │
└────────────────────────────────────────────┘
[ Start ] [ Stop ] [ Restart ] [ Refresh ]
[ Rename ] [ Change Image ] [ Reinstall ] [ Open in Panel ]
```

---

## Contents

- [What it does](#what-it-does)
- [Features](#features)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [Environment variables](#environment-variables)
- [Database](#database)
- [Registering slash commands](#registering-slash-commands)
- [Running locally](#running-locally)
- [Production deployment](#production-deployment)
- [Commands](#commands)
- [Updating](#updating)
- [Troubleshooting](#troubleshooting)
- [Project structure](#project-structure)
- [Architecture](#architecture)
- [Security](#security)
- [Limitations](#limitations)
- [Contributing](#contributing)
- [License](#license)

---

## What it does

Running a game hosting service means either giving every user a panel login and hoping they find their way around, or answering the same five questions in a support channel forever. PanelKit is the third option: the panel stays where it is, and Discord becomes the interface.

A user runs `kx!account create`. The bot generates a panel account with a random username and a cryptographically random password, delivers the credentials by direct message, and records the Discord-to-panel mapping. From then on they can provision a server, start and stop it, read its logs, change its container image, add sub-users and download a backup — all from Discord, all authorised against that mapping.

Administrators get their own category: provision on someone's behalf, suspend a user's servers, inspect an account, and reconcile the bot's records against the panel when the two disagree.

---

## Features

**Account management.** Panel accounts are generated with `crypto.randomBytes` using rejection sampling, so there is no modulo bias in the credentials. Passwords are shown exactly once, delivered by DM only, and stored nowhere — `account reset` is the recovery path, and it probes DM deliverability *before* changing the password so a closed inbox cannot lock a user out.

**Server provisioning.** `server create` reads the egg's own variables from the panel and merges operator overrides from `config.json`, so a required variable with no value is reported as a configuration error before anything is created rather than as an opaque panel 422 afterwards. Per-user limits are enforced inside a lock, so two concurrent requests cannot both pass the check.

**Interactive dashboard.** Live status, power controls, rename, container image switching and reinstall, all behind owner-bound component sessions that expire. Destructive actions require an explicit confirmation, and the confirmation is single-use.

**Sub-users.** Grant another panel account access to your server with a permission set the operator defines. Destructive server-level permissions are refused at config load, so a sub-user can never delete the server belonging to whoever invited them.

**Backups.** `files backup` archives the server root and delivers it by DM — attached when small, as a signed link when not. Neither the archive nor the link ever reaches a channel, because server configuration files routinely contain database passwords and API tokens.

**Logs.** `server logs` uploads the newest log file as an attachment, truncated from the front on a line boundary so the tail — where the error is — survives.

**Interactive help.** A paginated browser with a category selector and per-command detail, rendered from the command registry so it can never drift from what the bot actually implements.

**Two surfaces, one implementation.** Every command works as both `kx!server power a1b2c3d4 restart` and `/server power`. One declaration produces both, plus the help entry, so they cannot diverge.

**Production concerns, handled.** Per-user cooldowns, retry with backoff that honours `Retry-After`, graceful shutdown that checkpoints the WAL, structured JSON logging with secret redaction, a file-based liveness probe, and a project audit you can run in one command.

---

## Requirements

| Requirement | Notes |
| --- | --- |
| **Node.js 20.11 or newer** | 20.11 is the floor because the project uses `import.meta.dirname`. Node 22 is tested in CI. |
| **A C++ toolchain** | `better-sqlite3` compiles a native addon. On Debian or Ubuntu: `sudo apt install python3 make g++`. Not needed if you use Docker. |
| **A Discord application** | With a bot user, and the **Message Content Intent** enabled — prefix commands are silently dead without it. |
| **A Pterodactyl Panel** | Version 1.x or newer, reachable over HTTP or HTTPS from wherever the bot runs. |
| **Two API keys** | One Application key and one Client key. See [Pterodactyl setup](#pterodactyl-setup). |

Approximately 150 MB of RAM in normal operation, and a few megabytes of disk for the database.

---

## Installation

### With Docker

The shortest path, and the one that avoids compiling anything.

```bash
git clone https://github.com/adityatheog/panelkit-bot.git
cd panelkit-bot

cp .env.example .env
$EDITOR .env                 # fill in every value marked REQUIRED
$EDITOR config.json          # fill in the egg IDs and deploy.locationId

docker compose up -d
docker compose run --rm bot npm run deploy    # register slash commands, once
docker compose logs -f bot
```

### Directly with Node

```bash
git clone https://github.com/adityatheog/panelkit-bot.git
cd panelkit-bot

# better-sqlite3 needs a toolchain to compile its native addon.
sudo apt install python3 make g++

npm ci

cp .env.example .env
$EDITOR .env
$EDITOR config.json

npm run verify               # syntax, project audit and tests — no credentials needed
npm run deploy               # register slash commands, once
npm start
```

`npm run verify` is worth running before the first start. It checks that every expected file is present, that the command tree is intact, that `config.json` validates and that the database schema applies — all without needing a token or reaching the panel.

---

## Configuration

Configuration is split across two files, deliberately.

`.env` holds **secrets and per-deployment values**: tokens, API keys, the panel URL, policy thresholds. It is git-ignored.

`config.json` holds the **operator's catalogue**: which server types exist, what they cost, which container images are offered, how the help menu paginates. It is committed and reviewable.

### Pterodactyl setup

Two keys are needed, and they come from different places in the panel. Mixing them up is the most common setup problem — the symptom is a 403 from an endpoint that looks correct.

**Application API key** — Panel → **Admin** → **Application API** → **Create New**

Grant only what the bot uses:

| Resource | Permission | Used for |
| --- | --- | --- |
| Users | Read & Write | `account create`, `account delete`, `account reset` |
| Servers | Read & Write | `server create`, deletion, suspension, image changes |
| Nests | Read | reading egg variables to build a valid environment |
| Locations | Read | validating `deploy.locationId` |

Do not grant Nodes, Databases or Allocations write access; the bot never calls them. **A leaked Application key is equivalent to panel administrator access.**

**Client API key** — Panel → **Account** → **API Credentials** → **Create**

Client keys have no scopes; they inherit the permissions of the account that owns them. Use an account that can see every server the bot manages — a panel administrator account is simplest. Used for power actions, live statistics, rename, reinstall, sub-users and file operations.

### Finding the IDs

| Value | Where |
| --- | --- |
| `eggs.<key>.nestId` | Panel → Admin → Nests. The nest ID is in the URL: `/admin/nests/view/{nestId}` |
| `eggs.<key>.eggId` | Click into the egg. The ID is in the URL: `/admin/nests/egg/{eggId}` |
| `eggs.<key>.dockerImage` | On the egg's edit page, under Docker Images |
| `deploy.locationId` | Panel → Admin → Locations |
| `CLIENT_ID` | Discord Developer Portal → your application → General Information |
| `GUILD_ID` | Right-click your server → Copy Server ID (needs Developer Mode) |

### `config.json`

The shipped file has placeholder zeros for every egg ID. That is deliberate — inventing plausible IDs would produce a bot that fails at provisioning time with a confusing 422. An egg with `eggId: 0`, `nestId: 0` or an empty `dockerImage` is treated as unconfigured, hidden from the create menu, and named in a startup warning.

| Field | Meaning |
| --- | --- |
| `identity.name` | Shown in embeds and credential DMs. All branding lives here. |
| `identity.supportUrl` | Optional. Must be http or https if set. |
| `colors.primary` / `colors.error` | Required, six-digit hex. `success` and `warning` have defaults. |
| `account.emailDomain` | Domain for generated addresses: `<username>@domain`. |
| `account.usernameLength` / `passwordLength` | Clamped to safe ranges; a short password is refused. |
| `help.pageSize` | Commands per help page. 8 keeps four categories on one page and paginates Server. |
| `help.descriptionMax` | Truncation width in the help list. 51 matches the reference layout. |
| `cooldowns.defaultSeconds` | Applied to any command without an override. |
| `cooldowns.perCommand` | Per-command overrides, keyed by canonical name. Expensive commands carry more. |
| `deploy.locationId` | Panel location for automatic allocation. **Required before `server create` works.** |
| `deploy.dedicatedIp` / `portRange` | Passed through to the panel's deployment object. |
| `defaults.limits` | `memory` and `disk` in MB, `cpu` in percent, `io` between 10 and 1000. Zero memory or disk is refused. |
| `defaults.featureLimits` | `databases`, `allocations`, `backups` for new servers. |
| `subuser.defaultPermissions` | Granted by `server subuser add`. `settings.delete` is refused. |
| `backups.maxInlineBytes` | Archives up to this size are attached; larger ones are delivered as a link. |
| `logs.maxUploadBytes` | Log attachments are truncated to this, keeping the tail. |
| `plans` | The catalogue shown by `plans`. Empty means the command says so. |
| `eggs.<key>.label` | Shown in the server type selector. |
| `eggs.<key>.startup` | Overrides the egg's own startup command. Empty uses the egg's. |
| `eggs.<key>.environment` | Overrides for egg variables. Required variables with no default must be set here. |
| `eggs.<key>.logPaths` | Absolute paths tried in order by `server logs`. |
| `eggs.<key>.images` | Allowlist of `label → image` for the Change Image control. Empty disables it. |

Adding a server type means adding an entry to `eggs`. No source changes.

---

## Environment variables

Every variable the bot reads. `.env.example` documents each one inline with its default.

### Required

| Variable | Notes |
| --- | --- |
| `DISCORD_TOKEN` | Developer Portal → Bot → Reset Token. Not the OAuth2 client secret — the bot rejects that shape at startup. |
| `CLIENT_ID` | Application ID. Slash commands register under this, so a mismatch with the token means commands exist but do nothing. |
| `PANEL_URL` | Panel root. A trailing slash and an `/api` suffix are stripped automatically. |
| `PANEL_APP_KEY` | Application API key, prefixed `ptla_`. |
| `PANEL_CLIENT_KEY` | Client API key, prefixed `ptlc_`. Must differ from the Application key. |

### Recommended

| Variable | Default | Notes |
| --- | --- | --- |
| `GUILD_ID` | — | When set, slash commands register to that guild and appear instantly. Empty registers globally, which takes up to an hour. |
| `ADMIN_USER_IDS` | — | Comma-separated Discord user IDs allowed to run Admin commands. |
| `ADMIN_ROLE_IDS` | — | Comma-separated role IDs allowed to run Admin commands. |

**If both admin lists are empty, the bot falls back to the Discord "Administrator" permission and warns loudly at startup.** In a public server that grants panel-wide control to every moderator who holds Administrator. Set at least one list before inviting the bot anywhere shared.

### Optional

| Variable | Default | Notes |
| --- | --- | --- |
| `DEFAULT_PREFIX` | `kx!` | 1–8 characters, no whitespace. An alphanumeric prefix is warned about. |
| `ACCOUNT_AGE_DAYS` | `90` | Minimum Discord account age for self-service registration. `0` disables it and warns. |
| `FREE_SERVER_LIMIT` | `1` | Servers per user. Admin provisioning bypasses this. `0` refuses everyone and warns. |
| `STARTING_CREDITS` | `0` | Credits granted on account creation. |
| `DATABASE_PATH` | `./data/panelkit.sqlite` | Created automatically, with its parent directory. |
| `HEARTBEAT_PATH` | `./data/heartbeat` | Liveness file, rewritten every 30 seconds. |
| `PANEL_TIMEOUT_MS` | `15000` | Per-request timeout. Between 1000 and 120000. |
| `PANEL_MAX_RETRIES` | `3` | Total attempts including the first. `1` disables retries. |
| `VERIFY_PANEL_ON_STARTUP` | `true` | Verifies both API keys once at startup. Failure only warns. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error`. |
| `NODE_ENV` | `production` | |

Startup fails with a single error listing **every** missing or invalid variable, so a fresh `.env` takes one restart to fix rather than five. No secret value ever appears in an error message or a log line.

---

## Database

SQLite, via `better-sqlite3`. There is no setup step: the database, its parent directory and its schema are created on first start.

Two tables. `users` maps a Discord ID to a panel account; `servers` maps a Discord ID to a panel server. WAL journaling, foreign keys on, and a migration runner keyed on SQLite's own `user_version`.

Every statement is prepared and parameterised, and ownership is expressed in SQL rather than in JavaScript — `getOwnedServer` carries `WHERE identifier = ? AND discord_id = ?`, so a foreign caller matches zero rows regardless of what the calling code does.

```bash
node scripts/init-db.js                      # create or migrate, then report
node scripts/init-db.js --check              # report only, read-only
node scripts/init-db.js --backup ./backup.sqlite
```

`--backup` uses SQLite's online backup API, so the copy is consistent while the bot is running. Copying the file directly can capture a torn write-ahead log.

**Back this file up.** Losing it does not delete anything on the panel — the servers keep running — but the bot no longer knows who owns them, and every user loses access to their own server through Discord.

---

## Registering slash commands

Slash commands are registered as a deployment step, not on every boot. Discord rate-limits registration, and doing it at startup means a crash-looping process hammers the endpoint.

```bash
npm run deploy               # to GUILD_ID if set, otherwise globally
npm run deploy:global        # force global even with GUILD_ID set
npm run deploy:clear         # remove every registered command from the scope
node src/deploy-commands.js --dry-run    # print the payload, contact nothing
```

The payload is built from the same registry the bot executes, so registration cannot drift from implementation. The script refuses to deploy if any command in the registry would be unreachable in the payload — because `PUT` replaces the whole scope, so an incomplete payload would *remove* a working command rather than merely fail to add one.

Guild-scoped commands appear immediately. Global commands propagate over roughly an hour, so a deploy that looks like it did nothing usually has not finished.

---

## Running locally

```bash
npm start                    # production mode
npm run dev                  # restarts on source changes
npm run verify               # syntax, audit and tests
npm test                     # tests only
npm run health               # check the liveness file
```

For development, set `GUILD_ID` so slash commands appear instantly, and `LOG_LEVEL=debug` to see every panel request line (method and path only — never credentials).

---

## Production deployment

Three supported options. All three read credentials from the environment, run unprivileged, and use the same file-based liveness probe.

### Docker Compose

```bash
docker compose up -d
docker compose logs -f bot
docker compose ps                    # STATUS shows the health check result
docker compose exec bot npm run health
```

The database lives in a named volume so ownership works without matching a UID on the host. `config.json` is bind-mounted read-only, so egg IDs can change with a restart rather than a rebuild.

### PM2

```bash
pm2 start ecosystem.config.cjs
pm2 logs panelkit-bot
pm2 save && pm2 startup      # both, or the bot will not survive a reboot
pm2 install pm2-logrotate    # PM2 does not rotate logs on its own
```

Credentials are deliberately not in `ecosystem.config.cjs`: `pm2 save` writes the resolved environment to `~/.pm2/dump.pm2` in plaintext.

### systemd

```bash
sudo cp deploy/panelkit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now panelkit
journalctl -u panelkit -f
```

The unit is hardened: `ProtectSystem=strict` with only the data directory writable, every capability dropped, and a restricted syscall filter. `MemoryDenyWriteExecute` is deliberately **not** set — V8 needs writable-then-executable pages, and enabling it makes Node abort at startup with an unhelpful `mprotect` error.

### Whichever you choose

**Run one instance.** Component sessions and per-user locks live in process memory. Two instances would each hold half the sessions, and the locks that keep a user within `FREE_SERVER_LIMIT` would not serialise across them. Two gateway connections with the same token also means every command executes twice.

---

## Commands

24 commands in 5 categories. Every one works as both a prefix command and a slash command.

`kx!help` opens an interactive browser; `kx!help server power` jumps straight to one command's detail.

### Account

| Command | Description |
| --- | --- |
| `account create` | Create a panel account linked to your Discord account |
| `account delete` | Delete your panel account and all associated servers |
| `account info` | View your panel account details |
| `account reset` | Reset your panel account password |

### Admin

Requires `ADMIN_USER_IDS` or `ADMIN_ROLE_IDS`. Every action writes an audit line naming the actor.

| Command | Description |
| --- | --- |
| `create` | Create a panel account and server for another user |
| `admin servers` | List all servers across all users |
| `admin suspend` | Suspend all servers belonging to a user |
| `admin unsuspend` | Unsuspend all servers belonging to a user |
| `admin user` | Look up a user's panel account and servers |

### Files

| Command | Description |
| --- | --- |
| `files backup` | Archive and download your server files to your DMs |

### General

| Command | Description |
| --- | --- |
| `ping` | Check the bot latency |
| `plans` | View available hosting plans and pricing |
| `help` | Browse commands or get detail on a specific one |

### Server

| Command | Description |
| --- | --- |
| `server create` | Create a new server on the panel |
| `server delete` | Delete one of your servers |
| `server info` | View detailed information about your server |
| `server list` | List all your servers |
| `server logs` | Download the latest log file for your server |
| `server manage` | Open a management panel for your server |
| `server power` | Send a power action to your server |
| `server rename` | Rename one of your servers |
| `server subuser add` | Add a sub-user to your server |
| `server subuser remove` | Remove a sub-user from your server |
| `server usage` | View live resource usage for your server |

`ping`, `plans` and `help` work in direct messages. Everything else is guild-only, because authorisation needs a guild context.

---

## Updating

```bash
git pull
npm ci                       # if dependencies changed
npm run verify               # before restarting, not after
npm run deploy               # only if commands were added or changed
```

Then restart: `docker compose up -d --build`, `pm2 restart panelkit-bot`, or `sudo systemctl restart panelkit`.

Schema migrations apply automatically on start, inside a transaction per version. Running an **older** build against a newer database is refused rather than attempted — upgrade the bot rather than downgrading the database.

---

## Troubleshooting

### Startup

**`Missing required environment variables: …`**
`.env` is absent or incomplete. The message names every missing variable at once.

**`DISCORD_TOKEN does not look like a bot token`**
You have pasted the OAuth2 client secret. The bot token is under Bot → Reset Token and has three dot-separated segments.

**`PANEL_APP_KEY and PANEL_CLIENT_KEY are identical`**
The same key twice. They are different types created in different places — see [Pterodactyl setup](#pterodactyl-setup).

**`PANEL_APP_KEY looks like a client key`**
The two are swapped. This is a warning rather than an error, because older panels issue unprefixed keys.

**`Cannot find module` or `invalid ELF header`**
`better-sqlite3` was compiled against a different Node version or platform. `rm -rf node_modules && npm ci`.

**`ERR_REQUIRE_ESM` from PM2**
The config must be `ecosystem.config.cjs`, not `.js` — `package.json` declares `"type": "module"`.

### Commands

**Prefix commands do nothing, slash commands work**
The **Message Content Intent** is disabled in the Developer Portal. Without it `message.content` is empty and every prefix command is silently dead.

**Slash commands do not appear**
Run `npm run deploy`. With `GUILD_ID` set they appear immediately; globally they take up to an hour. Confirm `CLIENT_ID` matches the bot you invited.

**Slash commands appear but nothing happens**
`CLIENT_ID` and `DISCORD_TOKEN` belong to different applications. The bot logs this explicitly at startup.

**The bot replies to nothing in one channel**
It is missing **Embed Links**, **Send Messages** or **View Channel** there. The router logs exactly which.

### Panel

**`The panel rejected our API credentials`** (401)
A key is wrong or revoked. The log line names which API failed.

**`The panel denied access to this resource`** (403)
The Application key is missing a permission — usually Users or Servers write, or Nests read — or the Client key's account cannot see the server.

**`Could not reach the panel`**
Wrong `PANEL_URL`, DNS failure, or a firewall. Use the panel root; an `/api` suffix is stripped but the host must be right.

**`The panel presented an invalid TLS certificate`**
Expired or self-signed. Not retried, because it fails identically every time.

### Configuration

**`No server types are available yet`**
Every egg still has placeholder values. Fill in `eggId`, `nestId` and `dockerImage` for at least one.

**`Automatic deployment is not configured`**
Set `deploy.locationId` to a real panel location ID.

**`This server type is misconfigured: … requires API_KEY`**
The egg declares a required variable with no default. Set it under `eggs.<key>.environment`.

**Server creation fails with 400 or 422**
Usually no free allocation in the chosen location, or limits exceeding node capacity. The panel's own message is in the bot log, never shown to users.

### Operations

**`That server is still installing`**
Power actions are refused during installation, suspension and transfer, because the panel rejects them with an opaque 409.

**`No log file could be read`**
Pterodactyl exposes live console output over websockets only, so `server logs` reads a log *file*. Adjust `eggs.<key>.logPaths` to match where your egg writes.

**`ORPHANED SERVER` in the log**
Provisioning succeeded and the local write failed. The line carries the identifier. Use `admin user` to confirm, then either delete it in the panel or insert the row.

**A user cannot create a server but appears to own none**
A server was deleted directly in the panel, leaving a phantom record holding their slot. `admin user` reports the discrepancy.

**`SQLITE_CANTOPEN`**
The process cannot write to `DATABASE_PATH`. With Docker this is usually a bind mount whose host ownership does not match the container's `node` user — use the named volume.

**Credentials could not be delivered**
The user's DMs are closed. They enable direct messages from server members, then run `account reset`. The password is not recoverable and is deliberately not shown to administrators.

---

## Project structure

```
panelkit-bot/
├── src/
│   ├── index.js                  Startup sequence and graceful shutdown
│   ├── deploy-commands.js        Slash command registration
│   ├── commands/
│   │   ├── registry.js           One declaration → both surfaces + help
│   │   └── definitions/          24 commands, one file each
│   │       ├── account/  admin/  files/  general/  server/
│   ├── config/
│   │   ├── env.js                Environment validation and normalisation
│   │   └── config.js             config.json validation
│   ├── core/
│   │   ├── context.js            Surface-agnostic execution context
│   │   ├── cooldowns.js          Per-user, per-command throttling
│   │   ├── messageRouter.js      Prefix command dispatch
│   │   └── reply.js              Response helpers and the error funnel
│   ├── database/
│   │   └── db.js                 The only SQL in the project
│   ├── help/
│   │   ├── helpMenu.js           Pure rendering
│   │   └── helpController.js     Session and collector lifecycle
│   ├── interactions/
│   │   ├── router.js             Slash and component dispatch
│   │   └── dashboard.js          The server management panel
│   ├── services/
│   │   ├── pterodactyl.js        The only HTTP contracts
│   │   ├── retry.js              Retry policy, dependency-free
│   │   ├── accountService.js     Account lifecycle
│   │   ├── serverService.js      Provisioning, control, files
│   │   └── adminService.js       Privileged operations
│   └── utils/
│       ├── embeds.js  errors.js  format.js  locks.js
│       ├── logger.js  permissions.js  security.js
│       ├── sessions.js  validation.js
├── scripts/
│   ├── check.js                  Syntax and import verification
│   ├── verify-project.js         Structural audit
│   ├── init-db.js                Create, migrate, inspect, back up
│   └── healthcheck.js            Liveness probe
├── tests/                        19 files, no credentials needed
├── deploy/panelkit.service       systemd unit
├── .github/workflows/ci.yml      CI, runs without secrets
├── Dockerfile                    Multi-stage, unprivileged
├── docker-compose.yml
├── ecosystem.config.cjs          PM2
├── config.json
└── .env.example
```

---

## Architecture

Five decisions shape everything else.

**One command declaration, two surfaces.** A command declares a canonical space-separated name — `server subuser add` — and the registry produces the prefix invocation, the nested slash invocation and the help entry from it. Commands receive a surface-agnostic `ctx` and never touch a `Message` or an `Interaction`, which is what makes one `execute` serve both. Adding a command means adding one file.

**Authorisation is one function.** Every user-triggered server operation resolves `Discord user → local row → panel resource` through `serverService.requireOwnedServer()`. A user-supplied identifier never reaches the panel until that lookup returns a row. Missing and foreign servers produce an identical error, so the identifier space cannot be probed.

**All HTTP in one module.** `services/pterodactyl.js` is the only file that knows Pterodactyl's contracts. Two axios instances, never mixed, each with its own key. Callers receive plain camelCase objects, so a panel schema change is a one-line edit rather than a search across command files.

**All SQL in one module.** `database/db.js` holds every statement, prepared and parameterised. Ownership is scoped in the SQL itself, so a future handler that forgets the check still matches zero rows.

**Check-then-act is serialised.** Node returns to the event loop at every `await`, so a limit check followed by a panel call is a race. `utils/locks.js` provides per-key mutual exclusion; provisioning, deletion, sub-user changes and backups all run inside it.

---

## Security

Full detail in [SECURITY.md](SECURITY.md). The properties worth knowing:

**Ownership is enforced in SQL.** Not in JavaScript, where a refactor could omit it.

**Components carry no state.** A Discord custom ID is `namespace:action:sessionId`, and the session — holding the target server — lives in process memory keyed by an unguessable token. A button cannot be edited to act on someone else's server, because the server is not named in the button. Sessions are owner-bound and expire; a stale component gets "Timed Out" rather than executing.

**Admin access is explicit.** An allowlist, once configured, is authoritative — a guild administrator who is not on it is refused. Every admin action logs the actor and which rule granted access.

**Secrets never reach a log.** The logger redacts by key name *and* by value shape, at any depth. Panel API keys, bot tokens and `Authorization` headers are masked even inside an error message. `describeEnv` reduces every credential to a boolean, and the tests assert that no 8-character prefix or suffix survives.

**Credentials go to DMs only.** Passwords and signed download URLs are never posted in a channel and never shown to administrators. `account reset` probes deliverability before changing anything.

**Input is allowlisted.** Identifiers, server names, egg keys, power signals, emails and container images are validated by anchored patterns or set membership — on **both** surfaces, because Discord's client-side constraints are a convenience rather than a boundary.

**Destructive actions confirm.** Account deletion, server deletion and reinstall each require an explicit button press, and the confirmation is single-use.

**Failures are honest.** Account deletion aborts with nothing changed if any server cannot be removed, rather than reporting a success the user will not verify.

---

## Limitations

Stated plainly, because each is a deliberate trade rather than an oversight.

**Live console output is not available.** Pterodactyl serves it over a websocket only; there is no REST endpoint. `server logs` reads a log *file* through the documented file-manager endpoint, with per-egg paths. A real integration, but not the console stream.

**Single instance only.** Component sessions and per-user locks are in process memory. Horizontal scaling would require moving both to Redis.

**Sessions do not survive a restart.** Open menus become inert, which is correct — their collectors are gone too.

**Credits are stored but not earned or spent.** The balance, `grantCredits` and an atomic `spendCredits` all exist; no command consumes them. Wiring an economy is left to the operator.

**Panel-side changes are not reconciled automatically.** A server deleted directly in the panel leaves a local record. `admin user` and `admin servers` surface the discrepancy, and `findStaleServers` / `pruneStaleServers` exist to correct it — but nothing runs them on a schedule.

**`admin servers` shows panel user IDs for untracked servers.** A server created outside the bot has no Discord mapping to display.

**Backups are synchronous.** `files backup` compresses the server root in one operation, which is slow on a large server and subject to the panel's own limits. There is no progress reporting.

**Sub-users must already have a panel account.** Pterodactyl does not create one implicitly.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `npm run verify` must pass, commands go in `src/commands/definitions/`, and the architectural rules above are the ones worth respecting — all HTTP in the service layer, all SQL in the database layer, authorisation through `requireOwnedServer`.

Also in the repository: [SECURITY.md](SECURITY.md), [CHANGELOG.md](CHANGELOG.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

---

## License

MIT. See [LICENSE](LICENSE).

---

Coded by **Aditya** — [@adityatheog](https://github.com/adityatheog)
