# CLAUDE.md

Guidance for Claude Code working in this ArcAid repository.

## Working agreement

- **Run via Docker.** `docker compose up -d --build` for dev/test/prod. Never suggest `npm run dev` for running the app — `npm run build` and `npm run dev` exist for CI/build verification only.
- **Always build before committing.** `docker compose build` from repo root, plus `cd admin-ui && npm run build` if UI changed. Never push to `main` without a clean build.
- Don't ask permission for `cd`, `git`, or basic file navigation — execute directly.
- **"Resume" ritual:** read `SPRINT_STATUS.md` → read `ROADMAP.md` → `git branch --show-current` → `npm run build` (and admin-ui build if relevant) → present a status summary → continue last session's work.
- For **history**, read `CHANGELOG.md`. For **architectural decisions**, read `docs/decisions/`. For **current work**, read `SPRINT_STATUS.md`. Do not duplicate them here.

## Stack

TypeScript (CommonJS, NodeNext) · Node 20 · Discord.js v14 · Playwright · SQLite (NOT `better-sqlite3` — use the package already in `package.json`) · Express v5 · React 19 + Vite (ESM, separate `tsconfig`).

## Architecture

Two sub-applications in one process, served by Express on port 3001.

**Backend (`src/`)** compiles CommonJS to `dist/`. Entrypoint `src/index.ts` boots in order: DB init → load DB settings into `process.env` → clear leaderboard caches → validate env → start API → connect Discord → start `ScoreSyncPoller`.

- `src/engine/` — singletons via `getInstance()`: `TournamentEngine`, `Scheduler`, `ScoreSyncPoller`, `TimeoutManager`, `BackupManager`, `IdentityManager`. Per-use (NOT singletons): `IScoredClient` (Playwright), `IScoredApiClient` (HTTP). Pin-to-scoreboard creation goes through `gameCreation.ts`'s `pinGameToScoreboard()` / `unpinGameFromScoreboard()`; tournament activation goes through `TournamentEngine.activateGame()` / `processSlotMaintenance()`.
- `src/api/` — Express app in `server.ts` mounts four routers: `auth.ts` (login, OAuth, refresh), `rooms.ts` (room-scoped public + admin), `admin.ts` (super-admin), `global.ts` (non-scoped). Middleware in `middleware.ts`: `requireAuth`, `requireRoomAccess(paramName)`, `requireSuperAdmin`, `requireDiscordUser`, `conditionalRequireDiscordUser`. Rate limiters in `rateLimit.ts`. Admin writes auto-audit via `auditMiddleware.ts`. Zod schemas in `schemas.ts`.
- `src/services/` — business logic. Naming is descriptive; `ls src/services/` for the current set. Room-scoped services accept an optional `gameRoomId` parameter for filtering.
- `src/utils/` — `discord.ts`, `terminology.ts`, `cooldown.ts`, `logger.ts` (rotating-file-stream; `formatLogArg` writes `Error.stack` since Error props are non-enumerable and `JSON.stringify(err)` returns `{}`), `secrets.ts` (AES-GCM via `SECRETS_KEY` env), `platformMapping.ts` (canonical platform IDs + aliases — see "Platform stratification" below), `platformRules.ts`, `cronUtils.ts`, `catalogueUtils.ts` (`normalizeGameName`).

**Admin UI (`admin-ui/src/`)** is React 19 + Vite (ESM). All HTTP goes through `lib/api.ts` (relative `/api/` paths — never hardcode localhost). Three layouts: `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`). Plus standalone global pages (`/scoreboard`, `/catalogue`, `/games/:id`, `/friends`). Room-scoped pages get `roomId/roomSlug/roomName` from `RoomContext`. Public pages get viewer auth from `ViewerAuthContext` (auto-refreshes player tokens within 5min of expiry).

Scoreboard rendering is a Style+Theme dispatch: `SCOREBOARD_STYLE` (banner/showcase/minimal) + `SCOREBOARD_THEME` (showcase variants live in `lib/scoreboardThemes.ts`) → `CardRouter.tsx` selects `BannerCard`/`ShowcaseCard`/`MinimalCard`. Config derivation in `lib/scoreboardConfig.ts`: `deriveScoreboardConfig` is the new path; `deriveCardProps` is the legacy fallback. Live preview via `ScoreboardPreview` (CSS scale-transform).

