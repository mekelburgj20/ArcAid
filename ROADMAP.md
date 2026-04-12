# ArcAid — Roadmap

> See SPRINT_STATUS.md for live progress.

---

## Architecture Decisions

Load-bearing technical and product decisions are tracked in [`docs/decisions/`](docs/decisions/README.md). Each ADR captures the context, the choice, and the alternatives considered. Write a new ADR when a decision locks in a data shape, auth pattern, or external integration that future code will assume.

---

## Multi-Game-Room Architecture (COMPLETE)

### Phase 1: Database Foundation
- [x] New tables: `game_rooms`, `game_room_settings`, `local_admins`, `game_room_admins`, `super_admins`, `game_room_game_library`
- [x] Add `game_room_id` column to `tournaments` and `ranking_groups`
- [x] Idempotent migration: create default room, copy settings, backfill foreign keys
- [x] `GameRoomService` — CRUD for game rooms
- [x] `GameRoomSettingsService` — per-room settings CRUD
- [x] `GameRoom`, `LocalAdmin`, `GameRoomAdmin`, `SuperAdmin` TypeScript interfaces

### Phase 2: Auth Overhaul
- [x] Updated `TokenPayload` — `role: 'super_admin' | 'room_admin' | 'player'`, `gameRoomIds`, `discordId?`, `localAdminId?`
- [x] `requireRoomAccess(paramName)` middleware — checks super_admin OR room membership
- [x] `requireSuperAdmin` middleware
- [x] `AdminService` — super-admin, room Discord admin, and local admin management
- [x] Super-admin password login (`POST /api/auth/login`)
- [x] Room local admin login (`POST /api/auth/login/:roomSlug`)
- [x] Discord OAuth — checks `super_admins` → `game_room_admins` → issues `player` token for non-admin users

### Phase 3: API Route Restructuring
- [x] Split `server.ts` into `routes/auth.ts`, `routes/rooms.ts`, `routes/admin.ts`, `routes/global.ts`
- [x] Room-scoped service layer (gameRoomId parameter on all room-scoped services)
- [x] Backward-compat legacy aliases for Discord commands
- [x] Fix legacy alias URL rewriting (Express mount-path stripping issue)

### Phase 4: Frontend Restructuring
- [x] `SuperAdminLayout` — `/admin/*` sidebar with Dashboard, Rooms, Library, Backups, Logs, Settings
- [x] `RoomAdminLayout` — `/:slug/admin/*` sidebar with room-scoped navigation
- [x] `RoomContext` — provides `roomId`, `roomSlug`, `roomName` to room pages
- [x] `LandingPage` — public game room directory at `/`
- [x] `RoomLogin` — room admin login at `/:slug/login`
- [x] `SuperAdminDashboard`, `GameRoomManager`, `GlobalSettings` — super-admin pages
- [x] All existing admin pages updated to use `useRoom()` hook and room-scoped API calls

### Phase 5: Discord Bot Multi-Room (DEFERRED)
- [ ] Resolve `interaction.guildId` → game room in all commands
- [ ] Filter queries by room in all command handlers
- [ ] Deploy commands to all guilds with game rooms

---

## Completed Sprints (Historical)

<details>
<summary>Sprints 1–8 + Features (all complete)</summary>

### Sprint 1 — Stabilize
- [x] BUG-01: Relative API paths
- [x] BUG-02: Full `runMaintenance()`
- [x] BUG-03: TimeoutManager runner-up + auto-select
- [x] BUG-04: API auth middleware
- [x] BUG-05: Graceful reload
- [x] Zod validation, DB indexes, configurable settings

### Sprint 2 — Harden
- [x] IScoredClient retry logic, deterministic waits, persistent sessions, screenshot-on-failure
- [x] Log rotation, startup validation, Docker hardening, service layer, cooldowns

### Sprint 3 — Redesign
- [x] Tailwind CSS v4, shared component library, auth flow, all pages redesigned

### Sprint 4 — Phase 8
- [x] Internal leaderboard, WebSocket, public scoreboard, stats/analytics

### Sprint 5 — Discord UX + Player Portal
- [x] Embed announcements, autocomplete, `/my-stats`, public player/game pages

