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

## User Preferences Overhaul (COMPLETE)

- [x] Device-specific preferences: nested `{ desktop: {...}, mobile: {...} }` storage in `user_preferences.scoreboard_prefs`
- [x] Auto-migration from old flat JSON format to device-keyed format
- [x] `?device=desktop|mobile` query param on `GET/POST /api/me/scoreboard-preferences`
- [x] ScoreboardPreferencesModal expanded to ~20 settings: card style, showcase theme, UI theme, 6 toggle prefs, 5 select prefs, zoom slider, 5 advanced number prefs, 2 mobile-specific prefs
- [x] Desktop/Mobile toggle in modal header with Monitor/Smartphone icons
- [x] Gear icon moved to PublicLayout nav bar (between username and logout), communicates with Scoreboard via DOM event
- [x] Scoreboard.tsx device detection (`window.innerWidth <= 640`) and device-specific pref fetch
- [x] UI theme application via `setPublicTheme()` after pref fetch

---

## Tournament Rotation Bug Fix (COMPLETE)

- [x] `TournamentEngine.processSlotMaintenance()`: max_active_games guard before picker slot creation
- [x] `TournamentEngine.processSlotMaintenance()`: duplicate picker slot guard (skip if winner already has `[Pending Pick]`)
- [x] `TournamentEngine.autoPickAndActivate()`: max_active_games guard before auto-picking from queue
- [x] `TimeoutManager.fallbackToAutoSelection()`: max_active_games guard + orphaned slot cleanup
- [x] `TimeoutManager.handleTieredTimeout()`: stale slot check (verify game still QUEUED before acting)

---

## Mystery Award & UI Fixes (COMPLETE)

- [x] MysteryAward component — canvas-based random game picker replacing PinballPicker (DMD 192×48 dot grid, translite renderer with GI backlight/starburst/vignette, room logo in backglass)
- [x] Room branding in backglass — reads `room.logo_url` directly from `/api/rooms`, independent of scoreboard config
- [x] "Add to Queue" integration — Discord-authenticated users can queue the selected game from the picker
- [x] Nav/button rename: "Games" → "Game Picks", "Pick Random" → "Mystery Award" (Sparkles icon)
- [x] Scoreboard logo visibility toggle — `SCOREBOARD_LOGO_ENABLED` setting decouples logo upload from scoreboard display
- [x] Admin leaderboard inline rankings — matches public scoreboard behavior (inline when `rankingsSticky` off)
- [x] DMD rendering fix — removed `imageRendering: pixelated` to eliminate moiré pattern

---

## Lobby & Social Features (COMPLETE)

All 5 phases complete (2026-04-14→2026-04-15). Notification coalescing deferred.

- [x] Phase 0: Bug fixes — admin leaderboard public link, landing carousel clickthrough
- [x] Phase 1: Lobby Core — `lobby_feed_events` table, `LobbyFeedService`, `LobbyFeedGenerator` (5 score submission hooks), WebSocket live feed, Lobby page with activity stream, Scoreboard "All Games" tab (carousel with room card styles + search), feed cleanup scheduler, `community-leaderboards` endpoint enhanced with GameLeaderboard format + style resolution
- [x] Phase 2: Lobby Content & Admin — `lobby_announcements` + `community_shelf_items` tables, `AnnouncementService`, `CommunityShelfService`, lobby config via `game_room_settings`, LobbyAdmin page (5 sections), full 4-zone Lobby (social links, announcements rail, activity stream, community shelf), 6 lobby sub-components
- [x] Phase 3: Tournament & Milestone Integration — TournamentEngine hooks (3 event types), `MilestoneService` (threshold-based: scores/games/firsts)
- [x] Phase 4: Social Features — Friends system (`friendships` table, `FriendsService`, Friends page, friend feed events) + Discord push notifications (`NotificationService` with prefs + rate limiting, 5 dispatch hooks, `/arcaid-notifications` slash command)
- [x] Phase 5: Polish & Engagement — Freeplay contextual leaders, nav activity indicator, kiosk lobby ticker, feed coalescing. **Remaining:** notification coalescing (deferred)

