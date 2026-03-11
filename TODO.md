# ArcAid — Task Checklist

> Organized by sprint. See OVERHAUL_PLAN.md for full context and SPRINT_STATUS.md for live progress.

---

## Sprint 1 — Stabilize (COMPLETE)
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

## Sprint 2 — Harden (COMPLETE)
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

## Sprint 3 — Redesign (COMPLETE)
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

---

## Sprint 4 — Phase 8 (COMPLETE)
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

## Sprint 5 — Discord UX + Player Portal (COMPLETE)
**Branch:** `sprint-5/discord-ux`, `sprint-5/player-portal`

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

## Sprint 6 — Schedule UX & UAT (COMPLETE)
**Branch:** `sprint-6/schedule-ux-uat`

- [x] ScheduleBuilder component — friendly day/time/timezone picker (replaces raw cron)
- [x] Setup wizard password flow — Step 1 creates JWT before settings save
- [x] SettingsService empty value fix — skip blanks to preserve .env defaults
- [x] Tournament tag freeform input — replaced dropdown with text input
- [x] Tournament edit modal — edit name, tag, channel, schedule on existing tournaments
- [x] Per-tournament timezone — Scheduler reads timezone from cadence config
- [x] Channel ID clear on create — all form fields reset after creation
- [x] UAT fresh install — full flow tested with 4 tournaments

---

## Completed (Pre-Overhaul)

### Phases 0–7 (TableFlipper Feature Parity)
- [x] Generic engine with terminology toggle
- [x] SQLite schema with multi-tournament support
- [x] Playwright-powered IScoredClient
- [x] TournamentEngine.runMaintenance() stub (replaced in Sprint 1)
- [x] TimeoutManager stub (completed in Sprint 1)
- [x] Full slash command suite (user + admin)
- [x] React/Vite Admin UI (overhauled in Sprint 3)
- [x] Docker deployment
- [x] Backup manager

---

## Sprint 7 — Platform & Mode System (IN PROGRESS)
**Branch:** `sprint-2/harden`

### Core
- [x] Per-tournament mode (`pinball` / `videogame`) — replaces server-wide `TERMINOLOGY_MODE`
- [x] Per-game mode field in game library (single mode per entry)
- [x] Platform master list stored in settings (JSON array, seeded defaults)
- [x] Platform rules per tournament: `required`, `excluded`, `restrictedText`
- [x] DB migrations for `mode`, `platform_rules`, `platforms` columns
- [x] Data migration from `tournament_types` → `platforms`

### Filtering & Terminology
- [x] `getTerminology(mode?)` — per-tournament terminology (pinball=Table/Grind, videogame=Game/Tournament)
- [x] Platform-aware pick-game autocomplete (mode + required + excluded filtering)
- [x] Platform-aware TimeoutManager auto-selection
- [x] Remove `TERMINOLOGY_MODE` from settings, setup command, server status

### Admin UI
- [x] Game Library: mode filter toggles, mode selector in add/edit, platform chips
- [x] Game Library: edit modal for all fields
- [x] Tournaments: mode selector, PlatformRulesEditor component
- [x] Settings: Platforms master list editor (add/rename/remove)
- [x] Setup Wizard: simplified to 3 steps (removed terminology step)

### Future
- [ ] CSV import: validate unknown platforms with confirmation modal
- [ ] Docker rebuild and testing

---

## Sprint 8 — Public Player Portal (COMPLETE)
**Goal:** Give the public pages a dedicated, discoverable URL path based on the game room name.

### Setup
- [x] Add "Game Room Name" to Setup Wizard (Step 2, before Discord) — stores display name (e.g. "RTX Pinball") and auto-generates URL slug (e.g. `RTX_Pinball`) as `GAME_ROOM_NAME` / `GAME_ROOM_SLUG` in settings
- [x] Allow editing game room name/slug in Admin UI Settings page

### Public Portal Routing
- [x] Move public pages under `/:slug/` prefix:
  - `/:slug` — public landing page (scoreboard + nav)
  - `/:slug/players` — player list
  - `/:slug/players/:id` — player profile
  - `/:slug/games/:name` — game stats
- [x] Add shared public nav bar (game room branding, links between public pages)
- [x] Root `/` still goes to admin login (unchanged)
- [x] Redirect old `/scoreboard`, `/players`, `/games` routes to new slug-based paths (or remove)

### Branding
- [x] Public landing page header shows game room display name
- [ ] Optional: `CUSTOM_DOMAIN` setting for generating shareable links in Discord announcements

### Game Library Enhancements
- [x] Platform filter toggles in Game Library (toggleable chips, clear button)
- [x] VPS auto-import — `POST /api/game_library/import-vps` fetches from VPS API, extracts platforms
- [x] 5-star rating system — `game_ratings` table, per-user + community averages, StarRating component in Game Library and GameDetail

### Branding & UX
- [x] ArcAid logo on login page, admin sidebar, public nav bar, and favicon
- [x] Mobile-responsive layout: hamburger sidebar, responsive grids/cards/tables, overflow-safe
- [x] ScoreDisplay null safety fix (null winner_score crash)
- [x] crypto.randomUUID fallback for non-HTTPS contexts (mobile LAN access)

### Notes
- Custom domain mapping (e.g. `www.arcaid.space`) is infrastructure-level (DNS + reverse proxy to port 3001) — no app changes needed
- The slug is used for URL routing only; display name used for page headers/branding

---

## Next Steps (Future)

### UX Polish
- [ ] Discord OAuth login for player portal (self-service identity linking)
- [ ] Trend charts / sparklines on player profile pages
- [x] Mobile-responsive tweaks for admin UI and public pages
- [ ] Notification preferences (opt-in/out for reminders, announcements)
- [ ] Light mode / dark mode toggle in Settings — bright 80s retro theme as alternative to current dark arcade theme
- [ ] Full design iteration pass (feature branch) — color palette refinement, component polish

### Ops / Infrastructure
- [ ] CI/CD pipeline (build + test on push)
- [ ] Automated backup schedule (configurable via admin UI)
- [ ] Monitoring / alerting (health check dashboard, error rate tracking)
- [ ] Push to remote repository
