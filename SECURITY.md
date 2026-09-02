<!-- Coded by Aditya | GitHub- @adityatheog -->

# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting — Security → Report a vulnerability on this repository — or contact the maintainer through the profile listed in `package.json`.

Please include the affected version, reproduction steps, and what an attacker gains. A proof of concept against your own instance is welcome; please do not test against a panel you do not own.

Expect an acknowledgement within 72 hours, an assessment within a week, and a fix or documented mitigation within 14 days for anything confirmed. If a report turns out to be a configuration issue rather than a bug, you will get an explanation of why — and if the documentation made that misconfiguration likely, that counts as a bug in the documentation and gets fixed.

## Supported versions

The latest release on `main` receives security fixes. This project has no long-term support branches.

---

## Threat model

This is the part worth reading before deploying.

**PanelKit holds credentials that can create and destroy game servers and panel accounts.** A compromise of `PANEL_APP_KEY` is equivalent to Pterodactyl administrator access: it can create users, delete servers, and read every server's configuration. Treat `.env` with the same care as a production database password.

The assets, in order of consequence:

| Asset | Compromise means |
| --- | --- |
| `PANEL_APP_KEY` | Full panel administrative control. Every server on the panel, not just the bot's. |
| `PANEL_CLIENT_KEY` | Read and write access to every server the owning account can see, including file contents. |
| `DISCORD_TOKEN` | Full control of the bot identity: read every channel it can see, act as it in every guild. |
| The SQLite database | The Discord-to-panel mapping. Not credentials — no password is ever stored — but it identifies which Discord user owns which server. |
| A generated panel password | One user's panel account. Returned once at creation or reset and never persisted. |
| A signed download URL | The contents of one server's files, to anyone holding the URL, with no authentication. |

The adversaries considered:

**An ordinary Discord user** who can see the bot. They can send any command with any argument, and they can send component interactions with arbitrary custom IDs for any message they can see. Everything in the next section assumes this.

**A user with elevated Discord permissions** in a guild the bot has joined. Notably, they may hold the Administrator permission — which is why an explicit admin allowlist overrides it.

**A malicious or compromised dependency.** Four direct dependencies, all pinned exactly. The systemd unit mounts the filesystem read-only except the data directory, so a compromised package cannot rewrite the bot's own source to persist.

**A panel that is hostile or misconfigured.** The bot refuses redirects, so a panel cannot forward the `Authorization` header to another host. It never sends the panel bearer token to a node URL.

Explicitly **not** in scope: an attacker with shell access on the bot host, or with read access to `.env`. At that point they have the credentials directly, and no application-level control helps.

---

## Implemented protections

Each of these has tests asserting the negative case — that the attack fails — rather than only the happy path.

### Authorisation

**Ownership is resolved in SQL, not in JavaScript.** Every user-triggered server operation goes through `serverService.requireOwnedServer()`, which queries `WHERE identifier = ? AND discord_id = ?`. A foreign caller matches zero rows regardless of what the calling code does — so a future handler that forgets the check still has no access. Twelve public methods are individually tested to refuse a stranger *and* to make no panel request while doing so.

**Missing and foreign resources are indistinguishable.** An 8-character lowercase-alphanumeric identifier space is enumerable. `requireOwnedServer` returns the same error, code and status for a server that does not exist and one belonging to someone else, so probing yields nothing.

**Ownership checks precede panel requests.** Reaching the panel first and refusing afterwards would leak existence through the panel's own audit log and through response timing, even with the bot's answer unchanged.

**Admin allowlists are authoritative.** `ADMIN_USER_IDS` and `ADMIN_ROLE_IDS` are checked in both routers before any handler runs. Once either is set, it is the only authority — a guild administrator who is not on the list is refused. The Discord Administrator fallback exists only so a fresh install is administrable, and the bot warns loudly at startup while it is active.

> **If both lists are empty, every moderator holding Administrator in any guild the bot joins can suspend other users' servers and provision accounts on their behalf.** Set at least one list before public use.