**New files:** `LobbyFeedService.ts`, `LobbyFeedGenerator.ts`, `AnnouncementService.ts`, `CommunityShelfService.ts`, `MilestoneService.ts`, `FriendsService.ts`, `NotificationService.ts`, `notifications.ts` (Discord command), `Lobby.tsx`, `LobbyAdmin.tsx`, `Friends.tsx`, `AllGamesView.tsx`, `SocialLinksBar.tsx`, `PinnedMessage.tsx`, `AnnouncementCard.tsx`, `AnnouncementsRail.tsx`, `FeedItem.tsx`, `CommunityShelf.tsx`

**Migrations:** 043 (lobby_feed_events), 044 (lobby_announcements), 045 (community_shelf_items), 046 (friendships), 047 (notification_prefs)

### Cross-Page UX Improvements (2026-04-15)
- [x] GameDetail: non-tournament game support (conditional tabs, no bail on null stats)
- [x] GlobalGameDetail: room context via `?from=slug`, back link to `/:slug/freeplay`
- [x] Freeplay: podium-style cards matching GlobalScoreboard, clickable to game detail
- [x] AllGamesView: carousel with room card styles (CardRouter/GameCard), auto-cycle, search, arrows
- [x] Global score fan-out: fixed `grl.game_name` column name + added `global_games` direct lookup fallback

## Scores/Nav Reorg — Sprints 1-13 (COMPLETE, shipped 2026-04-18)

12-sprint plan + Sprint 13 polish pass. Context-capture plumbing, merge-model spec, shared `GameCard` + `SubmissionSheet` + themed icons, `DiscordNicknameResolver`, `PickAwardGate` cascade, `REQUIRE_DISCORD_LOGIN` relabel + orphan-on-flip + logo badge crop, `room_members` table, nav restructure + `UserMenu` + My Rooms + Stats merge, Scoreboard `Tournaments | All Games` tabs + `RoomTag` filter, Picks page rename + Mystery Award lift + 301 redirect, anonymous submission runtime + legacy modal deletion, `MergeService` + admin identity UI + self-claim hook, Global Scoreboard badges + cooldown display rules + emoji sweep. All committed to main as the `2.0.0` baseline and deployed.

## v2.1.0 — Tournament scoring + Stats Combo (COMPLETE, shipped 2026-04-18)

- [x] Tournament leaderboards read `score_history` filtered by `submitted_during_tournament_id` — best-during-window wins, no longer tied to all-time PB. Migration 063 backfills existing rows.
- [x] Multi-score inline expand on Game Detail with sparkline + This-tournament / All-time split, proof-photo links, source pills.
- [x] Stats page Combo — 4-card overview row (plays this week / active players / hottest game / latest submission) + new `GET /:roomId/stats/overview` endpoint.

## v2.2.x — Identity correctness + cabinet redesign (COMPLETE, shipped 2026-04-19 → 2026-04-21)

14 patch releases (v2.2.0 → v2.2.14) in a tight iteration cycle. Highlights:

- [x] **First-claim-wins identity** (`RoomNameClaimService`, `room_members.display_name`, `anon_room_claims`, migrations 064 + 066). Auto-suffix colliding names across Discord/anon/browser contexts. Multi-name per browser allowed (one token → many names per room).
- [x] **Pre-submit name-check** endpoint + `SubmissionSheet` collision prompt with editable suggestion.
- [x] **Global fan-out gate** — guest submissions never reach `/scoreboard`; gated on `normalizeSubmitterUserId`.
- [x] **`REQUIRE_DISCORD_LOGIN=true` default for new rooms**. Existing rooms untouched (migration 065 no-op marker).
- [x] **`conditionalRequireDiscordUser` middleware** decodes optional tokens even in guest-allowed rooms. Fixes regression where logged-in users fell through as `COMMUNITY`.
- [x] **Unified iScored sync** via `IScoredSubmitSync.syncScoreToIScored` — called from tournament submit, freeplay, and legacy community endpoint. `IScoredApiClient.submitScore` handles non-JSON rejections.
- [x] **Winner resolution from local DB** — `TournamentEngine.processSlotMaintenance` reads `submissions` first, iScored fallback. Anon winners get a claim-your-account Discord message, no `@mention`, no picker slot.
- [x] **Scoreboard click routing refactor** — removed inset-0 Link overlay from `GameCard`, `Scoreboard.tsx`, `GamesTabView.tsx`. Each card variant wraps its own title as a Link. Usernames everywhere are Links to `/:slug/players/:name`. Score rows + `+` expand icons capture clicks naturally.
- [x] **Picks URL slug** — `/:slug/picks?t=daily_grind` (was UUID). Back-compat preserved.
- [x] **Post-login lands on `/:slug/lobby`** (was `/:slug/picks`).
- [x] **`UserMenu` on Global pages** (`/scoreboard`, `/games/:id`). Shared `DiscordLoginButton` component.
- [x] **Mystery Award cabinet redesign** — `TournamentPoolTopper` (LED glow pill above backbox), circular Fire/Queue pinball-cabinet buttons always visible, Queue amber-orange (not green), grayed until a result lands. v2.2.14 flipped Fire/Queue positions.
- [x] **Service-worker cache-bust discipline** — `CACHE_NAME` bumped every UI-visible release so installed PWAs pick up changes on reload.

