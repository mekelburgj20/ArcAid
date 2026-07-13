# CLAUDE.md

Guidance for Claude Code working in this ArcAid repository.

## Working agreement

- **Run via Docker.** `docker compose up -d --build` for dev/test/prod. Never suggest `npm run dev` for running the app — `npm run build` and `npm run dev` exist for CI/build verification only.
- **Always build before committing.** `docker compose build` from repo root, plus `cd admin-ui && npm run build` if UI changed. Never push to `main` without a clean build.
- Don't ask permission for `cd`, `git`, or basic file navigation — execute directly.
- **"Resume" ritual:** read `SPRINT_STATUS.md` → read `ROADMAP.md` → `git branch --show-current` → `npm run build` (and admin-ui build if relevant) → present a status summary → continue last session's work.
- For **history**, read `CHANGELOG.md`. For **architectural decisions**, read `docs/decisions/`. For **current work**, read `SPRINT_STATUS.md`. Do not duplicate them here.

## Stack

TypeScript (CommonJS, NodeNext) · Node 24 prod runtime (Playwright noble base; Node 20 in the Docker build stages + CI gate — compiled output is portable) · Discord.js v14 · Playwright · SQLite (NOT `better-sqlite3` — use the package already in `package.json`) · Express v5 · React 19 + Vite (ESM, separate `tsconfig`).

## Architecture

Two sub-applications in one process, served by Express on port 3001.

**Backend (`src/`)** compiles CommonJS to `dist/`. Entrypoint `src/index.ts` boots in order: DB init → load DB settings into `process.env` → clear leaderboard caches → validate env → start API → connect Discord → start `ScoreSyncPoller`.

- `src/engine/` — singletons via `getInstance()`: `TournamentEngine`, `Scheduler`, `ScoreSyncPoller`, `TimeoutManager`, `BackupManager`, `IdentityManager`. Per-use (NOT singletons): `IScoredClient` (Playwright), `IScoredApiClient` (HTTP). Pin-to-scoreboard creation goes through `gameCreation.ts`'s `pinGameToScoreboard()` / `unpinGameFromScoreboard()`; tournament activation goes through `TournamentEngine.activateGame()` / `processSlotMaintenance()`.
- `src/api/` — Express app in `server.ts` mounts four routers: `auth.ts` (login, OAuth, refresh), `rooms.ts` (room-scoped public + admin), `admin.ts` (super-admin), `global.ts` (non-scoped). Middleware in `middleware.ts`: `requireAuth`, `requireRoomAccess(paramName)`, `requireSuperAdmin`, `requireDiscordUser`, `conditionalRequireDiscordUser`. Rate limiters in `rateLimit.ts`. Admin writes auto-audit via `auditMiddleware.ts`. Zod schemas in `schemas.ts`.
- `src/services/` — business logic. Naming is descriptive; `ls src/services/` for the current set. Room-scoped services accept an optional `gameRoomId` parameter for filtering.
- `src/utils/` — `discord.ts`, `terminology.ts`, `cooldown.ts`, `logger.ts` (rotating-file-stream; `formatLogArg` writes `Error.stack` since Error props are non-enumerable and `JSON.stringify(err)` returns `{}`), `secrets.ts` (AES-GCM via `SECRETS_KEY` env), `platformMapping.ts` (canonical platform IDs + aliases — see "Platform stratification" below), `platformRules.ts`, `cronUtils.ts`, `catalogueUtils.ts` (`normalizeGameName`).

**Admin UI (`admin-ui/src/`)** is React 19 + Vite (ESM). All HTTP goes through `lib/api.ts` (relative `/api/` paths — never hardcode localhost). Three layouts: `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`). Plus standalone global pages (`/scoreboard`, `/games/:id`, `/friends`) — **there is NO public `/catalogue` route**; `GlobalCatalogue` is a super-admin tool under `/admin/catalogue` (public catalogue browsing happens on `/scoreboard`). Room-scoped pages get `roomId/roomSlug/roomName` from `RoomContext`. Public pages get viewer auth from `ViewerAuthContext` (auto-refreshes player tokens within 5min of expiry).

Scoreboard rendering is a Style+Theme dispatch: `SCOREBOARD_STYLE` (banner/showcase/minimal) + `SCOREBOARD_THEME` (showcase variants live in `lib/scoreboardThemes.ts`) → `CardRouter.tsx` selects `BannerCard`/`ShowcaseCard`/`MinimalCard`. Config derivation in `lib/scoreboardConfig.ts`: `deriveScoreboardConfig` is the new path; `deriveCardProps` is the legacy fallback. Live preview via `ScoreboardPreview` (CSS scale-transform).

## Multi-tenant model

One DB, many `game_rooms`. Each room has slug, optional Discord guild ID, and per-room settings in `game_room_settings`. Tournaments and ranking groups carry `game_room_id`. `migrateToMultiRoom()` in `database.ts` runs idempotently on startup.

**Auth roles:** `super_admin` (server-wide), `room_admin` (per-room — password, invite, or Discord), `player` (Discord-authenticated non-admin), guest (no token). Player tokens live in `arcaid_player_token` localStorage, separate from admin tokens.

