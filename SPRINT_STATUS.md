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

## Last Session

**Date:** 2026-03-31
**What happened:** Integrated iScored REST API as primary score sync method (replacing Playwright for reads/writes). Built ScoreSyncPoller for continuous background sync. Added wheel icon card header style for pinball wheel PNGs on scoreboards. All settings exposed in admin UI with hot-reload support.
**Next:** Verify iScored API polling in production (user must enable API in iScored gameroom settings). User-driven features as needed.

## Blockers

None.