Manual test playbook: `tmp/manual-test-playbook-v2.2.3.md` (up to v2.2.7 checkpoints).

---

## v2.2.15 — Settings reorg + Identity moves (COMPLETE, shipped 2026-04-18)

- [x] Room Settings sections reordered: Theme → Scoreboard Display → Scoreboard Branding → Kiosk → Game Room → Integrations → Discord → Users → iScored.
- [x] "Refresh Schedules" button moved to bottom of Tournaments page; "System Actions" header removed.
- [x] Merge / Rename Player moved from Settings to the Identity admin page (`/:slug/admin/identity`).
- [x] Platforms management removed from Settings — covered by the `+` button next to Platforms in the Game Library row editor.
- [x] Discord admin "user not found" error now surfaces a distinct 400 with actionable text.
- [x] Default scoreboard display picker shows new card styles first; legacy styles behind "Show legacy styles" expander.

---

## v2.3.0 — Per-room integrations + at-rest secret encryption (COMPLETE, shipped 2026-04-19)

- [x] **Per-room iScored / Discord** — Discord guild ID, admin role ID, announcement channel ID, and iScored credentials moved from global to per-room `game_room_settings`. Each room can independently connect to its own Discord guild and iScored account, or disable either via `DISCORD_ENABLED` / `ISCORED_ENABLED` flags.
- [x] **At-rest encryption** — `src/utils/secrets.ts` AES-GCM pipeline keyed off `SECRETS_KEY` env. `ENCRYPTED_SETTING_KEYS` allowlist (initially `ISCORED_PASSWORD`). `SettingsService` and `GameRoomSettingsService` consult `isEncryptedKey()` for encrypt-on-write / decrypt-on-read. `maskEncryptedValues` returns `[ENCRYPTED]` on `GET /admin/settings` so the UI never round-trips ciphertext. `npm run generate-secrets-key` mints a fresh key.
- [x] **Discord plumbing fixes** (v2.3.1–v2.3.3) — gate slash commands and DMs on per-room `DISCORD_ENABLED`; exclude Discord-disabled rooms from cross-room queries; exclude orphan (no-tournament) games from `/list-active`.

---

## v2.4.0 — Catalogue Unification + Pin to Scoreboard (COMPLETE, shipped 2026-04-21)

8 phases (A–H), 9 migrations (068–076), 30 new tests (89 → 119).

**Catalogue unification:**
- [x] **Backfill** — Migration 069 populates `global_game_id` on `games`, `game_library`, `game_room_game_library`. Idempotent, transactional, type-aware (resolves video_game vs pinball via `tournaments.mode`). Pre-sprint fill rates 0% / 0% / 51% → ~100% across the board.
- [x] **UNIQUE INDEX `idx_global_games_name_type`** (migration 068) closes the read-check-insert race in `GlobalGameService.upsert`. Later replaced by composite `idx_global_games_identity` (migration 080) to allow same-name pinballs from different manufacturers.
- [x] **Orphan cleanup** (migration 070) — deleted 5 legacy pinned games (Walking Dead, Spider-Man, Iron Maiden, 24, Game of Thrones) with `tournament_id=NULL`. Cascades submissions/score_history/global_scores `game_id` to NULL before DELETE.
- [x] **Per-room overlay** (migration 071) — `game_room_game_library.custom_platforms` (JSON, unioned with global) + `display_name` (override).
- [x] **Query migration** — high-impact joins switched to FK-based: `rooms.ts` library JOIN, `GameLibraryService` room-library queries, `GlobalScoreService` fan-out short-circuits, `LeaderboardService` + `DashboardService` style-resolution. Cache bust (migration 072) on `leaderboard_cache` + `global_leaderboard_cache`.

