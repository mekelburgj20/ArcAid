# ArcAid — Task Checklist

> See SPRINT_STATUS.md for live progress.

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
- [x] Updated `TokenPayload` — `role: 'super_admin' | 'room_admin'`, `gameRoomIds`, `discordId?`, `localAdminId?`
- [x] `requireRoomAccess(paramName)` middleware — checks super_admin OR room membership
- [x] `requireSuperAdmin` middleware
- [x] `AdminService` — super-admin, room Discord admin, and local admin management
- [x] Super-admin password login (`POST /api/auth/login`)
- [x] Room local admin login (`POST /api/auth/login/:roomSlug`)
- [x] Discord OAuth — checks `super_admins` → `game_room_admins` → 403

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

## Future

### Multi-Room
- [ ] Discord Bot Multi-Room (Phase 5) — single bot, multi-guild, per-room command scoping

### UX Polish
- [ ] Trend charts / sparklines on player profile pages
- [ ] Notification preferences (opt-in/out for reminders, announcements)
- [ ] Additional themes
- [ ] Scoreboard designer page (admin-only CSS customization)

### Ops / Infrastructure
- [ ] CI/CD pipeline (build + test on push)
- [ ] Automated backup schedule (configurable via admin UI)
- [ ] Monitoring / alerting (health check dashboard, error rate tracking)
