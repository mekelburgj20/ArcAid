# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this ArcAid repository.

## Session Start Checklist

1. Read `SPRINT_STATUS.md` for current sprint, task statuses, and last session notes
2. Read `TODO.md` for remaining tasks with checkboxes
3. Verify git branch matches the current sprint (`git branch --show-current`)
4. Run `npm run build` to confirm the codebase compiles cleanly
5. If admin-ui changes are expected, also run `cd admin-ui && npm run build`

**"Resume" command:** When the user says "Resume", execute this full checklist, then present a status summary and proceed with the next tasks indicated by the status file.

## Project Summary

ArcAid is a tournament management system for virtual pinball and retro gaming communities. Discord bot + React Admin UI + Playwright-powered iScored automation.

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
- `src/engine/TournamentEngine.ts` — Core singleton: tournament CRUD + `runMaintenance()` (lock → scrape winner → complete → activate next → assign picker → announce) + `runCleanup()` (delete completed games from iScored per cleanup rule)
- `src/engine/IScoredClient.ts` — Playwright browser automation for iScored.info (retry with backoff, persistent sessions, screenshot-on-failure, DOM change detection, game deletion)
- `src/engine/Scheduler.ts` — Cron-based maintenance scheduling (reads `BOT_TIMEZONE` from settings), hot-reload via `reload()`, schedules cleanup cron tasks
- `src/engine/TimeoutManager.ts` — Winner/runner-up pick window tracking
- `src/api/server.ts` — Express REST API routing (delegates to service layer), admin endpoints (merge player, scheduler reload)
- `src/services/` — Business logic: `SettingsService`, `TournamentService`, `GameLibraryService`, `LeaderboardService`, `StatsService`, `LogService`, `VpsImportService`, `RatingService`, `RankingService`, `PreferencesService`, `DashboardService`, `BackupService`
- `src/utils/discord.ts` — Shared `sendChannelMessage()` for engine classes
- `src/utils/terminology.ts` — `getTerminology(mode?)` — per-tournament terminology (pinball=Table/Grind, videogame=Game/Tournament)
- `src/utils/cooldown.ts` — Per-user Discord command cooldown tracker
- `src/utils/startup.ts` — Startup environment validation

**Admin UI (`admin-ui/src/`):**
- All API calls through `admin-ui/src/lib/api.ts` (relative `/api/` paths — NEVER hardcode localhost)
- Admin pages (require login): Dashboard, Tournaments, GameLibrary, Leaderboard, Rankings, Stats, History, Logs, Backups, Settings, SetupWizard
- Public pages (no auth, no sidebar): Scoreboard, Players, PlayerDetail, GameDetail — served under `/:slug/*` via `PublicLayout`
- Shared components: `NeonCard`, `NeonButton`, `DataTable`, `StarRating`, `PublicLayout`, `ScheduleBuilder`, `ThemeProvider`, etc.
- Mobile-responsive: admin sidebar collapses to hamburger menu, public pages scale to phone screens

## Key Patterns

- Engine classes are **singletons** (`getInstance()`) except IScoredClient (instantiated per-use)
- `getTerminology(mode?)` — per-tournament terminology based on mode (pinball/videogame); no-arg defaults to generic
- Tournaments have a `mode` (pinball/videogame), `platformRules` (required/excluded/restrictedText), and `cleanup_rule` (immediate/retain/scheduled)
- Games in library have a `mode`, `platforms` (JSON array), and optional `image_url`
- `PLATFORMS` setting = master platform list (JSON array, editable in Settings UI)
- DB `settings` table = runtime config (overrides `.env` on startup, synced to `process.env` immediately on save)
- iScored games identified by tags: `DG`, `WG-VPXS`, `WG-VR`, `MG`
- Configurable values from settings: `GAME_ELIGIBILITY_DAYS` (120), `WINNER_PICK_WINDOW_MIN` (60), `RUNNERUP_PICK_WINDOW_MIN` (30), `BOT_TIMEZONE` (America/Chicago)
- API write endpoints require JWT Bearer token
- Two auth methods: password (first login sets admin password) and Discord OAuth (mods with `DISCORD_ADMIN_ROLE_ID`)
- Discord OAuth flow: frontend builds OAuth URL with `window.location.origin`, callback uses raw `fetch` (not `api.post`) to avoid 401-redirect
- JWT payload includes optional `discordId`, `username`, `avatar` for Discord-authenticated users
- Public slug matching is case-insensitive
- **Themes:** 3 themes (arcade/dark/light). CSS variables override `@theme` tokens via `.theme-dark`/`.theme-light` classes on `<html>`. Global theme stored in `UI_THEME` setting, per-user override in `user_preferences` table. `ThemeProvider` reads localStorage first (no flash), hydrates from API.

