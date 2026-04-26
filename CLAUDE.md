# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this ArcAid repository.

## Development Environment

This project runs in Docker containers. Never suggest `npm run dev` directly — always use `docker compose up` or equivalent Docker commands for local development and testing. The `npm run dev` and `npm run build` commands are for CI/build verification only, not for running the app.

## Permissions / Tool Usage

Do not ask for permission to run `cd`, `git`, or basic file navigation commands. Execute them directly.

## Tech Stack

Primary stack: TypeScript (frontend + backend), Docker for deployment. `better-sqlite3` is NOT available in this project — use the correct SQLite package already in `package.json` before trying alternatives.

## Workflow

Always run the build (`docker compose build`) and verify tests pass before committing. Never push to main without a successful build.

## Session Start Checklist

1. Read `SPRINT_STATUS.md` for current work and last session notes
2. Read `ROADMAP.md` for remaining tasks and future plans
3. Verify git branch matches current work (`git branch --show-current`)
4. Run `npm run build` to confirm the codebase compiles cleanly
5. If admin-ui changes are expected, also run `cd admin-ui && npm run build`

**"Resume" command:** When the user says "Resume", execute this full checklist, then present a status summary and proceed with the next tasks indicated by the status file.

## Project Summary

ArcAid is a multi-tenant tournament management platform for virtual pinball and retro gaming communities. Multiple game rooms on one server, each with independent tournaments, admins, settings, and iScored accounts. Discord bot + React Admin UI + iScored REST API integration (with Playwright fallback).

**Stack:** TypeScript (CommonJS, NodeNext), Node.js 20, Discord.js v14, Playwright, SQLite, Express v5, React 19 + Vite

## Key Commands

```bash
npm run build          # Compile TypeScript → dist/
npm run dev            # Run via tsx (no pre-build needed)
npm start              # Run compiled dist/index.js
npm run restore        # CLI restore tool

# Docker (production)
docker-compose up -d --build   # Admin UI on http://localhost:3001

# Admin UI (inside admin-ui/)
cd admin-ui && npm run dev     # Vite dev server
cd admin-ui && npm run build   # Build production assets
cd admin-ui && npm run lint    # ESLint
```

## Architecture at a Glance

Two sub-applications in one process:

**Backend (`src/`):**
- `src/index.ts` — Bootstrap (DB → settings → env → clear leaderboard cache → validate → API → Discord → ScoreSyncPoller)
- `src/engine/TournamentEngine.ts` — Core singleton: tournament CRUD + `runMaintenance()` + `runCleanup()`
- `src/engine/IScoredClient.ts` — Playwright browser automation (retry with backoff, persistent sessions, screenshot-on-failure)
- `src/engine/IScoredApiClient.ts` — Lightweight HTTP client for iScored REST API (score reads/writes, no Playwright needed)
- `src/engine/ScoreSyncPoller.ts` — Singleton; continuous iScored API polling with configurable interval, pause/resume for maintenance
- `src/engine/Scheduler.ts` — Cron-based maintenance scheduling with hot-reload, supports `L` (last day of month)
- `src/engine/TimeoutManager.ts` — Winner/runner-up pick window tracking
- `src/api/server.ts` — Express app setup, mounts 4 routers, backward-compat legacy aliases
- `src/api/routes/auth.ts` — Login (super-admin password, room local admin, Discord OAuth), change password, /me
- `src/api/routes/rooms.ts` — All room-scoped endpoints (public + admin): leaderboard, tournaments, settings, stats, etc.
- `src/api/routes/admin.ts` — Super-admin endpoints: room CRUD, super-admin management, backups, logs, global settings, master library, VPS/Wizard imports
- `src/api/routes/global.ts` — Non-scoped: /status, /me/preferences, /rooms, invite accept, global scoreboard/catalogue/scores, scoreboard preferences
- `src/api/middleware.ts` — `requireAuth`, `requireRoomAccess(paramName)`, `requireSuperAdmin`, `requireDiscordUser`
- `src/api/rateLimit.ts` — Rate limiters: `authLimiter` (5/min), `writeLimiter` (30/min), `pickLimiter` (5/min), `generalLimiter` (100/min), `globalSubmitLimiter` (10/hr per user)
- `src/api/correlationId.ts` — Assigns UUID per request, sets `X-Correlation-ID` header
- `src/api/auditMiddleware.ts` — Auto-logs admin write operations to `audit_log` table
- `src/services/` — Business logic layer:
  - **Global:** `SettingsService` (v2.3.0: consults `isEncryptedKey()` for encrypt-on-write / decrypt-on-read), `AdminService`, `GameRoomService` (new rooms get `REQUIRE_DISCORD_LOGIN=true` default as of v2.2.0), `GameRoomSettingsService` (v2.3.0: same encrypt-aware behavior — Discord/iScored creds live here), `PreferencesService` (device-keyed scoreboard prefs), `LogService`, `BackupService`, `DashboardService`, `AuditService`
  - **Room-scoped:** `TournamentService`, `GameLibraryService`, `LeaderboardService` (v2.1.0: reads `score_history` filtered by `submitted_during_tournament_id` instead of `submissions`), `StatsService` (v2.1.0: `getRoomOverview()` for the Stats-page Combo cards), `RankingService`, `RatingService`, `CommentService`, `CommunityScoreService` (v2.2.0: routes username through `RoomNameClaimService`), `ScoreHistoryService` (auto-resolves `submitted_during_tournament_id` from active game), `StyleCatalogueService`, `RoomEventService` (activity event logging)
  - **Identity + claim (v2.2.x):** `RoomNameClaimService` (first-claim-wins identity — `resolveAndClaim` + `checkAvailability` dry-run + `findClaimOwner`; auto-suffixes colliding names; multi-name per `anon_token`), `RoomMembershipService` (room_members upsert + listing + `display_name` per-room override), `AnonymousIdentityService` (get-or-create per-name anon identity, keyed on guild_id or room_id), `OrphanService` (orphan-on-flip logic for `REQUIRE_DISCORD_LOGIN` transitions), `IScoredSubmitSync` (v2.2.2: shared helper so `/submit-score`, `/freeplay-score`, and `/community-scores/:gameName` all sync to iScored identically)
  - **Import:** `VpsImportService` (VPS database JSON + global catalogue), `WizardImportService` (VPXS Wizard + Manual Install tables from GitHub), `OPDBImportService` (OPDB bulk pinball machine import), `IGDBImportService` (IGDB arcade/console games via Twitch OAuth)
  - **Global Catalogue:** `GlobalGameService` (catalogue CRUD, upsert with dedup, search, merge cascade), `SyncLogService` (sync log tracking + Discord alerts on failure)
  - **Global Scoreboard:** `GlobalScoreService` (score submissions, fan-out from room scores, soft/hard delete, bans; v2.2.0: guest submissions never fan out — early return on sentinel `playerId`), `GlobalLeaderboardService` (caching, recalculate, top games by popularity), `ScoreReportService` (score reporting and moderation)
  - **Lobby & Social:** `LobbyFeedService` (feed event CRUD, cursor pagination, 90-day cleanup, WebSocket emit), `LobbyFeedGenerator` (score event generation hooked into all 5 submission paths + notification dispatch), `AnnouncementService` (announcement CRUD with active/scheduled/expired), `CommunityShelfService` (shelf CRUD + reorder, URL type auto-detection), `MilestoneService` (threshold-based milestone detection), `FriendsService` (unidirectional friend follow/unfollow, reverse lookup for feed events), `NotificationService` (Discord DM dispatch with per-user prefs + rate limiting)
  - **Merge:** `MergeService` (anonymous→Discord identity reconciliation, admin-initiated via `/:slug/admin/identity` page; v2.2.15 moved Merge / Rename Player here from Settings)
