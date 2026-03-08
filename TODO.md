# ArcAid — Task Checklist

> Organized by sprint. See OVERHAUL_PLAN.md for full context and SPRINT_STATUS.md for live progress.

---

## Sprint 1 — Stabilize
**Branch:** `sprint-1/stabilize`

### Critical Bugs
- [ ] **BUG-01** — Create `admin-ui/src/lib/api.ts` API client using relative paths; replace all hardcoded `http://localhost:3001` fetch calls in every React page
- [ ] **BUG-02** — Implement full `TournamentEngine.runMaintenance()`: lock game on iScored, scrape winner, resolve to Discord user, send announcement, activate queued game, start pick timer; uncomment Scheduler maintenance invocation
- [ ] **BUG-03** — Implement `TimeoutManager` runner-up pivot (query 2nd highest score → assign as picker) and auto-select (random eligible game from `game_library`)
- [ ] **BUG-04** — Add API auth middleware: admin password → bcrypt hash in settings, JWT session tokens, `Authorization: Bearer` header required on all write endpoints; add `/api/auth/login` endpoint
- [ ] **BUG-05** — Replace `process.exit(0)` in `server.ts` with graceful reload (close Discord client + DB cleanly, or live-reload credentials without restart)

### Backend
- [ ] Add `zod` validation schemas for all API request bodies (tournaments, settings, game library import)
- [ ] Add DB indexes (`games.tournament_id`, `games.status`, `submissions.game_id`, `submissions.discord_user_id`)
- [ ] Add `created_at` / `updated_at` timestamps to `tournaments` and `games` tables
- [ ] Make hardcoded values configurable in settings: `GAME_ELIGIBILITY_DAYS` (120), `WINNER_PICK_WINDOW_MIN` (60), `RUNNERUP_PICK_WINDOW_MIN` (30), `BOT_TIMEZONE` (America/Chicago), `PORT` (3001)
- [ ] Fix inconsistent `tournament_types` format in `game_library` (normalize to JSON array)

### Discord
- [ ] Fix temp photo file leak in `submitscore.ts` — use `finally` block for cleanup
- [ ] Add score validation before iScored submission (positive integer check)

---

## Sprint 2 — Harden
**Branch:** `sprint-2/harden`

- [ ] Add retry logic with exponential backoff to `IScoredClient` operations
- [ ] Replace all `page.waitForTimeout()` in `IScoredClient` with deterministic waits (`waitForSelector`, `waitForLoadState`)
- [ ] Add persistent browser session — keep login alive between operations
- [ ] Add screenshot-on-failure in `IScoredClient` (saves to `data/playwright-errors/`)
- [ ] Add iScored DOM change detection (hash comparison, alert on change)
- [ ] Implement log rotation (`rotating-file-stream`, max 10MB, keep 5 files)
- [ ] Replace synchronous `fs.appendFileSync` in logger with async stream
- [ ] Add startup environment validation with clear error messages
- [ ] Add Docker health check (`HEALTHCHECK` in Dockerfile)
- [ ] Add non-root user to Docker image
- [ ] Add service layer (`src/services/`) — separate routing from business logic
- [ ] Add per-user command cooldowns in Discord (submit: 30s, pick: 10s, list: 5s)
- [ ] Add transaction safety for multi-step Discord command operations

---

## Sprint 3 — Redesign (Frontend)
**Branch:** `sprint-3/redesign`

### Foundation
- [ ] Migrate Admin UI to Tailwind CSS v4
- [ ] Build shared component library: `NeonCard`, `StatusBadge`, `TournamentBadge`, `ScoreDisplay`, `NeonButton`, `DataTable`, `LoadingState`, `ErrorBoundary`, `ConfirmModal`, toast system
- [ ] Add login page + JWT auth flow to Admin UI (`src/lib/api.ts` attaches token to all requests)
- [ ] Add `AuthLayout` wrapper — redirect to login if no valid session

### Pages
- [ ] **Dashboard** — redesign with live stats: active games, next rotation times, recent winners, quick action buttons; backed by new `GET /api/dashboard` endpoint
- [ ] **Tournaments** — add inline edit, active/inactive toggle, cron human-readable preview, visual schedule
- [ ] **Game Library** — add search/filter, inline edit, delete, last-played date column, CSV import preview
- [ ] **Logs** — replace polling with SSE streaming, add log level filter, search, color coding, auto-scroll toggle, download button
- [ ] **Settings** — categorize sections, mask sensitive fields, add "Test Connection" buttons, show last-modified timestamps
- [ ] **History** — new page: past tournament results, filterable by type/date, CSV export
- [ ] **Backups** — new page: list backups with timestamps/sizes, restore button with confirmation

### API
- [ ] `GET /api/dashboard` — combined active games, rotation schedule, recent winners, system health
- [ ] `GET /api/logs/stream` — SSE endpoint
- [ ] `GET /api/backups` — list available backups
- [ ] `POST /api/backups/:name/restore` — trigger restore with guard
- [ ] `GET /api/history` — paginated past game results

### Discord UX
- [ ] Consistent embed design across all announcements (color per tournament type)
- [ ] Improve `/pick-game` autocomplete — show eligibility in option label
- [ ] Improve `/list-scores` — add `@user` parameter, pagination
- [ ] Improve `/view-stats` — add win percentage, all-time high holder mention
- [ ] Expand `/setup` to configure channel IDs, role IDs, pick windows via Discord

---

## Sprint 4 — Phase 8 (New Features)
**Branch:** `sprint-4/phase8`

### Internal Leaderboard
- [ ] Add `scores` table (replaces/supplements `submissions`) with `verified` flag and `synced_at`
- [ ] Add `leaderboard_cache` table (JSON ranked results, `generated_at`)
- [ ] Leaderboard calculation service — recompute and cache on each new score
- [ ] Update `submitscore.ts` to write to `scores` table and invalidate cache
- [ ] Update `/list-scores` to read from `leaderboard_cache` (no iScored scraping)

### Real-time
- [ ] Add WebSocket server (Socket.io or `ws`) to Express
- [ ] Emit events: `score:new`, `game:rotated`, `picker:assigned`, `picker:reminder`, `bot:status`
- [ ] Connect Admin UI Dashboard to WebSocket for live updates

### Public Leaderboard
- [ ] Create public-facing route (`/scoreboard`) — no auth required
- [ ] Full-screen arcade high score display, auto-rotates between active tournaments
- [ ] WebSocket-driven live updates
- [ ] Designed for OBS browser source embedding

### Stats & Analytics
- [ ] `GET /api/stats/player/:discordUserId` — wins, games played, avg score, best game
- [ ] `GET /api/stats/game/:name` — times played, avg score, all-time high
- [ ] New **Leaderboard** page in Admin UI (internal)
- [ ] New **Stats** page in Admin UI (player + game analytics)

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
