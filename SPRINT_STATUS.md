# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the roadmap and future plans, see ROADMAP.md.

---

## Current Work

**Sprint 10: Production Hardening** — COMPLETE
**Post-Sprint Features** — COMPLETE (deployed to production)
**Community Platform Features** — COMPLETE (deployed to production)
**Player Engagement Features** — COMPLETE (deployed to production)
**Leaderboard UX Redesign** — COMPLETE (deployed to production)

### Global Scoreboard — Phase 1: Database & Catalogue Foundation (2026-04-08)
- [x] `catalogueUtils.ts` — normalizeGameName() algorithm for dedup matching
- [x] `platformMapping.ts` — canonical platform IDs, IGDB/VPS mappings, platform groups
- [x] Database: WAL mode enabled
- [x] Database: `global_games` table with UUID PKs, all enrichment fields, indexes
- [x] Database: `global_scores` table with soft-delete, photo hash, origin tracking
- [x] Database: `global_leaderboard_cache`, `sync_logs`, `score_reports`, `user_bans`, `sessions` tables
- [x] Database: migrations 037-038 (global_game_id on game_room_game_library + games)
- [x] Database: SYNC_ALERT_CHANNEL_ID default setting
- [x] `GlobalGameService.ts` — catalogue CRUD, upsert with dedup, search, merge cascade
- [x] `GlobalGameService.upsert()` — cross-type Frankenstein fix (4-step dedup: external ID → cross-type guard → IPDB URL cross-ref → strict name match). **Verified live** (2026-04-11) with sampled IGDB import — 4688 catalogue rows, 0 Frankensteins, 0 pinball-with-video-subtype contamination.
- [x] `IGDBImportService.importFromIGDB({ limit })` + `scripts/reimport-catalogue.ts --igdb-limit N --no-truncate` — sampled additive dev imports (avoids the multi-hour full IGDB run while still exercising the dedup hierarchy)
- [x] `scripts/backfill-vps-images.ts` (1075 rows patched) + `scripts/backfill-wizard-images.ts` (342 rows patched) — one-shot image backfills against the source GitHub repos
- [x] Global score submit modal: display name field with prefill from `/api/global/me/display-name`, 409 conflict on case-insensitive username collision against other Discord users
- [x] `docs/decisions/` ADR scaffold (README + 0000-template) + ROADMAP pointer + `/update-docs` skill check for decision freshness
- [x] `SyncLogService.ts` — sync log CRUD, Discord alert on failure
- [x] `VpsImportService.ts` — updated: rich metadata extraction (themes, designers, download URLs, wheel art, tutorials, rules, features), writes to global_games
- [x] `WizardImportService.ts` — updated: parses BOTH Wizard + Manual Install sections (~1125 tables), extracts table metadata
- [x] `OPDBImportService.ts` — new: bulk import from OPDB API, local image download
- [x] `IGDBImportService.ts` — new: Twitch OAuth token management, bulk seed arcade/console games, on-demand search
- [x] Admin API routes: `/admin/catalogue/sync-*`, catalogue CRUD, sync dashboard endpoints
- [x] Build verification: backend + frontend compile clean
- [x] Catalogue admin UI page (`admin-ui/src/pages/GlobalCatalogue.tsx`, 495 lines) — overview stats, sync controls with 2s polling, search/filter/pagination (PAGE_SIZE=200), expandable rows with approve/reject/delete
- [x] VPS auto-sync cron job — `Scheduler.startVpsCatalogueSync()` runs `0 2 * * 3` in `America/Los_Angeles`, calls `VpsImportService.importFromVps()`, wired from `Scheduler.start()`

**Phase 1 status: functionally complete.** Catalogue foundation (schema + services + imports + admin UI + auto-sync) is in place and verified live.