- `src/utils/` — `discord.ts` (sendChannelMessage, sendDirectMessage, resolveDiscordUserId), `terminology.ts`, `cooldown.ts`, `startup.ts`, `logger.ts` (v2.4.16: `formatLogArg()` writes `Error.stack` to file instead of `{}`), `config.ts`, `platformRules.ts` (shared platform eligibility check for API + Discord), `cronUtils.ts` (getNextRunTime via cron-parser for countdown timers), `catalogueUtils.ts` (normalizeGameName for dedup matching), `platformMapping.ts` (canonical platform IDs, IGDB/VPS/OPDB normalization, PLATFORM_GROUPS, includes `vpxs_manual` for v2.4.13 Wizard split), `secrets.ts` (v2.3.0: AES-GCM encryption pipeline keyed off `SECRETS_KEY`; `ENCRYPTED_SETTING_KEYS` allowlist; `encryptSecret`/`decryptSecret`/`maskEncryptedValues`)
- `src/engine/gameCreation.ts` (v2.4.0) — `createGameWithIScoredSync()` shared helper for tournament activation, picker-slot processing, and pin creation. Returns `{ gameId, iscoredStatus, iscoredId? }`. Used by `TournamentEngine` (3 call sites refactored) and the Pin endpoint.

**Admin UI (`admin-ui/src/`):**
- All API calls through `admin-ui/src/lib/api.ts` (relative `/api/` paths — NEVER hardcode localhost)
- **Layouts:** `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`)
- **Room context:** `admin-ui/src/contexts/RoomContext.tsx` provides `roomId`, `roomSlug`, `roomName` to room pages
- **Super-admin pages:** SuperAdminDashboard, GameRoomManager, GlobalSettings, StyleCatalogue (+ shared: Logs, Backups, MasterGameLibrary)
- **Room admin pages:** Dashboard, Tournaments, GameLibrary, Leaderboard, Rankings, Stats, History, GameStates (game state management escape hatch), StyleCatalogue (upload to global catalogue), LobbyAdmin (lobby content management), Settings (includes Users section), ActivityLog
- **Public pages (no auth):** LandingPage, Scoreboard, Players, PlayerDetail, GameDetail, GameAvailability, InviteAccept, PublicStats, KioskScoreboard, ScoreSubmit, Freeplay (catalogue browse + score submit), Lobby (live activity feed + announcements + community shelf)
- **Global pages:** GlobalScoreboard (`/scoreboard`), GlobalCatalogue (`/catalogue`), GlobalGameDetail (`/games/:id`)
- **Social pages:** Friends (`/friends`, requires Discord login)
- **Viewer auth context:** `ViewerAuthContext.tsx` provides `discordUser`, `playerToken`, `loginWithDiscord`, `logoutPlayer`, `usePlayerHeaders` — wraps public routes via `ViewerAuthProvider` in App.tsx. Auto-refreshes player tokens via refresh token (60s check, 5min pre-expiry threshold).
- **Scoreboard config:** `admin-ui/src/lib/scoreboardConfig.ts` exports `deriveCardProps(settings)` (legacy) and `deriveScoreboardConfig(settings)` (new style/theme system) — shared config derivation used by Scoreboard, KioskScoreboard, and ScoreboardPreview
- **Scoreboard card system:** Style+Theme 2-level selection (`SCOREBOARD_STYLE` + `SCOREBOARD_THEME`). Three styles: Banner (280px, iScored-compatible), Showcase (380px, art-forward with podium), Minimal (typography-only). Two Showcase themes: Glass Deck, Neon Circuit. `CardRouter.tsx` dispatches to `BannerCard`/`ShowcaseCard`/`MinimalCard`. Theme registry in `scoreboardThemes.ts`. Dual-path: new cards render when `SCOREBOARD_STYLE` is set, legacy `GameCard` otherwise.
- **Inline rankings:** `RankingGroupCard` renders inline with game cards when `rankingsSticky` is off (default). Style-matched: 3 rendering paths for Banner/Showcase/Minimal. `qrTopPad` aligns ranking card tops with game card borders when QR codes are above cards.
- **Scoreboard theme registry:** `admin-ui/src/lib/scoreboardThemes.ts` — `ShowcaseThemeConfig` interface (~40 properties), `SHOWCASE_THEMES` record, `STYLE_WIDTHS`, `STYLE_LABELS`. Adding a theme = adding a config object.
- **Scoreboard preview:** `admin-ui/src/components/ScoreboardPreview.tsx` — multi-card scaled preview in Settings using real catalogue images, scale-transform for sidebar fit
- **Layout presets:** `admin-ui/src/components/PresetSelector.tsx` — 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament) with auto-detection of custom settings
- **Image cropper:** `admin-ui/src/components/ImageCropper.tsx` — react-easy-crop wrapper for branding/style uploads with locked aspect ratios
- Shared components: `NeonCard`, `NeonButton`, `DataTable`, `StarRating`, `Sparkline`, `PublicLayout`, `ScheduleBuilder` (supports `L` for last day of month), `ThemeProvider`, `PickGameModal`, `GamePickerModal`, `StylePicker`, `PlayerAvatar`, `PresetSelector`, `ScoreboardPreview`, `ScoreboardPreferencesModal`, `ImageCropper`, `MysteryAward` (canvas-based random game picker with DMD + translite), etc.
- Mobile-responsive: hamburger sidebar on small screens, responsive grids and cards

## Multi-Room Architecture

### Data Model
- `game_rooms` — each room has a unique slug, optional Discord guild ID, and its own settings
- `game_room_settings` — per-room key/value config (iScored creds, timezone, pick windows, platforms, theme)
- `local_admins` — per-room username/password admin accounts
- `game_room_admins` — Discord users scoped as admins of specific rooms
- `super_admins` — Discord users with server-wide super-admin rights
- `game_room_game_library` — junction table: rooms curate a subset from the global `game_library`
- `tournaments` and `ranking_groups` have a `game_room_id` foreign key

### Auth
- **Super-admin password** — Bootstrap/fallback admin, issues `{ role: 'super_admin', gameRoomIds: [] }`
- **Room local admin** — Username/password per room, issues `{ role: 'room_admin', gameRoomIds: [roomId] }`
- **Discord OAuth** — Available on super-admin, room login, and public pages. Checks `super_admins` → `game_room_admins` → issues `player` token. State param: `__super__` for super-admin, `player:<slug>` for public page login, or bare slug for room admin
- **Player auth** — Non-admin Discord users get `role: 'player'` tokens for public features (game picking, queue management). Stored separately from admin tokens in `arcaid_player_token` localStorage key.
- **Admin invites** — One-time invite links (48h expiry) for onboarding room admins without sharing passwords. Optional Discord DM delivery.
- **JWT refresh tokens** — Discord OAuth logins issue a refresh token (30-day expiry, stored in `sessions` table). `POST /api/auth/refresh` rotates both tokens and re-derives role from DB. Frontend auto-refreshes within 5min of expiry; api.ts retries on 401 before redirecting to login.
- Middleware: `requireAuth` (JWT), `requireRoomAccess('roomId')` (checks scope), `requireSuperAdmin` (role check), `requireDiscordUser` (any Discord-authenticated user)