**Pin to Scoreboard:**
- [x] **Schema** — `games.game_room_id` (migration 073, denormalized + backfilled from tournaments), `games.display_order` (migration 076). Unique partial index `idx_games_pinned_unique` (migration 074) prevents double-pin per room.
- [x] **Cascade on unpin** — application-level via the helper. `UPDATE submissions SET game_id = NULL` (and same for score_history, global_scores.origin_game_id) before the DELETE. Score history preserved.
- [x] **`createGameWithIScoredSync()` shared helper** (`src/engine/gameCreation.ts`). Returns `{ gameId, iscoredStatus, iscoredId? }`. `TournamentEngine` refactored to use it at three call sites; new Pin endpoint also uses it.
- [x] **UI** — Pin button on Game Library row actions opens modal with iScored mirroring + global-scoreboard exclusion checkboxes. "Pinned" section on Game States page parallel to Active/Queued/Completed. Inline display-order editor.
- [x] **Visual** — `BannerCard`, `ShowcaseCard`, `MinimalCard` render a subtle "Pinned" chip when `isPinned: true`.

**Rankings & Stats audit:** Pinned games naturally excluded from `RankingService.computeRankings` (it's tournament-scoped). `StatsService` casual metrics include pinned scores; tournament-tagged metrics don't.

---

## v2.4.1–v2.4.15 — Catalogue dedup saga (COMPLETE, shipped 2026-04-21 → 2026-04-24)

15 patches over 4 days as iterative imports surfaced deeper layers of the dedup logic. Final state has 119/119 tests passing.

- [x] **v2.4.1** — Migration 068 auto-merges legacy duplicate `(name, type)` groups instead of aborting (prod had 112 groups; without auto-merge the UNIQUE INDEX creation aborted).
- [x] **v2.4.2** — Multi-pass merge loop (3 passes max) catches duplicates of duplicates. Diagnostic logging for residuals.
- [x] **v2.4.3** — Migration 069 backfill uses strict `LOWER(name)+type` exact-match helper instead of `GlobalGameService.upsert` (which collapsed multiple distinct names to the same key).
- [x] **v2.4.4** — Migration order fix: 077 (drop NOT NULL on `submissions.game_id`) now runs before 070 (orphan cleanup).
- [x] **v2.4.5** — All Games tab: catalogue card link target → room game detail (when mapped); rows with no image hidden by default.
- [x] **v2.4.6–v2.4.7** — Migrations 078/079 merge thin backfilled catalogue duplicates (`Bluey (Original, 2021)` thin row + `Bluey` rich row patterns).
- [x] **v2.4.8** — Migration 080 swaps `idx_global_games_name_type` for composite `idx_global_games_identity` on `(LOWER(name), type, LOWER(COALESCE(mfg,'')), COALESCE(year,0))`. Lets Stern Batman 2008 + Data East Batman 1991 coexist.
- [x] **v2.4.9** — Removed stale `SYNC_ALERT_CHANNEL_ID` from seed; migration 081 scrubs prod.
- [x] **v2.4.10** — Step-4 two-tier match: concrete (mfg+year-agreeing) preferred over loose (NULL-tolerant). Migration 082 re-runs thin-duplicate merger.
- [x] **v2.4.11** — Step-4 concrete uses exact year match (not ±1 tolerance). Multi-concrete tie-breaker prefers richest row (most external IDs, oldest `created_at`).
- [x] **v2.4.12** — `findByNormalizedName` rewritten to drop SQL `LIKE` prefilter — full-table scan + JS-side normalize compare. The `LIKE '%firstword%'` prefilter used the *normalized* (punctuation-stripped) first word against *raw* names, so `"gilligans"` couldn't match stored `"Gilligan's Island"` because the apostrophe broke the substring.
- [x] **v2.4.13** — Wizard import section-aware tagging: `vpxs` for auto-install, `vpxs_manual` for Manual Install Tables. Tournament platform rules can require reliability. SpongeBob no-parens edge case: loose-path richest-row tie-breaker.
- [x] **v2.4.14** — Per-tournament scheduler logs gain `[room-slug]` prefix. Super-admin Dashboard adds Activity Log link per room card.
- [x] **v2.4.15** — Step-4 concrete-path filters against full `nameMatches` (not `nonConflicting`) to handle VPS re-indexing. Pinball machines have a single canonical `(name, mfg, year)` identity, so a divergent vps_id just means the source re-indexed itself.

---

## v2.4.16 — Catalogue UX + diagnostics (COMPLETE, shipped 2026-04-25)

- [x] **`formatLogArg()` writes `Error.stack` to file** instead of `{}`. Pre-fix every `logError(msg, err)` site silently lost detail because `Error.message` and `.stack` are non-enumerable and the file logger used `JSON.stringify`. Console output was unaffected (Node's `util.inspect` handles Error specially), so the bug only surfaced in the rotating file (and the admin Logs viewer that reads it).
- [x] **OPDB / IGDB sync routes return 400 upfront** when credentials are missing. Was 202 → swallowed background failure → opaque `{}` log line.
- [x] **Global Settings → Configuration** gains `OPDB_API_KEY`, `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` fields. Masked inputs + reveal toggle on the secrets. `OPDB_API_KEY` and `TWITCH_CLIENT_SECRET` added to `ENCRYPTED_SETTING_KEYS` allowlist.
- [x] **VPS importer split** into `playable` (legacy game_library — unchanged) and `cataloguable` (any VPS entry with a name → global_games + image-download pass). Broken-flagged tables (Bluey, Britney Spears, etc.) — they have user-submitted scores and valid metadata + images upstream — now populate the global catalogue.

---

## Future

### Player Self-Service + Moderation

Three related features that together tighten up score/comment integrity and give admins a proper moderation surface. All gated behind Discord-authenticated identity — anonymous users don't get self-service edit/delete (they have no durable identity to verify), don't get to leave comments/tips, and don't need to be "banned" because the claim system auto-suffixes them anyway.

**A. Self-edit / self-delete scores**

Logged-in players can correct or remove their own submissions across every surface where their score appears.

- [ ] **Delete own score** — button/icon on each score row where `submitted_by_user_id === viewer's Discord ID`. Applies to `submissions`, `community_scores`, `score_history`, AND the fanned-out `global_scores` row for the same event. Soft-delete (set `deleted_at` / `orphaned_at`) rather than hard-delete so audit trail survives.
- [ ] **Edit own score value** — modal with new score input + photo upload. Gated on ownership. Writes a new `score_history` row for the revision, updates the canonical `submissions` / `community_scores` row to the new value, re-fans to `global_scores` (delete old global row + insert new). Photo required if the game's room requires photos on new submits.
- [ ] **Scope consistency** — deleting/editing a room score automatically mirrors to the global row (via `submitted_from_room_id` + `submitted_during_tournament_id` linkage). Deleting a pure global submission only affects `global_scores`.
- [ ] **Self-actions logged to `audit_log`** with actor, target row id, old/new values. Room admin + super-admin can see via the activity log.
- [ ] **Rate limit** — e.g., 10 self-edits per user per hour to prevent leaderboard thrashing.
- [ ] **UX** — edit/delete controls on: Tournament card rows (expanded view), Game Detail leaderboard rows, Community tab rows, Global Scoreboard rows, Global Game Detail rows. Hidden for non-owners.

Open design question: **should edit be allowed to raise a score or only lower it?** Raising is abusable without photo-proof verification. Safe default: edits require a new photo if photos are required for submission in that room; otherwise any value is allowed but all edits are logged.

**B. Comments/tips require Discord login**

Currently `POST /:roomId/comments/:gameName` and the global `/global/games/:id/comments` both accept anonymous posts. Change the gate.

- [ ] **Server** — add `requireDiscordUser` middleware to comment POST endpoints (room + global). Reject 401 without a valid player token. Existing anon comments stay visible but read-only.
- [ ] **Client** — comment compose UI hides or replaces with "Log in to leave a tip" CTA when viewer isn't Discord-authenticated. Same for rating.
- [ ] **Self-edit / self-delete comments** — same ownership rule as scores. Logged-in users see edit + delete controls on their own comments on Room Game Detail and Global Game Detail. Soft-delete (set `deleted_at`), audit-logged.
- [ ] **Legacy anon comments** — kept as-is, visible but no owner controls. Admin can still delete them from the mod surface.

**C. Admin ban — logged-in users**

`user_bans` table already exists (used by `GlobalScoreService.isBanned` to short-circuit global submissions). Build out the full moderation workflow around it.

- [ ] **Admin ban UI** — new page (or section in existing admin activity log): `/admin/bans` (super-admin, global) and `/:slug/admin/bans` (room-admin, room-scoped). List current bans, add a ban (Discord user ID + reason + optional expiry), lift a ban.
- [ ] **Ban scope** — two tiers: (1) **room ban** — user can't submit/comment in that room, existing content orphaned; (2) **global ban** — user can't submit anywhere, all their content hidden from Global Scoreboard. Super-admins can set either; room admins can only set room-level.
- [ ] **Enforcement points** — extend the existing `isBanned()` check from global submissions only to room submissions, comment POSTs, rating POSTs, friend POSTs. Consistent 403 response with ban reason (if admin chose to surface it).
- [ ] **Ban → content cascade** — decide per ban whether the user's existing scores + comments are: (a) hidden from public views (soft), (b) deleted (hard), or (c) left visible. Default to (a) soft-hide for reversibility. `orphaned_at` column already exists on `submissions` / `community_scores` / `score_history` for this pattern.
- [ ] **Ban → Discord notification** — optional DM to the banned user with reason, scope, and expiry. Opt-out respected if they've turned off Discord notifications, but bans should probably override that since it's a moderation action.
- [ ] **Audit** — every ban / unban logged to `audit_log` with actor, target, reason, scope.

**Shared plumbing across A/B/C:**
- Need a new `/api/me/scores` endpoint returning the viewer's own recent submissions across all score tables (paginated) so the UI can show a "My scores" management view.
- Need a new `/api/me/comments` endpoint, same pattern.
- Ownership check helper: `requireOwnsScore(scoreId)` / `requireOwnsComment(commentId)` middleware that reads the row's `submitted_by_user_id` / `user_id` and compares to `req.user.discordId`. Super-admins bypass.

**Rough sizing:** A is ~2 days (lots of surface area — scores live in 4 tables and 6+ UI components). B is ~0.5 days (middleware flip + compose-UI gate). C is ~1-1.5 days depending on whether the ban→cascade hide logic is implemented or deferred. All three should probably ship behind a `FEATURE_PLAYER_SELF_SERVICE=true` settings flag initially so it can be rolled back without data loss.

### Discord Push Notifications (COMPLETE)

- [x] `NotificationService.ts` — Discord DM dispatch with per-user prefs check + in-memory rate limiting (5/user/hour)
- [x] 5 notification dispatch hooks:
  - Rank Dethroned: `LobbyFeedGenerator.onScoreSubmitted()` — when new #1, notify previous #1
  - Friend Score: `LobbyFeedGenerator.onScoreSubmitted()` — alongside friend_score feed events
  - Tournament Win: `TournamentEngine` after winner resolution
  - Turn to Pick: `TournamentEngine` after picker slot creation
  - Tournament Starting: `Scheduler` every 15 minutes — 45-60 min before tournament cadence fires
- [x] Discord `/arcaid-notifications` slash command — `show` (embed), `toggle <type>`, `enable all`, `disable all`
- [x] Registered in `DiscordClient.ts` command list
- [ ] Notification coalescing — batch 3+ same-type notifications within 5 minutes into summary DM (deferred to Phase 5 polish)

### Multi-Room
- [ ] Discord Bot Multi-Room (Phase 5) — single bot, multi-guild, per-room command scoping

### Score Photo Persistence
Score proof photos are stored locally on disk (`data/score-photos/`). As the Global Scoreboard becomes the primary submission path (no iScored dependency), reliable photo storage is critical. Many rooms will not use iScored integration at all.

Current gaps:
- Direct global submissions store photos locally — works, but no redundancy or CDN
- Legacy iScored-synced scores reference external CDN URLs that may expire
- Room-originated photos referenced by global scores may 404 if the file wasn't persisted during fan-out
- No backup/replication strategy for photo files (DB is backed up, photos are not)

Options to evaluate:
- [ ] S3/object storage for all score photos (persistent, CDN-backed, scales independently)
- [ ] Serve missing photos gracefully (placeholder image instead of 404)
- [ ] Include `data/score-photos/` in backup volume (quick win)
- [ ] Download and persist iScored CDN photos during sync (for rooms still using iScored)
- [ ] Copy room photos to global photo dir during fan-out

### Phantom anon-claim cleanup — manual runbook (not automation)

First-claim-wins is the policy: whoever uses a name first in a room owns it. **We don't automate "Discord trumps anon" name transfers** — that's the fraud surface we explicitly rejected when the design was agreed. If a Discord user and a legit-different-human anon share a display name, the anon (who got there first) keeps it, the Discord user gets `Name_2`.

The one exception is a phantom claim — an anon row that *is actually the same human* as the Discord user who later tries to claim the name, typically from the pre-v2.2.5 window when `conditionalRequireDiscordUser` was dropping Bearer tokens in guest-allowed rooms. Those should be cleaned up case-by-case, never automated.

**Procedure:**

1. Verify the claim is a phantom. Needs at least two of:
   - The anon claim's `claimed_at` falls inside a known middleware-bug window (pre-v2.2.5 deploy, or after any future auth-middleware regression).
   - The user confirms it was their browser session.
   - The `anon_token` matches a localStorage UUID the user can produce.
2. Identify the row precisely:
   ```sql
   SELECT anon_token, room_id, display_name, claimed_at
     FROM anon_room_claims
    WHERE LOWER(display_name) = LOWER('<name>')
      AND room_id = '<room-uuid>';
   ```
3. Delete narrow, keyed on `anon_token` + `room_id` + `display_name`:
   ```sql
   DELETE FROM anon_room_claims
    WHERE anon_token = '<token>'
      AND room_id = '<room-uuid>'
      AND LOWER(display_name) = LOWER('<name>');
   ```
4. Log the deletion in `audit_log` with a reason so there's a trail (or document in ops notes if the table doesn't accept ad-hoc reasons).

**Do not:**
- Run the broad `DELETE ... WHERE name IN (SELECT iscored_username FROM user_mappings)` form. It can't distinguish phantom from legit and violates first-claim-wins.
- Surface a self-serve "claim this name" button in the UI — same fraud surface.
- Build a background job that auto-cleans phantoms. Needs a human to verify the claim is actually the same user.

The existing admin merge tool at `/:slug/admin/identity` is the right place for real cross-identity reconciliation when it turns out two claims should collapse into one.

### Game Library filters — Platform / Manufacturer / Type / etc.

The game library and global catalogue are already searchable by name across four surfaces: room admin (`/:slug/admin/library`), global catalogue (`/catalogue`), freeplay picker (`/:slug/freeplay`), and super-admin master library. Add a filter panel so users can narrow by metadata fields without typing.

- [ ] **Filter fields (MVP):**
  - **Platform** — the canonical platform IDs from `src/utils/platformMapping.ts` (VPX, VPXS, VPX-VR, IRL, AtGames, Scorbit, etc.). Multi-select. Already stored as JSON array on `game_library.platforms` / `global_games.platforms`.
  - **Manufacturer** — Stern, Bally, Williams, Gottlieb, Data East, Sega, etc. Stored on `global_games.manufacturer`; usually missing on pure room entries (falls back to catalogue lookup via `global_game_id`).
  - **Type** — Real pinball (EM / SS / modern), Virtual pinball, Video game, Arcade cabinet. Derivable from platform + year + catalogue category; may need a dedicated column if the derivation gets ambiguous.
  - **Year** — range slider or decade dropdown.
  - **Theme / Tags** — adventure, sci-fi, supernatural, licensed (IP tags from VPS/OPDB imports). Multi-select.
  - **Player count** — 1P / 2P / 4P (already surfaced on Global Game Detail, see image #5 earlier).
- [ ] **Filter UI:** collapsible sidebar on desktop, bottom-sheet on mobile. Filter chips above the grid show active filters with `×` to remove. Clears-all link when any filter is active.
- [ ] **URL state** — filters serialize to query params (`?platform=vpx,vpxs&manufacturer=stern&year=1990-2000`) so shares and deep-links work.
- [ ] **Combined with search** — existing name-search input stays; filters narrow the result set server-side, search is applied on top.
- [ ] **API surface** — extend the existing list endpoints (`GET /:roomId/game_library`, `GET /global/catalogue`, `GET /admin/master-library`) to accept the filter params. Single query with `WHERE` clauses + JSON array intersection for `platforms`.
- [ ] **Performance** — all filter columns need indexes on `global_games` (platforms is JSON so an index helps but doesn't fully accelerate). Consider a materialized `global_games_facets` view or extracting filter keys into indexed columns if the catalogue grows past ~10k entries.
- [ ] **Filter facet counts** — next to each filter option show the number of matching games (e.g. "Stern (47)", "Bally (23)"). Requires a separate aggregation query. Can ship without initially; add once the UI is validated.

Open questions:
- **Type derivation**: is "Real pinball" vs "Virtual pinball" vs "Video game" stored anywhere already, or do we need a new column? If new, seed from a platform→type mapping table.
- **Room-local vs global**: should room-admin library filters be restricted to what the room has (reflecting its curated list) or show the full global catalogue with availability indicators? MVP: restricted to room's actual library; add "browse global" as a secondary pivot later.

Rough sizing: 1-2 days depending on whether Type needs a new column + migration. Facet counts add another half-day.

### Comments & Tips — bidirectional view (Option 2)

Comments/tips and ratings currently live in two parallel stores: `game_comments`/`game_ratings` (room-scoped, keyed on `(room_id, game_name)`, anon allowed) and `global_game_comments`/`global_game_ratings` (keyed on `global_game_id`, Discord required). A tip written on the Room Game Detail never reaches the Global Game Detail for the same game, and vice versa.

Ship a union-view model that keeps both stores but surfaces cross-room content where appropriate:

- [ ] Comment compose UI gains a "Share globally" checkbox. Defaults on for Discord-authed users (writes to both tables); anon comments stay room-only.
- [ ] Room Game Detail renders local + global comments together, tagged by origin (e.g., small "Globally" badge on shared comments, room logo on room-only). Add a `?scope=room|global|both` filter or tab.
- [ ] Global Game Detail adds a "From rooms" section or similar so room-shared tips are discoverable cross-community.
- [ ] **Ratings:** probably fully unify for any game with a `global_game_id` — a star is a star. Room-only games (no global mapping) keep their ratings local.
- [ ] Migration / backfill decision: do we one-shot promote existing room comments with Discord-authored authors into `global_game_comments`, or leave history as-is?

Rough scope: half a day of focused work. Needs a design pass on the compose UX (where exactly the checkbox lives, default state per auth state, how to handle room games without a global mapping).

### iScored Sync Hardening
Cooldown enforcement gaps identified in v2.2.0 review. Evaluate and address in a future sprint.

- [ ] **Cooldown bypass via `/sync-state`** — when an admin manually creates a game on iScored tagged `DG` / `WG-VPXS` / `WG-VR` / `MG`, the next `/sync-state` creates a local `games` row set to ACTIVE with no `GAME_ELIGIBILITY_DAYS` / `last_played` check (`src/discord/commands/syncstate.ts:45-65`). The game goes live in ArcAid even if `game_library` says it's still in cooldown. Cooldown is only enforced by `runMaintenance()`, `autoPickAndActivate()`, and the web `/pick-game` path — not by sync. Decide: (a) treat sync as admin-override and document, (b) refuse to create the local row when cooldown applies, or (c) create it as LOCKED so it's recorded but doesn't surface on scoreboards. Option (c) preserves iScored-is-source-of-truth while respecting cooldown.
- [ ] **Duplicate active games when sync runs with an active DG game present** — related to above. Sync doesn't check `max_active_games` before marking a discovered game ACTIVE, so two DG games can be ACTIVE simultaneously until the next maintenance run rotates one out.

### Ops / Infrastructure
- [x] CI/CD pipeline (GitHub Actions: build + push to GHCR + deploy to Hetzner on push to main)
- [ ] Automated backup schedule (configurable via admin UI)
- [ ] Monitoring / alerting (health check dashboard, error rate tracking)
- [ ] Super-admin dashboard server metrics (CPU, memory, I/O, container stats)
- [ ] High availability / multi-container — see notes below
- [x] Friends-list score filtering — implemented via unidirectional follow model (no Discord relationships.read needed)

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