### Global Scoreboard — Phase 2: Score Model (2026-04-11)
- [x] `global_scores` schema with origin tracking, soft-delete, ban check, exclude_from_global flag
- [x] `GlobalScoreService` — submit / fan-out / soft+hard delete / list / `isBanned()`
- [x] `GlobalScoreService.fanOutFromRoomSubmission()` — room → global with dedup, opt-in check, room+game resolution hierarchy
- [x] Fan-out wired into all 4 room submission paths: `CommunityScoreService.submitScore()`, `ScoreSyncPoller` (iScored sync), Discord `/submit-score`, web `POST /:roomId/freeplay-score`
- [x] `POST /api/global/scores` — direct global submission (Discord login + photo + ban check + display name conflict resolution + opt-out)
- [x] `GlobalScoreSubmitModal.tsx` frontend with display-name pre-fill and exclude-from-global checkbox
- [x] Discord `/submit-score` `exclude_global` boolean parameter
- [x] `GET /api/global/scoreboard` (paginated catalogue with aggregates) + per-game leaderboard endpoint
- [x] `GET /api/global/games` + `GET /api/global/games/:id` (catalogue browse)
- [x] WebSocket `emitScoreNewGlobal()` — live score toasts on the global scoreboard channel
- [x] `POST /api/global/scores/:scoreId/report` — flag scores for moderation (one open report per user per score)
- [x] Room admin Settings: `GLOBAL_SCOREBOARD_ENABLED` (default on) and `REQUIRE_DISCORD_LOGIN` (default off) toggles in the Integrations card
- [x] Room `ScoreSubmitModal` per-score "Don't post to global" checkbox + wired through `POST /:roomId/submit-score/:gameName` to `CommunityScoreService` `excludeFromGlobal` option
- [x] `DELETE /api/me/global-scores/:scoreId` — user can soft-delete their own global scores (ownership verified by `player_id === req.user.discordId`)
- [x] `globalSubmitLimiter` (10/hour per Discord user) on `POST /api/global/scores`, replacing the shared 30/min IP-based `writeLimiter`
- [x] Build verification: backend + frontend compile clean

**Phase 2 status: complete.**

### Global Scoreboard — Phase 5: Global Scoreboard Page (already implemented)
- [x] `GlobalScoreboard.tsx` (400 lines) — paginated game grid with search, sort (popular/most_scores/highest_score/most_recent/name_asc), platform group chips (Physical/Virtual Pinball/Arcade & Video), scope filter (global + per-room dropdown)
- [x] WebSocket `score:new:global` → live toast notifications with optimistic card stat update
- [x] Submit button → Discord login gate → `GlobalScoreSubmitModal` (photo + display name + opt-out)
- [x] "Load More" pagination (PAGE_SIZE=30, infinite load)
- [x] Catalogue image resolution (local path → `/api/catalogue-images/` mount)
- [x] Route wired in App.tsx: `/scoreboard` → `<ViewerAuthProvider><GlobalScoreboard /></ViewerAuthProvider>`

### Global Scoreboard — Phase 7: Game Detail Page (already implemented)
- [x] `GlobalGameDetail.tsx` (553 lines) — full game detail page at `/games/:globalGameId`
- [x] Hero: cover art + wheel overlay + title + manufacturer/year/subtype/players + description + platform badges + theme tags
- [x] Designers card, Table Authors card, References card (IPDB/VPS/OPDB/IGDB links)
- [x] Downloads section — per-format download links from VPS (vpuniverse, vpforums, etc.)
- [x] Tutorials section — embedded YouTube iframes from VPS/IGDB
- [x] Rules section — linked rules documents from VPS
- [x] Leaderboard table with avatar, score, room origin, date, photo proof link, report button
- [x] Scope filter (All rooms / per-room) on the leaderboard
- [x] Score report flow with prompt and 409 duplicate check
- [x] Submit button → Discord login gate → `GlobalScoreSubmitModal` → refresh rankings
- [x] Route wired in App.tsx: `/games/:globalGameId` → `<ViewerAuthProvider><GlobalGameDetail /></ViewerAuthProvider>`