### API Structure
- `POST /api/auth/login` — super-admin password login
- `POST /api/auth/login/:roomSlug` — room local admin login
- `GET /api/rooms/:roomId/*` — room-scoped endpoints (public + admin)
- `GET /api/rooms/:roomId/pick-status` — pending picks, queued games, and tournaments for logged-in Discord user (requireDiscordUser)
- `POST /api/rooms/:roomId/pick-game` — pick/queue a game from web UI (requireDiscordUser + pickLimiter, max 5 per tournament)
- `DELETE /api/rooms/:roomId/queue/:gameId` — remove a queued game (requireDiscordUser, ownership verified)
- `PUT /api/rooms/:roomId/queue/reorder` — reorder queued games (requireDiscordUser, ownership verified)
- `GET /api/rooms/:roomId/games/:gameId/info` — public game info for standalone score submission
- `GET /api/rooms/:roomId/game_library/search` — game library autocomplete with fuzzy matching (requireAuth)
- `GET /api/rooms/:roomId/admin/activity` — room admin activity log (requireAuth + requireRoomAccess)
- `GET /api/rooms/:roomId/admin/platform-usage/:platform` — check if platform is used by tournaments (requireAuth + requireRoomAccess)
- `GET /api/rooms/:roomId/admin/game-states` — list all games with full state info for game state management (requireAuth + requireRoomAccess)
- `PATCH /api/rooms/:roomId/admin/game-states/:gameId/status` — force game status change with optional iScored sync (requireAuth + requireRoomAccess)
- `PATCH /api/rooms/:roomId/admin/game-states/:gameId/clear-picker` — cancel picker timeout (requireAuth + requireRoomAccess)
- `DELETE /api/rooms/:roomId/admin/game-states/:gameId` — delete game entry with optional iScored deletion (requireAuth + requireRoomAccess)
- `POST /api/rooms/:roomId/admin/game-states/:gameId/sync-iscored` — granular iScored operations (requireAuth + requireRoomAccess)
- `POST /api/rooms/:roomId/admin/game-states/force-maintenance` — trigger maintenance for a tournament (requireAuth + requireRoomAccess)
- `POST /api/rooms/:roomId/admin/styles/upload` — room admins upload custom styles to global catalogue (requireAuth + requireRoomAccess)
- **v2.5.0 per-room contribution flow** (requireAuth + requireRoomAccess):
  - `POST /api/rooms/:roomId/game_library/proposals` — read-only dedup preview, returns `{ exact, possible }`
  - `POST /api/rooms/:roomId/game_library/use_global` — link an approved global_games row into the room
  - `POST /api/rooms/:roomId/game_library/room_only` — add to library with `global_game_id = NULL`
  - `POST /api/rooms/:roomId/game_library/submit_to_global` — create `status='pending'` global + link
  - `POST /api/rooms/:roomId/game_library/import-csv-preview` — bulk dedup preview, returns categorized rows
  - `POST /api/rooms/:roomId/game_library/import-csv-commit` — apply per-row decisions, best-effort
- **v2.5.0 super-admin Catalogue Approvals** (requireSuperAdmin):
  - `GET /api/admin/catalogue/pending` — list pending submissions (cursor-paginated, joined with submitter + room)
  - `GET /api/admin/catalogue/pending-count` — single integer for the nav badge
  - `POST /api/admin/catalogue/pending/:gameId/approve`
  - `POST /api/admin/catalogue/pending/:gameId/reject` — body `{ reason? }`
  - `POST /api/admin/catalogue/pending/:gameId/merge_into/:targetGameId` — delegates to `GlobalGameService.merge`
- `POST /api/admin/catalogue/sync-steam-pinball` — v2.5.0 Steam Pinball importer (no env-var pre-flight; Steam appdetails is anonymous)
- `GET /api/submit/platforms?roomId=X&gameName=Y` (or `?globalGameId=Z`) — v2.5.0 resolver returning the submittable platform set for the picker; alias-folds + dedupes via `normalizePlatform()` server-side
- `GET /api/admin/*` — super-admin endpoints (requireSuperAdmin)
- `POST /api/auth/refresh` — exchange refresh token for new access + refresh tokens
- `GET/POST /api/me/scoreboard-preferences?device=desktop|mobile` — user scoreboard display preferences, device-specific (requireDiscordUser)
- `DELETE /api/me/global-scores/:scoreId` — user delete-own global score (requireDiscordUser)
- `GET /api/global/scoreboard` — global leaderboard (public)
- `GET /api/global/catalogue` — searchable global game catalogue (public)
- `POST /api/global/scores` — submit score to global scoreboard (requireDiscordUser + globalSubmitLimiter)
- `GET /api/*` — global endpoints (status, preferences, public room listing)
- **Legacy aliases:** `/api/leaderboard`, `/api/tournaments`, etc. redirect to default room for backward compat with Discord commands

### Migration
- `migrateToMultiRoom()` in `database.ts` — idempotent, runs on startup
- Creates default room from existing `GAME_ROOM_SLUG` / `GAME_ROOM_NAME` settings
- Copies per-room settings, backfills `game_room_id` on tournaments/ranking_groups
- Skips if a room already exists

## Key Patterns

