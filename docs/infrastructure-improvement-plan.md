# Deploy safety & UAT environment — infrastructure improvement plan

> **Read this first if you are picking up deploy-safety or staging work.** It is self-contained:
> the measured baseline, the code-anchored reasons, and the concrete steps are all here.
>
> Status: **designed, nothing built.** Written 2026-09-07 at v2.155.5, against prod as measured
> that day. Tier 0 is the piece to do first — it is ~1 hour and removes the largest unmitigated
> risk currently carried.

## 1. Why this exists

ArcAid ships fast, straight from `main` to production, with a growing real user base. The
question this plan answers is not "how do we get a staging environment" — it is **"what
actually threatens players, and what is the cheapest thing that stops it."** Those turn out to
be different questions, and the answer is not primarily a UAT box.

### 1.1 Risk model

| Risk | Severity | Caught by local Docker testing? |
|---|---|---|
| A migration mangles real data | **Unrecoverable** — 11 MB of irreplaceable player history, 178 forward-only migrations | **No** |
| Destructive iScored op (delete/hide) | High — iScored has no undo | Partially (`IScoredSnapshotService` covers this) |
| Bot posts to a live channel / DMs real players | High, visible | No — this already happened (fixed in v2.140.0) |
| Auth breaks, everyone locked out | High | Partially |
| Container fails to boot on Linux (perms, base image) | High — total outage | **No** — uid-999/noble took prod down 2026-07-05 |
| UI regression, broken button | Low | **Yes, reliably** |

Local Docker catches the bottom row well and the top rows not at all. **Local testing is
necessary, mandatory, and insufficient.** The highest-value additions are (a) rehearsing the
deploy against a *copy of the real database*, and (b) a rollback that takes 60 seconds.

### 1.2 Measured baseline — prod, 2026-09-07

Re-measure before acting on any of this; these numbers drive the "don't co-tenant" ruling.

```bash
ssh arcaid 'free -h; df -h /; du -sh /var/lib/docker/volumes/arcaid_arcaid-data/_data'
```

| Fact | Value (2026-09-07) |
|---|---|
| Host | `arcaid-prod-01`, Hetzner VPS, Ubuntu 24.04, kernel 6.8 |
| RAM | **1.9 Gi total · 1.2 Gi available · 195 Mi free** |
| Disk | 38 G total · 18 G used · **19 G free (49%)** |
| `arcaid-data` volume | **4.0 G** (overwhelmingly catalogue images) |
| `arcaid.db` | **11 MB** |
| Running | `arcaid` (ghcr `:latest`) + `caddy` (`caddy:2-alpine`), both on the `web` network |
| Server compose | `/opt/arcaid/docker-compose.yml`, hand-maintained, owned by `deploy` |
| Caddyfile | `/opt/arcaid/Caddyfile` — two lines, `arcaid.app { reverse_proxy arcaid:3001 }` |

## 2. Code-anchored findings (verified 2026-09-07 — do not re-derive)

These three facts determine the shape of everything below.

| # | Finding | Anchor |
|---|---|---|
| **F1** | **No Discord bot token ⇒ the scheduler never starts.** `Scheduler.getInstance().start()` sits *inside* `if (canStartBot)`. That call registers every tournament maintenance cron, the per-minute picker-timeout checker, **`EventScheduler.tick`** (the Live Event *and* Throwdown clock), the nightly backup cron, the iScored snapshot cron, and profile hydration. A local or UAT instance without a token executes **none** of the time-driven half of ArcAid. | `src/index.ts:121`, `:137`; `src/engine/Scheduler.ts:79-113` |
| **F2** | **A second instance on the prod bot token is an incident, not a test.** `deployCommands()` is called with no `guildId`, so it hits `Routes.applicationCommands` — **global** registration on every boot. A shared token means the second instance overwrites prod's global command set each time it restarts, and both bots race every interaction (`DiscordAPIError[40060]`). Lived on 2026-08-21 with the local `arcaid-bot` container. **Staging needs a separate Discord *Application*, not just a separate guild.** | `src/index.ts:131`; `src/discord/DiscordClient.ts:186-195`; memory `gotcha_local_container_duplicate_bot` |
| **F3** | **The prod box cannot host staging.** 1.9 Gi RAM with 1.2 Gi available, and both instances can launch Chromium for iScored Playwright ops. Staging OOM-killing prod is the exact inversion of the goal. | §1.2 |