### Global Scoreboard — Phase 6: Game Room Enhancements (complete)
- [x] Backend: `POST /:roomId/freeplay-score` endpoint (photo required, global catalogue lookup, fan-out to global_scores)
- [x] Backend: scope filter on global leaderboard (origin_game_room_id)
- [x] `REQUIRE_DISCORD_LOGIN` room setting + `conditionalRequireDiscordUser` middleware
- [x] `REQUIRE_SCORE_PHOTO` room setting
- [x] `Freeplay.tsx` — room-scoped freeplay page at `/:slug/freeplay` with catalogue search/filter, game grid, photo-required submit modal, opt-out checkbox. Nav link (Joystick icon) in PublicLayout.

### Global Scoreboard — Phase 3: User Preference System (2026-04-11) — COMPLETE
- [x] `PreferencesService` exists (admin theme only)
- [x] `user_preferences` table exists
- [x] Migration 040: `scoreboard_prefs` TEXT column on `user_preferences`
- [x] `PreferencesService.getScoreboardPrefs()` / `setScoreboardPrefs()` — JSON blob merge semantics (null/empty deletes key)
- [x] `GET/POST /api/me/scoreboard-preferences` endpoints (requireDiscordUser)
- [x] Scoreboard.tsx merges user prefs on top of room config when playerToken present
- [x] Preference hierarchy: user preference → room admin default (via config merge)

### Global Scoreboard — Phase 4: JWT Refresh Tokens (2026-04-11) — COMPLETE
- [x] `sessions` table exists in schema
- [x] `auth.ts`: `generateRefreshToken()`, `createSession()`, `refreshAccessToken()`, `cleanExpiredSessions()`
- [x] Refresh rotates both access + refresh tokens, re-derives role from DB (picks up permission changes)
- [x] Discord OAuth callback issues refresh token on all paths (super_admin, room_admin, player)
- [x] `POST /api/auth/refresh` endpoint
- [x] DiscordCallback.tsx stores refresh tokens (player: `arcaid_player_refresh_token`, admin: `arcaid_admin_refresh_token`)
- [x] ViewerAuthContext auto-refresh: checks every 60s, refreshes within 5min of expiry, restores expired sessions on mount
- [x] api.ts: admin 401 handler tries refresh before redirecting to login
- [x] Logout clears refresh tokens

### Scoreboard UX Fixes (2026-04-06)
- [x] Inline rankings mode — when `rankingsSticky` is off (default), RankingGroupCards render inline with game cards in all 3 layouts (grid/vertical/scroll)
- [x] Rankings card style-matching — RankingGroupCard redesigned with 3 rendering paths matching Banner (280px), Showcase (380px, theme-matched), and Minimal (380px) card styles
- [x] Rankings card layout: rank + avatar + username row, points + "Games: X" below, no column headings, "OVERALL RANKINGS" title on card
- [x] QR code alignment — rankings cards add `marginTop` equal to QR code height + 4px gap (`qrTopPad`) to align with game card borders
- [x] Game title styles expanded from 5 to 12 options (matching scoreboard title styles): default, glow, neon-magenta, chrome, fire, plasma, backglass, marquee, retro, pixel, shadow, outlined
- [x] Fire title style animation — rapidly shifting gradient (background-position animation at 1.5s)
- [x] Neon Magenta title style animation — infrequent neon flicker effect (6s cycle)
- [x] Horizontal scrollbar fix — `items-start` only applied for left/right rankings positions (flex-row), not top/bottom (flex-col)
- [x] Discord avatar fallback on rankings cards — username-based avatar lookup for players with synthetic discord_user_id (SYSTEM/COMMUNITY)
- [x] RankingService: treat "COMMUNITY" discord_user_id same as "SYSTEM" (synthetic ID handling)
- [x] Service worker cache bumped to v5