**Admin actions are audited.** Every privileged operation logs the actor, the target, the outcome, and which rule granted access — user allowlist, role allowlist, or the Administrator fallback. That distinction is the difference between a routine log line and an incident.

**Both member shapes are handled.** discord.js supplies a `GuildMember` when the guild is cached and a raw `APIInteractionGuildMember` when it is not, with `roles` as a plain array and `permissions` as a decimal string. Code reading only `roles.cache` denies role-based admin access intermittently in production. Both are parsed.

### Interactive components

**Custom IDs carry no state.** A custom ID is `namespace:action:sessionId`. Everything identifying the target — the server identifier, the panel server ID, the page number — lives server-side in `utils/sessions.js`, keyed by a 72-bit random token. A user cannot edit a button to act on a server they do not own, because the server is not named in the button. Tests assert that no identifier, panel ID or owner ID appears in any rendered custom ID.

**Substituting another session's token does not help.** It resolves to that session, whose owner check then refuses the caller.

**Sessions are owner-bound and verified in the handler.** Discord's UI visibility is not an authorisation boundary: anyone who can see a message can send its component interactions. Every collector compares `interaction.user.id` against the session owner before acting.

**Expiry is enforced on read.** Not only by the periodic sweeper — a component pressed between sweeps still resolves to nothing. A stale component receives the "Timed Out" reply rather than executing.

**Confirmations are single-use.** Destructive flows delete the session *before* the work begins, not after, because deleting an account with several servers takes tens of seconds during which the button remains clickable. A second press falls through to the router and is refused.

**The session store is bounded.** A cap with oldest-first eviction, so component spam cannot grow the map without limit. The worst outcome of eviction is one user's menu expiring early.

### Input validation

**Allowlist, never blocklist.** Identifiers, server names, egg keys, power signals, emails, Discord IDs, UUIDs, permissions and file paths are each validated by an anchored pattern or set membership. A novel payload fails by default rather than needing a new rule.

**Slash-command data is revalidated.** Discord enforces option types and lengths client-side and in its own API, but a stale registered command or a crafted request can deliver values that violate them. Both surfaces run the same validators, and the tests assert that identical bad input produces an identical error message — so a user cannot pick a surface with a weaker check.

**Objects cannot smuggle values past a length check.** The coercion helper returns `''` for objects rather than calling `String(raw)`, and a test asserts a hostile `toString` is never invoked.

**Path traversal is checked segment by segment.** A leading-slash test alone accepts `/logs/../../etc/passwd`, so whole `..` segments are rejected separately while a legitimate filename like `/logs/..log` is allowed.

**Server names exclude markdown and mention syntax.** They render in embeds throughout the bot, including a dashboard that refreshes, so a name containing `@everyone` or backticks would ping a channel or break formatting repeatedly.

**Container images come from an allowlist only.** The Change Image control sends an *index* into the configured list rather than an image string, and `serverService` revalidates the resolved image against the same list. There is no path — crafted payload included — by which a user runs a container the operator did not configure.

**Destructive sub-user permissions are refused at config load.** Pterodactyl accepts `settings.delete` in a permission list, and an operator copying from panel documentation could include it — at which point every sub-user added through the bot could delete the server belonging to whoever invited them. The config validator rejects it by name.

### Credentials

**Generated with `crypto.randomBytes` and rejection sampling.** A `byte % alphabet.length` implementation produces valid-looking passwords with measurably reduced entropy in the first few symbols, and every naive test passes. Distribution is asserted across 2,000 samples with a 15% deviation threshold.

**Delivered by direct message only.** Passwords and signed download URLs never appear in a channel, never in a log, and never in an error. They are returned from the service exactly once and stored nowhere — which is why there is no password lookup for administrators, and why `admin user` says so explicitly.

**Deliverability is probed before anything irreversible.** `account reset` sends a cheap message *before* changing the password, so a closed inbox produces a clean refusal with the existing password intact rather than locking the user out. `files backup` probes before compressing, so a closed inbox does not waste a minute of node time and leave an orphaned archive.

**Undelivered credentials are not shown as a fallback.** An ephemeral channel reply is not a secure channel — it is visible to anyone shoulder-surfing and persists in the client. When a DM fails, the user is told how to retry; the value is not offered another way.