Two supporting facts that shape the detail:

- **`BackupManager.createBackup()` already produces the right clone source.** It uses
  `VACUUM INTO`, which writes a fully-checkpointed standalone `arcaid.db` with **no `-wal`/`-shm`
  sidecars**, and it already runs nightly. Do not write new backup code — copy the newest
  `/app/backups/<timestamp>/arcaid.db`. (`src/engine/BackupManager.ts`, step 1 of `createBackup`.)
- **`decryptSecret` throws on a wrong key** (AES-GCM auth-tag failure) — it does not degrade to
  null. So a UAT instance with a fresh `SECRETS_KEY` reading a prod-cloned `enc:v1:` row will
  throw at read time. The sanitize step must *delete* those rows, not rely on the key mismatch.
  (`src/utils/secrets.ts`.)

## 3. Tier 0 — deploy safety net (~1 hour, do this first)

**This is worth more than the UAT box and is independent of every decision below.**

80% of a rollback already exists and cannot be reached: `deploy.yml` pushes a `sha-<commit>` tag
to ghcr on every deploy, but `/opt/arcaid/docker-compose.yml` hardcodes `:latest`.

Critically: **code rollback is trivial, schema rollback is impossible.** Migrations are
forward-only and run on container boot. Once migration N has run against prod, the only way back
is a file taken *before* it ran — and there currently isn't one at the moment of the deploy.

### 3.1 Parameterize the image tag

In `/opt/arcaid/docker-compose.yml`:

```yaml
image: ghcr.io/mekelburgj20/arcaid:${ARCAID_TAG:-latest}
```

### 3.2 Snapshot the DB immediately before every deploy

In `.github/workflows/deploy.yml`, replace the body of the `Deploy to Hetzner` SSH script:

```bash
cd /opt/arcaid
docker compose pull
V=/var/lib/docker/volumes/arcaid_arcaid-data/_data
docker compose stop arcaid
cp "$V/arcaid.db" "$V/pre-deploy-$(date -u +%Y%m%dT%H%M%SZ).db"
ls -1t "$V"/pre-deploy-*.db | tail -n +21 | xargs -r rm   # keep 20 ≈ 220 MB
docker compose up -d --remove-orphans --force-recreate
docker image prune -f
```

Two things matter here:

- The snapshot must be taken **after the old container stops and before the new one starts** —
  migrations run on boot.
- With the container stopped, a plain `cp` of `arcaid.db` is safe. While it is running it is
  **not** (WAL); use `BackupManager` or `VACUUM INTO` in that case.

Keep the existing `Verify deployed version` step exactly as it is — it is what caught the
2026-08-28 stale-container deploy.

### 3.3 Rollback runbook

Put this in `docs/runbooks/rollback.md` alongside `docs/runbooks/restore.md`:

```bash
ssh arcaid
cd /opt/arcaid
V=/var/lib/docker/volumes/arcaid_arcaid-data/_data

# 1. Code only (no migration ran, or the migration was harmless)
ARCAID_TAG=sha-<previous-commit> docker compose up -d --force-recreate

# 2. Code + schema (the migration is the problem)
docker compose stop arcaid
cp "$V/pre-deploy-<timestamp>.db" "$V/arcaid.db"
ARCAID_TAG=sha-<previous-commit> docker compose up -d --force-recreate

# 3. Confirm
curl -s https://arcaid.app/api/version
docker logs arcaid --tail 50
```