**Discord OAuth state encoding:** `__super__` → super-admin login, `player:<slug>` → public-page player login, bare slug → room admin login. Scope must be `identify` only — `guilds.members.read` causes 400s on the authorize redirect.

**JWT refresh tokens** stored in `sessions` (30d expiry). Frontend `api.ts` auto-refreshes within 5min of access-token expiry and retries on 401 before redirecting to login.

**Per-room Discord/iScored credentials** live in `game_room_settings`: `DISCORD_GUILD_ID`, `DISCORD_ADMIN_ROLE_ID`, `DISCORD_ANNOUNCE_CHANNEL_ID`, `ISCORED_USERNAME`, `ISCORED_PASSWORD`, `ISCORED_GAMEROOM`, plus `DISCORD_ENABLED` / `ISCORED_ENABLED` toggles. The bot token + Discord client ID/secret stay global. Discord-disabled rooms are excluded from cross-room slash-command queries.

## Score system & identity

- `submissions` is the source of truth for *best-per-player-per-game*. ID format `${gameId}-${username.toLowerCase()}` (sync-compatible with iScored).
- `score_history` logs every score event with source tracking. **It is the physical union of all score sources**: community/freeplay submits dual-write into it via `ScoreHistoryService.log` (`source='community'`, from `CommunityScoreService.submitScore`), so room-wide "all scores" reads (e.g. `RoomScoresService`) read `score_history` ALONE — never UNION `community_scores` (the admin wipe-player path deletes `score_history` rows but deliberately NOT `community_scores`, so a union would resurrect wiped scores). **Tournament leaderboards read `score_history` filtered by `submitted_during_tournament_id`** (best-during-window wins) — `submissions` is still written for back-compat. As of v2.8.0, `LeaderboardService.recalculate()` partitions by `COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))` so multi-alias Discord users collapse to one row per game; pure-anon rows still partition per-name.
- **Three-table identity layer** (v2.8.0):
  - `user_mappings(discord_user_id, iscored_username UNIQUE COLLATE NOCASE, avatar_hash, created_at)` — **many-to-one**: one Discord user can hold many iScored aliases. UNIQUE on iscored_username (case-insensitive) so one alias maps to at most one Discord user. `discord_user_id` PK was dropped in migration 095.
  - `user_profiles(discord_user_id PK, display_name, avatar_hash, avatar_fetched_at, ...)` — one row per Discord user. Holds the user-chosen global display name (case-insensitively unique via partial UNIQUE INDEX `idx_user_profiles_display_name`) plus the avatar cache (moved off `user_mappings.avatar_hash`, which still exists but is no longer the read source).
  - `anonymous_identities` / `anon_room_claims` / `room_members` — pre-existing per-room claim tables; unchanged.
- **Display resolution rule.** Everywhere a player name renders: `display_name ?? iscored_username`. FE has a centralized `playerName(entry)` helper exported from `admin-ui/src/components/ScoreboardComponents.tsx`. BE responses ship both fields; matching/keying logic still uses `iscored_username` (stable identifier, used in URL routes like `/players/:name` and React `key` props).
- **Forward attribution at merge.** `MergeService.recordMerge` writes `user_mappings(discord_user_id, iscored_username)` inside the transaction with a pre-flight `MAPPING_CONFLICT` check; `ScoreSyncPoller` picks it up on the next poll cycle (load is fresh per cycle at `ScoreSyncPoller.ts:109`). `reverseMerge` deletes that alias row and re-anonymizes any post-merge auto-attributed rows (rows that weren't in the snapshot but landed under the auto-mapping rule between merge and reversal — special-cases `global_scores.player_id` vs the other tables' `discord_user_id`). `MergeService.previewMerge` derives the tournament-completed timestamp from `MAX(games.end_date) WHERE status='COMPLETED'` (no `tournaments.end_date` column exists).
- **First-claim-wins names per room.** `RoomNameClaimService.resolveAndClaim` walks a suffix loop (`Bob` → `Bob_2`); `checkAvailability` is the pre-submit dry-run used by `SubmissionSheet`. Discord claims live in `room_members.display_name`; anon claims in `anon_room_claims` (one anon-token may hold multiple names per room). The room-scoped `room_members.display_name` is **separate** from the global `user_profiles.display_name` — the former is per-room first-claim policy, the latter is the user-chosen global rendering name. Merge does NOT touch `room_members.display_name`.
- **Anon ID:** `x-user-id` header carries a `localStorage` UUID for guest write paths (community scores, comments). Used for comment author-only delete.
- **Global scoreboard fan-out gate:** `GlobalScoreService.fanOutFromRoomSubmission` early-returns when `normalizeSubmitterUserId` is null — guest submissions never appear on `/scoreboard`. iScored-synced rows still fan out via `iscored:*` synthetic IDs.
- **`conditionalRequireDiscordUser` decodes a Bearer token when present *regardless* of the room's `REQUIRE_DISCORD_LOGIN` setting.** Pre-fix: logged-in users in guest-allowed rooms silently fell through as `COMMUNITY`.
- **`/map-user` Discord command is additive (v2.8.0).** It adds an alias for the target Discord user; errors if the name is already mapped to a different user. The legacy "replace" semantic is gone (no `/unmap-user` companion shipped — deferred). All four `user_mappings` UPSERT call sites (`auth.ts`, `global.ts`, `mapuser.ts`, `submitscore.ts`, `IdentityManager.ts`) now `ON CONFLICT(iscored_username) DO NOTHING` instead of `ON CONFLICT(discord_user_id) DO UPDATE`.