**Recovery does not require an administrator.** `account reset` regenerates and redelivers, so a lost password never creates a reason for an operator to hold user credentials.

### Secrets in logs

**Redaction is by key name and by value shape, recursively.** The logger masks any key matching token, secret, password, authorization, apikey, cookie or credential at any depth — and separately masks Pterodactyl key prefixes, Discord token shapes and `Bearer` values wherever they appear, including inside a plain string.

**Raw errors are never logged.** An axios error carries the full request config including the `Authorization` header. Every panel failure is normalised before it propagates, and `toLogMeta` builds an explicit projection rather than passing the error object through.

**Users see curated text only.** `toUserMessage` returns a generic message for anything unrecognised, because an unreviewed exception message is by definition one that has not been checked for safety. Panel error details — which name egg variables and node configuration — are captured for operators and withheld from users.

**The startup log carries no fragment of a secret.** `describeEnv` reduces every credential to a boolean, and the tests assert that no 8, 12 or 16 character prefix or suffix survives — a partial leak still narrows a brute-force search.

**Validation errors never echo values.** Even for a value that failed validation, because a mistyped token is still a token and error messages end up in issue reports.

### Network

**Redirects are refused.** Both axios instances set `maxRedirects: 0`. Axios follows redirects by default and forwards the `Authorization` header, so a panel that redirected an API path to another host would hand over the Application key. A redirect surfaces as an error instead.

**Signed URLs never carry the panel token.** A download URL points at a *node*, not the panel, and authenticates by itself. `fetchSignedFile` uses a bare axios call, and a test asserts no `Authorization` header reaches the node.

**Non-idempotent requests are never replayed.** HTTP 429 means the request was rejected before execution, so it is safe to retry for any method. A 5xx or a socket error leaves the outcome unknown — the panel may have created the server and then failed to respond — so only GET is retried. Every state-changing call additionally passes an explicit veto, so a future change to the retry default cannot start duplicating servers.

**TLS failures are not retried.** An expired certificate fails identically every time; retrying only delays the operator seeing the cause.

**Credentials in `PANEL_URL` are refused.** They would be sent on every request and would appear in any log recording the base URL.

**http to a non-local host warns.** Some deployments terminate TLS at a proxy, so it is not fatal — but the operator should know API keys are crossing the network in cleartext.

### Persistence

**Every statement is prepared and parameterised.** No SQL is built by concatenation. A test asserts that injection payloads match no row and that the surrounding tables survive.

**Credit spending is atomic.** The balance check lives in the `WHERE` clause, so a read-then-write double-spend is impossible; SQLite arbitrates.

**No SQL text reaches a user.** better-sqlite3 error messages include the statement, which names tables and columns. Every failure is normalised to a generic message.

**Ownership-scoped writes.** `updateServer` and `deleteServer` both carry `AND discord_id = ?`, so a foreign caller changes zero rows.

### Concurrency

**Check-then-act is serialised.** Node returns to the event loop at every `await`, so a limit check followed by a panel call is a race: two concurrent requests both read a count of zero, both pass, and the user ends up over `FREE_SERVER_LIMIT`. Provisioning, deletion, sub-user changes and backups run inside per-key locks. The test reproduces the race unlocked — asserting it *fails* — then locked.

**Re-entrant acquisition is detected.** Recursive acquisition of the same key can never succeed and would hang forever with no error. It throws instead, naming the key.

### Destructive operations

**Confirmation is required.** Account deletion, server deletion and reinstall each need an explicit button press. Deletion prompts name what will be destroyed — every server by name and identifier — because "delete my account" and "delete my four servers" are not the same decision in most people's heads.

**Success is never reported unless it happened.** Account deletion removes servers first, and if any cannot be removed the operation aborts with nothing changed locally. A user who reads "Account Deleted" will not go and check whether their servers are still consuming resources.

**Reconciliation never infers absence from ambiguity.** Only a 404 proves a server is gone. Reading "deleted" from a 502 during an outage would let one sweep destroy every live mapping in the database, so every other status leaves the record alone — and each candidate is re-verified immediately before removal.