Find the previous commit with `gh run list --workflow deploy.yml` or `git log --oneline main`.
Any score submitted between the snapshot and the rollback is lost in case 2 — that is the
trade, and it is why the snapshot is taken as late as possible.

## 4. Tier 1 — the UAT environment (~half a day + a few €/month)

### 4.1 Infrastructure

1. **A second VPS**, same class as prod, fresh Ubuntu 24.04. Not co-tenanted — see F3. Sizing it
   the same as prod is deliberate: a memory problem then shows up in UAT first.
2. **DNS**: `A` record `uat.arcaid.app` → the new IP.
3. **`/opt/arcaid-uat/docker-compose.yml`** — a copy of the prod compose (keep `init: true` and
   the healthcheck) with:
   - `image: ghcr.io/mekelburgj20/arcaid:${ARCAID_TAG:-latest}`
   - `container_name: arcaid-uat`
   - its own `.env`, its own named volumes
4. **Caddyfile** — keep it off search engines and off casual visitors:
   ```
   uat.arcaid.app {
       basic_auth {
           uat <hash from `caddy hash-password`>
       }
       header X-Robots-Tag "noindex, nofollow"
       reverse_proxy arcaid:3001
   }
   ```
   (`basic_auth` is the Caddy ≥2.7 name; `basicauth` is the deprecated alias.)
5. **ghcr read access** for the UAT host, and GitHub secrets `UAT_HOST` + `UAT_SSH_KEY`.
6. **`sqlite3` installed on the UAT host** — it is a staging box, there is no reason not to, and
   the sanitize step is far simpler with it than with `docker exec … node -e`.

### 4.2 Separate identities — this is where it goes wrong

| Thing | Why it must differ | How |
|---|---|---|
| **Discord Application** | F2. Non-negotiable. | New app at discord.com/developers → fresh `DISCORD_BOT_TOKEN` / `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET`; invite to a test guild only. **Required for the scheduler to run at all (F1).** |
| `JWT_SECRET` | Otherwise a prod access token authenticates against UAT and vice versa | fresh random |
| `SECRETS_KEY` | `decryptSecret` throws on mismatch — see §2 | `npm run generate-secrets-key`, **and** delete the encrypted rows (§4.4) |
| VAPID keypair | UAT must not push to browsers holding prod subscriptions | `npm run generate-vapid-keys` |
| Google OAuth redirect | Login is otherwise broken on UAT | Add `https://uat.arcaid.app/...` as a **second authorized redirect URI on the existing Google client**. Cheapest path, and acceptable because Google login has no bot that acts. A second client is cleaner if you'd rather not share the secret. |
| `CORS_ORIGIN` | `startup.ts` warns if unset in production | set to `https://uat.arcaid.app` |

### 4.3 Cloning prod's database

- **Source**: the newest `/app/backups/<timestamp>/arcaid.db` from `BackupManager`. WAL-safe,
  no sidecars, already produced nightly. Do not `cp` a live `arcaid.db`.
- **Images**: `rsync` the 4 GB of asset subdirectories **once** at setup. After that, sync only
  the 11 MB DB. Nightly 4 GB transfers are pointless; missing images just make the UI look broken.
- **Cadence**: nightly is plenty. A `cron` on the UAT host that pulls the newest backup, runs
  the sanitize SQL, and restarts the container.

**What you keep is the point.** All the scores, all the identity rows, all the legacy row
shapes going back to the TableFlipper-era imports. That is what makes migration N+1 a real test.

### 4.4 Sanitize — mandatory, not optional

A raw prod clone booted on UAT will **poll and write to the real iScored boards**, post to real
Discord channels, DM real players, web-push real browsers, and log into the real AtGames
account. Run this on the copy, on the UAT host, **before the container ever starts**.

