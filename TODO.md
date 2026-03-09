# ArcAid — Task Checklist

> Organized by sprint. See OVERHAUL_PLAN.md for full context and SPRINT_STATUS.md for live progress.

---

## Sprint 1 — Stabilize
**Branch:** `sprint-1/stabilize`

### Critical Bugs
- [x] **BUG-01** — Create `admin-ui/src/lib/api.ts` API client using relative paths; replace all hardcoded `http://localhost:3001` fetch calls in every React page
- [x] **BUG-02** — Implement full `TournamentEngine.runMaintenance()`: lock game on iScored, scrape winner, resolve to Discord user, send announcement, activate queued game, start pick timer; uncomment Scheduler maintenance invocation
- [x] **BUG-03** — Implement `TimeoutManager` runner-up pivot (query 2nd highest score → assign as picker) and auto-select (random eligible game from `game_library`)
- [x] **BUG-04** — Add API auth middleware: admin password → bcrypt hash in settings, JWT session tokens, `Authorization: Bearer` header required on all write endpoints; add `/api/auth/login` endpoint
- [x] **BUG-05** — Replace `process.exit(0)` in `server.ts` with graceful reload (close Discord client + DB cleanly, or live-reload credentials without restart)

### Backend
- [x] Add `zod` validation schemas for all API request bodies (tournaments, settings, game library import)
- [x] Add DB indexes (`games.tournament_id`, `games.status`, `submissions.game_id`, `submissions.discord_user_id`)
- [x] Add `created_at` / `updated_at` timestamps to `tournaments` and `games` tables
- [x] Make hardcoded values configurable in settings: `GAME_ELIGIBILITY_DAYS` (120), `WINNER_PICK_WINDOW_MIN` (60), `RUNNERUP_PICK_WINDOW_MIN` (30), `BOT_TIMEZONE` (America/Chicago), `PORT` (3001)
- [x] Fix inconsistent `tournament_types` format in `game_library` (normalize to JSON array)

### Discord
- [x] Fix temp photo file leak in `submitscore.ts` — use `finally` block for cleanup
- [x] Add score validation before iScored submission (positive integer check)

---

## Sprint 2 — Harden
**Branch:** `sprint-2/harden`

- [x] Add retry logic with exponential backoff to `IScoredClient` operations
- [x] Replace all `page.waitForTimeout()` in `IScoredClient` with deterministic waits (`waitForSelector`, `waitForLoadState`)
- [x] Add persistent browser session — keep login alive between operations
- [x] Add screenshot-on-failure in `IScoredClient` (saves to `data/playwright-errors/`)
- [x] Add iScored DOM change detection (hash comparison, alert on change)
- [x] Implement log rotation (`rotating-file-stream`, max 10MB, keep 5 files)
- [x] Replace synchronous `fs.appendFileSync` in logger with async stream
- [x] Add startup environment validation with clear error messages
- [x] Add Docker health check (`HEALTHCHECK` in Dockerfile)
- [x] Add non-root user to Docker image
- [x] Add service layer (`src/services/`) — separate routing from business logic
- [x] Add per-user command cooldowns in Discord (submit: 30s, pick: 10s, list: 5s)
- [x] Add transaction safety for multi-step Discord command operations

---

## Sprint 3 — Redesign (Frontend)
**Branch:** `sprint-3/redesign`

### Foundation
- [x] Migrate Admin UI to Tailwind CSS v4
- [x] Build shared component library: `NeonCard`, `StatusBadge`, `TournamentBadge`, `ScoreDisplay`, `NeonButton`, `DataTable`, `LoadingState`, `ConfirmModal`, toast system
- [x] Add login page + JWT auth flow to Admin UI (`src/lib/api.ts` attaches token to all requests)
- [x] Add `AuthLayout` wrapper — redirect to login if no valid session

### Pages
- [x] **Dashboard** — redesign with live stats: active games, next rotation times, recent winners; backed by `GET /api/dashboard`
- [x] **Tournaments** — DataTable, create form, ConfirmModal delete, toast notifications
- [x] **Game Library** — search/filter, add form, CSV import, TournamentBadge tags
- [x] **Logs** — level filter chips, search, color coding, auto-scroll toggle, download button
- [x] **Settings** — categorized sections, sensitive field masking
- [x] **History** — paginated past tournament results, filterable by tournament/type
- [x] **Backups** — list backups with timestamps/sizes, restore button with confirmation

### API
- [x] `GET /api/dashboard` — combined active games, rotation schedule, recent winners, system health
- [x] `GET /api/logs/stream` — SSE endpoint
- [x] `GET /api/backups` — list available backups
- [x] `POST /api/backups/:name/restore` — trigger restore with guard
- [x] `GET /api/history` — paginated past game results

### Discord UX
- [x] Consistent embed design across all announcements (color per tournament type)
- [x] Improve `/pick-game` autocomplete — show eligibility in option label
- [x] Improve `/list-scores` — add `@user` parameter, pagination
- [x] Improve `/view-stats` — add win percentage, all-time high holder mention
- [x] Expand `/setup` to configure channel IDs, role IDs, pick windows via Discord

### Player Portal
- [x] `/my-stats` Discord command — personal stats card (wins, win%, avg, best, recent scores)
- [x] Public `/players` page — searchable player list, ranked by best score
- [x] Public `/players/:id` page — player profile with stat cards, recent scores, game links
- [x] Public `/games/:name` page — game stats, record holder, recent results

---

## Sprint 4 — Phase 8 (New Features)
**Branch:** `sprint-4/phase8`

### Internal Leaderboard
- [x] Add `scores` table (replaces/supplements `submissions`) with `verified` flag and `synced_at`
- [x] Add `leaderboard_cache` table (JSON ranked results, `generated_at`)
- [x] Leaderboard calculation service — recompute and cache on each new score
- [x] Update `submitscore.ts` to write to `scores` table and invalidate cache
- [x] Update `/list-scores` to read from `leaderboard_cache` (no iScored scraping)

### Real-time
- [x] Add WebSocket server (Socket.io) to Express
- [x] Emit events: `score:new`, `game:rotated`, `picker:assigned`, `bot:status`, `leaderboard:updated`
- [x] Connect Admin UI Leaderboard to WebSocket for live updates

### Public Leaderboard
- [x] Create public-facing route (`/scoreboard`) — no auth required
- [x] Full-screen arcade high score display, auto-rotates between active tournaments
- [x] WebSocket-driven live updates (score flash, auto-refresh)
- [x] Designed for OBS browser source embedding

### Stats & Analytics
- [x] `GET /api/stats/player/:discordUserId` — wins, games played, avg score, best game
- [x] `GET /api/stats/game/:name` — times played, avg score, all-time high
- [x] New **Leaderboard** page in Admin UI (internal)
- [x] New **Stats** page in Admin UI (player + game analytics)

---

## Completed (Pre-Overhaul)

### Phases 0–7 (TableFlipper Feature Parity) ✅
- [x] Generic engine with terminology toggle
- [x] SQLite schema with multi-tournament support
- [x] Playwright-powered IScoredClient
- [x] TournamentEngine.runMaintenance() stub (replaced in Sprint 1)
- [x] TimeoutManager stub (completed in Sprint 1)
- [x] Full slash command suite (user + admin)
- [x] React/Vite Admin UI (overhauled in Sprint 3)
- [x] Docker deployment
- [x] Backup manager