**Display-name resolution in BE leaderboard queries.** Every leaderboard/ranking/stats query that ships `display_name` to the FE follows the same pattern: LEFT JOIN `user_mappings` for the `iscored:*` synthetic-id fallback, then LEFT JOIN `user_profiles` keyed on `COALESCE(submitted_by_user_id, um.discord_user_id)`. See `LeaderboardService.recalculate`, `GlobalLeaderboardService.recalculate`, `RankingService.calculateOverallRankings`, `StatsService.getOverallStats`/`getAllPlayerStats`/`getRoomOverview`, and `/api/global/recent-scores`.

All web submission paths (`/submit-score`, `/freeplay-score`, `/community-scores`) sync via `IScoredSubmitSync.syncScoreToIScored()` — single helper, divergence not possible. `IScoredApiClient.submitScore` parses response text before `JSON.parse` to handle "Access Denied" plain-text rejections.

**Per-row score moderation (v2.9.0).** Two delete paths, both gated server-side and emitting `leaderboard:updated` globally on success.
- **Admin "wipe player from game"** — `DELETE /api/rooms/:roomId/admin/games/:gameId/submissions/:submissionId` (`requireAuth + requireRoomAccess`). Drops the `submissions` row + every matching `score_history` row for `(game_room_id, lower(iscored_username), game_id-or-game_name)`. Works on pinned games (LEFT JOIN tournaments + `ownedByRoom` check; pre-v2.9 the INNER JOIN 404'd pinned rows). Surfaced via `ManageScoresModal` (admin Leaderboard page → "Scores" button on each card).
- **Per-row delete (admin or self)** — `DELETE /api/rooms/:roomId/score-history/:historyId` (`requireDiscordUser`). Authorization tiers: super_admin → any row; room_admin → any row in their rooms; player → only rows where `submitted_by_user_id === viewer.discordId`. Restricted to `source IN ('tournament','sync')`. After delete, recomputes the corresponding `submissions` row from remaining `score_history` (`ORDER BY score DESC, created_at ASC LIMIT 1`); deletes if none left, else updates `score`+`timestamp` to the new top row's values. Surfaced as a hover-only trash icon on each row in the `GameDetail.tsx` per-player history expand.
- **`deleted_score_suppressions` tombstone (migration 096).** iScored has no per-score delete API. Without help, `ScoreSyncPoller` would re-import the deleted score on the next ~30s cycle. Both delete paths write `(game_id, lower(iscored_username), suppressed_score)` with `MAX(existing, deleted_score)` on conflict. The poller bulk-loads suppressions per game and skips `score <= suppressed_score` before its existing `> existing.score` check — new higher scores still flow through, deleted scores stay deleted. iScored-side cleanup remains manual (ROADMAP).

## iScored integration

`IScoredApiClient` (HTTP, fast) is the default for score read/write. `IScoredClient` (Playwright) is required for game management — hide/create/delete — and is the fallback when the API can't satisfy a call. `ISCORED_API_ENABLED` gates the path. `ScoreSyncPoller` runs continuous background sync (default 10s tick) with pause/resume during maintenance. Settings hot-reload through `SettingsService`.

**Per-account session serialization (v2.10.0).** Every Playwright iScored mutation goes through `IScoredSessionRegistry.withSession(creds, fn)` — a singleton in `src/engine/IScoredSessionRegistry.ts`. Calls for the same iScored account chain serially: only one `fn` runs at a time per account. The underlying client is held across calls within a 1.5s idle TTL so cron-fire batches reuse the same Playwright login. **`new IScoredClient(...)` is allowed only inside the registry's `acquireClient` method** — every other call site (TournamentEngine, TimeoutManager, gameCreation, IScoredSubmitSync, the four rooms.ts admin endpoints, the four Discord commands, the admin backup endpoint) acquires sessions via the registry. Pre-v2.10 each call site constructed its own client; on rtx_pinball's Wed 22:00 fire (4 weeklies + DG sharing one account) this caused dropdown-state-flip contention — `IScoredClient.deleteGame` short-circuited at line 692 with `Game '<name>' not found in dropdown. Skipping delete.` and the local DB went HIDDEN while iScored kept the entry visible. See ADR 0012.

**`deleteGame` returns `Promise<boolean>`.** `false` on the dropdown short-circuit (entity not found), `true` on completed delete. Callers (`runCleanup`, `deleteGameCompletely`, the rooms.ts admin endpoints) branch on the result and log accurately. Pre-v2.10 the method returned `void` and callers logged `Deleted from iScored: <name>` regardless — failure was indistinguishable from success.

**Notification-gated polling (v2.10.0).** Each tick fetches iScored's static `/notifications/rooms/room_<roomID>.txt` per account; the expensive `getAllScores` call only fires when the body changed (or the 10 min backstop elapsed). `IScoredNotificationGate` owns the cache + decision. roomID is auto-discovered from the public `roomCommands.php?c=getRoomInfo&user=<slug>` endpoint at first poll (not under `/api/`, undocumented but used by iScored's own room iframe); `ISCORED_ROOM_ID` env overrides for the env-fallback account only. Discovery failure → one-time WARN + degrade to backstop-only polling for that account. Backstop interval configurable via `ISCORED_API_POLL_BACKSTOP_MS` (default 600000). Background: Daniel Reynolds (iScored) → Justin, 2026-04-29: 500K queries/month vs. 10 actual scores entered prompted the change.