## Score System

- **Single source of truth:** The `submissions` table. The `scores` table is legacy and no longer written to.
- **Submission IDs:** Sync-compatible format `${gameId}-${username.toLowerCase()}` — both Discord `/submit-score` and `/sync-state` converge on the same record.
- **Leaderboards** group by `LOWER(iscored_username)` and prefer real Discord user IDs over `SYSTEM`/placeholder IDs.
- **Sync cleanup:** `/sync-state` removes local synced records not found on iScored (handles deletions and username changes).
- **Player identity:** `iscored_username` is the primary identity key (not `discord_user_id`). Player pages route by username.
- **Auto-mapping:** First-time `/submit-score` users without a mapping are auto-mapped using their Discord display name.
- **Merge/rename:** `POST /api/admin/merge-player` updates username across submissions, scores, user_mappings, and renames sync-format submission IDs.

## Cleanup System

Per-tournament `cleanup_rule` (stored as JSON):
- `{ mode: 'immediate' }` — delete from iScored on completion
- `{ mode: 'retain', count: N }` — keep N most recent, delete older
- `{ mode: 'scheduled', cron: '...', timezone?: '...' }` — cron-based cleanup
- `/run-cleanup` also handles orphan ACTIVE games with no tournament

## Ranking System

Cross-tournament overall player rankings. Admin creates "ranking groups" that select specific tournaments and a ranking method.

**Tables:** `ranking_groups`, `ranking_group_tournaments` (junction), `ranking_groups_cache`

**Rank methods** (matching iScored):
- `max_10` — Top 10 per game get points (100/80/65/50/40/30/20/15/10/5), best N games summed
- `average_rank` — Average leaderboard position across games, lower is better, requires min_games
- `best_game_papa` — Points by rank (100/90/85/84/83...), best N games summed
- `best_game_linear` — Points by rank (100/99/98/97...), best N games summed

**Cache:** `ranking_groups_cache` stores computed JSON, invalidated on score submit and player merge.

## Development Process

**Branch convention:** `sprint-N/description` (e.g., `sprint-1/stabilize`)

**State files to update:**
- `SPRINT_STATUS.md` — every session start/end
- `TODO.md` — as tasks complete
- `README.md` — end of each sprint
- `OVERHAUL_PLAN.md` — end of each sprint (progress section)

**Full overhaul plan:** See `OVERHAUL_PLAN.md` (4 sprints: Stabilize → Harden → Redesign → Phase 8)

## Database

SQLite at `data/arcaid.db` (git-ignored). Schema auto-created on first run. Leaderboard cache cleared on every startup.

Key tables: `tournaments`, `game_library` (with `image_url`, `mode`, `platforms`), `games` (status: QUEUED/ACTIVE/COMPLETED/HIDDEN), `submissions` (source of truth for scores), `leaderboard_cache`, `user_mappings`, `settings`, `game_ratings`, `ranking_groups`, `ranking_group_tournaments`, `ranking_groups_cache`, `user_preferences`

Legacy table: `scores` (exists but no longer written to; kept for backward compatibility)

Indexed on: `games.tournament_id`, `games.status`, `submissions.game_id`, `submissions.discord_user_id`, `submissions.timestamp`

## Deployment

- **Production:** Always Docker (`docker-compose up -d --build`). No `npm run dev` needed.
- **After code changes:** Rebuild container to pick up changes.
- Admin UI production assets built during Docker image build and served by Express.
- Custom domain mapping is infrastructure-level (DNS + reverse proxy), not app-level.
- **ngrok** can be used for quick public exposure during development: `ngrok http 3001`
