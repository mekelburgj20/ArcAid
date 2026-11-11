# CLAUDE.md

Guidance for Claude Code working in this ArcAid repository. This file is the always-on spine: the working agreement, the architecture map, the cross-cutting invariants and the owner rulings. **Domain detail lives in `.claude/rules/*.md`** (path-scoped: a rule file loads itself when you read or edit a matching file; read it explicitly when you are planning work in that domain before opening its files). History is `CHANGELOG.md`; reasoning is `docs/decisions/`; live work is `WORK.md`.

## Working agreement

- **Run via Docker.** `docker compose up -d --build` for dev/test/prod. Never suggest `npm run dev` for running the app — `npm run build` and `npm run dev` exist for CI/build verification only.
- **Always build before committing.** `docker compose build` from repo root, plus `cd admin-ui && npm run build` if UI changed. Never push to `main` without a clean build.
- **A UI change means running the admin-ui test suite too** — `cd admin-ui && npx vitest run`, not just its build and lint. CI runs it; a build-clean UI edit can still fail it (a second encrypted settings field once made a document-wide `queryByRole('button', {name: 'Show'})` ambiguous, 2026-08-25).
- **Two open PRs share one version slot.** The squash that lands SECOND must carry the HIGHER version, or prod's `/api/version` goes backwards and the later CHANGELOG block sits under the earlier one. When main moves under your open PR: rebase, keep BOTH CHANGELOG blocks (yours above), take main's `package.json` + lock and re-bump YOUR version above it (line 3 of each, plus line 9 of the lock), `--force-with-lease`, let CI re-run.
- **"Skip the CI tests" / "just get it in" means the `[skip tests]` flag** (owner, 2026-11-01): commit directly to `main` with `[skip tests]` in the message; `deploy.yml` skips its `test` job and goes straight to the image build + deploy (the Docker build still compiles both halves; the same switch is the `skip_tests` input on a manual workflow_dispatch). It is NOT the skip-ci marker, which suppresses the whole workflow including the deploy (docs/marker commits only). Still run the local build and the vitest files you touched. Without that instruction, the normal PR + green gate applies. **Never write the literal skip-ci marker anywhere in a commit message you want deployed** — GitHub scans the whole message, body included (c31b11e88).
- Don't ask permission for `cd`, `git`, or basic file navigation — execute directly.
- **"Resume" ritual:** `/work` (reads `WORK.md`: the Now block, claims, ready items, blockers) → `git branch --show-current` → `npm run build` (and admin-ui build if relevant) → status summary → take or continue an item. End every session with `/wrap`.
- **Doc budget.** This file stays under 40,000 chars and 200 lines; each `.claude/rules/*.md` stays under 40,000 chars (Claude Code truncates a rule file above that). `npm run docs:check` enforces both and CI runs it. New standing facts go in the rule file for their domain; only a cross-cutting invariant, a map entry or an owner ruling goes here. Write the rule and a pointer `(vX.Y.Z, ADR NNNN)`; the incident story goes in CHANGELOG or the ADR.

## Rules index (`.claude/rules/`)

| File | Read it before touching |
|---|---|
| `scores-identity.md` | score submission, `score_history`/`submissions`, leaderboards, score correction/moderation, tombstones, identity tables, name/avatar resolution, platform rules |
| `witness.md` | Arcaid Witness devices, `GET /witness/*`, VPX/cabinet score ingest, routing, integrity mode, limited attempts, invite-only rosters, witness flag mode |
| `atgames.md` | AtGames private-tournament sync, `AtGamesPrivateClient`, the `atgames:<id>` account link |
| `events.md` | Live Event format, `EventScheduler`, check-in lobby, Throwdowns, Seasons, Pick by poll |
| `rooms-tournaments.md` | join policy/membership, rotation engine, pick queue, rankings cache, room timezone, admin health/ops, OG meta |
| `iscored.md` | iScored API/Playwright clients, session registry, poller, snapshots, delete kill-switch, Deactivate vs Delete, cleanup |
| `catalogue.md` | `global_games`, importers (VPS/Wizard/OPDB/IGDB/Steam/FX VR/AtGames), ratings, My Tables, platform taxonomy |
| `discord.md` | slash commands and guild scoping, command policy, announcements/mentions, chat responses, notifications, lobby feed |
| `admin-ui.md` | anything under `admin-ui/`: layouts, scoreboard rendering, themes, service worker, score entry, live refresh |

## Stack