### Sprint 6 — Schedule UX & UAT
- [x] ScheduleBuilder, tournament editing, per-tournament timezone

### Sprint 7 — Platform & Mode
- [x] Per-tournament mode/platforms, terminology per tournament

### Sprint 8 — Public Player Portal
- [x] Slug-based routing, game room branding, VPS import, star ratings, mobile-responsive

### Feature: Ranking Groups
- [x] 4 ranking methods, admin management, public scoreboard integration

### Feature: UI Theme System
- [x] 3 themes, per-user preferences, ThemeProvider

</details>

---

## Sprint 10: Production Hardening

### Tier 1: Critical (COMPLETE)
- [x] API rate limiting (express-rate-limit: auth 5/min, general 100/min)
- [x] Missing DB indexes (games.iscored_id, tournaments.game_room_id, user_mappings.iscored_username, ranking_groups.game_room_id)
- [x] CORS restriction (CORS_ORIGIN env var, permissive only in dev)
- [x] JWT_SECRET required in production (throws on startup, warns in dev)

### Tier 2: Code Quality
- [x] N+1 query optimization (LeaderboardService batch cache, TimeoutManager batch settings, IdentityManager batch mappings, eligibility batch)
- [x] Race condition fix — per-tournament maintenance mutex
- [x] Standardize error responses — already consistent (`{ error: string }`)
- [x] WebSocket double-emit fix (emit to room only, CORS aligned with CORS_ORIGIN)
- [x] Extract TournamentForm component (shared form fields + useReducer hook)
- [x] Auto-reload scheduler on tournament update — already implemented

### Tier 4: Polish
- [x] Helmet middleware (security headers, CSP/COEP disabled for frontend compat)
- [x] Request correlation IDs (X-Correlation-ID header, attached to req)
- [x] Health check improvements (`/api/status` checks DB, Discord, iScored + uptime)
- [x] Audit logging (audit_log table, auto-logs admin writes, GET /api/admin/audit-log)
- [x] Database migration versioning (schema_migrations table, named migrations)

### Testing Foundation (COMPLETE)
- [x] Vitest setup (vitest.config.ts, setup.ts, helpers.ts)
- [x] LeaderboardService tests (9 tests)
- [x] TournamentService tests (5 tests)
- [x] RankingService tests (8 tests)
- [x] Auth + Status API tests (8 tests)
- [x] Rooms API tests (10 tests)
- [x] All 40 tests passing

---

## Post-Sprint Features (COMPLETE)

### Admin & Auth Enhancements
- [x] Discord OAuth on super-admin login page (`/login`)
- [x] Admin invite system (one-time links, 48h expiry, `admin_invites` table, migration 013)
- [x] Discord DM delivery of invite links (optional, via `sendDirectMessage`)
- [x] Discord admin management UI (add/remove Discord users as room admins in Settings)
- [x] Discord username resolution (accept usernames or IDs across all admin UIs)
- [x] Invite acceptance page (`/invite/:token` — public, sets username/password)

### Schedule Improvements
- [x] Last day of month support (`L` marker in cron, Scheduler runs on days 28-31 with runtime guard)
- [x] Monthly day dropdown extended to 1-31 plus "Last day" option

### Game Library
- [x] VPXS Wizard Tables import (`WizardImportService`, fetches from LegendsUnchained GitHub)
- [x] Room-scoped imports (VPS/Wizard pass roomId, backend calls `addToRoom`)
- [x] UI fixes: hide Activate button on super-admin library, always use admin prefix for imports

### UI Polish
- [x] Center single game room card on landing page (flexbox layout)
- [x] Remove redundant "Go to Scoreboard" button on landing page

---

## Community Platform Features (COMPLETE)

- [x] Public stats page with enhanced metrics (avg finish position, top 5% rate, champion streak, sparklines)
- [x] Per-game player stats lookup on game detail page
- [x] Community score submissions (scores outside tournaments, community leaderboards)
- [x] Game tips & comments (player-submitted tips and comments per game)
- [x] Discord post-score rating flow (star buttons + comment modal after /submit-score)
- [x] Score history tracking (score_history table, expandable per-player history on scoreboard)
- [x] Style catalogue (iScored style import/upload, per-game assignment)
- [x] Kiosk mode (/:slug/kiosk, auto-refresh)
- [x] Scoreboard branding (logo upload, background upload, title customization)
- [x] Session persistence (login auto-redirect with valid JWT)
- [x] Styled admin section headings (NeonCard cyan accent)

