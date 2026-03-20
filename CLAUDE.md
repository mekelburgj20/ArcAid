# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this ArcAid repository.

## Session Start Checklist

1. Read `SPRINT_STATUS.md` for current work and last session notes
2. Read `ROADMAP.md` for remaining tasks and future plans
3. Verify git branch matches current work (`git branch --show-current`)
4. Run `npm run build` to confirm the codebase compiles cleanly
5. If admin-ui changes are expected, also run `cd admin-ui && npm run build`

**"Resume" command:** When the user says "Resume", execute this full checklist, then present a status summary and proceed with the next tasks indicated by the status file.

## Project Summary

ArcAid is a multi-tenant tournament management platform for virtual pinball and retro gaming communities. Multiple game rooms on one server, each with independent tournaments, admins, settings, and iScored accounts. Discord bot + React Admin UI + Playwright-powered iScored automation.

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
- `src/index.ts` — Bootstrap (DB → settings → env → clear leaderboard cache → validate → API → Discord)
- `src/engine/TournamentEngine.ts` — Core singleton: tournament CRUD + `runMaintenance()` + `runCleanup()`
- `src/engine/IScoredClient.ts` — Playwright browser automation (retry with backoff, persistent sessions, screenshot-on-failure)
- `src/engine/Scheduler.ts` — Cron-based maintenance scheduling with hot-reload, supports `L` (last day of month)
- `src/engine/TimeoutManager.ts` — Winner/runner-up pick window tracking
- `src/api/server.ts` — Express app setup, mounts 4 routers, backward-compat legacy aliases
- `src/api/routes/auth.ts` — Login (super-admin password, room local admin, Discord OAuth), change password, /me
- `src/api/routes/rooms.ts` — All room-scoped endpoints (public + admin): leaderboard, tournaments, settings, stats, etc.
- `src/api/routes/admin.ts` — Super-admin endpoints: room CRUD, super-admin management, backups, logs, global settings, master library, VPS/Wizard imports
- `src/api/routes/global.ts` — Non-scoped: /status, /me/preferences, /rooms (public listing), invite accept
- `src/api/middleware.ts` — `requireAuth`, `requireRoomAccess(paramName)`, `requireSuperAdmin`
- `src/api/rateLimit.ts` — Rate limiters: `authLimiter` (5/min), `writeLimiter` (30/min), `generalLimiter` (100/min)
- `src/api/correlationId.ts` — Assigns UUID per request, sets `X-Correlation-ID` header
- `src/api/auditMiddleware.ts` — Auto-logs admin write operations to `audit_log` table
- `src/services/` — Business logic layer:
  - **Global:** `SettingsService`, `AdminService`, `GameRoomService`, `GameRoomSettingsService`, `PreferencesService`, `LogService`, `BackupService`, `DashboardService`, `AuditService`
  - **Room-scoped:** `TournamentService`, `GameLibraryService`, `LeaderboardService`, `StatsService`, `RankingService`, `RatingService`
  - **Import:** `VpsImportService` (VPS database JSON), `WizardImportService` (VPXS Wizard Tables from GitHub)
- `src/utils/` — `discord.ts` (sendChannelMessage, sendDirectMessage, resolveDiscordUserId), `terminology.ts`, `cooldown.ts`, `startup.ts`, `logger.ts`, `config.ts`

**Admin UI (`admin-ui/src/`):**
- All API calls through `admin-ui/src/lib/api.ts` (relative `/api/` paths — NEVER hardcode localhost)
- **Layouts:** `SuperAdminLayout` (`/admin/*`), `RoomAdminLayout` (`/:slug/admin/*`), `PublicLayout` (`/:slug/*`)
- **Room context:** `admin-ui/src/contexts/RoomContext.tsx` provides `roomId`, `roomSlug`, `roomName` to room pages
- **Super-admin pages:** SuperAdminDashboard, GameRoomManager, GlobalSettings (+ shared: Logs, Backups, MasterGameLibrary)
- **Room admin pages:** Dashboard, Tournaments, GameLibrary, Leaderboard, Rankings, Stats, History, Settings (includes Users section)
- **Public pages (no auth):** LandingPage, Scoreboard, Players, PlayerDetail, GameDetail, GameAvailability, InviteAccept
- Shared components: `NeonCard`, `NeonButton`, `DataTable`, `StarRating`, `PublicLayout`, `ScheduleBuilder` (supports `L` for last day of month), `ThemeProvider`, etc.
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
- **Discord OAuth** — Available on both super-admin and room login pages. Checks `super_admins` → `game_room_admins` → 403
- **Admin invites** — One-time invite links (48h expiry) for onboarding room admins without sharing passwords. Optional Discord DM delivery.
- Middleware: `requireAuth` (JWT), `requireRoomAccess('roomId')` (checks scope), `requireSuperAdmin` (role check)