TypeScript (CommonJS, NodeNext) · Node 24 prod runtime (Playwright noble base; Node 20 in the Docker build stages + CI gate) · Discord.js v14 · Playwright · SQLite (NOT `better-sqlite3` — use the package already in `package.json`) · Express v5 · React 19 + Vite (ESM, separate `tsconfig`).

## Architecture

Two sub-applications in one process, served by Express on port 3001.

**Backend (`src/`)** compiles CommonJS to `dist/`. Entrypoint `src/index.ts` boots in order: DB init → load DB settings into `process.env` → clear leaderboard caches → validate env → start API → connect Discord → start `ScoreSyncPoller`.

- `src/engine/` — singletons via `getInstance()`: `TournamentEngine`, `Scheduler`, `ScoreSyncPoller`, `TimeoutManager`, `BackupManager`, plus the per-minute `EventScheduler` / `SeasonScheduler`. Per-use (NOT singletons): `IScoredClient` (Playwright), `IScoredApiClient` (HTTP). Pin-to-scoreboard creation goes through `gameCreation.ts`'s `pinGameToScoreboard()` / `unpinGameFromScoreboard()`; tournament activation through `TournamentEngine.activateGame()` / `processSlotMaintenance()`.
- `src/api/` — Express app in `server.ts` mounts four routers: `auth.ts` (login, OAuth, refresh), `rooms.ts` (room-scoped public + admin), `admin.ts` (super-admin), `global.ts` (non-scoped). Middleware in `middleware.ts`: `requireAuth`, `requireRoomAccess(paramName)`, `requireSuperAdmin`, `requireDiscordUser`, `optionalDiscordUser`, `roomVisibilityGate`, `requireNotBanned`. Rate limiters in `rateLimit.ts`. Admin writes land in the activity log via `activityAdminMiddleware.ts` (ADR 0037); `auditMiddleware.ts` is dead, `audit_log` gets explicit `AuditService.log` calls. Zod schemas in `schemas.ts`.
- `src/services/` — business logic; routes delegate here. `ls src/services/` for the current set. Room-scoped services accept an optional `gameRoomId` parameter.
- `src/utils/` — `discord.ts`, `terminology.ts`, `cooldown.ts`, `logger.ts` (rotating-file-stream; `formatLogArg` writes `Error.stack` since `JSON.stringify(err)` returns `{}`), `secrets.ts`, `platformMapping.ts`, `platformRules.ts`, `cronUtils.ts`, `catalogueUtils.ts` (`normalizeGameName`).

**Admin UI (`admin-ui/src/`)** is React 19 + Vite. All HTTP goes through `lib/api.ts` (relative `/api/` paths — never hardcode localhost); a public page's room read goes through `lib/roomFetch.ts` (an `approval` room refuses it without the player token, v2.241.1). Three layouts: `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`), plus standalone global pages (`/scoreboard`, `/games/:id`, `/friends`). **There is NO public `/catalogue` route**; `GlobalCatalogue` is a super-admin tool. Room pages get `roomId/roomSlug/roomName` from `RoomContext`; public pages get viewer auth from `ViewerAuthContext`. Player tokens live in `arcaid_player_token` localStorage, separate from admin tokens. Detail: `admin-ui.md`.

## Data model in one screen