## Multi-tenant model

One DB, many `game_rooms`. Each room has slug, optional Discord guild ID, and per-room settings in `game_room_settings`. Tournaments and ranking groups carry `game_room_id`. `migrateToMultiRoom()` in `database.ts` runs idempotently on startup.

**Auth roles:** `super_admin` (server-wide), `room_admin` (per-room — password, invite, or Discord), `player` (Discord-authenticated non-admin), guest (no token). Player tokens live in `arcaid_player_token` localStorage, separate from admin tokens.

**Discord OAuth state encoding:** `__super__` → super-admin login, `player:<slug>` → public-page player login, bare slug → room admin login. Scope must be `identify` only — `guilds.members.read` causes 400s on the authorize redirect.

**JWT refresh tokens** stored in `sessions` (30d expiry). Frontend `api.ts` auto-refreshes within 5min of access-token expiry and retries on 401 before redirecting to login.

**Per-room Discord/iScored credentials** live in `game_room_settings`: `DISCORD_GUILD_ID`, `DISCORD_ADMIN_ROLE_ID`, `DISCORD_ANNOUNCE_CHANNEL_ID`, `ISCORED_USERNAME`, `ISCORED_PASSWORD`, `ISCORED_GAMEROOM`, plus `DISCORD_ENABLED` / `ISCORED_ENABLED` toggles. The bot token + Discord client ID/secret stay global. Discord-disabled rooms are excluded from cross-room slash-command queries.

## Score system & identity

- `submissions` is the source of truth for *best-per-player-per-game*. ID format `${gameId}-${username.toLowerCase()}` (sync-compatible with iScored).
- `score_history` logs every score event with source tracking. **Tournament leaderboards read `score_history` filtered by `submitted_during_tournament_id`** (best-during-window wins) — `submissions` is still written for back-compat. `LeaderboardService.recalculate()` uses `ROW_NUMBER() OVER (PARTITION BY LOWER(iscored_username) ORDER BY score DESC, created_at ASC)`.
- Player identity is keyed on **`iscored_username` (NOT `discord_user_id`)**. Leaderboards group by `LOWER(iscored_username)`. Merge/rename via `POST /admin/merge-player`.
- **First-claim-wins names per room.** `RoomNameClaimService.resolveAndClaim` walks a suffix loop (`Bob` → `Bob_2`); `checkAvailability` is the pre-submit dry-run used by `SubmissionSheet`. Discord claims live in `room_members.display_name`; anon claims in `anon_room_claims` (one anon-token may hold multiple names per room).
- **Anon ID:** `x-user-id` header carries a `localStorage` UUID for guest write paths (community scores, comments). Used for comment author-only delete.
- **Global scoreboard fan-out gate:** `GlobalScoreService.fanOutFromRoomSubmission` early-returns when `normalizeSubmitterUserId` is null — guest submissions never appear on `/scoreboard`. iScored-synced rows still fan out via `iscored:*` synthetic IDs.
- **`conditionalRequireDiscordUser` decodes a Bearer token when present *regardless* of the room's `REQUIRE_DISCORD_LOGIN` setting.** Pre-fix: logged-in users in guest-allowed rooms silently fell through as `COMMUNITY`.

All web submission paths (`/submit-score`, `/freeplay-score`, `/community-scores`) sync via `IScoredSubmitSync.syncScoreToIScored()` — single helper, divergence not possible. `IScoredApiClient.submitScore` parses response text before `JSON.parse` to handle "Access Denied" plain-text rejections.

## iScored integration

`IScoredApiClient` (HTTP, fast) is the default for score read/write. `IScoredClient` (Playwright) is required for game management — lock/hide/create/delete — and is the fallback when the API can't satisfy a call. `ISCORED_API_ENABLED` gates the path. `ScoreSyncPoller` runs continuous background sync (default 30s) with pause/resume during maintenance. Settings hot-reload through `SettingsService`.

## Catalogue (global_games)