### Scoreboard Card Redesign (2026-04-05)
- [x] Style+Theme 2-level card system: Banner (280px, iScored-compatible), Showcase (380px, premium art-forward with podium), Minimal (typography-only)
- [x] Showcase themes: Glass Deck (DM Sans/Mono, dark glass, pyramid podium) and Neon Circuit (Orbitron/Share Tech Mono, circuit SVGs, chip podium, animated glow)
- [x] Theme registry (scoreboardThemes.ts) — adding themes = adding config objects, no layout code changes
- [x] CardRouter dispatcher + BannerCard + ShowcaseCard + MinimalCard + ShowcasePodium + ScoreList components
- [x] Neon Circuit inline SVG assets (circuit board background, glow nodes, scanline overlay, chip podium)
- [x] StyleThemePicker settings component (style selector → theme selector → Advanced toggle)
- [x] Dual-path backward compat: new system activates only when SCOREBOARD_STYLE is explicitly set; legacy GameCard preserved
- [x] Settings.tsx: upgrade banner for legacy rooms, switch-back link for new-style rooms
- [x] deriveScoreboardConfig() with legacy migration heuristics (fullart/banner+fill → showcase, wheel → showcase, else → banner)
- [x] ScoreboardPreview, Scoreboard, KioskScoreboard all updated with dual-path CardRouter/GameCard rendering

### Scoreboard Settings UX & Card Rendering Fixes (2026-04-02)
- [x] Multi-card preview in Settings — 3 real game cards with distinct background and identifier images from style catalogue
- [x] Scale-transform preview — cards render at full size and scale down to fit sidebar, preserving pixel-accurate layout
- [x] Grid vs Scroll preview — preview mirrors actual Scoreboard.tsx rendering logic for both layout modes
- [x] Compact score entry layout — stacked vertical format (rank/avatar/name above score) for compact card style
- [x] Sticky save button — Settings page header pinned to viewport top with backdrop blur
- [x] Tournament preset no longer overlaps in preview (scale transform renders at real width)
- [x] Settings page layout widened — 50/50 split instead of flex-1 + fixed 320px sidebar
- [x] Preset grid: 2×3 grid with Custom cell always visible (amber active, gray inactive)
- [x] Renamed "Hide Scoreboard Title" → "Hide Game Room Title" with clarified description
- [x] Footer split: "Full Leaderboard →" inside glass panel, QR code outside
- [x] Glass panel opacity slider (SCOREBOARD_GLASS_OPACITY: 0-100%, default 60%) — controls fill mode glass panels
- [x] Game title auto-hide — when identifier (header) image exists, game name text is hidden
- [x] Display name field on game_library — optional override for game name on scoreboard cards
- [x] Display name propagation from game_library → games table on activation
- [x] Game title style dropdown (SCOREBOARD_GAME_TITLE_STYLE: default/glow/shadow/outlined/backlit)
- [x] Game title visibility enhancement toggle (SCOREBOARD_GAME_TITLE_ENHANCE: dark backdrop behind title text)
- [x] Score entry style setting (SCOREBOARD_SCORE_STYLE: glass/shadow/outlined/glow) — replace glass panels with text effects to let background images show through

### Scoreboard UX Overhaul (2026-04-01)
- [x] CSS container query auto-sizing text — clamp() functions scale title and score text based on card width
- [x] Layout presets — 5 curated presets (Classic, Compact, Showcase, Arcade Wheel, Tournament) with "Custom" auto-detection
- [x] Live preview in Settings — renders cards with current unsaved settings, updates instantly on change
- [x] Image cropper — react-easy-crop integration for branding and style uploads with locked aspect ratios
- [x] Shared config utility (deriveCardProps) — eliminates duplicated config parsing across Scoreboard, KioskScoreboard, ScoreboardPreview
- [x] Sidebar card header style (SCOREBOARD_CARD_LAYOUT: 'sidebar') — image left of game title
- [x] Card background fill toggle (SCOREBOARD_BG_FILL: off/fill) — background image fills entire card with glass-panel styling
- [x] Card background sizing (SCOREBOARD_BG_SIZE: cover/contain/tile) — controls CSS background-size
- [x] 2-column game layout (SCOREBOARD_GAME_COLUMNS: auto/2) — forces two game cards per row on desktop
- [x] Per-game logo/background images — independent logo_style_id and bg_style_id, mix backgrounds and logos from different styles
- [x] Image type selector (both/background/logo) in StylePicker and GamePickerModal
- [x] >1T score abbreviation with tooltip for scores exceeding 999,999,999,999
- [x] Smart constraint hiding — wheel scale hidden when not wheel layout, etc.
- [x] Terminology unification — "Logo" → "Identifier", "Style" → "Art Pack"