The SQL below was executed against the real table shapes (`game_rooms`, `game_room_settings`,
`settings`, `sessions`, `push_subscriptions`, `witness_devices`) on 2026-09-07 and verified to
leave zero `enc:v1:` rows, zero credential rows, and zero sessions/subscriptions/devices.

```sql
-- scripts/sanitize-uat-db.sql   (run: sqlite3 arcaid.db < sanitize-uat-db.sql)

-- 1. Kill every outbound integration, every room.
INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value)
SELECT id, k, 'false' FROM game_rooms,
  (SELECT 'ISCORED_ENABLED' AS k UNION ALL SELECT 'ATGAMES_ENABLED'
   UNION ALL SELECT 'DISCORD_ENABLED' UNION ALL SELECT 'ISCORED_ALLOW_DELETE'
   UNION ALL SELECT 'CHAT_RESPONSES_ENABLED');

-- 2. Delete the credentials themselves (also removes every enc:v1: blob the
--    new SECRETS_KEY cannot read).
DELETE FROM game_room_settings WHERE key IN (
  'ISCORED_USERNAME','ISCORED_PASSWORD','ISCORED_PUBLIC_URL','ISCORED_GAMEROOM',
  'ATGAMES_EMAIL','ATGAMES_PASSWORD','ATGAMES_DEVICE_FP',
  'DISCORD_GUILD_ID','DISCORD_ADMIN_ROLE_ID','DISCORD_ANNOUNCE_CHANNEL_ID'
);

-- 2b. The SECOND guild-id store. `game_rooms.discord_guild_id` is a real
--     column, distinct from the settings key above. It is currently read only
--     by GameRoomService.getByGuildId, which has NO callers (resolveGuildReadScope
--     and guildInteractionBlockReason both use game_room_settings.DISCORD_GUILD_ID).
--     Cleared defensively so reviving that method can never point UAT at a live guild.
UPDATE game_rooms SET discord_guild_id = NULL;

-- 3. Global secrets + noisy crons.
DELETE FROM settings WHERE key IN (
  'WEB_PUSH_VAPID_PUBLIC_KEY','WEB_PUSH_VAPID_PRIVATE_KEY',
  'OPDB_API_KEY','TWITCH_CLIENT_SECRET','RA_API_KEY',
  'GOOGLE_CLIENT_SECRET','DISCORD_CLIENT_SECRET'
);
INSERT OR REPLACE INTO settings (key, value) VALUES
  ('OPS_ALERT_ENABLED','false'),
  ('ISCORED_SNAPSHOTS_ENABLED','false');

-- 4. Anything that can reach a real person or device.
DELETE FROM sessions;             -- refresh tokens
DELETE FROM push_subscriptions;   -- or UAT pushes to real phones
DELETE FROM witness_devices;      -- re-pair a cabinet if testing Witness

-- 5. Re-point ONE room at the test guild so Discord is actually exercised.
--    Replace <slug>, <test-guild-id>, <test-channel-id>.
INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value)
SELECT id, 'DISCORD_ENABLED', 'true' FROM game_rooms WHERE slug = '<slug>';
INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value)
SELECT id, 'DISCORD_GUILD_ID', '<test-guild-id>' FROM game_rooms WHERE slug = '<slug>';
INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value)
SELECT id, 'DISCORD_ANNOUNCE_CHANNEL_ID', '<test-channel-id>' FROM game_rooms WHERE slug = '<slug>';
```

> **The one precise trap.** In `src/utils/iscoredCreds.ts`, `resolveCredsFromSettings` returns
> `null` immediately on `ISCORED_ENABLED='false'`, *before* the env fallback — so step 1 is
> genuinely sufficient for rooms that exist at clone time. But a room **created later on UAT**
> has no per-room creds and **falls through to `envCreds()`**. Therefore also leave
> `ISCORED_USERNAME` / `ISCORED_PASSWORD` **out of UAT's `.env` entirely**. Two layers, because
> one of them has a hole. (AtGames needs no equivalent — it is room-only by design, no env
> fallback.)