- **Multi-tenant:** one DB, many `game_rooms`; per-room settings in `game_room_settings` (`SettingsService` = global, `GameRoomSettingsService` = room; both hot-reload). Tournaments, ranking groups and games carry `game_room_id`. `migrateToMultiRoom()` runs idempotently on startup.
- **Auth roles:** `super_admin`, `room_admin` (password, invite, or Discord), `player` (Discord/Google-authenticated), guest. JWT refresh tokens in `sessions` (30d); `api.ts` auto-refreshes within 5 min of expiry. Discord OAuth `state`: `__super__` / `player:<slug>` / bare slug; scope `identify` only.
- **Room access:** `JOIN_POLICY` is `open` · `approval` (invisible to non-members) · `discord_role` (views like `open`, Discord role to join). **Every view/listing reader tests `=== 'approval'` only.** `ROOM_LISTED` is the ONE listing switch (`game_rooms.is_public` mirrors it, written only through `GameRoomService`). **Writes outside `open` rooms need membership: `RoomAccessService.checkMayWrite`** (403 `JOIN_REQUIRED`); comments/tips stay guest-open; a NULL room is never gated.
- **Tournaments:** `format` is `rotation` or `event` (fixed once created). A game is a `games` row with `status` ∈ QUEUED / ACTIVE / COMPLETED / ARCHIVED / SCHEDULED (event rounds). `tournament_id IS NULL` = a pinned board (ADR 0005). **`is_active = 0` on a rotation is a PAUSE, never "closed"** — never filter score acceptance on it; the one open-card rule is `src/utils/openCard.ts`.
- **Scores:** `submissions` = best-per-player-per-game (id `${gameId}-${username.toLowerCase()}`, iScored-compatible). **`score_history` is the physical union of every score source** (`source` ∈ `tournament` / `sync` / `community` / `atgames` / `vpx`) — room-wide reads read it ALONE, never UNION `community_scores`. Tournament boards read it by `submitted_during_tournament_id` **plus `gameRunWindowSql`** (two runs of one table in one tournament). `global_scores` is the Global Scoreboard copy; `global_game_id` NOT NULL. `platform` (engine/device provenance, ADR 0016) is required at the API boundary. `score_history.game_room_id` is NULLABLE (Throwdowns) — a new room-grouped query must decide what NULL means.
- **Identity:** `user_mappings` (many iScored aliases → one Discord user, `iscored_username` UNIQUE NOCASE), `user_profiles` (one row per user: global `display_name`, avatar cache), `user_identity_links` (Google / `atgames:<id>` providers, canonical id via `IdentityLinkService.resolveCanonical`), `room_members.display_name` (per-room first-claim name, separate from the global one), `anonymous_identities` / `anon_room_claims`. `submitted_by_user_id` never holds a synthetic `iscored:*` / `atgames:*` id (`normalizeSubmitterUserId`).
- **Secrets:** AES-GCM via `SECRETS_KEY` (mint with `npm run generate-secrets-key`); `ENCRYPTED_SETTING_KEYS` in `src/utils/secrets.ts` is a deliberate allowlist consulted through `isEncryptedKey(key)` by both settings services — **adding a secret means adding it there** (ADR 0003). `maskEncryptedValues` returns `[ENCRYPTED]` on `GET /admin/settings` so the UI never round-trips ciphertext.

## Cross-cutting invariants

Each line is the rule; the named rule file has the detail and the why.

**Adding a manual score write path** (web route, Discord command, OAuth draft commit) — call, in order: `EventSubmissionGate.checkEventSubmission` (or `checkThrowdownSubmission`), `checkAttemptLimitSubmission`, `checkRosterSubmission`, `RoomAccessService.checkMayWrite`, `SubmissionGameResolver.resolveSubmissionGame` **once** (thread its result everywhere downstream — a second name lookup is the ambiguous-active-games bug), `ensurePlatformAllowed`, then `ScoreHistoryService.log` with `tournamentId` + `gameId`, `IScoredSubmitSync.syncScoreToIScored`, `GlobalScoreService.fanOutFromRoomSubmission`, `LobbyFeedGenerator.onScoreSubmitted`. The three existing web routes and Discord `/submit-score` are the reference. → `scores-identity.md`, `witness.md`, `events.md`.