### iScored API Integration & Wheel Icons (2026-03-31)
- [x] iScored REST API client (IScoredApiClient.ts) — lightweight HTTP replacement for Playwright scraping
- [x] Score sync poller (ScoreSyncPoller.ts) — continuous background polling with configurable interval (default 30s)
- [x] Dual-path score sync: API-preferred with Playwright fallback (controlled by ISCORED_API_ENABLED)
- [x] Hot-reload for API settings (enable/disable poller, change interval without restart)
- [x] sync-state Discord command updated: API path (single HTTP call) or Playwright path (per-game scraping)
- [x] Fire-and-forget iScored sync on web score submission uses API when enabled
- [x] Winner resolution in TournamentEngine uses API with Playwright fallback
- [x] Global settings UI: ISCORED_API_ENABLED and ISCORED_API_POLL_INTERVAL exposed in super-admin panel
- [x] Wheel icon card header style (SCOREBOARD_CARD_HEADER_STYLE: 'wheel') — pinball wheel PNGs as game identifiers
- [x] Configurable wheel icon scale (SCOREBOARD_WHEEL_SCALE: 100-200%, default 150%)
- [x] Wheel icons overflow card border (transparent background, drop shadow, proper card spacing)

### Leaderboard UX Redesign (2026-03-28)
- [x] 8 new themes: backglass, crt-green, plasma, cabinet, silverball, wizard, playfield, marquee
- [x] Admin/Public theme split (admin theme per-admin, public theme room-wide via SCOREBOARD_THEME)
- [x] Discord avatar integration (avatar_hash on user_mappings, PlayerAvatar component)
- [x] Two-column score layout option (SCOREBOARD_SCORE_COLUMNS setting)
- [x] QR codes on score cards with three-state toggle (SCOREBOARD_QR_MODE: disabled/kiosk-only/all)
- [x] Standalone score submission page at /:slug/submit/:gameId (ScoreSubmit.tsx)
- [x] Viewer rank highlight for logged-in players (cyan row)
- [x] Countdown timers on game cards showing time until next maintenance (cronUtils.ts)
- [x] Kiosk enabled toggle with frontend enforcement
- [x] Game room admin activity log at /:slug/admin/activity (RoomEventService + ActivityLog.tsx)
- [x] Game library autocomplete with fuzzy match warnings
- [x] Inline platform add from Game Library page
- [x] Settings page reorganized with inline toggles
- [x] New DB table: room_events (activity log)
- [x] New DB column: user_mappings.avatar_hash
- [x] New dependencies: cron-parser (backend), qrcode (frontend)

### UX Plan Completion & Bug Fixes (2026-03-29)
- [x] Bug fix: locked game score rejection (backend 403 on non-ACTIVE games for submit-score and community-scores)
- [x] Locked game UI on ScoreSubmit.tsx (lock icon) and ScoreSubmitModal (gameStatus prop, locked state)
- [x] PWA support: manifest.json, service worker (cache-first static, network-first navigation), PWA meta tags
- [x] "Your Best" quick stat on game cards (footer: "Your best: X (Rank #Y)" for logged-in users)
- [x] Compact card header option (SCOREBOARD_CARD_HEADER_STYLE: banner/compact — thumbnail + title bar mode)
- [x] Score toast notifications (WebSocket score:new data payload → slide-down toast on scoreboard)
- [x] Platform in-use validation on deletion (GET /admin/platform-usage/:platform, error toast with tournament names)
- [x] Global game CSS override UI (GLOBAL_CARD_STYLES_ENABLED toggle + color pickers for title/scores/border/background)
- [x] Kiosk backend enforcement confirmed working (frontend checks KIOSK_ENABLED from scoreboard-config)