Verify the sanitize worked before trusting it:

```bash
sqlite3 arcaid.db "SELECT key, count(*) FROM game_room_settings
  WHERE key LIKE 'ISCORED%' OR key LIKE 'ATGAMES%' OR key LIKE 'DISCORD%'
  GROUP BY key;"
```

### 4.5 CI wiring — a force-pushable `uat` branch

The lowest-friction trigger for a solo developer:

```bash
git push origin HEAD:uat -f      # whatever you're working on is now on uat.arcaid.app
```

In `deploy.yml`:

- add `uat` to the `on.push.branches` list;
- on `uat`, push **only** the `sha-<commit>` tag — never `latest`, which prod's compose resolves;
- select host/secrets by `github.ref` (`UAT_HOST`/`UAT_SSH_KEY` vs `HETZNER_HOST`/`HETZNER_SSH_KEY`);
- **duplicate the `Verify deployed version` step against `https://uat.arcaid.app/api/version`** —
  a stale UAT container fools you exactly the way a stale prod one did on 2026-08-28.

> **⚠ The trap in this step.** `build-and-deploy` is gated on
> `if: github.event_name == 'push' || github.event_name == 'workflow_dispatch'` — a push to
> `uat` **already satisfies that**. So adding `uat` to `on.push.branches` and changing nothing
> else will build your work-in-progress branch, tag it `:latest`, and **deploy it to
> production**. The branch-on-`github.ref` for the image tags and the SSH target is not a
> refinement; it is the whole change. Verify with a throwaway commit on `uat` and confirm
> `https://arcaid.app/api/version` is unchanged before trusting it.

`main` → prod stays exactly as it is today. The existing PR test gate is untouched.

## 5. Tier 2 — the local loop (~2 hours, do it today regardless)

Local Docker with a **dedicated Discord Application** (its own token — F2) and a fresh DB.

- **Good for**: does the feature work, does the UI look right, do the crons fire, does the event
  clock advance. Per F1, the test bot token is what makes the last two possible at all — without
  it you have never exercised the scheduler locally.
- **Not good for**: does this migration survive real data; does it boot under real Linux
  permissions. Those are Tier 1's job.
- Keep `restart: no` on any local container (memory `gotcha_local_container_duplicate_bot`).

## 6. Recommended code change — `ARCAID_ENV`

**Not built. Belt-and-braces over §4.4.** A sanitize script that misses one key means UAT DMs a
real player; an env guard cannot miss.

Set `ARCAID_ENV=staging` in UAT's `.env` and hard-gate the outbound edges — roughly six places:

| Edge | File |
|---|---|
| Announcements | `src/utils/discord.ts` → `resolveAnnouncementChannelId` (already the single choke point; `ANNOUNCE_NONE` lives there) |
| DMs | `NotificationService.notify` |
| Browser push | `WebPushService` |
| iScored score writes | `IScoredSubmitSync.syncScoreToIScored` |
| iScored Playwright mutations | `IScoredSessionRegistry.withSession` |
| AtGames | `AtGamesPrivateClient` (login + create) |

Plus **a visible environment banner** in the admin UI and public pages whenever
`ARCAID_ENV !== 'production'`. This pays for itself the first time someone else tests for you
and files a UAT bug as a prod bug — or, worse, dismisses a real prod bug because they thought
they were on UAT.

## 7. The routing rule — how to stay fast

> **UAT is for changes that touch data, money, or other people's systems. Everything else ships
> from a green PR.**

| Ships straight to prod on a green PR | Must sit on UAT first |
|---|---|
| UI / CSS / copy / layout / theme work | **Anything with a new migration** |
| New read-only endpoints, admin views | iScored / AtGames / Discord **write** paths |
| Doc changes | Auth, sessions, OAuth, identity linking |
| Anything fully covered by the vitest suites | Scheduler / `EventScheduler` / rotation logic |
| | `Dockerfile`, base image, uid, volume changes |