- **Every score reaches the Global Scoreboard unless the PLAYER opted out** (`user_preferences.share_to_global`; ADR 0023). Formless paths (event rounds, Throwdowns, cabinets) go through `GlobalScoreService.fanOutAutomatedScore`; `'sync'` is the ONE refusal (unknown provenance), enforced inside the fan-out; guest submissions never fan out. → `scores-identity.md`
- **Score correction sits wherever a score delete sits**, through `components/CorrectScoreModal.tsx`; a machine-reported (`vpx`/`atgames`) row is never edited by anyone. Deletes write a tombstone (`deleted_score_suppressions` for synced, `auto_score_suppressions` for auto-posted) or the poller/cabinet resurrects the score. → `scores-identity.md`
- **Names and avatars resolve at READ, never in a cache or a row.** `leaderboard_cache`, `global_leaderboard_cache`, `event_result`, `rotation_events` store identity-stable ids; `resolveProfiles` / `resolveUserLabels` / `labelForProfile` (`PlayerProfileResolver.ts`) attach labels. Rendering a player from a bare id without that chain is the voter-snowflake bug (owner, 2026-10-18). FE renders `display_name ?? iscored_username` via `playerName()`. → `scores-identity.md`
- **Every `user_mappings` writer calls `IdentityAliasEffectsService.onAliasLinked`** gated on the INSERT actually inserting; every alias removal calls `onAliasUnlinked`. → `scores-identity.md`
- **Columns with a parser are read only through it:** `tournaments.platform_rules` → `parseTournamentRules`; `DISCORD_COMMAND_POLICY` → `parseCommandPolicy`; `DISCORD_JOIN_ROLE_IDS` → `parseJoinRoleIds`; `witness_flag_mode` → `normalizeWitnessFlagMode`; `sanctioned_rules` → `normalizeSanctionedRules`; `integrity_mode`/evidence → `evaluateSanctioned` (the ONE evaluation); theme ids → `normalizeThemeId`; `discord_channel_id = 'none'` → only `resolveAnnouncementChannelId` (`ANNOUNCE_NONE`).
- **One timezone chain:** `resolveTimezone` in `src/utils/roomTimezone.ts` (object zone → `ROOM_TIMEZONE` → `BOT_TIMEZONE` → `America/Chicago`); never hand-copy the fallback at a site that interprets a tournament time. → `rooms-tournaments.md`
- **Pick queue:** every queue reader imports `queueOrderSql` / `QUEUE_ORDER_SQL`; every writer goes through `TournamentEngine.queueGame` (newest-first, owner 2026-08-27) and `PickQueueService.compactQueue`; the cap is `PICK_QUEUE_MAX`, never a literal. → `rooms-tournaments.md`
- **Interactive activation announces after COMMIT** via `engine.announceGameActivated` (`activateGame` itself announces nothing). Anything that ADDRESSES a player pings via `sendChannelEmbed(..., { pingUserIds })`; never a bare `<@id>` in an embed; every pick prompt names its tournament in title and body. → `discord.md`
- **Discord commands are room-scoped:** reads through `resolveGuildReadScope(guildId, userId)`, writes through `discordWriteTarget.ts`, and every interaction entry point (commands, autocomplete, buttons, modals) through `commandPolicyDecision` (refusal + ephemeral; replies are ephemeral by default, applied by `forceEphemeralReplies` before the command runs, v2.218.0). A bare `FROM tournaments` / `FROM games` in a command is a cross-room leak. → `discord.md`
- **iScored:** `new IScoredClient(...)` only inside `IScoredSessionRegistry.acquireClient`; every `deleteGame` caller checks `iscoredDeletesAllowed(roomId)` first and calls `IScoredSnapshotService.captureBeforeMutation` inside the session; `deleteGame` returns `boolean` — branch on it. → `iscored.md`
- **Events register no cron; `EventScheduler.tick()` is the clock.** Every flip is `UPDATE … WHERE status = <expected>` acted on only when `changes === 1`; `eventEndGraceSec()` is the one grace. `min_elapsed_sec` is a badge, never a rejection; witness verdicts are badges, never gates — except `witness_flag_mode = 'prevent'` at standings time (ADR 0031). → `events.md`, `witness.md`
- **Witness routing is one pure rule, `deviceRoutesTo`** (`src/utils/witnessRouting.ts`), and entry is one test, `entryAllowed` (`src/utils/tournamentEntry.ts`), shared by ingest, the lobby and the typed gate. A new filter in `VpxScoreIngestService.match` needs its step in `missReason` too. Every used-attempt count reads `USED_STATUS_SQL`. Every board landing goes through `writeBoardRow`, which also upserts `submissions` — the ONLY table the rotation close crowns a winner from (W93, v2.220.0). → `witness.md`
- **Catalogue:** every importer goes through `GlobalGameService.upsert` and stamps `imported_from`; `foldCataloguePlatforms` is the ONE legacy→engine fold; `studio` is never `manufacturer`. Ratings are ONE store (`global_game_ratings`, ADR 0035); inventory may be anonymous, opinions may not (owner 2026-08-24). → `catalogue.md`
- **Platform taxonomy lives twice:** `src/utils/scoreProvenance.ts` ≡ `admin-ui/src/lib/scoreProvenance.ts` below the header (parity test) and `src/utils/platformMapping.ts` ↔ `admin-ui/src/lib/platforms.ts` (no parity test). Change both. Theme ids likewise: `lib/themeIds.ts` ≡ `utils/themeIds.ts`. → `catalogue.md`, `admin-ui.md`
- **Live pages recover without the socket:** any page that emits `join:room` uses `hooks/useLiveRefresh.ts`. → `admin-ui.md`
- **Every new room-page notice** goes in the `PublicLayout` notice column through `components/DismissibleNotice.tsx` and `lib/roomNotices.ts`. → `admin-ui.md`
- **Notifications:** adding a type touches `PREF_TYPE_KEYS`, the prefs interface, `getPrefsWithExplicit` defaults, the Discord `PREF_LABELS` and `AccountSettings.tsx`'s `NOTIF_TYPES`. → `discord.md`
- **Fan-out try/catch swallows column errors silently.** When changing schema in any score table, verify every fan-out path's column references against the live schema.
- **Every new event source writes an activity row** (`ActivityLogService.record` / `recordForDevice`; room decided at write time; `record` never throws; refusals are `problem` rows). A write path without one is invisible on Room Admin -> Activity (v2.227.0, ADR 0037). → `scores-identity.md`

