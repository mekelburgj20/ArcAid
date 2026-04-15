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

### Global Scoreboard — Phase 3: User Preference System (2026-04-11→2026-04-12) — COMPLETE
- [x] `PreferencesService` exists (admin theme only)
- [x] `user_preferences` table exists
- [x] Migration 040: `scoreboard_prefs` TEXT column on `user_preferences`
- [x] `PreferencesService.getScoreboardPrefs()` / `setScoreboardPrefs()` — JSON blob merge semantics (null/empty deletes key)
- [x] Device-specific preferences: nested `{ desktop: {...}, mobile: {...} }` storage with auto-migration from flat format
- [x] `GET/POST /api/me/scoreboard-preferences?device=desktop|mobile` endpoints (requireDiscordUser)
- [x] Scoreboard.tsx merges user prefs on top of room config when playerToken present, with device detection (`window.innerWidth <= 640`)
- [x] Preference hierarchy: user preference → room admin default (via config merge)
- [x] `ScoreboardPreferencesModal` — full-featured modal with ~20 settings: card style, showcase theme, UI theme, toggles, selects, zoom, advanced number prefs, mobile-specific prefs
- [x] Gear icon in PublicLayout nav bar (between username and logout) triggers modal via DOM event (`open-scoreboard-prefs`)

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

### Tournament Rotation Bug Fix (2026-04-12)
- [x] `TournamentEngine.processSlotMaintenance()`: max_active_games guard before creating picker slots (prevents over-fill)
- [x] `TournamentEngine.processSlotMaintenance()`: duplicate picker slot guard (skips if winner already has `[Pending Pick]`)
- [x] `TournamentEngine.autoPickAndActivate()`: max_active_games guard before auto-picking from queue
- [x] `TimeoutManager.fallbackToAutoSelection()`: max_active_games guard + orphaned picker slot cleanup
- [x] `TimeoutManager.handleTieredTimeout()`: stale slot check (verify game still exists and is QUEUED before acting)

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
- Feature: User Preferences Overhaul (device-specific prefs, expanded modal, gear button in nav) — COMPLETE
- Fix: Tournament Rotation Bug (max_active_games guards, duplicate picker slot prevention) — COMPLETE
- Feature: Mystery Award & UI Fixes (canvas-based picker, logo toggle, admin inline rankings) — COMPLETE

### Mystery Award & UI Fixes (2026-04-13→2026-04-14)
- [x] MysteryAward component — replaced PinballPicker with new canvas-based backbox component (DMD 192×48 dot grid, translite renderer with GI backlight/starburst/vignette, room logo in backglass)
- [x] Room branding integration — backglass shows `room.logo_url` from `/api/rooms`, independent of scoreboard config
- [x] "Add to Queue" integration — Discord-authenticated users can queue the randomly selected game directly from the picker
- [x] Nav rename: "Games" → "Game Picks", button: "Pick Random" → "Mystery Award" (Sparkles icon)
- [x] Page description added to Game Picks page
- [x] Scoreboard logo visibility toggle — `SCOREBOARD_LOGO_ENABLED` setting lets rooms upload logos for Mystery Award backglass without showing them on the scoreboard
- [x] Admin leaderboard inline rankings — matches public scoreboard behavior (inline ranking cards when `rankingsSticky` is off)
- [x] DMD rendering fix — removed `imageRendering: pixelated` to eliminate moiré/plaid pattern at scaled display sizes

### Lobby & Social Features (2026-04-14→2026-04-15)

**Phase 0: Bug Fixes**
- [x] Admin leaderboard "View Public Scoreboard" link
- [x] Landing page carousel clickthrough to GlobalGameDetail

**Phase 1: Lobby Core**
- [x] Migration 043: `lobby_feed_events` table with indexes
- [x] `LobbyFeedService.ts` — feed event CRUD, cursor-based pagination, 90-day cleanup, WebSocket emit
- [x] `LobbyFeedGenerator.ts` — central score event generation, hooked into all 5 submission paths
- [x] Score submission hooks: CommunityScoreService (3 web routes), Discord `/submit-score`, ScoreSyncPoller
- [x] Lobby feed API: `GET/POST /:roomId/lobby/feed` (public read, admin curated posts)
- [x] WebSocket: `join:lobby`/`leave:lobby` channels + `emitLobbyEvent()` for live feed updates
- [x] Scheduler: `startLobbyFeedCleanup()` cron job (3:30 AM, 90-day retention)
- [x] `Lobby.tsx` — public lobby page with activity stream, infinite scroll, WebSocket live updates
- [x] `AllGamesView.tsx` — Scoreboard "All Games" tab: auto-cycling carousel with room card styles (CardRouter/GameCard), search bar, left/right arrows, hover-pause
- [x] Scoreboard tab toggle (Tournament | All Games)
- [x] Lobby nav item (first position, MessageSquare icon) in PublicLayout
- [x] `community-leaderboards` endpoint enhanced — returns `GameLeaderboard`-compatible data with style resolution (room library → game_library → style_catalogue), search param, rankings array + avatar hashes