### Bug Fixes & Game State Management (2026-03-30)
- [x] Bug fix: timeout/queue logic — picker slot was created even when a queued game was activated, causing erroneous pick timer + reminders
- [x] Bug fix: phantom games on iScored — erroneous picker timeout cascaded to auto-selection, creating games on iScored that weren't ACTIVE in ArcAid
- [x] Admin score deletion (Trash2 icon on leaderboard, backend DELETE endpoint with cache invalidation)
- [x] Photo upload on mobile now allows gallery choice (removed capture="environment" attribute)
- [x] Game States admin page (/:slug/admin/games) — full game state management escape hatch
  - View all games with status, tournament, iScored ID, picker info
  - Force status changes (QUEUED/ACTIVE/COMPLETED) with optional iScored sync
  - Clear picker timeouts, delete phantom entries, bulk clean [Pending Pick] slots
  - Granular iScored operations (lock/unlock/hide/unhide/delete/create)
  - Force maintenance trigger per tournament
  - Confirmation modals and activity logging for all actions

### Player Engagement Features (2026-03-27)
- [x] Discord player login on public pages (OAuth → player token)
- [x] Web-based game picking from Game Availability page
- [x] Queue management (reorder, delete, max 5 per tournament)
- [x] Queue cooldown revalidation at activation time
- [x] "Your Picks" summary card with numbered queue
- [x] Auto-merge near-duplicate games during import
- [x] Mobile-responsive Game Availability layout
- [x] Scoreboard background opacity slider

### Community Platform Features (2026-03-21 → 2026-03-23)
- [x] Public stats page with enhanced metrics (avg finish position, top 5% rate, champion streak, sparklines)
- [x] Per-game player stats lookup on game detail page
- [x] Community score submissions (scores outside tournaments, community leaderboards)
- [x] Game tips & comments (player-submitted tips and comments per game)
- [x] Discord post-score rating flow (star buttons + comment modal after /submit-score)
- [x] Score history tracking (score_history table, expandable per-player history on scoreboard)
- [x] Style catalogue system (iScored style import/upload, per-game assignment)
- [x] Kiosk mode (/:slug/kiosk, auto-refresh)
- [x] Scoreboard branding (logo upload, background upload, title customization)
- [x] Session persistence on login pages (auto-redirect with valid JWT)
- [x] Removed room-level Discord bot token/client ID/secret (global-only)
- [x] Styled admin section headings (NeonCard cyan accent)

### Sprint 10 Summary
- Tier 1 Critical: Rate limiting, DB indexes, CORS, JWT validation
- Tier 2 Code Quality: N+1 fixes, maintenance mutex, WebSocket fix, TournamentForm extraction
- Tier 4 Polish: Helmet, correlation IDs, health checks, audit logging, migration versioning
- Testing Foundation: 40 tests (Vitest, in-memory SQLite)

### Post-Sprint Features (2026-03-16 → 2026-03-19)
- [x] Discord OAuth on super-admin login page
- [x] Admin invite system (one-time invite links, 48h expiry, optional Discord DM delivery)
- [x] Discord admin management (add Discord users as room admins, log in via OAuth)
- [x] Discord username resolution everywhere (accept usernames instead of numeric IDs)
- [x] UI fixes: hide Activate on super-admin library, center single room on landing, remove redundant button
- [x] Last day of month schedule support (custom `L` marker, Scheduler runtime guard for days 28-31)
- [x] VPXS Wizard Tables import (fetches from LegendsUnchained GitHub, imports with VPXS platform)
- [x] Room-scoped game imports (VPS/Wizard imports now associate games with current room)

### Previous
**Multi-Game-Room Architecture** — COMPLETE (merged to main, deployed 2026-03-16)

## Previous Sprints

