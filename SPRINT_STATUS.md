# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the task checklist, see TODO.md.

---

## Current Work

**Sprint 10: Production Hardening** — IN PROGRESS

### Tier 1: Critical — COMPLETE
- [x] 1.2 API Rate Limiting (`express-rate-limit`: 5/min auth, 100/min general)
- [x] 1.3 Missing Database Indexes (`games(iscored_id)`, `tournaments(game_room_id)`, `user_mappings(iscored_username)` unique, `ranking_groups(game_room_id)`)
- [x] 1.4 CORS Restriction (configurable via `CORS_ORIGIN` env var, wide-open only in dev)
- [x] 1.5 JWT Secret Validation (throws on startup if missing in production)

### Tier 2: Code Quality — COMPLETE
- [x] 2.1 N+1 query optimization (4 fixes: LeaderboardService, TimeoutManager, IdentityManager, eligibility)
- [x] 2.2 Per-tournament maintenance mutex (prevents concurrent maintenance collisions)
- [x] 2.3 Error responses — already consistent
- [x] 2.4 WebSocket double-emit fix + CORS alignment
- [x] 2.5 TournamentForm component extraction (shared fields + useReducer)
- [x] 2.6 Scheduler reload on tournament update — already implemented

### Tier 4: Polish — COMPLETE
- [x] 4.1 Helmet middleware (security headers)
- [x] 4.2 Request correlation IDs (X-Correlation-ID)
- [x] 4.3 Health check improvements (DB/Discord/iScored status + uptime)
- [x] 4.4 Audit logging (audit_log table + auto-logging middleware + admin API)
- [x] 4.5 Database migration versioning (schema_migrations table)

### Testing Foundation — COMPLETE
- [x] Vitest setup (`vitest.config.ts`, `src/__tests__/setup.ts`, `src/__tests__/helpers.ts`)
- [x] Service tests: LeaderboardService (9), TournamentService (5), RankingService (8)
- [x] API route tests: auth + status (8), rooms (10)
- [x] 40 tests, all passing
- [x] DB schema fix: migration columns added to CREATE TABLE for fresh in-memory DBs
- [x] Test files excluded from `tsc` build (vitest handles its own transform)

### Previous
**Multi-Game-Room Architecture** — COMPLETE (merged to main, deployed)

## Multi-Room Architecture Progress

| # | Phase | Status | Notes |
|---|-------|--------|-------|
| 1 | Database Foundation | `done` | 6 new tables, idempotent migration, data backfill |
| 2 | Auth Overhaul | `done` | 3 auth methods, scoped JWT, requireRoomAccess middleware |
| 3 | API Route Restructuring | `done` | Split server.ts into 4 route files, room-scoped services |
| 4 | Frontend Restructuring | `done` | SuperAdminLayout, RoomAdminLayout, RoomContext, new pages |
| 5 | Legacy Alias Fix | `done` | Backward-compat URL rewriting for Discord commands |

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

## Last Session

**Date:** 2026-03-15
**What happened:** Sprint 10 (Production Hardening) — completed Tiers 1, 2, 4, and Testing Foundation. Testing: Vitest with 40 tests (3 service + 2 API route test files), in-memory SQLite, test helpers for room/tournament/game/submission creation. Fixed DB schema issue where migration-added columns weren't in CREATE TABLE statements, causing fresh in-memory DBs to fail on index creation.
**Next:** Discord Bot Multi-Room (Phase 5).

## Blockers

None.
