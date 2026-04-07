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
- `src/api/routes/global.ts` — Non-scoped: /status, /me/preferences, /rooms (public listing), invite accept
- `src/api/middleware.ts` — `requireAuth`, `requireRoomAccess(paramName)`, `requireSuperAdmin`, `requireDiscordUser`
- `src/api/rateLimit.ts` — Rate limiters: `authLimiter` (5/min), `writeLimiter` (30/min), `pickLimiter` (5/min), `generalLimiter` (100/min)
- `src/api/correlationId.ts` — Assigns UUID per request, sets `X-Correlation-ID` header
- `src/api/auditMiddleware.ts` — Auto-logs admin write operations to `audit_log` table
- `src/services/` — Business logic layer:
  - **Global:** `SettingsService`, `AdminService`, `GameRoomService`, `GameRoomSettingsService`, `PreferencesService`, `LogService`, `BackupService`, `DashboardService`, `AuditService`
  - **Room-scoped:** `TournamentService`, `GameLibraryService`, `LeaderboardService`, `StatsService`, `RankingService`, `RatingService`, `CommentService`, `CommunityScoreService`, `ScoreHistoryService`, `StyleCatalogueService`, `RoomEventService` (activity event logging)
  - **Import:** `VpsImportService` (VPS database JSON), `WizardImportService` (VPXS Wizard Tables from GitHub)
- `src/utils/` — `discord.ts` (sendChannelMessage, sendDirectMessage, resolveDiscordUserId), `terminology.ts`, `cooldown.ts`, `startup.ts`, `logger.ts`, `config.ts`, `platformRules.ts` (shared platform eligibility check for API + Discord), `cronUtils.ts` (getNextRunTime via cron-parser for countdown timers)

**Admin UI (`admin-ui/src/`):**
- All API calls through `admin-ui/src/lib/api.ts` (relative `/api/` paths — NEVER hardcode localhost)
- **Layouts:** `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`)
- **Room context:** `admin-ui/src/contexts/RoomContext.tsx` provides `roomId`, `roomSlug`, `roomName` to room pages
- **Super-admin pages:** SuperAdminDashboard, GameRoomManager, GlobalSettings, StyleCatalogue (+ shared: Logs, Backups, MasterGameLibrary)
- **Room admin pages:** Dashboard, Tournaments, GameLibrary, Leaderboard, Rankings, Stats, History, GameStates (game state management escape hatch), StyleCatalogue (upload to global catalogue), Settings (includes Users section), ActivityLog
- **Public pages (no auth):** LandingPage, Scoreboard, Players, PlayerDetail, GameDetail, GameAvailability, InviteAccept, PublicStats, KioskScoreboard, ScoreSubmit (standalone QR code score submission)
- **Viewer auth context:** `ViewerAuthContext.tsx` provides `discordUser`, `playerToken`, `loginWithDiscord`, `logoutPlayer`, `usePlayerHeaders` — wraps public routes via `ViewerAuthProvider` in App.tsx
- **Scoreboard config:** `admin-ui/src/lib/scoreboardConfig.ts` exports `deriveCardProps(settings)` (legacy) and `deriveScoreboardConfig(settings)` (new style/theme system) — shared config derivation used by Scoreboard, KioskScoreboard, and ScoreboardPreview
- **Scoreboard card system:** Style+Theme 2-level selection (`SCOREBOARD_STYLE` + `SCOREBOARD_THEME`). Three styles: Banner (280px, iScored-compatible), Showcase (380px, art-forward with podium), Minimal (typography-only). Two Showcase themes: Glass Deck, Neon Circuit. `CardRouter.tsx` dispatches to `BannerCard`/`ShowcaseCard`/`MinimalCard`. Theme registry in `scoreboardThemes.ts`. Dual-path: new cards render when `SCOREBOARD_STYLE` is set, legacy `GameCard` otherwise.
- **Inline rankings:** `RankingGroupCard` renders inline with game cards when `rankingsSticky` is off (default). Style-matched: 3 rendering paths for Banner/Showcase/Minimal. `qrTopPad` aligns ranking card tops with game card borders when QR codes are above cards.
- **Scoreboard theme registry:** `admin-ui/src/lib/scoreboardThemes.ts` — `ShowcaseThemeConfig` interface (~40 properties), `SHOWCASE_THEMES` record, `STYLE_WIDTHS`, `STYLE_LABELS`. Adding a theme = adding a config object.
- **Scoreboard preview:** `admin-ui/src/components/ScoreboardPreview.tsx` — multi-card scaled preview in Settings using real catalogue images, scale-transform for sidebar fit
- **Layout presets:** `admin-ui/src/components/PresetSelector.tsx` — 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament) with auto-detection of custom settings
- **Image cropper:** `admin-ui/src/components/ImageCropper.tsx` — react-easy-crop wrapper for branding/style uploads with locked aspect ratios
- Shared components: `NeonCard`, `NeonButton`, `DataTable`, `StarRating`, `Sparkline`, `PublicLayout`, `ScheduleBuilder` (supports `L` for last day of month), `ThemeProvider`, `PickGameModal`, `GamePickerModal`, `StylePicker`, `PlayerAvatar`, `PresetSelector`, `ScoreboardPreview`, `ImageCropper`, etc.
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
- `GET /api/admin/*` — super-admin endpoints (requireSuperAdmin)
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

**Community tables:** `community_scores` (non-tournament score submissions), `score_history` (all score events with source tracking), `game_comments` (player tips and comments per game)

**Style tables:** `style_catalogue` (iScored style catalog entries)

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
