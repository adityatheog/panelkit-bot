<!-- Coded by Aditya | GitHub- @adityatheog -->

<div align="center">

# PanelKit

**Run your Pterodactyl Panel from Discord.**

Users create panel accounts, provision servers, and control them with slash commands or an interactive dashboard — without ever opening the panel.

[![CI](https://github.com/adityatheog/panelkit-bot/actions/workflows/ci.yml/badge.svg)](https://github.com/adityatheog/panelkit-bot/actions/workflows/ci.yml)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A520.11-5FA04E?logo=node.js&logoColor=white)](https://nodejs.org)
[![discord.js](https://img.shields.io/badge/discord.js-14.16.3-5865F2?logo=discord&logoColor=white)](https://discord.js.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Commands](https://img.shields.io/badge/commands-24-informational)](#commands)
[![Dependencies](https://img.shields.io/badge/dependencies-4-brightgreen)](#dependencies)

[Quick start](#quick-start) · [Commands](#commands) · [Configuration](#configuration) · [Deployment](#deployment) · [Troubleshooting](#troubleshooting) · [Security](SECURITY.md)

</div>

---

```
kx!server manage
┌──────────────────────────────────────────────┐
│  Managing: My Server                         │
│  • Type: Node.js   • ID: a1b2c3d4            │
│  • Address: play.example.com:25565           │
│                                              │
│  • State:  🟢 Running                         │
│  • Uptime: 2h 14m 3s                         │
│  • CPU:    12.40% of 100%                    │
│  • RAM:    384.2 MB / 1.0 GB (38%)           │
│  • Disk:   1.2 GB / 5.0 GB (24%)             │
└──────────────────────────────────────────────┘
 [ Start ] [ Stop ] [ Restart ] [ Refresh ]
 [ Rename ] [ Change Image ] [ Reinstall ] [ Open in Panel ]
```

---

## Why

Running a hosting service means either handing every user a panel login and hoping they find their way around, or answering the same five questions in a support channel forever.

PanelKit is the third option. The panel stays where it is; Discord becomes the interface.

A user runs `kx!account create`. The bot generates a panel account, DMs the credentials, and records the Discord-to-panel mapping. From then on they provision, start, stop, inspect, back up and share their own server — all authorised against that mapping, none of it touching your admin interface.

---

## Quick start

<table>
<tr><th width="50%">Docker (recommended)</th><th width="50%">Node</th></tr>
<tr valign="top"><td>

```bash
git clone https://github.com/adityatheog/panelkit-bot
cd panelkit-bot

cp .env.example .env
$EDITOR .env          # 5 required values
$EDITOR config.json   # egg + location IDs

docker compose up -d
docker compose run --rm bot npm run deploy
```

No toolchain needed — the image compiles `better-sqlite3` in a build stage.

</td><td>

```bash
git clone https://github.com/adityatheog/panelkit-bot
cd panelkit-bot

sudo apt install python3 make g++
npm ci

cp .env.example .env && $EDITOR .env
$EDITOR config.json

npm run verify && npm run deploy && npm start
```

`npm run verify` needs **no credentials** — run it first.

</td></tr>
</table>

> [!IMPORTANT]
> Two things that silently break the bot if missed:
>
> **Enable the Message Content Intent** — Developer Portal → Bot → Privileged Gateway Intents. Without it every prefix command does nothing while slash commands keep working, which makes the cause almost impossible to guess.
>
> **Set `ADMIN_USER_IDS` or `ADMIN_ROLE_IDS`** — with both empty, admin commands fall back to the Discord *Administrator* permission. In a shared server that hands panel-wide control to every moderator holding it. The bot warns at startup while this is the case.

---

## Features

| | |
| --- | --- |
| 🔐 **Account provisioning** | Random usernames, `crypto.randomBytes` passwords with rejection sampling, DM-only delivery. Nothing stored — `account reset` is the recovery path, and it probes DM deliverability *before* changing the password so a closed inbox can't lock anyone out. |
| 🖥️ **Server lifecycle** | Create, delete, rename, reinstall, power, image switching. Egg variables are read from the panel and merged with your overrides, so a missing required value is a config error *before* provisioning rather than an opaque 422 after. |
| 🎛️ **Interactive dashboard** | Live status with owner-bound component sessions that expire. Destructive actions confirm, and the confirmation is single-use. |
| 👥 **Sub-users** | Share a server with a permission set you define. `settings.delete` is refused at config load, so a sub-user can never delete the owner's server. |
| 📦 **Backups & logs** | Archives and log files delivered by DM — attached when small, signed link when not. Never in a channel, because server configs routinely hold database passwords. |
| 📖 **Interactive help** | Paginated browser rendered from the command registry, so it can't drift from what the bot implements. |
| ⚡ **Two surfaces, one codebase** | Every command works as `kx!server power a1b2c3d4 restart` **and** `/server power`. One declaration produces both. |
| 🛡️ **Production hardened** | Per-user cooldowns, retry with jitter honouring `Retry-After`, graceful shutdown that checkpoints the WAL, JSON logging with secret redaction, file-based liveness probe, one-command audit. |

---

## Commands

**24 commands, 5 categories.** All work on both surfaces. `kx!help` opens the browser; `kx!help server power` jumps straight to one command.

<table>
<tr><td valign="top" width="50%">

**Account**
| Command | |
| --- | --- |
| `account create` | Create a linked panel account |
| `account delete` | Delete account + all servers |
| `account info` | View your account details |
| `account reset` | Reset your panel password |

**Files**
| Command | |
| --- | --- |
| `files backup` | Archive files to your DMs |

**General** · *works in DMs*
| Command | |
| --- | --- |
| `ping` | Check bot latency |
| `plans` | View hosting plans |
| `help` | Browse commands |

</td><td valign="top" width="50%">

**Server**
| Command | |
| --- | --- |
| `server create` | Provision a new server |
| `server delete` | Delete a server |
| `server info` | Detailed information |
| `server list` | List your servers |
| `server logs` | Download the latest log |
| `server manage` | Open the dashboard |
| `server power` | Start / stop / restart / kill |
| `server rename` | Rename a server |
| `server subuser add` | Grant access |
| `server subuser remove` | Revoke access |
| `server usage` | Live resource usage |

**Admin** · *allowlist-gated, audit-logged*
| Command | |
| --- | --- |
| `create` | Provision for another user |
| `admin servers` | List all panel servers |
| `admin suspend` | Suspend a user's servers |
| `admin unsuspend` | Restore them |
| `admin user` | Look up an account |

</td></tr>
</table>

---

## Requirements

| | |
| --- | --- |
| **Node.js ≥ 20.11** | The floor is 20.11 for `import.meta.dirname`. Node 22 is tested in CI. |
| **C++ toolchain** | `better-sqlite3` compiles a native addon: `python3 make g++`. Not needed with Docker. |
| **Discord application** | With a bot user and the **Message Content Intent** enabled. |
| **Pterodactyl Panel 1.x+** | Reachable over HTTP or HTTPS from the bot. |
| **Two API keys** | One Application, one Client — see below. |

Roughly 150 MB RAM and a few MB of disk.

---

## Configuration

Split in two, deliberately. **`.env`** holds secrets and per-deployment values (git-ignored). **`config.json`** holds your catalogue — server types, plans, images, cooldowns (committed and reviewable).

### The two API keys

They come from different places, and mixing them up is the most common setup problem — the symptom is a 403 from an endpoint that looks correct.

**Application key** — Admin → Application API → Create New

| Resource | Permission | For |
| --- | --- | --- |
| Users | Read & Write | account create / delete / reset |
| Servers | Read & Write | create, delete, suspend, image change |
| Nests | Read | reading egg variables |
| Locations | Read | validating `deploy.locationId` |

Nothing else. Not Nodes, Databases or Allocations write.

> [!WARNING]
> A leaked Application key is equivalent to **panel administrator access**. Treat `.env` like a production database password: `chmod 600`.

**Client key** — Account → API Credentials → Create

No scopes; it inherits the owning account's access. Use an account that can see every server the bot manages.

### Where the IDs live

| Value | Location |
| --- | --- |
| `nestId` | Admin → Nests — in the URL: `/admin/nests/view/{id}` |
| `eggId` | Click the egg — `/admin/nests/egg/{id}` |
| `dockerImage` | The egg's edit page, under Docker Images |
| `deploy.locationId` | Admin → Locations |
| `CLIENT_ID` | Developer Portal → General Information |
| `GUILD_ID` | Right-click your server → Copy Server ID |

> [!NOTE]
> `config.json` ships with **placeholder zeros**. That's deliberate — inventing plausible egg IDs produces a bot that fails at provisioning with a confusing 422. An egg with `eggId: 0` is treated as unconfigured, hidden from the menu, and named in a startup warning. Fill in one egg and `deploy.locationId` before `server create` works.

### Environment variables

<details>
<summary><b>Required</b> — five values, the bot won't start without them</summary>

| Variable | Notes |
| --- | --- |
| `DISCORD_TOKEN` | Bot → Reset Token. **Not** the OAuth2 client secret — the bot rejects that shape at startup. |
| `CLIENT_ID` | Application ID. Slash commands register under this; a mismatch with the token means commands exist but do nothing. |
| `PANEL_URL` | Panel root. A trailing slash and an `/api` suffix are stripped automatically. |
| `PANEL_APP_KEY` | Application key, prefixed `ptla_`. |
| `PANEL_CLIENT_KEY` | Client key, prefixed `ptlc_`. Must differ from the Application key. |

</details>

<details>
<summary><b>Recommended</b> — admin access and instant command registration</summary>

| Variable | Default | Notes |
| --- | --- | --- |
| `GUILD_ID` | — | Set it and slash commands appear **instantly**. Empty registers globally, taking up to an hour. |
| `ADMIN_USER_IDS` | — | Comma-separated user IDs for Admin commands. |
| `ADMIN_ROLE_IDS` | — | Comma-separated role IDs for Admin commands. |

</details>

<details>
<summary><b>Optional</b> — policy, storage, networking, logging</summary>

| Variable | Default | Notes |
| --- | --- | --- |
| `DEFAULT_PREFIX` | `kx!` | 1–8 chars, no whitespace. An alphanumeric prefix is warned about. |
| `ACCOUNT_AGE_DAYS` | `90` | Minimum Discord account age to self-register. `0` disables it and warns. |
| `FREE_SERVER_LIMIT` | `1` | Servers per user. Admin provisioning bypasses this. |
| `STARTING_CREDITS` | `0` | Credits on account creation. |
| `DATABASE_PATH` | `./data/panelkit.sqlite` | Created automatically with its parent. |
| `HEARTBEAT_PATH` | `./data/heartbeat` | Liveness file, rewritten every 30s. |
| `PANEL_TIMEOUT_MS` | `15000` | Between 1000 and 120000. |
| `PANEL_MAX_RETRIES` | `3` | Total attempts including the first. `1` disables retries. |
| `VERIFY_PANEL_ON_STARTUP` | `true` | Verifies both keys once. Failure only warns. |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` |
| `NODE_ENV` | `production` | |

</details>

Startup fails with **one** error listing *every* missing or invalid variable — so a fresh `.env` takes one restart to fix, not five. No secret value ever appears in an error or a log line.

<details>
<summary><b><code>config.json</code> reference</b></summary>

| Field | Meaning |
| --- | --- |
| `identity.name` | Shown in embeds and credential DMs. All branding lives here. |
| `colors.primary` / `error` | Required, six-digit hex. `success` and `warning` have defaults. |
| `account.emailDomain` | Generated addresses: `<username>@domain`. |
| `account.usernameLength` / `passwordLength` | Clamped to safe ranges; a short password is refused. |
| `help.pageSize` | Commands per help page. `8` keeps four categories on one page. |
| `help.descriptionMax` | Truncation width in the help list. |
| `cooldowns.defaultSeconds` | Applied to any command without an override. |
| `cooldowns.perCommand` | Overrides keyed by canonical name. Expensive commands carry more. |
| `deploy.locationId` | **Required** before `server create` works. |
| `defaults.limits` | `memory`/`disk` in MB, `cpu` percent, `io` 10–1000. Zero memory or disk is refused. |
| `subuser.defaultPermissions` | Granted by `server subuser add`. `settings.delete` is refused. |
| `backups.maxInlineBytes` | Archives up to this are attached; larger become links. |
| `logs.maxUploadBytes` | Log attachments truncated to this, keeping the tail. |
| `plans` | The `plans` catalogue. Empty means the command says so. |
| `eggs.<key>.environment` | Overrides for egg variables. Required ones with no default go here. |
| `eggs.<key>.logPaths` | Absolute paths tried in order by `server logs`. |
| `eggs.<key>.images` | Allowlist for Change Image. Empty disables the button. |

Adding a server type means adding an `eggs` entry. No source changes.

</details>

---

## Deployment

Three supported paths. All read credentials from the environment, run unprivileged, and share one file-based liveness probe.

<details>
<summary><b>Docker Compose</b> — named volume, hot-reloadable config</summary>

```bash
docker compose up -d
docker compose logs -f bot
docker compose ps                     # STATUS shows the health check
docker compose exec bot npm run health
```

The database lives in a named volume so ownership works without matching a host UID. `config.json` is bind-mounted read-only, so egg IDs change with a restart rather than a rebuild.

**Back up while running:**
```bash
docker compose exec bot node scripts/init-db.js --backup /app/data/backup.sqlite
docker compose cp bot:/app/data/backup.sqlite ./backup.sqlite
```

</details>

<details>
<summary><b>PM2</b> — for a host that already has Node</summary>

```bash
pm2 start ecosystem.config.cjs
pm2 logs panelkit-bot
pm2 save && pm2 startup      # both, or it won't survive a reboot
pm2 install pm2-logrotate    # PM2 doesn't rotate logs itself
```

The config is `.cjs` because `package.json` declares `"type": "module"` and PM2 loads config with `require()`. Credentials are deliberately absent from it — `pm2 save` writes the environment to `~/.pm2/dump.pm2` in plaintext.

</details>

<details>
<summary><b>systemd</b> — hardened unit, journald logging</summary>

```bash
sudo cp deploy/panelkit.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now panelkit
journalctl -u panelkit -f
```

`ProtectSystem=strict` with only the data directory writable, every capability dropped, restricted syscall filter. `MemoryDenyWriteExecute` is deliberately **not** set — V8 needs writable-then-executable pages, and enabling it makes Node abort with an unhelpful `mprotect` error.

</details>

> [!CAUTION]
> **Run one instance.** Component sessions and per-user locks live in process memory. Two instances would each hold half the sessions, and the locks that keep users within `FREE_SERVER_LIMIT` wouldn't serialise across them. Two gateway connections on one token also means every command executes twice.

---

## Development

```bash
npm run verify     # syntax + audit + tests — no credentials needed
npm test           # tests only
npm run dev        # restart on source changes
npm run health     # check the liveness file
npm run deploy     # register slash commands
```

| Script | What it catches |
| --- | --- |
| `npm run syntax` | Parses **and imports** every module, so a renamed export or a broken relative path fails here rather than at startup. |
| `npm run audit` | Structural completeness: expected files, the command tree exactly 24 commands in 5 categories in order, both surfaces wired, config valid, schema applying, no placeholders, no committed secrets. |
| `npm test` | 19 files, `node:test`, no framework. |

Set `GUILD_ID` and `LOG_LEVEL=debug` while developing.

### Registering slash commands

```bash
npm run deploy                            # GUILD_ID if set, else global
npm run deploy:global                     # force global
npm run deploy:clear                      # remove all from the scope
node src/deploy-commands.js --dry-run     # print the payload, contact nothing
```

The payload is built from the same registry the bot executes, so registration can't drift from implementation. The script refuses to deploy if any command would be unreachable in the payload — because `PUT` replaces the whole scope, an incomplete payload would *remove* a working command.

---

## Database

SQLite via `better-sqlite3`. No setup step: the file, its parent directory and the schema are created on first start.

```bash
node scripts/init-db.js                        # create or migrate, then report
node scripts/init-db.js --check                # read-only report
node scripts/init-db.js --backup ./backup.sqlite
```

Two tables: `users` maps a Discord ID to a panel account, `servers` maps a Discord ID to a panel server. WAL journaling, foreign keys on, migrations keyed on SQLite's own `user_version` and applied in a transaction per version.

Every statement is prepared and parameterised, and **ownership is expressed in SQL** — `getOwnedServer` carries `WHERE identifier = ? AND discord_id = ?`, so a foreign caller matches zero rows regardless of calling code.

> [!IMPORTANT]
> **Back this file up.** Losing it deletes nothing on the panel — servers keep running — but the bot no longer knows who owns them, and every user loses access through Discord. Use `--backup` rather than copying the file, which can capture a torn write-ahead log.

---

## Troubleshooting

Organised by symptom, because that's what you have.

<details>
<summary><b>Startup fails</b></summary>

| Message | Cause |
| --- | --- |
| `Missing required environment variables: …` | `.env` incomplete. Every missing variable is named at once. |
| `DISCORD_TOKEN does not look like a bot token` | You pasted the OAuth2 client secret. The bot token is under Bot → Reset Token and has three dot-separated segments. |
| `PANEL_APP_KEY and PANEL_CLIENT_KEY are identical` | Same key twice. Different types, different places. |
| `PANEL_APP_KEY looks like a client key` | Swapped. A warning, not an error — older panels issue unprefixed keys. |
| `Cannot find module` / `invalid ELF header` | `better-sqlite3` compiled against a different Node or platform. `rm -rf node_modules && npm ci`. |
| `ERR_REQUIRE_ESM` from PM2 | Config must be `ecosystem.config.cjs`, not `.js`. |
| `SQLITE_CANTOPEN` | Can't write `DATABASE_PATH`. With Docker this is usually a bind mount whose host ownership doesn't match the container's `node` user — use the named volume. |

</details>

<details>
<summary><b>Commands don't work</b></summary>

| Symptom | Cause |
| --- | --- |
| Prefix commands do nothing, slash commands work | **Message Content Intent disabled.** `message.content` is empty, so every prefix command is silently dead. |
| Slash commands don't appear | Run `npm run deploy`. With `GUILD_ID` they appear immediately; globally, up to an hour. |
| Slash commands appear but nothing happens | `CLIENT_ID` and `DISCORD_TOKEN` belong to different applications. The bot logs this explicitly at startup. |
| Silent in one channel only | Missing **Embed Links**, **Send Messages** or **View Channel**. The router logs exactly which. |

</details>

<details>
<summary><b>Panel errors</b></summary>

| Message | Cause |
| --- | --- |
| `The panel rejected our API credentials` | A key is wrong or revoked. The log names which API failed. |
| `The panel denied access to this resource` | Application key missing a permission — usually Users or Servers write, or Nests read. Or the Client key's account can't see the server. |
| `Could not reach the panel` | Wrong `PANEL_URL`, DNS, or a firewall. Use the panel root. |
| `The panel presented an invalid TLS certificate` | Expired or self-signed. Not retried, because it fails identically every time. |
| Creation fails 400/422 | Usually no free allocation in the location, or limits exceeding node capacity. The panel's own message is in the log, never shown to users. |

</details>

<details>
<summary><b>Configuration errors</b></summary>

| Message | Fix |
| --- | --- |
| `No server types are available yet` | Every egg still has placeholders. Fill in `eggId`, `nestId`, `dockerImage` for at least one. |
| `Automatic deployment is not configured` | Set `deploy.locationId`. |
| `This server type is misconfigured: … requires API_KEY` | The egg declares a required variable with no default. Set it under `eggs.<key>.environment`. |

</details>

<details>
<summary><b>Operational oddities</b></summary>

| Symptom | Explanation |
| --- | --- |
| `That server is still installing` | Power actions are refused during installation, suspension and transfer — the panel rejects them with an opaque 409. |
| `No log file could be read` | Pterodactyl exposes console over websockets only, so `server logs` reads a *file*. Adjust `eggs.<key>.logPaths`. |
| `ORPHANED SERVER` in the log | Provisioning succeeded, the local write failed. The line carries the identifier. `admin user` confirms it. |
| User can't create a server but owns none | A server was deleted directly in the panel, leaving a phantom record holding their slot. `admin user` reports it. |
| Credentials not delivered | DMs closed. They enable direct messages from server members, then run `account reset`. The password is not recoverable and is deliberately not shown to administrators. |

</details>

---

## Architecture

Five decisions shape everything else.

**One declaration, two surfaces.** A command declares a canonical name — `server subuser add` — and the registry produces the prefix invocation, the nested slash invocation and the help entry. Commands receive a surface-agnostic `ctx` and never touch a `Message` or an `Interaction`. Adding a command means adding one file.

**Authorisation is one function.** Every user-triggered server operation resolves `Discord user → local row → panel resource` through `requireOwnedServer()`. A user-supplied identifier never reaches the panel until that returns a row, and missing and foreign servers produce an identical error so the ID space can't be probed.

**All HTTP in one module.** `services/pterodactyl.js` owns every Pterodactyl contract. Two axios instances, never mixed. Callers get plain camelCase objects, so a panel schema change is a one-line edit.

**All SQL in one module.** `database/db.js` holds every statement, prepared and parameterised, with ownership scoped in the SQL itself.

**Check-then-act is serialised.** Node returns to the event loop at every `await`, so a limit check followed by a panel call is a race. `utils/locks.js` provides per-key mutual exclusion.

<details>
<summary><b>Project layout</b></summary>

```
src/
├── index.js                  Startup sequence and graceful shutdown
├── deploy-commands.js        Slash command registration
├── commands/
│   ├── registry.js           One declaration → both surfaces + help
│   └── definitions/          24 commands, one file each
├── config/                   env.js, config.js — validation
├── core/                     context, cooldowns, messageRouter, reply
├── database/db.js            The only SQL in the project
├── help/                     helpMenu (pure), helpController (stateful)
├── interactions/             router, dashboard
├── services/                 pterodactyl, retry, account, server, admin
└── utils/                    validation, security, sessions, locks,
                              logger, errors, embeds, format, permissions
scripts/                      check, verify-project, init-db, healthcheck
tests/                        19 files, no credentials needed
deploy/panelkit.service       systemd unit
```

</details>

---

## Security

Full detail in [SECURITY.md](SECURITY.md), including a threat model and an explicit list of what this **doesn't** protect against. The properties worth knowing:

- **Ownership enforced in SQL**, not in JavaScript where a refactor could omit it
- **Components carry no state** — a custom ID is `namespace:action:sessionId`, and the session lives in memory keyed by an unguessable token, so a button can't be edited to target someone else's server
- **Admin allowlists are authoritative** once set; a guild administrator not on the list is refused, and every admin action logs the actor and which rule granted access
- **Secrets never reach a log** — redaction by key name *and* value shape, recursively. `describeEnv` reduces every credential to a boolean, and tests assert no 8-character fragment survives
- **Credentials go to DMs only**, never a channel, never to administrators
- **Input allowlisted on both surfaces**, because Discord's client-side constraints are a convenience rather than a boundary
- **Failures are honest** — account deletion aborts with nothing changed if any server can't be removed, rather than reporting a success nobody will verify

Found something? **Don't open a public issue** — see [SECURITY.md](SECURITY.md).

---

## Limitations

Each is a deliberate trade, not an oversight.

| | |
| --- | --- |
| **No live console** | Pterodactyl serves it over websockets only. `server logs` reads a log *file* through the documented file-manager endpoint. A real integration, but not the stream. |
| **Single instance** | Sessions and locks are in process memory. Scaling means moving both to Redis. |
| **Sessions don't survive restarts** | Open menus go inert — correct, since their collectors are gone too. |
| **Credits stored, not spent** | The balance and an atomic `spendCredits` exist; no command consumes them. What credits *cost* is your policy decision. |
| **Drift isn't auto-reconciled** | A server deleted in the panel leaves a local record. `admin user` surfaces it and `pruneStaleServers` fixes it, but nothing runs on a schedule. |
| **Backups are synchronous** | One compression operation, slow on large servers, no progress reporting. |
| **Sub-users need a panel account** | Pterodactyl doesn't create one implicitly. |

---

## Dependencies

Four, pinned exactly. `node:test` is the test runner and `node:crypto` generates every credential, so neither needs a package.

| Package | Version | Why |
| --- | --- | --- |
| [`discord.js`](https://discord.js.org) | 14.16.3 | Discord API client |
| [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) | 11.5.0 | Synchronous SQLite — makes read-modify-write within one function atomic |
| [`axios`](https://axios-http.com) | 1.7.7 | The timeout and redirect controls this needs |
| [`dotenv`](https://github.com/motdotla/dotenv) | 16.4.5 | `.env` loading |

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). In short: `npm run verify` must pass, commands go in `src/commands/definitions/`, and the five architectural rules above are the ones worth respecting.

Also here: [SECURITY.md](SECURITY.md) · [CHANGELOG.md](CHANGELOG.md) · [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)

---

<div align="center">

**MIT** licensed · see [LICENSE](LICENSE)

Coded by **Aditya** — [@adityatheog](https://github.com/adityatheog)

</div>