**Rollback where it is safe, and honesty where it is not.** A failed local write after account creation rolls the panel account back. A failed local write after *server* creation deliberately does not — deleting a server that may already be installing risks destroying files — so the error names the identifier and the log line is tagged `ORPHANED SERVER`.

### Abuse

**Per-user, per-command cooldowns.** Discord's rate limits protect Discord, not the panel. A user looping `files backup` makes a node compress a filesystem repeatedly. Cooldowns are recorded only when a command is *allowed* to proceed, so hammering a command does not extend its own penalty.

**A Discord account age requirement.** `ACCOUNT_AGE_DAYS` raises the cost of throwaway-account abuse, and fails closed on an unusable creation timestamp rather than letting a partial user object bypass it.

**Bounded fan-out.** Live state lookups, bulk suspensions and reconciliation sweeps are all capped, so one command cannot issue an unbounded burst of panel requests.

**Bounded memory.** The session store and the cooldown store both have caps and sweepers; the lock manager reference-counts and deletes its entries rather than retaining one per user who has ever run a command.

---

## Hardening checklist

Before exposing the bot to users who are not you:

- [ ] **Set `ADMIN_USER_IDS` or `ADMIN_ROLE_IDS`.** Without one, admin commands fall back to the Discord Administrator permission.
- [ ] **Grant the Application key only Users read/write, Servers read/write, Nests read and Locations read.** Not Nodes, Databases or Allocations write.
- [ ] **`chmod 600 .env`** and confirm it is not tracked: `git ls-files .env` should print nothing.
- [ ] **Use `https://` for `PANEL_URL`** unless the panel is on the same host.
- [ ] **Run as an unprivileged user.** The Docker image, the systemd unit and the PM2 config all do; a manual `node src/index.js` as root does not.
- [ ] **Back up `data/panelkit.sqlite`.** Use `node scripts/init-db.js --backup <path>` rather than copying the file, which can capture a torn WAL. Losing it disconnects every user from servers that keep running.
- [ ] **Review `subuser.defaultPermissions`** against your panel version. The validator refuses the known-destructive ones, but the set should still be the minimum you intend.
- [ ] **Keep `ACCOUNT_AGE_DAYS` above zero** on a public bot.
- [ ] **Restrict who can invite the bot.** Server creation consumes real resources on your nodes.
- [ ] **Run `npm run verify` after every update.** It asserts the audit properties described here.
- [ ] **Watch the log for `ORPHANED SERVER` and `ADMIN ACTION`.** The first indicates a reconciliation is needed; the second is your audit trail.

---

## What this bot does not protect against

Stated plainly, because a security document that implies completeness is worse than one that admits its edges.

**A compromised host.** Shell access or read access to `.env` yields the credentials directly.

**A malicious operator.** Anyone who can edit `config.json` can set `subuser.defaultPermissions` to something broad, point `deploy.locationId` anywhere, or configure any container image. The config layer refuses the specific footguns it knows about; it does not defend against the person who owns the file.

**A panel administrator.** A user who is also a Pterodactyl administrator can bypass everything the bot enforces by using the panel directly. `admin user` reports panel administrator status for exactly this reason.

**Discord platform compromise.** If Discord itself misattributes an interaction, ownership checks based on `interaction.user.id` follow it.

**Resource exhaustion at the panel.** Cooldowns and limits bound what one user can request through the bot. They do not bound what a server does once running — that is the panel's and the node's concern.

**Denial of service.** A user who can invoke commands can generate load. Cooldowns raise the cost; they do not eliminate it.

---

## Cryptography

No custom cryptography. `node:crypto` only:

- `randomBytes` with rejection sampling for usernames, passwords, session IDs and error references
- `timingSafeEqual` behind a length check, for the one comparison helper that exists

No hashing, encryption or signing is performed. Panel passwords are generated and transmitted to the panel over TLS; the panel hashes them. Nothing sensitive is stored, so nothing needs encrypting at rest.

---

Coded by **Aditya** — [@adityatheog](https://github.com/adityatheog)