In practice roughly one PR in five needs UAT. The rest keeps the current cadence, gated by the
CI suite that already exists.

## 8. Rejected — do not re-litigate

| Idea | Why not |
|---|---|
| **Blue/green deployment** | Wrong shape for single-writer SQLite: one file, one writer, and two live versions cannot share it across a schema change. The correct analogue here is Tier 0 — tagged image + pre-deploy snapshot + 60-second rollback. |
| **Migrate to Postgres to enable blue/green** | A month of work to solve a problem that does not exist at this scale. Revisit only if concurrency, not deploy safety, becomes the driver. |
| **Co-tenant UAT on the prod box** | F3. Staging OOM-killing prod inverts the entire goal. |
| **Synthetic seed data for UAT** | The whole value is the *real* data shape. Sanitize a clone; do not invent one. |
| **Nightly 4 GB asset sync** | Copy once at setup; sync only the 11 MB DB thereafter. |

## 9. Known drift and follow-ups

- **The repo's `docker-compose.prod.yml` has drifted from `/opt/arcaid/docker-compose.yml`.**
  The server's copy has `init: true` and the healthcheck; the repo's has neither. Someone will
  eventually edit the repo file, assume it deployed, and be wrong. Reconcile them while building
  the UAT compose, or delete `docker-compose.prod.yml` and note in `CLAUDE.md` that the server's
  copy is hand-maintained.
- **Prod RAM headroom is thin** (1.2 Gi available). Not urgent, but prod is one Chromium launch
  plus one large catalogue import away from swap thrash. A bump to 4 GB is cheap insurance.
- **Arcaid Witness cabinets report to a fixed URL.** To exercise Witness on UAT, re-pair one
  device against `uat.arcaid.app` — device tokens are per-database, so a paired prod cabinet
  cannot reach UAT and vice versa.
- **PWA/service worker on a second origin** gets its own caches, which is correct — but tell
  testers not to *install* the UAT PWA, or they will lose track of which app they are in.

## 10. Progress

- [ ] **T0.1** Parameterize `ARCAID_TAG` in `/opt/arcaid/docker-compose.yml`
- [ ] **T0.2** Pre-deploy DB snapshot + 20-file retention in `deploy.yml`
- [ ] **T0.3** `docs/runbooks/rollback.md`
- [ ] **T1.1** UAT VPS provisioned, DNS, Caddy (basic auth + noindex)
- [ ] **T1.2** Separate Discord Application; fresh `JWT_SECRET` / `SECRETS_KEY` / VAPID; Google redirect URI
- [ ] **T1.3** `scripts/sanitize-uat-db.sql` + nightly clone cron on the UAT host
- [ ] **T1.4** `uat` branch trigger in `deploy.yml` + `/api/version` verification against UAT
- [ ] **T2.1** Local Docker with a dedicated Discord Application (do first — unblocks scheduler testing)
- [ ] **T3.1** `ARCAID_ENV` outbound guards + environment banner
- [ ] **T4.1** Reconcile `docker-compose.prod.yml` with the server's copy

## 11. Cross-references

- `CLAUDE.md` → *Deployment*, and the Playwright/base-image/uid-999 entries under *Gotchas*
- `docs/runbooks/restore.md` — restoring from a `BackupManager` backup
- `.github/workflows/deploy.yml` — the existing test gate, image tagging, and version verification
- `src/index.ts:107-155` — boot order and the `canStartBot` gate (F1)
- `src/utils/iscoredCreds.ts` — cred resolution precedence and the env fallback (§4.4 trap)
- `src/engine/BackupManager.ts` — `VACUUM INTO` snapshot (§4.3)
- ADR 0012 (iScored session registry) — why Playwright ops are serialized per account, and why a
  second instance sharing an iScored account is dangerous