**Deactivate vs. Delete (v2.7.x).** Two distinct admin actions on an ACTIVE game, both surfaced on the Tournaments admin page:

- **Deactivate** — `TournamentEngine.deactivateGame()` and `processSlotMaintenance()` (cron rotation). End-of-round semantics. Steps: (1) `finalSyncScoresForGame()` pulls iScored scores into `submissions` + `score_history` so anything submitted between the last poll cycle and this call is captured, (2) `setGameStatus({ locked: true })` on iScored (skipped as `'shared'` when another ACTIVE row owns the same `iscored_id`), (3) mark COMPLETED — `iscored_id` is intentionally KEPT non-NULL so `runCleanup`'s retain/scheduled/immediate policies can still find the row.

- **Delete** — `TournamentEngine.deleteGameCompletely()` exposed at `DELETE /api/rooms/:roomId/games/:id`. Destructive variant for "wrong game in wrong tournament". Steps: (1) final sync (same as above), (2) `deleteGame()` on iScored (also `'shared'`-guarded), (3) orphan local scores (`UPDATE submissions/score_history SET game_id = NULL` and `global_scores SET origin_game_id = NULL` per ADR 0005), (4) `DELETE FROM games`. Score *records* are kept so the player's personal history is preserved, but the games row and its leaderboard are gone.

The duplicate-DM bug (WHO dunnit / rtx_pinball incident, 2026-04-27) is killed by the SyncPoller's `ORDER BY` (status pref then `created_at DESC`, see `ScoreSyncPoller.pollOneAccount`) — even when legacy rows share an `iscored_id`, the poller deterministically picks the ACTIVE one and matches the existing `submissions` row by id. `finalSyncScoresForGame` is shared by both Deactivate and Delete; it never fires `LobbyFeedGenerator.onScoreSubmitted` (data capture only, no live events).

## Catalogue (global_games)