- Sprint 1 (Stabilize) — COMPLETE
- Sprint 2 (Harden) — COMPLETE
- Sprint 3 (Redesign) — COMPLETE
- Sprint 4 (Phase 8) — COMPLETE
- Sprint 5 (Discord UX + Player Portal) — COMPLETE
- Sprint 6 (Schedule UX & UAT) — COMPLETE
- Sprint 7 (Platform & Mode) — COMPLETE
- Sprint 8 (Public Player Portal) — COMPLETE
- Sprint 9 (UI Themes) — ABANDONED (Gemini), reimplemented as feature
- Feature: Ranking Groups — COMPLETE
- Feature: UI Theme System — COMPLETE
- Sprint 10 (Production Hardening) — COMPLETE
- Feature: Player Engagement (Discord login, web picking, queue management) — COMPLETE
- Feature: Leaderboard UX Redesign — COMPLETE
- Feature: UX Plan Completion (PWA, global styles, compact header, toast, platform validation) — COMPLETE
- Feature: Game State Management (admin escape hatch for game/queue/iScored issues) — COMPLETE
- Feature: iScored API Integration (REST API client, score sync poller, wheel icons) — COMPLETE
- Feature: Scoreboard UX Overhaul (presets, preview, auto-sizing, image cropper, sidebar/fill layouts) — COMPLETE
- Feature: Scoreboard Preview & UX Fixes (multi-card preview, compact stacked scores, sticky save, display names, glass opacity, title styles) — COMPLETE
- Feature: Scoreboard Card Redesign (Style+Theme 2-level system, Banner/Showcase/Minimal cards, Glass Deck/Neon Circuit themes) — COMPLETE
- Feature: Scoreboard UX Fixes (inline rankings, style-matched ranking cards, 12 game title styles, avatar fallback) — COMPLETE

## Last Session

**Date:** 2026-04-12
**What happened:** Completed all remaining Global Scoreboard phases, committed, merged, and deployed to production.

**Work done this session:**
- Phase 2 gaps closed: room admin opt-out toggles, ScoreSubmitModal opt-out checkbox, user delete-own endpoint, per-user global rate limiter (10/hr)
- Phase 3 (User Preferences): migration 040 (scoreboard_prefs column), PreferencesService rewritten with JSON blob merge, GET/POST /api/me/scoreboard-preferences endpoints, Scoreboard.tsx merges user prefs on top of room config when logged in
- Phase 4 (JWT Refresh Tokens): auth.ts gains generateRefreshToken/createSession/refreshAccessToken/cleanExpiredSessions, Discord OAuth issues refresh tokens (30-day, rotated on use, role re-derived from DB), POST /api/auth/refresh endpoint, ViewerAuthContext auto-refresh (60s poll, 5min pre-expiry threshold, restores expired sessions on mount), api.ts admin 401 retry via refresh before redirect
- Phase 6 frontend: Freeplay.tsx (catalogue browse + score submit for any game)
- Committed as 3 commits on `feature/global-scoreboard-phase1`, fast-forward merged to main
- CLAUDE.md updated with all new services, pages, tables, endpoints, auth patterns
- Deployed via CI/CD to Hetzner (run 24301112235, 1m17s), verified: API 200, scoreboard 200, container healthy

**Git state:** On `main`, clean working tree (no modified source files). Two stale local branches (`feature/global-scoreboard-phase1`, `feature/scoreboard-redesign`) — both fully merged, safe to delete.

**Untracked non-source files** (intentionally not committed): planning docs (`Global Scoreboard *.md`, `continue.md`, `random_table_prompt.md`, `ui_fixes.md`, `ux-scoreboard-redesign-prompt.md`, `video_tutorial_prompt.md`), design HTML files (`docs/arcaid-*.html`), `.vscode/settings.json`, asset files (`assets/`), data directories (`data/catalogue-images/`, `data/iscored-styles/`, `data/styles/`).

**Production notes:** Discord bot token is invalid on prod (pre-existing, unrelated) — API runs without Discord. ScoreSyncPoller active.

**Status:** All 7 Global Scoreboard phases complete and deployed. Identity ADR (`0001-identity-site-handles.md`) still parked until anonymous flow details are decided.

## Blockers

(none)