## Owner rulings (do not reopen)

| Date | Ruling | Where |
|---|---|---|
| 2026-08-24 | Inventory (My Tables) may be anonymous; opinions (ratings) are named | `catalogue.md`, v2.206.0 |
| 2026-08-27 | Pick queue is newest-first | `rooms-tournaments.md`, v2.143.0 |
| 2026-08-31 | A submitter may correct their own score while the card is unlocked | `scores-identity.md`, v2.150.0 |
| 2026-10-18 | Season and Pick by poll are independent switches; poll cards belong in the Lobby | ADR 0026, `events.md` |
| 2026-10-18 | Never render a raw user id; resolve through the label chain | v2.162.1 |
| 2026-10-19 | Known-build rule is an allow-list (`official` + `panasony` pass), never "official only" | ADR 0027, `witness.md` |
| 2026-10-22 | An event round is a labelled Start + End pair, duration is a caption | v2.167.2 |
| 2026-10-25 | `is_active = 0` on a rotation is a pause, not closed | `events.md` |
| 2026-10-25 | Machine-reported rows are not editable by anyone; Sanctioned / Limited closes the submitter correction tier | v2.176.0 |
| 2026-10-25 | `score_plausibility` and `quit` are flags only, never gates; a quit game still counts | ADR 0027, `witness.md` |
| 2026-10-25 | A joined Throwdown is reachable from every un-pinned device, Global-only included | ADR 0032 |
| 2026-10-26 | Every existing Witness device moved to "All my rooms" | migration 191, ADR 0033 |
| 2026-11-01 | "Skip the CI tests" = `[skip tests]` direct to main | working agreement |
| 2026-11-09 | No "unwitnessed" word: public integrity marks are ✓ and ⚠ only | ADR 0038, `witness.md` |
| 2026-11-10 | Round timing is the runner's (Room Admin → Activity), never on public boards or Discord | ADR 0038, `events.md` |
| ADR 0018 | Personal rooms were REJECTED; Throwdowns are room-less | `events.md` |
| ADR 0034 | The room owner decides whether a room is listed | `rooms-tournaments.md` |

## Database

SQLite at `data/arcaid.db` (git-ignored). Schema auto-creates on first run. Migrations are an inline array in `database.ts` (NOT a `migrations/` folder), run idempotently in array order, tracked by `name` in `schema_migrations`; complex handlers live in `src/database/migrations/*.ts`. **Claim the next free number before coding.** Read the migration entries for column intent; this file does not list them.

**Foreign-key enforcement is ON:** `PRAGMA foreign_keys = ON` is set in `initDatabase` AFTER the migration loop + `migrateToMultiRoom` (just before `return db`), never at connection-open — create-copy-drop-rename rebuilds need `foreign_keys` off. A one-time `PRAGMA foreign_key_check` logs residual violations. Declared `ON DELETE CASCADE`s are load-bearing. **New cross-table deletes must rely on a declared cascade or unlink/clean NO-ACTION children first** — known NO-ACTION refs: `games.tournament_id`, `submissions`/`scores`/`score_history.game_id` (unlink → NULL, ADR 0005), `global_scores.global_game_id` (NOT NULL → delete) / `origin_game_room_id` (unlink), `merge_records.anonymous_identity_id`; the fixed delete paths are `TournamentService.delete`, `GameRoomService.delete`, `GlobalGameService.delete` and the admin "remove game, retain scores" route. `ALTER TABLE`-added columns (`tournaments.game_room_id`, `ranking_groups.game_room_id`, the `submitted_*` columns, `games.game_room_id`/`won_game_id`) are pseudo-FKs with no constraint. Two `score_history` rebuilds share `rebuildScoreHistorySource` — never hand-copy that create-copy-drop-rename.

## Build and environment gotchas