- **4-step dedup hierarchy** in `GlobalGameService.upsert`: (1) external ID match (`opdb_id`/`vps_id`/`igdb_id`, with cross-type guard), (2) IPDB URL cross-reference for pinball, (3) reserved, (4) normalized-name match (full-table scan + JS-side `normalizeGameName` — no SQL `LIKE` because punctuation broke it). Step 4 is two-tier: **concrete** matches (both sides have non-null mfg + year, exact match) outrank **loose** (NULL-tolerant). Tie-break: external-ID count → mfg/year populatedness → oldest `created_at`.
- Composite UNIQUE INDEX `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))`. Same-name pinballs from different manufacturers coexist; true `(name, type, mfg, year)` dupes reject. See ADR 0004.
- **Library = global catalogue.** As of v2.6.0 the legacy `game_library` table is dropped (migration 092). Tournament activation, the per-room library page, autopick, Discord autocomplete, and leaderboard image fallback all read from `global_games WHERE status='approved'` directly. See ADR 0007.
- **`game_room_game_library` survives** (post-v2.6.0) for one purpose only: per-game style overlay (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`) keyed on `(game_room_id, game_name)`. The `custom_platforms` and `display_name` overlay columns are unread (column kept for now). Future cleanup will re-key the surviving overlay onto a `(game_room_id, global_game_id)` table and drop this one too.
- **Per-room game tags** live in a separate table `room_game_tags(game_room_id, global_game_id, tag)` — variant-keyed via `global_games.id`. Game's effective platforms = catalogue platforms ∪ room tags. UNION applied across `ensurePlatformAllowed`, `/api/submit/platforms`, `/:roomId/platforms/available`, library list response, web pick-game, admin activate-game, Discord activate/pick autocomplete, autopick paths. `RoomGameTagsService.getTagMapByGameNameForRoom` is the batched-lookup helper. Migration 093. See ADR 0008.
- **Pending-approval flow:** room admins propose new globals via `POST /:roomId/game_library/submit_to_global` (`status='pending'`); super-admins approve/reject/merge at `/admin/catalogue/approvals`. Public `GET /global/games` hard-codes `status='approved'`.
- **`GlobalGameService.findCandidates(input)`** is the read-only dedup walker (extracted from `upsert`'s hierarchy) powering the per-room contribution proposal endpoints.

## Catalogue importers

Each importer feeds the same `GlobalGameService.upsert` path so the dedup hierarchy keeps the catalogue clean. Admin endpoints under `/api/admin/catalogue/sync-<source>`; FE buttons on `/admin/catalogue`.

- **VPS** (Virtual Pinball Spreadsheet) — primary pinball metadata source. Fetches the VPS database JSON, splits into `playable` + `cataloguable` filters, downloads images. Background image-download pass after the metadata pass returns.
- **VPXS Wizard** — README parser, splits `wizard_auto` (verified VPXS) from `wizard_manual` (Manual Install Tables). Tags `vpxs` vs `vpxs_manual` accordingly.
- **OPDB** — pinball metadata + manufacturer/year data. Requires `OPDB_API_KEY` env var.
- **IGDB** — arcade/console games via Twitch OAuth. Requires `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`.
- **Steam Pinball** — Zen + Zaccaria DLC catalogues across six Steam apps. `tmp/pack-contents-draft.md` source-of-truth → `src/services/steamPinballPackContents.ts` (committed). Curated `PACK_CONTENTS` map expands DLCs into per-table upserts. v2.5.0.
- **FX VR** — Pinball FX VR (Meta Quest standalone) catalogue tagger. `tmp/fx-vr-tables-draft.md` (gitignored) → `tmp/emit-fx-vr-data-ts.js` → `src/services/fxVrPackContents.ts`. 39 tables across 17 packs. Tags `pinball_fx_vr`. v2.7.0.
- **AtGames** — pulls column A of a curated Google Sheet (public CSV export, no API key). Always tags `atgames` + one `atgames_<variant>` per detected cabinet (HD/4K/Micro/HDP/ALU/Mini/Gamer/Core) extracted from columns H/I/J/K. v2.7.0.

### Refreshing curated importers

Three importers (Steam Pinball, FX VR, AtGames Sheet) follow the same pattern: a hand-curated source-of-truth lives in `tmp/` (gitignored), an emitter script generates a typed TS data module that's committed to `src/services/`, and an import service consumes it. To add new entries:

| Importer | Source-of-truth (gitignored) | Emitter | Committed data module | Refresh cadence |
|---|---|---|---|---|
| **Steam Pinball** | `tmp/pack-contents-draft.md` | manual edit + commit `steamPinballPackContents.ts` | `src/services/steamPinballPackContents.ts` | **No defined go-forward path** — initial 220 tables across 78 packs were curated in v2.5.0; updating when Zen/Zaccaria add DLC requires re-deriving the pack list and regenerating by hand. |
| **FX VR** | `tmp/fx-vr-tables-draft.md` (39 tables, 17 packs) | `node tmp/emit-fx-vr-data-ts.js > src/services/fxVrPackContents.ts` | `src/services/fxVrPackContents.ts` | Edit the draft to add tables/packs as Zen ships them, regenerate, click "Sync FX VR" on the Catalogue admin page. |
| **AtGames Sheet** | the user's public Google Sheet (no local draft file) | none — fetched live at sync time | none committed | Edit the sheet, click "Sync AtGames" on the Catalogue admin page. |

For Steam Pinball specifically: when a Steam app gains a new DLC pack, the current process is to hand-add it to `steamPinballPackContents.ts` along with its tables. A future "regenerate from Steam app metadata" tool would help but isn't built — the curation step (deciding which tables count, applying display-name normalization) is partly judgment-based.

Endpoints: `POST /admin/catalogue/sync-steam-pinball`, `POST /admin/catalogue/sync-fx-vr`, `POST /admin/catalogue/sync-atgames`. All three use `GlobalGameService.upsert` so the dedup hierarchy keeps the catalogue clean across re-runs (idempotent).

## Platform taxonomy

Canonical IDs live in `src/utils/platformMapping.ts` (BE) **and** `admin-ui/src/lib/platforms.ts` (FE). When adding/changing a platform, update both — the FE has its own copy of `CANONICAL_PLATFORMS` + `PLATFORM_ALIASES`. Forgetting causes silent FE/BE drift. Display label fallback uppercases unknown ids (`fx2` → `FX2`).

Categories: physical (`real`, `atgames` + 8 variants), virtual_pinball (Visual Pinball X/9, VPX Standalone + manual, Future Pinball, BAM, Pinball FX family + classic + classic VR + midnight + VR, Star Wars Pinball VR, Zaccaria + VR), arcade_video (NES/SNES/Genesis/etc.).

## Pin-to-scoreboard

`games.tournament_id IS NULL` is the canonical pinned-row signal. `games.game_room_id` is denormalized (equals `tournament.game_room_id` for tournament rows; set explicitly for pins). Unique partial index `idx_games_pinned_unique ON games(game_room_id, LOWER(name)) WHERE tournament_id IS NULL` prevents double-pin per room. **Cascade on unpin is application-level, NOT `ON DELETE CASCADE`:** `UPDATE submissions SET game_id = NULL` (and same for `score_history` + `global_scores.origin_game_id`) before DELETE — keeps history. See ADR 0005.

## Platform stratification

`platform` is required at the API boundary on `submissions`/`score_history`/`community_scores`/`global_scores` (column nullable in SQL for legacy rows). **Two orthogonal axes:**

- **`required` ("Must be available on") → game-level eligibility ONLY.** `passesplatformRules(gamePlatforms, rules)` checks game has at least one required platform; decides which games qualify for the tournament. Does NOT restrict which platforms can submit scores.
- **`excluded` ("Not allowed on") → submission-level filter ONLY.** `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` returns the picker set as `gamePlatforms − excluded` (required is intentionally not applied here). Does NOT restrict game eligibility.

Example: WHO dunnit on `[vpx, vpxs, real, fx, fx_vr, atgames]`. Tournament Must=`[atgames]`, NotAllowed=`[]`. Game qualifies (has atgames). Picker shows all 6 platforms — player may submit a vpx, vpxs, real, fx, fx_vr, or atgames score.

`SubmissionSheet` reads via `GET /api/submit/platforms` which returns `{ platforms, submittable, tournamentRules }`. One platform → read-only chip; 2+ → required dropdown. Chip caption disambiguates with `fullGamePlatforms.length > 1` → "(only platform allowed by this tournament)" else "(only platform for this game)". Discord `/submit-score` auto-fills when 1, prompts when 2+. Server re-validates at every submit handler (`ensurePlatformAllowed`, also strict-excluded-only). `/leaderboard/:gameId?platform=X` returns `distinctPlatforms[]` for the GameDetail tab strip. See ADR 0006.

**When adding/changing a platform:** update `src/utils/platformMapping.ts` AND mirror to `admin-ui/src/lib/platforms.ts` (FE has its own copy of `CANONICAL_PLATFORMS` + `PLATFORM_ALIASES`). Forgetting causes silent FE/BE drift.

## At-rest secret encryption

`src/utils/secrets.ts` provides AES-GCM keyed off `SECRETS_KEY` env (mint via `npm run generate-secrets-key`). `ENCRYPTED_SETTING_KEYS` is a deliberate allowlist (no convention-based auto-encrypt). **Adding a new secret means adding it to the allowlist** — typo-proofing. `SettingsService` and `GameRoomSettingsService` consult `isEncryptedKey(key)` for encrypt-on-write / decrypt-on-read. `maskEncryptedValues` returns `[ENCRYPTED]` placeholder on `GET /admin/settings` so the UI never round-trips ciphertext. See ADR 0003.

## Lobby, social, notifications

- **Lobby feed** lives in `lobby_feed_events` (separate from `room_events` — 90-day retention vs 7, different query patterns). Cursor pagination via `created_at`. WebSocket channel `lobby:${roomId}`. `LobbyFeedGenerator.onScoreSubmitted` is hooked into all score submission paths via fire-and-forget dynamic imports. Lobby config (social links, pinned message, feed settings) stored as JSON in `game_room_settings` keys — no new tables.
- **Friends** use a unidirectional follow model. `FriendsService.getPlayersWhoFriended` is the reverse lookup driving targeted `friend_score` events.
- **`NotificationService.notify`** checks per-user opt-in prefs (`notification_prefs` JSON on `user_preferences`) + in-memory rate limit (5/user/hour). Five types, all default-off: `tournamentWin`, `turnToPick`, `tournamentStarting`, `rankDethroned`, `friendScore`. Managed via `/arcaid-notifications` Discord command.
- **Milestones** use "exactly equals threshold" count queries — no separate tracking table.

## Patterns worth knowing

- **Game queue:** explicit `queue_order` column (FIFO), max 5 per user per tournament. Cooldown revalidation at activation; ineligible queued games auto-removed during maintenance.
- **Tournament rotation guards:** `processSlotMaintenance()` checks `max_active_games` and existing `[Pending Pick]` rows before creating picker slots. `TimeoutManager.fallbackToAutoSelection()` includes orphan cleanup.
- **Per-slot picker dedup (v2.9.0):** picker placeholder dedup is keyed `(tournament_id, picker_discord_id, won_game_id)` — was `(tournament_id, picker_discord_id)` pre-v2.9 which collapsed multi-slot wins (e.g. WG-VPXS max=2 with the same player on top of both got one prompt + one DM, only one slot got refilled). DM and channel embed both name the won game. `won_game_id` is not an FK with cascade — admin removing a completed game leaves the placeholder dangling, but `GET /:roomId/pick-status` LEFT JOINs so `won_game_name` falls null gracefully and the FE clause is conditional.
- **Discord `/pick-game` placeholder fulfillment (v2.9.0):** the Discord command now mirrors the web `/pick-game` route's three-branch flow — pending+full repurposes the placeholder (keeps `queue_order = NULL` so it stays at the front of the queue), open-slot drops any existing placeholder inside the activate transaction, no-pending+full queues normally. Pre-v2.9 the Discord command branched only on `hasOpenSlot` and left placeholders dangling.
- **Cleanup-race fix (v2.9.0):** Wed `0 22 * * *` daily maintenance + `0 22 * * 3` scheduled cleanup fire at the same instant; pre-fix the cleanup query ran before maintenance had completed today's active game and missed it. Now `runMaintenanceWork` runs cleanup inline at the end of the slot loop when `cleanupRule.mode === 'scheduled'` AND the cleanup cron's `min/hour/dom/mon/dow` would all match right now in its timezone (`cleanupCronMatchesNow` helper). Separate cleanup cron stays registered — fires idempotently.
- **Ranking-group cache watermark (v2.10.1):** `ranking_groups_cache` self-invalidates via a fingerprint over indexed columns — `(eligible_games_count, score_count, score_sum, MAX(end_date), MAX(start_date))` for the group's tournaments. `RankingService.getRankings` recomputes the watermark on every read; mismatch with the stored snapshot triggers silent recompute. **No mutation code path needs to call `RankingService.invalidate*()`** for score / game-status changes — the data tells us when it's stale. Manual "Recompute" admin button retained as a diagnostic escape hatch but is no longer load-bearing. `RankingService.update()` (config changes, not data changes) is the one path that still calls `invalidate()` directly. Sub-10ms watermark vs. ~50-200ms recompute — net win on every cache hit. See ADR 0013.
- **Room-admin observability (v2.15.0, S10):** `GET /:roomId/admin/health` aggregates four things → (1) Discord gateway readiness + guild membership via `getDiscordClient()?.isReady()` / `.isInGuild(guildId)`. **The live `DiscordClient` is reachable via the module-level `getDiscordClient()` accessor** (set in its constructor); pre-S10 the gateway `Client` was a private field on a throwaway local in `index.ts`, so every "bot online" check (`DashboardService`, `/api/status`) was env-var *presence*, not connection state. (2) `ScoreSyncPoller.getStatus()` — global + per-account (`accountHealth` map) last-success / last-error timestamps + consecutive-failure counts. (3) Per-tournament last run from **`maintenance_runs` (migration 106)** — `runMaintenance()` records one row (`success` / `skipped` / `error` + summary + duration) for every cron *and* forced run via `MaintenanceRunService`; append-only, **no FK** (an audit log that outlives its tournament, like `games.tournament_id`). (4) `getVersionInfo()`. Force Maintenance (`POST .../game-states/force-maintenance`) now **awaits** the run and returns the real outcome (was fire-and-forget + a blind 3s FE refetch). **`OpsAlertService.sendOperatorAlert`** DMs a super-admin after `OPS_ALERT_FAIL_THRESHOLD` (5) consecutive poller failures for one account, debounced once-per-outage + re-armed on recovery — **ships inert** behind global settings `OPS_ALERT_ENABLED` + `OPS_ALERT_DISCORD_USER_ID` (both unseeded → off; not encrypted — a user ID isn't a secret). App version: `GET /api/version` → `{version, commit, builtAt}` (version from root `package.json` via `npm_package_version`; `commit`/`builtAt` from `APP_GIT_SHA`/`APP_BUILT_AT` env baked by `deploy.yml` `GIT_SHA`/`BUILT_AT` build-args in the `Dockerfile` prod stage) — **NOT** the SW `CACHE_NAME`.
- **Style catalogue is global** (shared across rooms). Per-game overlay via `logo_style_id` + `bg_style_id` on `games` and `game_room_game_library`. Resolution: `effectiveBgId = bgStyleId || catalogueStyleId`.
- **Image upload limit** 30MB. Formats PNG/APNG/JPEG/WebP. APNG animates natively in `<img>` tags.
- **Score abbreviation:** scores ≥1T render as `X.XT` with full value in tooltip.
- **Score toast:** WebSocket `score:new` carries `{ gameId, gameName, playerName, score }`; Scoreboard shows slide-down toast.
- **Themes:** 11 themes in CSS variables. Admin theme is per-user (`user_preferences`); scoreboard theme is room-wide (`SCOREBOARD_THEME`). `ThemeProvider` reads localStorage first to avoid flash.
- **PWA:** `manifest.json` + `sw.js` in `admin-ui/public/`; service worker is cache-first for static assets, network-first for navigation.
- **Public slug matching is case-insensitive.**

## Gotchas (silent-failure mode)

- **Service-worker cache-bust:** any UI-visible change must bump `CACHE_NAME` in `admin-ui/public/sw.js`. Static JS/CSS is cache-first; skip the bump and installed PWAs pin to old bundle.
- **Tailwind on Windows:** must use `@tailwindcss/postcss` (NOT `@tailwindcss/vite` — oxide scanner fails silently).
- **Express v5:** `req.params` values typed `string | string[] | undefined`. Cast `as string` at use site.
- **`rotating-file-stream` types** are at `dist/types/index.d.ts`, not the package root.
- **node-cron** does NOT support `L` (last day of month). `Scheduler.resolveCron()` maps `L` → `28-31` and runtime-guards inside the job.
- **Discord ActionRow** holds max 5 buttons. Star-rating + Skip required splitting into multiple rows.
- **Production container is `arcaid`** (not `arcaid-bot`). No `sqlite3` binary inside — use `node -e` with the existing JS package for ad-hoc DB queries.
- **Legacy alias URL rewriting:** Express strips the mount path, so `/api/leaderboard`-style aliases must explicitly reconstruct the full `/api/rooms/:roomId/...` path including segment.
- **Cross-component DOM events:** PublicLayout (nav) ↔ Scoreboard (Outlet child) communicate via `window.dispatchEvent(new Event('open-scoreboard-prefs'))`. Used because React Router `<Outlet />` doesn't pass props down.
- **Background-sync routes** (`/admin/catalogue/sync-opdb`, `/sync-igdb`) validate credentials upfront and return `400` with an actionable message — pre-fix they returned `202 started` and threw silently.
- **Long-running imports** (IGDB bulk sync, big VPS pulls): never run in foreground, and back up `data/arcaid.db` first if the operation touches schema.
- **Fan-out try/catch swallows column errors silently.** When changing schema in any score table, verify the fan-out path's column references against the live schema.
- **Discord embed colors:** daily=gold(0xFFD700), weekly=blue(0x00BFFF), monthly=purple(0xAA00FF), custom=green(0x00FF88).
- **Playwright base image is hard-coupled to the npm `playwright` version.** The Dockerfile prod stage is `FROM mcr.microsoft.com/playwright:v<X>-noble` with **no `npx playwright install`** — browsers come *only* from the base image, so the npm `playwright` version MUST equal the base-image tag. Bump one without the other and the container's browsers mismatch → every `IScoredClient` op (game create/hide/delete, `/sync-state`, tournament maintenance rotation) throws `Executable doesn't exist` at runtime. **No CI gate catches it:** vitest mocks Playwright and the Docker build never launches a browser. When bumping `playwright` — including any Dependabot backend-minor-patch group that happens to include it — bump the `Dockerfile` base-image tag in the SAME commit/PR (they must land in one deploy; splitting breaks prod in either merge order). Surfaced by the 2026-07-05 safe-wave 1.58.2→1.61.1 bump. **The base moved `jammy`→`noble` in the sqlite3-6 migration** (noble = Ubuntu 24.04, glibc 2.39; sqlite3 6.0.1's prebuild needs `GLIBC_2.38`, which jammy's 2.35 lacks — the app would crash on DB init at boot). Noble also ships Node 24, so the prod runtime is Node 24 (pinned via NodeSource `setup_24.x`). **CRITICAL: `arcaid` is pinned to uid 999 in the Dockerfile** — noble's default `useradd` assigns 997, but the bind-mounted `/app/data` + existing `arcaid.db` are owned by uid 999 (from prod's jammy history) and the CMD's `/app/data` chown is non-recursive; without the pin, the 997 user can't write the 999-owned DB → `SQLITE_READONLY` crash on boot (this took prod down on the first noble deploy attempt, 2026-07-05, reverted; fix = `useradd -u 999`). **A fresh-DB boot test does NOT catch this** (a fresh DB is created by the running user, so ownership always matches) — validate any base-image/UID change against a COPY of the prod DB under real Linux permissions.

## Database

SQLite at `data/arcaid.db` (git-ignored). Schema auto-creates on first run. Migrations are an inline array in `database.ts` (NOT a `migrations/` folder of files), run idempotently on startup in array order, tracked by `name` in `schema_migrations`; complex handlers are extracted to `src/database/migrations/*.ts`. Claim the next free number before coding. Read the migration entries directly for column-by-column intent — that's the source of truth, don't try to maintain a list here.

**Foreign-key enforcement is ON (S3).** `PRAGMA foreign_keys = ON` is set in `initDatabase` **after** the migration loop + `migrateToMultiRoom` (just before `return db`), **never at connection-open** — migrations 066/077/095 are FK-checked table rebuilds (SQLite requires `foreign_keys` OFF for create-copy-drop-rename), and a swallowed 077 `INSERT…SELECT` failure under enforcement would half-migrate a legacy DB. A one-time `PRAGMA foreign_key_check` logs (does not throw) residual violations after enabling. Declared `ON DELETE CASCADE`s are now **load-bearing** (the ~14 `game_rooms` children + ranking/global-game children auto-clean). **New cross-table deletes must either rely on a declared cascade or unlink/clean NO-ACTION children first** — the known NO-ACTION refs are `games.tournament_id`, `submissions`/`scores`/`score_history.game_id` (unlink → NULL, ADR 0005), `global_scores.global_game_id` (NOT NULL → delete) / `origin_game_room_id` (unlink), and `merge_records.anonymous_identity_id`. The fixed delete paths are `TournamentService.delete`, `GameRoomService.delete`, `GlobalGameService.delete`, and the admin "remove game, retain scores" route. **Caveat:** 17 ALTER-added columns (`tournaments.game_room_id`, `ranking_groups.game_room_id`, the `submitted_*` context columns on the score tables, `games.game_room_id`/`won_game_id`) are **pseudo-FKs with no real constraint** — SQLite can't add enforced FKs via `ALTER TABLE` — so integrity coverage is partial, not total.

## Deployment

Production is always Docker (`docker-compose up -d --build`). Admin UI assets build inside the image and are served by Express. Custom domain mapping is infra-level (DNS + reverse proxy). `ngrok http 3001` for ad-hoc public exposure during dev.

After deploy: `docker logs arcaid --tail 50` and verify no restart loop. `JWT_SECRET` must be set or auth breaks on first login.

## Cross-references

- `SPRINT_STATUS.md` — current/last-session work
- `ROADMAP.md` — outstanding tasks, phantom anon-claim cleanup runbook
- `CHANGELOG.md` — version-by-version history (do not duplicate here)
- `docs/decisions/` — ADRs (0003 secrets, 0004 catalogue identity, 0005 pin-via-NULL, 0006 platform stratification, 0007 library=catalogue, 0008 room game tags, 0009 platform rules orthogonal, 0010 user identity layer, 0011 deleted-score tombstone, 0012 iScored session registry, 0013 cache watermark validation, 0014 manufacturer dedup guard + based_on_ipdb_url)
- `docs/step-2-cleanup-plan.md` — library/catalogue unification cleanup plan (COMPLETE in v2.6.0; deviation noted at the top of the file)
- `../CLAUDE.md` — multi-project orientation (parent monorepo)