---

## Player Engagement Features (COMPLETE)

- [x] Discord player login on public pages (OAuth → player token for non-admin users)
- [x] Web-based game picking from Game Availability page (pick/queue with tournament selector)
- [x] Queue management (reorder, delete, max 5 per tournament per user)
- [x] Queue cooldown revalidation (ineligible games skipped at activation time)
- [x] "Your Picks" summary on Game Availability page (pending win picks + queued games)
- [x] Player avatar and logout in public nav bar
- [x] PickGameModal component (tournament selector, pending pick indicator)
- [x] Discord `/submit-score` now shows web UI tip with room URL
- [x] Auto-merge near-duplicate games during import (comma-variant names merged as aliases)
- [x] `platformRules.ts` shared utility (extracted from Discord command for API reuse)
- [x] Explicit `queue_order` column for FIFO game queue ordering
- [x] Queue limit enforcement in both web and Discord `/pick-game`
- [x] Mobile-responsive Game Availability layout (labeled card format)
- [x] Scoreboard background opacity slider

---

## Leaderboard UX Redesign (COMPLETE)

- [x] 8 new themes (backglass, crt-green, plasma, cabinet, silverball, wizard, playfield, marquee) — total 11 themes
- [x] Admin/Public theme split (admin theme per-admin, public theme room-wide via SCOREBOARD_THEME)
- [x] Discord avatar integration (avatar_hash on user_mappings, PlayerAvatar component)
- [x] Two-column score layout (SCOREBOARD_SCORE_COLUMNS setting)
- [x] QR code score submission (SCOREBOARD_QR_MODE: disabled/kiosk-only/all, standalone /:slug/submit/:gameId page)
- [x] Viewer rank highlight for logged-in players (cyan row)
- [x] Countdown timers on game cards (cron-parser based next-run calculation)
- [x] Kiosk enabled toggle with frontend enforcement
- [x] Game room admin activity log (RoomEventService + /:slug/admin/activity page)
- [x] Game library autocomplete with fuzzy match warnings
- [x] Inline platform add from Game Library page
- [x] Settings page reorganized with inline toggles
- [x] PWA support (manifest.json, service worker, installable on Android/iOS)
- [x] "Your Best" quick stat on game cards (footer shows logged-in user's best score + rank)
- [x] Compact card header option (SCOREBOARD_CARD_HEADER_STYLE: banner/compact)
- [x] Score toast notifications (WebSocket-powered slide-down toast on new scores)
- [x] Platform in-use validation on deletion (checks tournaments before removing)
- [x] Global game CSS override UI (GLOBAL_CARD_STYLES_ENABLED + color pickers for title/scores/border/background)
- [x] Locked game score rejection (backend 403 + frontend lock icon for non-ACTIVE games)

---

## iScored API Integration & Wheel Icons (COMPLETE)

- [x] iScored REST API client (IScoredApiClient.ts) — lightweight HTTP client for score reads/writes
- [x] Score sync poller (ScoreSyncPoller.ts) — continuous background polling, configurable interval (default 30s)
- [x] Dual-path architecture: API-preferred with Playwright fallback (ISCORED_API_ENABLED toggle)
- [x] Hot-reload settings: enable/disable poller and change interval without restart
- [x] sync-state command: API path (single HTTP call) or Playwright path (per-game scraping)
- [x] Fire-and-forget iScored sync on web score submission uses API when enabled
- [x] Winner resolution in TournamentEngine uses API with Playwright fallback
- [x] Global settings UI for ISCORED_API_ENABLED and ISCORED_API_POLL_INTERVAL
- [x] Wheel icon card header style (SCOREBOARD_CARD_HEADER_STYLE: 'wheel')
- [x] Configurable wheel icon scale (SCOREBOARD_WHEEL_SCALE: 100-200%, default 150%)

---

## Scoreboard UX Overhaul (COMPLETE)

- [x] CSS container query auto-sizing text — clamp() functions scale title and score text based on card width
- [x] Layout presets — 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament) with auto-detection of custom settings
- [x] Live preview in Settings — multi-card scaled preview with real game art, mirrors grid/scroll layout
- [x] Image cropper — react-easy-crop integration for branding and style uploads with locked aspect ratios
- [x] Shared config utility (deriveCardProps in scoreboardConfig.ts) — eliminates duplicated config parsing
- [x] Sidebar card header style (SCOREBOARD_CARD_LAYOUT: 'sidebar') — image left of game title
- [x] Card background fill toggle (SCOREBOARD_BG_FILL: off/fill) — background fills entire card with glass-panel overlay
- [x] Card background sizing (SCOREBOARD_BG_SIZE: cover/contain/tile) — controls CSS background-size
- [x] 2-column game layout (SCOREBOARD_GAME_COLUMNS: auto/2) — forces two game cards per row on desktop
- [x] Per-game logo/background images — independent logo_style_id and bg_style_id on games and game_room_game_library
- [x] Image type selector (both/background/logo) in StylePicker and GamePickerModal
- [x] Compact score entry stacked layout — rank/avatar/name above score for compact card style
- [x] Sticky save button — Settings page header pinned to viewport top with backdrop blur
- [x] >1T score abbreviation with tooltip for scores exceeding 999,999,999,999
- [x] Terminology unification — "Logo" → "Identifier", "Style" → "Art Pack"
- [x] PresetSelector component with smart constraint hiding (wheel scale hidden when not wheel layout, etc.)
- [x] Settings page 50/50 layout — wider preview panel for pixel-accurate multi-card display
- [x] Preset grid: 2×3 with always-visible Custom indicator (amber active, gray inactive)
- [x] "Hide Game Room Title" toggle (renamed from "Hide Scoreboard Title" for clarity)
- [x] Footer/QR separation — "Full Leaderboard →" inside glass panel, QR code outside
- [x] Glass panel opacity slider (SCOREBOARD_GLASS_OPACITY: 0-100%) — controls fill mode glass panels independently
- [x] Game title auto-hide — when identifier (header) image exists, game name text suppressed
- [x] Display name field (game_library.display_name) — optional scoreboard name override, falls back to game name
- [x] Game title style dropdown (SCOREBOARD_GAME_TITLE_STYLE: default/glow/shadow/outlined/backlit)
- [x] Game title visibility enhancement toggle (SCOREBOARD_GAME_TITLE_ENHANCE: dark backdrop behind title text)