- Engine classes are **singletons** (`getInstance()`) except IScoredClient and IScoredApiClient (instantiated per-use). ScoreSyncPoller is a singleton.
- `getTerminology(mode?)` — per-tournament terminology based on mode (pinball/videogame)
- Tournaments have a `mode`, `platformRules`, `cleanup_rule`, and `game_room_id`
- DB `settings` table = global runtime config (includes `ISCORED_API_ENABLED`, `ISCORED_API_POLL_INTERVAL`); `game_room_settings` = per-room config (iScored creds, theme, etc.)
- Room-scoped services accept an optional `gameRoomId` parameter for filtering
- API write endpoints require JWT Bearer token
- Discord OAuth flow: frontend builds OAuth URL with `window.location.origin`, callback uses raw `fetch`
- Public slug matching is case-insensitive
- **Themes:** 11 themes (arcade/dark/light + backglass/crt-green/plasma/cabinet/silverball/wizard/playfield/marquee). Admin theme is per-admin preference (`user_preferences`); public/scoreboard theme is room-wide (`SCOREBOARD_THEME` setting). CSS variables, `ThemeProvider` reads localStorage first (no flash).
- Login pages auto-redirect to dashboard if valid JWT exists in localStorage (24h expiry)
- **Game queue:** Explicit `queue_order` column (FIFO), max 5 per user per tournament, cooldown revalidation at activation time. Ineligible queued games auto-removed during maintenance.
- **QR code submission:** `SCOREBOARD_QR_MODE` setting (disabled/kiosk-only/all) controls QR codes on score cards; standalone submit page at `/:slug/submit/:gameId` (`ScoreSubmit.tsx`)
- **Discord avatars:** `avatar_hash` column on `user_mappings`, displayed via `PlayerAvatar` component on scoreboards and player pages. Rankings cards use username-based fallback avatar lookup for players with synthetic `discord_user_id` (SYSTEM/COMMUNITY).
- **Countdown timers:** Game cards show time until next maintenance using `cronUtils.ts` (`cron-parser` package)
- **Activity log:** `room_events` table, `RoomEventService` logs admin actions (tournament changes, settings updates, etc.), viewable at `/:slug/admin/activity`
- **Scoreboard layout:** `SCOREBOARD_SCORE_COLUMNS` setting enables two-column score layout; viewer rank highlight (cyan row) for logged-in players
- **"Your Best" stat:** Game cards show logged-in user's best score and rank in a footer section when `viewerEntry` exists
- **Card layout:** `SCOREBOARD_CARD_LAYOUT` setting (`banner`/`compact`/`wheel`/`sidebar`); compact shows thumbnail + title with stacked score entries (name above score); wheel shows pinball wheel PNG above card border with configurable scale (`SCOREBOARD_WHEEL_SCALE`, 100-200%, default 150%); sidebar shows image left of game title in proportional square. All layouts use `iconImage` (logo preferred, falls back to background) for compact/wheel/sidebar thumbnails.
- **Card background fill:** `SCOREBOARD_BG_FILL` setting (`off`/`fill`); when `fill`, game background image fills the entire card behind the layout with glass-panel styling for readability. Works with any card layout.
- **Card background sizing:** `SCOREBOARD_BG_SIZE` setting (`cover`/`contain`/`tile`); controls CSS background-size for game images in card headers and fill mode. Backward compat: old `SCOREBOARD_CARD_HEADER_STYLE=fullart` maps to layout=banner + bgFill=fill.
- **Game columns:** `SCOREBOARD_GAME_COLUMNS` setting (`auto`/`2`); auto fills based on card size, `2` forces two game cards per row on desktop (single column on mobile)
- **Score entry style:** `SCOREBOARD_SCORE_STYLE` setting (`glass`/`shadow`/`outlined`/`glow`); glass uses frosted panels behind scores, other styles remove panels and apply text-shadow effects so background images show through
- **Glass panel opacity:** `SCOREBOARD_GLASS_OPACITY` setting (0-100, default 60); controls `bg-black/XX` on glass panels in fill mode
- **Game title style:** `SCOREBOARD_GAME_TITLE_STYLE` setting (12 options matching scoreboard title styles: `default`/`glow`/`neon-magenta`/`chrome`/`fire`/`plasma`/`backglass`/`marquee`/`retro`/`pixel`/`shadow`/`outlined`); fire and neon-magenta include CSS animations. Applied to game name on all card styles via `getTitleStyleClass()` + `gameTitleStyle` prop chain.
- **Game title enhance:** `SCOREBOARD_GAME_TITLE_ENHANCE` toggle; adds dark semi-transparent backdrop behind game title text for readability on busy backgrounds
- **Game title auto-hide:** When a card has an identifier (header) image (`styleHeaderUrl`), the game name `<h3>` text is hidden — the identifier serves as the name
- **Game display name:** `game_library.display_name` (nullable) — optional override shown on scoreboard cards; falls back to `game_library.name`. Propagated to `games.display_name` on activation.
- **Layout presets:** Settings page offers 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament) via `PresetSelector`. Individual settings hidden behind "Customize" toggle. `computeActivePreset()` auto-detects custom settings. Preset grid is 2×3 with always-visible Custom indicator.
- **Settings live preview:** `ScoreboardPreview` renders 3 mock game cards with real catalogue art, using CSS `transform: scale()` to fit the 50/50 layout. Mirrors actual grid/scroll rendering logic. Updates instantly on setting changes.
- **Card text sizing:** Fixed `rem` font sizes for card titles and scores. (Container queries were removed due to a Chromium rendering bug with CSS `zoom`.)
- **Image cropper:** `ImageCropper` component (react-easy-crop) used for branding uploads and style catalogue uploads. Canvas-based resize before upload.
- **Score abbreviation:** Scores ≥1T (1,000,000,000,000) display as "X.XT" with full value in tooltip.
- **Global card styles:** `GLOBAL_CARD_STYLES_ENABLED` toggle + `GLOBAL_CARD_CSS_TITLE`, `GLOBAL_CARD_CSS_SCORES`, `GLOBAL_CARD_CSS_BOX`, `GLOBAL_CARD_BG_COLOR` color overrides applied room-wide
- **Score toast:** WebSocket `score:new` event carries `{ gameId, gameName, playerName, score }` payload; Scoreboard shows slide-down toast notification
- **Platform validation:** `GET /:roomId/admin/platform-usage/:platform` checks tournament references before platform deletion
- **Locked game protection:** `POST submit-score` and `POST community-scores` reject non-ACTIVE games with 403; frontend shows lock icon
- **PWA:** `manifest.json` + `sw.js` in `admin-ui/public/`; service worker caches static assets (cache-first) and navigation (network-first)
- **Game State Management:** Admin escape hatch at `/:slug/admin/games` — force status changes, clear picker timeouts, delete phantom entries, granular iScored sync, force maintenance trigger. All actions require confirmation and are logged to activity.
- **iScored API integration:** `IScoredApiClient` (HTTP) preferred over `IScoredClient` (Playwright) for score operations. `ISCORED_API_ENABLED` toggle (default true) controls path selection. `ScoreSyncPoller` runs continuous background sync (default 30s). Settings hot-reload via `SettingsService`.
- **Style catalogue:** Global catalogue shared across all rooms. Super-admins can import from iScored, upload custom styles, and delete. Room admins can browse, upload custom styles, and apply styles to games via "Apply to Game" modal (`GamePickerModal`). Upload limit 30MB, supports PNG/APNG/JPEG/WebP (background and header both optional, at least one required). APNG files animate natively in `<img>` tags on scorecards.
- **Per-game images:** Games have independent `logo_style_id` and `bg_style_id` columns (on both `games` and `game_room_game_library`). Resolution: `effectiveBgId = bgStyleId || catalogueStyleId`, `effectiveLogoId = logoStyleId || catalogueStyleId`. Allows mixing backgrounds and logos from different styles. Image type selector (`both`/`background`/`logo`) available in StylePicker and GamePickerModal.
- **Upload limits:** All image uploads (styles, room assets, score photos) accept up to 30MB. Supported formats: PNG, APNG, JPEG, WebP.
- **Global Scoreboard:** Cross-room leaderboard at `/scoreboard`. Scores fan out from room submissions via `GlobalScoreService.fanOutFromRoomSubmission()` — wired into all 4 submission paths (CommunityScoreService, ScoreSyncPoller, Discord `/submit-score`, web submit). Room admins can opt out via `GLOBAL_SCOREBOARD_ENABLED` setting. Users can opt out per-score with `excludeFromGlobal` flag. `globalSubmitLimiter` (10/hr per Discord user) on direct global submissions. **v2.2.0 fan-out gate:** guest submissions (playerId normalizes to sentinel ANON/COMMUNITY/SYSTEM) **never** fan out to global — ensures every row on `/scoreboard` has a real Discord ID behind it. iScored-synced rows still fan out because they carry `iscored:*` synthetic IDs.
- **v2.1.0 tournament scoring from `score_history`:** Tournament card leaderboards read `score_history` filtered by `submitted_during_tournament_id` (best-during-window wins). `submissions` table still written for back-compat. `LeaderboardService.recalculate()` uses `ROW_NUMBER() OVER (PARTITION BY LOWER(iscored_username) ORDER BY score DESC, created_at ASC)` for best-per-player selection. Migration 063 backfills historical rows.
- **v2.2.x first-claim-wins identity:** First identity to use a name in a room owns it; later arrivals auto-suffix to `Bob_2`, `Bob_3`. Anon claims keyed on localStorage `arcaid_anon_id` UUID (sent as `x-user-id` header). Discord claims keyed on `discord_user_id`. Storage: `room_members.display_name` (Discord) + `anon_room_claims` (anon; v2.2.3 PK widened to allow multiple names per token per room). `RoomNameClaimService.resolveAndClaim` walks suffix loop; `checkAvailability` is the pre-submit dry-run used by `POST /:roomId/submit/name-check` and the `SubmissionSheet` collision prompt. No retroactive re-attribution of legacy rows (see ROADMAP: Phantom anon-claim cleanup runbook).
- **v2.2.5 `conditionalRequireDiscordUser`:** Middleware decodes an Authorization token when present **regardless** of the room's `REQUIRE_DISCORD_LOGIN` setting. Previously returned `next()` without touching the header when login wasn't required, so logged-in users' submissions in guest-allowed rooms silently fell through as `COMMUNITY`.
- **v2.2.x scoreboard click-routing (title-as-Link):** `GameCard` and `Scoreboard.tsx`/`GamesTabView.tsx` no longer render an inset-0 `<Link>` overlay. Each card variant (BannerCard / MinimalCard / ShowcaseCard) wraps its own **title** element in a `<Link>` via the `titleLinkTo` prop plumbed through `CardRouter`. Usernames in all card variants + ScoreList + ShowcasePodium are Links to `/:slug/players/:name`. Score rows with `onClick` expand handlers now capture clicks naturally (no pointer-events workaround). Tournament card clicks go to **Room Game Detail** (`/:slug/games/:name`), not Global — consistent with what's visible on the card.
- **v2.2.1 winner resolution from local DB:** `TournamentEngine.processSlotMaintenance` reads top scorer from `submissions` (local truth) first. Falls back to iScored only when local has nothing. Anon winners get a Discord announcement with claim guidance, no `@mention`, no picker slot created. Matches `Scoreboard` card display.
- **v2.2.2 iScored sync unification:** `IScoredSubmitSync.syncScoreToIScored()` helper called from all three web submission paths (`/submit-score/:gameName`, `/freeplay-score`, `/community-scores/:gameName`). Pre-v2.2.2 only the first path synced — freeplay submissions never reached iScored. `IScoredApiClient.submitScore()` now parses response text before `JSON.parse` to handle "Access Denied" plain-text rejections cleanly.
- **v2.2.4 post-login redirect:** `ViewerAuthContext.loginWithDiscord` default returnPath is `/:slug/lobby` (was `/:slug/picks`).
- **v2.2.10 Picks URL slug:** `/:slug/picks?t=<uuid>` → `/:slug/picks?t=daily_grind` (tournament name slugified). Back-compat: UUIDs still accepted.
- **v2.2.13 Mystery Award cabinet redesign:** `TournamentPoolTopper` (new component) renders above the backbox as a pinball cabinet topper with LED glow — click to reveal drop-down overlaying backbox. Fire (spin) + Queue (add to queue) buttons are always visible as circular `.pinball-round-btn`s; Queue grayed out until a result lands. Cabinet aesthetic throughout (chrome bezel + amber/orange gradient, no green). v2.2.14 flipped Fire/Queue positions (Queue left, Fire right).
- **v2.2.11 service-worker cache-bust discipline:** `admin-ui/public/sw.js` uses cache-first for static JS/CSS. Any UI-visible change that needs clients to pick up a new bundle **must bump `CACHE_NAME`** (e.g., `arcaid-v8` → `arcaid-v9`) so the SW's activate handler purges old caches. Skipping the bump leaves installed PWAs pinned to the old bundle.
- **Shared `DiscordLoginButton`:** `admin-ui/src/components/DiscordLoginButton.tsx` — Discord brand SVG + `#5865F2` blue styling. Used on `GlobalScoreboard`, `GlobalGameDetail`, and PublicLayout's inline fallback so all public-facing login buttons look identical.
- **Freeplay:** `/:slug/freeplay` page lets players browse the global catalogue and submit scores to any game, not just active tournament games. Posts to `POST /api/rooms/:roomId/freeplay-score`.
- **Scoreboard user preferences:** `user_preferences.scoreboard_prefs` stores per-user display overrides in device-keyed JSON: `{ desktop: {...}, mobile: {...} }`. Auto-migrates from old flat format. `GET/POST /api/me/scoreboard-preferences?device=desktop|mobile` accepts device type. Scoreboard.tsx detects device (`window.innerWidth <= 640`), fetches device-specific prefs, merges on top of room config. `ScoreboardPreferencesModal` (~20 settings with Desktop/Mobile toggle) triggered via `open-scoreboard-prefs` DOM event from PublicLayout gear icon. Preference hierarchy: user pref → room admin default.
- **Cross-component communication:** PublicLayout (nav bar) and Scoreboard (renders via `<Outlet />`) communicate via DOM custom events: `window.dispatchEvent(new Event('open-scoreboard-prefs'))` from nav gear button, `window.addEventListener` in Scoreboard.tsx. Used because React Router Outlet doesn't support direct prop passing.
- **Mystery Award:** `MysteryAward.tsx` — canvas-based random game picker (replaced PinballPicker). Features: 192×48 DMD dot grid with glow halos, translite renderer with GI backlight/starburst/vignette, room logo in backglass area (`backglassUrl` from `room.logo_url` via `/api/rooms`, independent of scoreboard config), "Add to Queue" for Discord-authenticated users (`onPickGame` prop). Phases: idle → cycling (Fisher-Yates shuffle, easeOutQuart deceleration) → landed (winner reveal with flash).
- **Scoreboard logo toggle:** `SCOREBOARD_LOGO_ENABLED` setting (default true) controls whether `LOGO_URL` appears on the scoreboard. When false, `deriveScoreboardConfig`/`deriveCardProps` return empty `logoUrl`. Mystery Award backglass is unaffected (reads `room.logo_url` directly).
- **Tournament rotation guards:** `TournamentEngine.processSlotMaintenance()` checks `max_active_games` before creating picker slots and checks for duplicate `[Pending Pick]` entries before creating new ones. `autoPickAndActivate()` also validates `max_active_games`. `TimeoutManager.fallbackToAutoSelection()` includes `max_active_games` guard and orphaned slot cleanup. `handleTieredTimeout()` verifies game still exists and is QUEUED before acting.
- **Lobby feed:** `lobby_feed_events` table (separate from `room_events` — different retention/schema/query patterns). 90-day retention (vs 7-day for room_events). Cursor-based pagination via `created_at`. WebSocket `lobby:${roomId}` channel for live updates. `LobbyFeedGenerator.onScoreSubmitted()` hooked into all 5 score submission paths (CommunityScoreService, Discord `/submit-score`, ScoreSyncPoller) via fire-and-forget dynamic imports.
- **Lobby config:** Stored as `game_room_settings` keys: `LOBBY_SOCIAL_LINKS` (JSON array of `{type, url, label}`), `LOBBY_PINNED_MESSAGE` (JSON `{content, enabled}`), `LOBBY_FEED_SETTINGS` (JSON `{enabledTypes, stalenessThresholdDays, roomStatsFrequency}`). No new tables needed for config.
- **Friends:** Unidirectional follow model (no pending/mutual confirmation). `FriendsService.getPlayersWhoFriended()` reverse lookup used by `LobbyFeedGenerator` to emit targeted `friend_score` events. Friends page at `/friends` (global, not room-scoped).
- **Discord push notifications:** `NotificationService.notify()` checks per-user opt-in prefs (`notification_prefs` JSON on `user_preferences`) + in-memory rate limit (5/user/hour via Map). 5 types: `tournamentWin` (after winner resolution), `turnToPick` (after picker slot creation), `tournamentStarting` (Scheduler checks every 15min, 45-60min before cron fires), `rankDethroned` (new #1 notifies previous #1), `friendScore` (alongside friend feed events). All default false (opt-in). `/arcaid-notifications` Discord command: show, toggle, enable/disable all.
- **Milestones:** `MilestoneService.checkAndEmit()` uses "exactly equals threshold" check against count queries — no separate tracking table. Thresholds: scores submitted (10/25/50/100/250/500/1000), unique games (5/10/25/50), #1 positions (1/5/10/25).
- **v2.3.0 at-rest encryption:** `src/utils/secrets.ts` provides AES-GCM encryption keyed off `SECRETS_KEY` (32-byte hex from env). `ENCRYPTED_SETTING_KEYS: ReadonlySet<string>` is the deliberate allowlist (no convention-based auto-encrypt) — currently `ISCORED_PASSWORD`, `OPDB_API_KEY`, `TWITCH_CLIENT_SECRET`. `SettingsService` and `GameRoomSettingsService` consult `isEncryptedKey(key)` to encrypt on write and decrypt on read. `maskEncryptedValues` returns a `[ENCRYPTED]` placeholder on `GET /admin/settings` so the UI never round-trips ciphertext. `npm run generate-secrets-key` mints a fresh key. **Adding a new secret means adding to the allowlist** — a typo can't silently land in plaintext.
- **v2.3.0 per-room iScored / Discord:** `DISCORD_GUILD_ID`, `DISCORD_ADMIN_ROLE_ID`, `DISCORD_ANNOUNCE_CHANNEL_ID`, `ISCORED_USERNAME`, `ISCORED_PASSWORD`, `ISCORED_GAMEROOM` live in `game_room_settings` (per-room). `DISCORD_ENABLED` and `ISCORED_ENABLED` per-room toggles gate slash commands, DM dispatch, and sync. The bot token / client ID / client secret remain global. Discord-disabled rooms are excluded from cross-room slash-command queries.
- **v2.4.0 catalogue unification:** Every `games`, `game_library`, and `game_room_game_library` row links to a canonical `global_games.id` via `global_game_id`. Identity is resolved through the FK first (with name-based COALESCE fallbacks kept as defense in depth). Per-room overlay fields on `game_room_game_library`: `custom_platforms` (JSON array, unioned with `global_games.platforms`) and `display_name` (override; falls back through `game_library.display_name` → `global_games.display_name` → `global_games.name`). `GameLibraryService.getEffectivePlatformsForGame(roomId, gameId)` is the canonical resolver; `platformRules.checkEligibility()` reads effective platforms.
- **v2.4.0 catalogue dedup hierarchy (`GlobalGameService.upsert`):** 4 steps. (1) External ID match (`opdb_id` / `vps_id` / `igdb_id` — authoritative, with cross-type guard); (2) IPDB URL cross-reference for pinball; (3) — reserved; (4) Normalized-name match via `findByNormalizedName` (full-table scan + JS-side `normalizeGameName` compare — no SQL `LIKE` prefilter because punctuation broke it). Step 4 is two-tier: **concrete** matches (both sides have non-null mfg + year, exact match) win over **loose** matches (NULL-tolerant). Multi-concrete and multi-loose use a richest-row tie-breaker (most external IDs first, then most-populated mfg/year, then oldest `created_at`). Step 4 concrete-path filters against the full `nameMatches` set, not `nonConflicting` — a pinball machine has a single canonical `(name, mfg, year)` identity, so a divergent external ID just means the source re-indexed itself (VPS does this occasionally). UPDATE uses COALESCE so the new authoritative external ID adopts cleanly.
- **v2.4.0 composite UNIQUE INDEX `idx_global_games_identity`:** On `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))` (migration 080). Lets same-name pinballs from different manufacturers (Stern Batman 2008 vs Data East Batman 1991) coexist while rejecting true `(name, type, mfg, year)` duplicates. Replaced the strict 2-column `idx_global_games_name_type` from v2.4.0 baseline (migration 068) which had to be dropped to allow real-world variants. NULL collision (two rows with NULL mfg + NULL year + same name+type) still rejects via `COALESCE(...,'')` / `COALESCE(...,0)`.
- **v2.4.0 Pin to Scoreboard:** `games.tournament_id IS NULL` is the canonical pinned-row signal. `games.game_room_id` (denormalized — equals `tournament.game_room_id` for tournament rows, set explicitly for pinned). Unique partial index `idx_games_pinned_unique ON games(game_room_id, LOWER(name)) WHERE tournament_id IS NULL` prevents double-pinning the same game in the same room. `games.display_order` gives admins explicit ordering for pinned cards. Cascade on unpin (handler-level, not `ON DELETE CASCADE`): `UPDATE submissions SET game_id = NULL`, same for `score_history` and `global_scores.origin_game_id`, then DELETE the game row — score history survives the unpin.
- **v2.4.0 `createGameWithIScoredSync()` helper:** New module `src/engine/gameCreation.ts`. Single signature for tournament activation, picker-slot processing, and pin creation. Returns `{ gameId, iscoredStatus: 'created' | 'failed' | 'skipped', iscoredId? }` so callers can surface partial success. `TournamentEngine` refactored to use the helper at three call sites — avoids drift.
- **v2.4.13 Wizard auto vs manual tagging:** `WizardImportService.platformsForTable(t)` returns `['vpxs']` for `t.section === 'wizard_auto'` (auto-install, verified) and `['vpxs_manual']` for `wizard_manual` (Manual Install Tables — hit-or-miss on AtGames Standalone). Canonical platform `vpxs_manual` ("VPX Standalone (Manual Install)") in `platformMapping.ts`. `reconcileWizardPlatformTags(touchedIds)` strips stale `vpxs`/`vpxs_manual` tags and re-applies the correct one when a table moves between sections on a re-import.
- **v2.4.16 logger Error rendering:** `formatLogArg(value)` in `src/utils/logger.ts` special-cases `Error` and writes `value.stack` (or `name: message` fallback) to the rotating file. Pre-fix every `logError(msg, err)` site stringified the Error via `JSON.stringify`, which sees only enumerable properties — and `Error.message` and `.stack` are non-enumerable, so the file got `{}`. Console output was unaffected (Node's `util.inspect` handles Error specially), so the bug only surfaced in the file (and the admin Logs viewer that reads it).
- **v2.4.16 background-sync route credential gating:** `POST /api/admin/catalogue/sync-opdb` and `/sync-igdb` validate `process.env.OPDB_API_KEY` / `TWITCH_CLIENT_ID + TWITCH_CLIENT_SECRET` upfront and return `400 { error: "..." }` with an actionable message. Pre-fix they returned `202 started`, threw inside the background task, and the only signal was the swallowed file log line.
- **v2.4.16 VPS dual-gate:** `VpsImportService.importFromVps()` keeps two filters with different intents. `playable = tables.filter(t => t.name && !t.broken && t.tableFiles?.length > 0)` feeds the legacy `game_library` (room picks shouldn't include unplayable tables). `cataloguable = tables.filter(t => t.name)` feeds the global catalogue and the background image-download pass — broken-flagged tables still have valid name/manufacturer/year/imgUrl and may have user-submitted scores, so they belong in `global_games`.
- **v2.5.0 platform taxonomy expansion:** 7 new canonical IDs in `CANONICAL_PLATFORMS` (`pinball_fx_classic`, `pinball_fx_classic_vr`, `pinball_fx_midnight`, `pinball_fx_vr`, `star_wars_pinball_vr`, `zaccaria`, `zaccaria_vr`). Removed legacy `pinball_fx3` + generic `vr` bucket. New `'VR'` `PLATFORM_GROUPS` quick-pick. `PLATFORM_ALIASES` + `VPS_FORMAT_MAP` fold pre-rebrand names forward (`fx3` / `Pinball FX3` / `pinball_fx3` → `pinball_fx_classic`).
- **v2.5.0 Steam pinball importer:** `SteamPinballImportService.importAll()` runs across six Steam apps (Pinball FX Classic 442120, Pinball FX 2328760, Pinball FX Classic VR 547590, Pinball FX Midnight 2337640, Zaccaria 444930, Star Wars Pinball VR 1530770). Curated `PACK_CONTENTS` map in `steamPinballPackContents.ts` (78 packs → 220 table entries) — pack DLCs expand into per-table upserts rather than landing as a single pack-named row. Skip-list catches Volume/Pack/Bundle/Tables/VR/Soundtrack/Editor/Mode entries. `cleanTableName` strips ™/®/©/℠ + wrapping quotes. `findSuffixVariantMatch` folds "X" / "X Pinball" duplicates pre-upsert (since `normalizeGameName` doesn't strip the suffix). 1100ms inter-fetch throttle; 30s back-off on HTTP 429. Admin route: `POST /api/admin/catalogue/sync-steam-pinball` (no env-var pre-flight — Steam appdetails is anonymous). To regenerate `PACK_CONTENTS`: edit `tmp/pack-contents-draft.md`, then run `node tmp/emit-pack-data-ts.js > src/services/steamPinballPackContents.ts`.
- **v2.5.0 score-platform stratification:** required `platform` field on `submissions`, `score_history`, `community_scores`, `global_scores` (column nullable in SQL for legacy rows; required at the API boundary via Zod on `ScoreSubmissionSchema` / `CommunityScoreSchema` / `FreeplayScoreSchema` / `/global/scores`). `resolveSubmittablePlatforms(gamePlatforms, tournamentRules?)` in `platformRules.ts` — game's effective platforms ∩ active tournament rules. Server-side `ensurePlatformAllowed` (rooms.ts) re-validates at every submit handler. `SubmissionSheet` picker fetches the resolved set via `GET /api/submit/platforms` (alias-folds + dedupes server-side); read-only chip when 1 platform, required dropdown when 2+. Discord `/submit-score` auto-fills when 1, rejects with valid-choices ephemeral reply when 2+. `ScoreSyncPoller` stamps `tournament.iscored_default_platform` (NULL when admin hasn't set it) on synced rows. Leaderboard endpoint (`/leaderboard/:gameId`) accepts `?platform=<id>` and returns `distinctPlatforms[]` for the GameDetail tab strip. `RankedEntry` + `GlobalRankedEntry` carry per-row platform; "All" view shows badges + demotes NULL-platform rows to a "Platform unknown" tail section.
- **v2.5.0 per-room contribution flow:** removed legacy "Import from VPS" / "Import VPXS Wizard" buttons from per-room game library page; server endpoints (`/admin/game_library/import-vps`, `/import-wizard`) kept for now but are unreachable from UI. New `GlobalGameService.findCandidates(input)` (read-only dedup walker, extracted from `upsert`'s 4-step hierarchy) powers `POST /:roomId/game_library/proposals` (preview), `/use_global` (link existing approved global), `/room_only` (no global submission), `/submit_to_global` (creates `status='pending'` global + links from room). Add Game UX renders an inline result panel (exact / possible / no-match). CSV import switched to two-step: `/import-csv-preview` categorizes rows into `auto_link` / `auto_submit` / `needs_review`; FE renders bucketed preview with per-row decision UI; `/import-csv-commit` applies decisions per-row best-effort with collected errors.
- **v2.5.0 super-admin Catalogue Approvals:** `GET /admin/catalogue/pending` (joined with submitter + room + cursor-paginated), `/pending-count` (nav badge polled every 60s), `POST /pending/:gameId/approve`, `/reject` (audited reason via existing `auditLog` middleware — no manual `AuditService.log` call needed), `/merge_into/:targetGameId` (delegates to `GlobalGameService.merge`). New `admin-ui/src/pages/CatalogueApproval.tsx`; nav badge in `SuperAdminLayout`.
- **v2.5.0 visibility hardening:** public `GET /global/games` hard-codes `status='approved'` (was honoring `?status=` query — leak risk). Aligned `'pending_review'` stub references to `'pending'` across `getCounts` + admin status PATCH validator.
- **v2.5.1 library = global catalogue (step 1):** per-room library page (`GET /:roomId/game_library`) now reads `global_games WHERE status='approved'` directly. The legacy `game_room_game_library` curation overlay (custom_platforms / display_name) is no longer consulted for the list view. Tournaments still pick from `game_library` for now — out of scope for step 1. Step 2 (drop the legacy tables, move aliases to `global_games`, simplify proposal endpoints) documented in `docs/step-2-cleanup-plan.md`.
- **v2.5.1 platform display-name shortening:** `CANONICAL_PLATFORMS.displayName` shortened for Zen + Zaccaria families (`"Pinball FX Classic"` → `"FX Classic"`, etc.). IDs unchanged. Display-only — no DB migration. Mirrored to `admin-ui/src/lib/platforms.ts` for FE rendering.
- **v2.5.1 FE platform helper (`admin-ui/src/lib/platforms.ts`):** mirrors backend `CANONICAL_PLATFORMS` + `PLATFORM_ALIASES`. Exports `normalizePlatform(raw)`, `getPlatformDisplay(raw)`, `normalizePlatformList(raw[])`. Used by `SubmissionSheet` picker, `GameDetail` tabs + per-row badges, `GlobalGameDetail` Platform column, and `GameLibrary` chips + filter pills. **When you add a platform to `src/utils/platformMapping.ts`, mirror it here.**
- **v2.5.2 platform-data normalization sweep (migration 089):** walks every JSON platform array (`global_games.platforms`, `game_library.platforms`, `game_room_game_library.custom_platforms`, `tournaments.platform_rules`) and folds each entry through `normalizePlatform()`. Dedupes case-insensitively. Migration 083 only rewrote the literal `pinball_fx3` token; case mismatches (`fp` AND `FP`) and aliases (`FX3` AND `pinball_fx_classic`) survived in JSON arrays. Production landed: 2733 `global_games` + 2813 `game_library` + 4 tournament rule rows normalized. Idempotent. `GameLibrary.tsx` chips + filter row also alias-fold + dedupe at render time as defense in depth.

## Community Features

- **Public write endpoints** (`community-scores`, `comments`, `ratings`) use rate limiting but no JWT auth — anonymous access by design
- **Anonymous user tracking:** `x-user-id` header (UUID from `localStorage`), used for comment ownership (author-only delete)
- **Community scores** are separate from tournament `submissions` — stored in `community_scores` table, also logged to `score_history`
- **Score counts endpoint** (`GET /:roomId/score-counts/:gameId`) returns `{ username: count }` for players with >1 submission — used for conditional expand icons on scoreboard
- **GameDetail tabs:** Leaderboard | Community | Tips & Comments | Your Stats — organizes the growing per-game content
- **Discord rating flow:** After `/submit-score`, bot sends star-rating buttons (max 5 per ActionRow) + Skip button, then a comment modal on rating click

## Score System

- **Single source of truth:** The `submissions` table
- **Submission IDs:** Sync-compatible format `${gameId}-${username.toLowerCase()}`
- **Leaderboards** group by `LOWER(iscored_username)` and prefer real Discord user IDs
- **Sync cleanup:** `/sync-state` removes local synced records not found on iScored
- **Player identity:** `iscored_username` is the primary key (not `discord_user_id`)
- **Merge/rename:** `POST /api/rooms/:roomId/admin/merge-player` updates across all tables
- `score_history` table logs every score event (tournament, community, sync) for full historical tracking separate from best-score-only `submissions`

## Ranking System

Cross-tournament overall player rankings scoped to a game room.

**Rank methods:** `max_10`, `average_rank`, `best_game_papa`, `best_game_linear`

**Cache:** `ranking_groups_cache` invalidated on score submit and player merge.

## Database

SQLite at `data/arcaid.db` (git-ignored). Schema auto-created on first run. Idempotent migrations on startup.

**Multi-room tables:** `game_rooms`, `game_room_settings`, `local_admins`, `game_room_admins`, `super_admins`, `game_room_game_library`

**Core tables:** `tournaments` (with `game_room_id`), `game_library`, `games`, `submissions`, `leaderboard_cache`, `user_mappings` (includes `avatar_hash`), `settings`, `game_ratings`, `ranking_groups` (with `game_room_id`), `ranking_group_tournaments`, `ranking_groups_cache`, `user_preferences`

**Admin tables:** `admin_invites` (one-time invite tokens with expiry), `audit_log` (admin action tracking), `schema_migrations` (versioned migration tracking), `room_events` (per-room activity log)

**Community tables:** `community_scores` (non-tournament score submissions), `score_history` (all score events with source tracking, includes `submitted_during_tournament_id` for v2.1.0 tournament-window scoring), `game_comments` (player tips and comments per game)

**Style tables:** `style_catalogue` (iScored style catalog entries)

**Global tables:** `global_games` (cross-room game catalogue with UUID PKs), `global_scores` (global scoreboard submissions with soft-delete; v2.2.0 fan-out gate keeps guest submissions out), `global_leaderboard_cache`, `sync_logs` (catalogue import tracking), `score_reports` (moderation), `user_bans`, `sessions` (JWT refresh tokens, 30-day expiry)

**Identity/claim tables (Sprints 1-11 + v2.2.x):** `anonymous_identities` (per-room anon claim by nickname, keyed on guild_id or room_id; added by migration 052), `merge_records` (audit trail for Discord↔anon identity merges via `MergeService`; added by Sprint 2), `room_members` (Discord user's per-room membership + optional `display_name` override added by migration 064 for first-claim-wins), `anon_room_claims` (per-anon-token per-room display claim; added by migration 064, PK widened in migration 066 to allow multiple claims per token)

**Key migrations to know:**
- **063** — `score_history` backfill of `submitted_during_tournament_id` + `leaderboard_cache` flush (v2.1.0 tournament scoring shift)
- **064** — `room_members.display_name` column + `anon_room_claims` table (v2.2.0 first-claim-wins)
- **065** — no-op marker for the `REQUIRE_DISCORD_LOGIN` default-flip event (v2.2.0)
- **066** — `anon_room_claims` PK rebuilt to `(anon_token, room_id, display_name)` (v2.2.3 multi-name per browser)
- **067** — encrypted-secret column upgrade marker (v2.3.0)
- **068** — Audit + auto-merge legacy duplicate `(name, type)` groups in `global_games`. Multi-pass (v2.4.2) so duplicates of duplicates resolve. Originally also created `idx_global_games_name_type` (UNIQUE on `(LOWER(name), type)`) — that index was later dropped by migration 080.
- **069** — Backfill `global_game_id` on `games`, `game_library`, `game_room_game_library`. Uses strict `LOWER(name)+type` exact-match (v2.4.3) — does NOT call `GlobalGameService.upsert` because the 4-step dedup matched too aggressively at backfill time.
- **070** — Orphan cleanup: delete the 5 legacy pinned games (Walking Dead, Spider-Man, Iron Maiden, 24, Game of Thrones) with `tournament_id=NULL`. Cascades submissions/score_history/global_scores `game_id` to NULL before DELETE.
- **071** — `game_room_game_library.custom_platforms` (JSON) + `display_name` (nullable text). v2.4.0 per-room overlay.
- **072** — Cache bust on `leaderboard_cache` + `global_leaderboard_cache` after the v2.4.0 query-migration shift.
- **073** — `games.game_room_id` column + backfill from `tournaments.game_room_id`. Pin-to-Scoreboard.
- **074** — Unique partial index `idx_games_pinned_unique ON games(game_room_id, LOWER(name)) WHERE tournament_id IS NULL`. Prevents double-pin per room.
- **075** — Marker only (cascade-on-unpin is application-level via the helper, not schema `ON DELETE CASCADE`).
- **076** — `games.display_order` column. NULL by default for tournament games (inherit from tournament); admins set explicitly for pinned.
- **077** — Drop NOT NULL on `submissions.game_id`. Must run before 070 (which sets `game_id = NULL` on orphan-cascade); ordering fixed in v2.4.4.
- **078–079** — Merge thin backfilled catalogue duplicates: rows with parens-baked `(Mfg, YYYY)` suffix in name + a corresponding rich row with stripped name + populated mfg/year. 078 strict comma regex; 079 catches no-comma `(Mfg YYYY)` cases.
- **080** — Drop `idx_global_games_name_type`, create composite `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))`. v2.4.8 — lets same-name pinballs from different manufacturers coexist.
- **081** — Scrub stale `SYNC_ALERT_CHANNEL_ID` value from seed (v2.4.9).
- **082** — Re-run thin-duplicate merger after step-4 dedup tightening (v2.4.10).
- **083** — v2.5.0 rename `pinball_fx3` → `pinball_fx_classic` across `global_games`, `game_library`, `game_room_game_library.custom_platforms`, `tournaments.platform_rules` JSON arrays. Handler in `migrations/platformTaxonomyExpansion.ts`. Production: 102 `global_games` + 99 `game_library` rows.
- **084** — v2.5.0 `ALTER TABLE … ADD COLUMN platform TEXT` on `submissions` / `score_history` / `community_scores` / `global_scores` + 4 composite indexes; `tournaments.iscored_default_platform` (NULL = synced rows leave platform NULL); `submission_drafts.platform` for OAuth-handoff replay.
- **085** — v2.5.0 backfill `platform` on legacy score rows where source game has exactly 1 platform (joins `games → game_library` by name). Multi-platform rows stay NULL ("Platform unknown"). Wrapped in `BEGIN`/`COMMIT`. Idempotent.
- **086** — v2.5.0 cache bust on `leaderboard_cache` + `global_leaderboard_cache` for the new platform-bearing `RankedEntry` shape.
- **087** — v2.5.0 `global_games.{submitted_by_user_id, submitted_by_room_id, submitted_at}` for the per-room → super-admin approval queue. Partial index `idx_global_games_pending ON (status, submitted_at) WHERE status = 'pending'`.
- **088** — v2.5.1 second cache bust on both leaderboard caches so existing `GlobalRankedEntry` blobs pick up the new `platform` field on next read.
- **089** — v2.5.2 sweep every JSON platform array (`global_games.platforms`, `game_library.platforms`, `game_room_game_library.custom_platforms`, `tournaments.platform_rules`) and fold each entry through `normalizePlatform()`. Dedupes case-insensitively so `vpx` AND `VPX` AND `FX3` AND `pinball_fx_classic` all collapse to canonical IDs. Production: 5550 rows normalized. Idempotent.

**Lobby & Social tables:** `lobby_feed_events` (activity feed with 90-day retention, cursor pagination, entity linking), `lobby_announcements` (admin-curated with display_from/display_until scheduling), `community_shelf_items` (media links with type auto-detection and reorder), `friendships` (unidirectional follow model, no pending/mutual confirmation)

## Deployment

- **Production:** Always Docker (`docker-compose up -d --build`)
- Admin UI production assets built during Docker image build and served by Express
- Custom domain mapping is infrastructure-level (DNS + reverse proxy), not app-level
- **ngrok** can be used for quick public exposure during development: `ngrok http 3001`

### Deployment Checklist

After any deployment, verify:
1. All required env vars are set (especially `JWT_SECRET`)
2. Dockerfile CMD format is correct
3. Container starts without restart loops — check with `docker logs arcaid --tail 50`
4. Do not mark a deploy as complete until logs confirm healthy startup