**Phase 2: Lobby Content & Admin**
- [x] Migration 044: `lobby_announcements` table
- [x] Migration 045: `community_shelf_items` table
- [x] `AnnouncementService.ts` — announcement CRUD with active/scheduled/expired status
- [x] `CommunityShelfService.ts` — shelf CRUD with reorder, URL type auto-detection
- [x] Lobby config via `game_room_settings`: social links, pinned message, feed settings
- [x] API: 12 new endpoints for announcements, shelf, and lobby config (public + admin)
- [x] `LobbyAdmin.tsx` — admin page with 5 sections: social links, pinned message, announcements, community shelf, feed settings
- [x] Lobby components: SocialLinksBar, PinnedMessage, AnnouncementCard, AnnouncementsRail, FeedItem, CommunityShelf
- [x] Full 4-zone Lobby page: social links bar → announcements rail → activity stream → community shelf

**Phase 3: Tournament & Milestone Integration**
- [x] TournamentEngine hooks: 3 lobby feed events (tournament results with winner, game rotation × 2)
- [x] `MilestoneService.ts` — threshold-based milestone detection (scores submitted, unique games, #1 positions)
- [x] Milestone events emitted from LobbyFeedGenerator on score submission

**Phase 4: Social Features (PARTIAL)**
- [x] Migration 046: `friendships` table (unidirectional follow model)
- [x] Migration 047: `notification_prefs` column on `user_preferences`
- [x] `FriendsService.ts` — friend CRUD, reverse lookup for feed events
- [x] Friends API: `GET/POST/DELETE /me/friends`, notification prefs `GET/PUT`
- [x] `Friends.tsx` — global friends page with add/remove/avatar display
- [x] Friend score events in lobby feed (targeted to friend's viewer)
- [x] Friends link (UserPlus icon) in PublicLayout avatar area
- [x] Route: `/friends` with ViewerAuthProvider
- [ ] `NotificationService.ts` — Discord DM dispatch with user prefs + rate limiting (5/user/hour)
- [ ] Notification dispatch hooks (rank dethroned, friend score, tournament win, turn to pick, tournament starting)
- [ ] Discord `/arcaid-notifications` slash command (show/toggle notification prefs)

**Phase 5: Polish & Engagement (PARTIAL)**
- [x] Freeplay contextual leaders — top 5 scores shown in submit modal via `/community-scores/:gameName/leaders`
- [x] Activity indicator in nav — localStorage-based last-seen tracking, cyan dot badge on Lobby icon
- [ ] Kiosk lobby ticker — scrolling feed events at bottom of KioskScoreboard
- [ ] Feed coalescing — collapse 3+ score_posted events from same player within 1 hour
- [ ] Notification rate limiting & coalescing — batch 3+ same-type notifications into summary

### Cross-Page UX Improvements (2026-04-15)
- [x] GameDetail non-tournament support — removed bail on null stats, conditional tournament tabs, default to community tab
- [x] GlobalGameDetail room context — `?from=slug` preserves room context, back link goes to `/:slug/freeplay`
- [x] Freeplay podium cards — rewritten to match GlobalScoreboard card style (RANK_STYLES, PodiumSlot, CommunityGameCard)
- [x] Global score fan-out fixes:
  - Fixed `grl.name` → `grl.game_name` in `fanOutFromRoomSubmission()` (critical — was silently killing ALL fan-out via game_room_game_library path)
  - Added 4th fallback lookup directly against `global_games` table by name
- [x] All Games cards link to GlobalGameDetail when globalGameId exists, with room context via `?from=slug`

## Last Session

**Date:** 2026-04-15
**What happened:** Fixed cross-page UX issues (game detail, freeplay, global score fan-out), then rewrote All Games tab as auto-cycling carousel with room card styles and search.

**Work done this session:**
- **GameDetail non-tournament support:** Removed bail on null stats, added conditional tournament tabs, default to community tab
- **GlobalGameDetail room context:** `?from=slug` param preserves room context; back link navigates to `/:slug/freeplay`
- **Freeplay podium cards:** Rewritten CommunityGameCard with GlobalScoreboard-style podium layout (RANK_STYLES, PodiumSlot)
- **Global score fan-out fixes:** Fixed `grl.name` → `grl.game_name` (was silently breaking ALL fan-out); added direct `global_games` name lookup as 4th fallback
- **AllGamesView carousel:** Rewritten to use same CardRouter/GameCard as tournament tab, auto-cycles every 5s, pauses on hover, left/right arrows, search bar at top
- **community-leaderboards endpoint:** Enhanced to return GameLeaderboard-compatible format with style resolution (room library → game_library → style_catalogue), search param, rankings with avatar hashes
- **Bug fix:** `game_library` table has no `catalogue_style_id` column — fixed SQL query

**Git state:** On `main`, all committed and deployed. Latest commit: `cb481504` (fix: community-leaderboards query)

**Production status:** Deployed and healthy. CI/CD run 24459681027 completed.

**Known issue:** User reported All Games and Freeplay showing no games after the carousel deploy. Traced to `catalogue_style_id` column missing from `game_library` table (500 error from endpoint). Fix deployed (`cb481504`) but user hasn't confirmed yet.

**Next up:**
- Verify All Games carousel and Freeplay are working after the SQL fix
- Discord push notifications: `NotificationService` (DM dispatch + prefs + rate limiting), notification hooks (rank dethroned, friend score, tournament win, turn to pick), Discord `/arcaid-notifications` command
- Remaining Phase 5 polish: kiosk lobby ticker, feed coalescing

## Blockers

(none)