### API Structure
- `POST /api/auth/login` — super-admin password login
- `POST /api/auth/login/:roomSlug` — room local admin login
- `GET /api/rooms/:roomId/*` — room-scoped endpoints (public + admin)
- `GET /api/admin/*` — super-admin endpoints (requireSuperAdmin)
- `GET /api/*` — global endpoints (status, preferences, public room listing)
- **Legacy aliases:** `/api/leaderboard`, `/api/tournaments`, etc. redirect to default room for backward compat with Discord commands

### Migration
- `migrateToMultiRoom()` in `database.ts` — idempotent, runs on startup
- Creates default room from existing `GAME_ROOM_SLUG` / `GAME_ROOM_NAME` settings
- Copies per-room settings, backfills `game_room_id` on tournaments/ranking_groups
- Skips if a room already exists

## Key Patterns

- Engine classes are **singletons** (`getInstance()`) except IScoredClient (instantiated per-use)
- `getTerminology(mode?)` — per-tournament terminology based on mode (pinball/videogame)
- Tournaments have a `mode`, `platformRules`, `cleanup_rule`, and `game_room_id`
- DB `settings` table = global runtime config; `game_room_settings` = per-room config
- Room-scoped services accept an optional `gameRoomId` parameter for filtering
- API write endpoints require JWT Bearer token
- Discord OAuth flow: frontend builds OAuth URL with `window.location.origin`, callback uses raw `fetch`
- Public slug matching is case-insensitive
- **Themes:** 3 themes (arcade/dark/light). CSS variables, per-user override in `user_preferences`. `ThemeProvider` reads localStorage first (no flash).

## Score System

- **Single source of truth:** The `submissions` table
- **Submission IDs:** Sync-compatible format `${gameId}-${username.toLowerCase()}`
- **Leaderboards** group by `LOWER(iscored_username)` and prefer real Discord user IDs
- **Sync cleanup:** `/sync-state` removes local synced records not found on iScored
- **Player identity:** `iscored_username` is the primary key (not `discord_user_id`)
- **Merge/rename:** `POST /api/rooms/:roomId/admin/merge-player` updates across all tables

## Ranking System

Cross-tournament overall player rankings scoped to a game room.

**Rank methods:** `max_10`, `average_rank`, `best_game_papa`, `best_game_linear`

**Cache:** `ranking_groups_cache` invalidated on score submit and player merge.

## Database

SQLite at `data/arcaid.db` (git-ignored). Schema auto-created on first run. Idempotent migrations on startup.

**Multi-room tables:** `game_rooms`, `game_room_settings`, `local_admins`, `game_room_admins`, `super_admins`, `game_room_game_library`

**Core tables:** `tournaments` (with `game_room_id`), `game_library`, `games`, `submissions`, `leaderboard_cache`, `user_mappings`, `settings`, `game_ratings`, `ranking_groups` (with `game_room_id`), `ranking_group_tournaments`, `ranking_groups_cache`, `user_preferences`

**Admin tables:** `admin_invites` (one-time invite tokens with expiry), `audit_log` (admin action tracking), `schema_migrations` (versioned migration tracking)

## Deployment

- **Production:** Always Docker (`docker-compose up -d --build`)
- Admin UI production assets built during Docker image build and served by Express
- Custom domain mapping is infrastructure-level (DNS + reverse proxy), not app-level
- **ngrok** can be used for quick public exposure during development: `ngrok http 3001`