---

## Scoreboard Card Redesign (COMPLETE)

- [x] Style+Theme 2-level card system: Banner (280px), Showcase (380px), Minimal (typography-only)
- [x] Showcase themes: Glass Deck (dark glass, pyramid podium) and Neon Circuit (circuit SVGs, chip podium, animated glow)
- [x] Theme registry pattern (scoreboardThemes.ts) — adding themes = adding a config object
- [x] CardRouter dispatcher + per-style card components (BannerCard, ShowcaseCard, MinimalCard)
- [x] Shared sub-components: ShowcasePodium (pyramid + chip variants), ScoreList (rank 4-N rows)
- [x] Neon Circuit inline SVG assets (circuit board bg, glow nodes, scanlines, chip podium)
- [x] StyleThemePicker settings UI (style → theme → Advanced toggle)
- [x] Dual-path backward compat: legacy GameCard preserved, new system opt-in via SCOREBOARD_STYLE key
- [x] Legacy migration heuristics in deriveScoreboardConfig()
- [x] Settings upgrade/downgrade UX (upgrade banner for legacy, switch-back link for new)

---

## Scoreboard UX Fixes (COMPLETE)

- [x] Inline rankings mode — RankingGroupCards render inline with game cards when `rankingsSticky` is off (default), across grid/vertical/scroll layouts
- [x] Rankings card style-matching — 3 rendering paths matching Banner, Showcase (theme-matched), and Minimal card styles
- [x] Rankings card layout redesign — rank + avatar + username row, points + "Games: X" below, "OVERALL RANKINGS" title on card, no column headings
- [x] QR code alignment — ranking cards add `qrTopPad` marginTop to align with game card borders (not QR code tops)
- [x] Game title styles expanded to 12 options (matching scoreboard title styles): default, glow, neon-magenta, chrome, fire, plasma, backglass, marquee, retro, pixel, shadow, outlined
- [x] Fire title animation — rapidly shifting gradient (1.5s background-position cycle)
- [x] Neon Magenta flicker animation — infrequent neon flicker effect (6s cycle)
- [x] Horizontal scrollbar fix — `items-start` conditional on left/right rankings positions only
- [x] Discord avatar fallback — username-based avatar lookup in RankingService for community score players with synthetic discord_user_id
- [x] Service worker cache versioning (v5)