- **CRLF flips on Windows — both `Write` AND `Edit` tools** can rewrite a whole file's endings (a ~3700-line whitespace-only diff). Detect with `git diff --numstat` vs `git diff -w --numstat` (must match); fix with `unix2dos` and verify `git diff -w` shows no content change. Check before every commit that touched a large file.
- **Never regenerate the root lockfile on Windows** (`npm install` / `npm audit fix` strip Linux optional deps and break the Docker build); use Dependabot.
- **Tailwind on Windows:** `@tailwindcss/postcss`, NOT `@tailwindcss/vite` (oxide scanner fails silently).
- **Express v5:** `req.params` values are `string | string[] | undefined` — cast `as string` at use.
- **`rotating-file-stream` types** are at `dist/types/index.d.ts`, not the package root.
- **node-cron** does NOT support `L`; `Scheduler.resolveCron()` maps `L` → `28-31` with a runtime guard.
- **Production container is `arcaid`** (not `arcaid-bot`). No `sqlite3` binary inside — use `node -e` with the existing JS package. **The local `arcaid-bot` container is a second production bot if it runs** (repo `.env` holds the prod token; restart policy `no`; never leave it up).
- **Playwright base image is hard-coupled to the npm `playwright` version.** `FROM mcr.microsoft.com/playwright:v<X>-noble` with no `npx playwright install`: bump both in the SAME commit or every `IScoredClient` op (game create/hide/delete, `/sync-state`, maintenance rotation) throws `Executable doesn't exist` (no CI gate catches it; vitest mocks Playwright). **`arcaid` is pinned to uid 999 in the Dockerfile (`useradd -u 999`)** — the bind-mounted `/app/data` + `arcaid.db` are owned by 999 and the chown is non-recursive; a default uid gets `SQLITE_READONLY` at boot and a fresh-DB boot test does NOT catch it (took prod down 2026-07-05) — validate any base-image/UID change against a COPY of the prod DB under real Linux permissions.
- **Long-running imports** (IGDB bulk sync, big VPS pulls): never in the foreground; back up `data/arcaid.db` before anything that touches schema.
- **Legacy alias URL rewriting:** Express strips the mount path, so `/api/leaderboard`-style aliases must reconstruct the full `/api/rooms/:roomId/...` path.
- **Service-worker cache-bust is automatic** (`arcaid-sw-build-id` Vite plugin) — never bump a cache name by hand; never swap an `admin-ui/public/` asset in place, rename it. → `admin-ui.md`
- **Under vitest, `IScoredSnapshotService` is inert unless the test calls `setRootForTests`** — otherwise unrelated maintenance tests reach the real iScored API with `.env` creds.

## Deployment

Production is always Docker (`docker compose up -d --build`); admin UI assets build inside the image and are served by Express. `deploy.yml` builds the image and deploys to Hetzner on push to `main`; `GET /api/version` → `{version, commit, builtAt}` from `package.json` + `APP_GIT_SHA`/`APP_BUILT_AT` build-args. After deploy: `docker logs arcaid --tail 50` and verify no restart loop. `JWT_SECRET` must be set or auth breaks on first login. `ngrok http 3001` for ad-hoc public exposure during dev.

## Cross-references

- `WORK.md` — the live tracker (`npm run work:summary`; grammar in `.claude/commands/work.md`). `ROADMAP.md` / `LAUNCH.md` / `SPRINT_STATUS.md` are frozen archives that items point into.
- `CHANGELOG.md` — version-by-version history (do not duplicate here).
- `docs/decisions/` — ADRs; `docs/decisions/README.md` is the index. Load-bearing ones: 0003 secrets, 0004 catalogue identity, 0005 pin-via-NULL, 0006/0009/0016 platform rules + provenance, 0010 identity layer, 0011/0024 tombstones, 0012 iScored session registry, 0013 cache watermark, 0015 multi-IdP, 0017 Live Event, 0018 Throwdowns, 0020–0022 Witness, 0023 every score reaches Global, 0025/0026 Seasons + polls, 0027 integrity mode, 0028 WORK.md, 0029 limited attempts, 0031 flag mode, 0032/0033 routing + entry, 0034 listing, 0035 one ratings store.
- `docs/season-format-plan.md`, `docs/vpx-desktop-witness-plan.md`, `docs/infrastructure-improvement-plan.md` — design docs items point at.
- Sister repos: Castcade (`C:/code/repos/castcade`, desktop Witness producer; its asks in `docs/arcaid-side-changes.md` there) and Arcaid Witness (`C:/code/repos/arcaid-witness`, the cabinet app).
- `../CLAUDE.md` — multi-project orientation (parent monorepo).