- **4-step dedup hierarchy** in `GlobalGameService.upsert`: (1) external ID match (`opdb_id`/`vps_id`/`igdb_id`, with cross-type guard), (2) IPDB URL cross-reference for pinball, (3) reserved, (4) normalized-name match (full-table scan + JS-side `normalizeGameName` — no SQL `LIKE` because punctuation broke it). Step 4 is two-tier: **concrete** matches (both sides have non-null mfg + year, exact match) outrank **loose** (NULL-tolerant). Tie-break: external-ID count → mfg/year populatedness → oldest `created_at`.
- Composite UNIQUE INDEX `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))`. Same-name pinballs from different manufacturers coexist; true `(name, type, mfg, year)` dupes reject. See ADR 0004.
- **Library = global catalogue.** As of v2.6.0 the legacy `game_library` table is dropped (migration 092). Tournament activation, the per-room library page, autopick, Discord autocomplete, and leaderboard image fallback all read from `global_games WHERE status='approved'` directly. See ADR 0007.
- **`game_room_game_library` survives** (post-v2.6.0) for one purpose only: per-game style overlay (`catalogue_style_id`, `logo_style_id`, `bg_style_id`, `style_header_disabled`) keyed on `(game_room_id, game_name)`. The `custom_platforms` and `display_name` overlay columns are unread (column kept for now). Future cleanup will re-key the surviving overlay onto a `(game_room_id, global_game_id)` table and drop this one too.
- **Pending-approval flow:** room admins propose new globals via `POST /:roomId/game_library/submit_to_global` (`status='pending'`); super-admins approve/reject/merge at `/admin/catalogue/approvals`. Public `GET /global/games` hard-codes `status='approved'`.
- **`GlobalGameService.findCandidates(input)`** is the read-only dedup walker (extracted from `upsert`'s hierarchy) powering the per-room contribution proposal endpoints.

## Pin-to-scoreboard

`games.tournament_id IS NULL` is the canonical pinned-row signal. `games.game_room_id` is denormalized (equals `tournament.game_room_id` for tournament rows; set explicitly for pins). Unique partial index `idx_games_pinned_unique ON games(game_room_id, LOWER(name)) WHERE tournament_id IS NULL` prevents double-pin per room. **Cascade on unpin is application-level, NOT `ON DELETE CASCADE`:** `UPDATE submissions SET game_id = NULL` (and same for `score_history` + `global_scores.origin_game_id`) before DELETE — keeps history. See ADR 0005.

## Platform stratification

`platform` is required at the API boundary on `submissions`/`score_history`/`community_scores`/`global_scores` (column nullable in SQL for legacy rows). `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` in `platformRules.ts` returns the picker set (game's effective platforms ∩ active tournament rules). `SubmissionSheet` reads via `GET /api/submit/platforms`; one platform → read-only chip; 2+ → required dropdown. Discord `/submit-score` auto-fills when 1, prompts when 2+. Server re-validates at every submit handler (`ensurePlatformAllowed`). `/leaderboard/:gameId?platform=X` returns `distinctPlatforms[]` for the GameDetail tab strip. See ADR 0006.

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

## Database

SQLite at `data/arcaid.db` (git-ignored). Schema auto-creates on first run. Migrations live in `src/database/migrations/` and run idempotently on startup. Read the migration files directly for column-by-column intent — that's the source of truth, don't try to maintain a list here. `schema_migrations` table tracks applied versions.

## Deployment

Production is always Docker (`docker-compose up -d --build`). Admin UI assets build inside the image and are served by Express. Custom domain mapping is infra-level (DNS + reverse proxy). `ngrok http 3001` for ad-hoc public exposure during dev.

After deploy: `docker logs arcaid --tail 50` and verify no restart loop. `JWT_SECRET` must be set or auth breaks on first login.

## Cross-references

- `SPRINT_STATUS.md` — current/last-session work
- `ROADMAP.md` — outstanding tasks, phantom anon-claim cleanup runbook
- `CHANGELOG.md` — version-by-version history (do not duplicate here)
- `docs/decisions/` — ADRs (0003 secrets, 0004 catalogue identity, 0005 pin-via-NULL, 0006 platform stratification, 0007 library=catalogue)
- `docs/step-2-cleanup-plan.md` — library/catalogue unification cleanup plan (COMPLETE in v2.6.0; deviation noted at the top of the file)
- `../CLAUDE.md` — multi-project orientation (parent monorepo)