## Global Scoreboard (COMPLETE)

All 7 phases implemented and deployed to production (2026-04-12).

- [x] Phase 1: Database & Catalogue Foundation — `global_games`/`global_scores` tables, `GlobalGameService` with cross-source dedup, VPS/OPDB/Wizard/IGDB importers, `GlobalCatalogue` admin page
- [x] Phase 2: Score Model — `GlobalScoreService` with fan-out from all 4 room submission paths, per-score global opt-out, user delete-own, `globalSubmitLimiter` (10/hr per user), room admin `GLOBAL_SCOREBOARD_ENABLED` toggle
- [x] Phase 3: User Preference System — `scoreboard_prefs` JSON blob on `user_preferences`, merge semantics, GET/POST endpoints, Scoreboard.tsx merges user prefs on top of room config
- [x] Phase 4: JWT Refresh Tokens — 30-day refresh tokens via `sessions` table, token rotation with role re-derivation, auto-refresh in ViewerAuthContext, admin 401 retry in api.ts
- [x] Phase 5: Global Scoreboard Page — `/scoreboard` with cross-room leaderboard, `GlobalLeaderboardService` with caching and popularity ranking
- [x] Phase 6: Game Room Enhancements — Freeplay page (`/:slug/freeplay`), catalogue browse + score submit for any game
- [x] Phase 7: Game Detail Page — `/games/:id` with per-game global scores, metadata, and score submission

---

## Future

### Multi-Room
- [ ] Discord Bot Multi-Room (Phase 5) — single bot, multi-guild, per-room command scoping

### UX Polish
- [ ] Notification preferences (opt-in/out for reminders, announcements)

### Ops / Infrastructure
- [x] CI/CD pipeline (GitHub Actions: build + push to GHCR + deploy to Hetzner on push to main)
- [ ] Automated backup schedule (configurable via admin UI)
- [ ] Monitoring / alerting (health check dashboard, error rate tracking)
- [ ] Super-admin dashboard server metrics (CPU, memory, I/O, container stats)
- [ ] High availability / multi-container — see notes below
- [ ] Friends-list score filtering (requires OAuth2 user token flow or manual friends list — Discord bots can't access `relationships.read`)

#### High Availability Notes
Current constraints: SQLite (single-writer), singleton engine classes (in-memory state), Playwright persistent sessions (local disk).

| Approach | Effort | Notes |
|----------|--------|-------|
| Active-passive failover | Low | 2 containers, 1 active. Docker restart policy + health checks. Shared volume for SQLite. |
| Read replicas (Litestream) | Medium | SQLite WAL mode + Litestream replication. One writer, N readers. Public scoreboard benefits most. |
| Separate concerns | Medium | Stateless API container (scales horizontally) + singleton engine/scheduler container. Requires DB change. |
| Migrate to PostgreSQL | High | True multi-container with connection pooling. Rewrite all raw SQL + migrations. Biggest payoff, largest effort. |

**Quick wins:** Docker `restart: always` + health check, Litestream for continuous S3 backups, reverse proxy (nginx/Caddy) for SSL/rate limiting, CDN for static assets. **Recommendation:** Start with active-passive + Litestream, migrate to PostgreSQL when scale demands it.

### Platform Integrations
- [ ] IFPA (International Flipper Pinball Association) — submit tournament results to official world rankings via API
- [ ] Matchplay.events — interoperability with the most-used competitive pinball tournament platform
- [ ] Scorbit — automated score capture from connected physical pinball machines (eliminates manual submission for IRL)
- [ ] Stern Insider Connected — pull scores from Stern connected machines
- [ ] Guilded / Revolt — alternative community platform support beyond Discord
