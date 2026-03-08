# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Sprint

**Sprint 2 — Harden**
**Branch:** `sprint-2/harden`
**Goal:** Resilience, security, and code quality. Make iScored integration robust, improve logging, add Docker hardening.

## Sprint Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Retry logic with exponential backoff for IScoredClient | `done` | `withRetry()` wrapper, configurable max attempts |
| 2 | Replace `waitForTimeout` with deterministic waits | `done` | `waitForSelector`, `waitForLoadState('networkidle')` |
| 3 | Persistent browser session (keep login alive) | `done` | `isSessionAlive()` check, reuse existing session |
| 4 | Screenshot-on-failure in IScoredClient | `done` | Saves to `data/playwright-errors/`, auto-created dir |
| 5 | iScored DOM change detection | `done` | Hash comparison on lineup DOM, warns on change |
| 6 | Log rotation (rotating-file-stream) | `done` | Max 10MB/file, daily rotation, keep 5 files |
| 7 | Replace sync fs.appendFileSync with async stream | `done` | Uses `rotating-file-stream` writable stream |
| 8 | Startup environment validation | `done` | `src/utils/startup.ts`, clear messages for missing config |
| 9 | Docker health check | `done` | `HEALTHCHECK` hitting `/api/status` |
| 10 | Docker non-root user | `done` | `arcaid` user + group, `chown` data dir |
| 11 | Service layer (src/services/) | `done` | `SettingsService`, `TournamentService`, `GameLibraryService`, `LogService` |
| 12 | Per-user command cooldowns in Discord | `done` | submit: 30s, pick: 10s, list: 5s via `src/utils/cooldown.ts` |
| 13 | Transaction safety for multi-step commands | `done` | `pickgame.ts` wraps DB ops in BEGIN/COMMIT/ROLLBACK |

**Also completed (Sprint 1 leftovers):**
- Fix inconsistent `tournament_types` format in `game_library` (normalize CSV to JSON array migration)
- Add score validation before iScored submission (positive integer check in `submitscore.ts`)

## Sprint 2 — COMPLETE

All 13 tasks done, plus 2 Sprint 1 leftovers. Ready to commit and merge.

## Upcoming Sprints

| Sprint | Name | Goal |
|--------|------|------|
| Sprint 3 | Redesign | Full frontend overhaul — Tailwind, arcade theme, new pages |
| Sprint 4 | Phase 8 | Internal leaderboard, WebSockets, public scoreboard |

## Last Session

**Date:** 2026-03-08
**What happened:** Completed all Sprint 2 tasks in one session:
- IScoredClient: retry logic, deterministic waits, persistent sessions, screenshot-on-failure, DOM change detection
- Logger: async rotating-file-stream (10MB, 5 files)
- Startup: environment validation with clear messages
- Docker: HEALTHCHECK + non-root `arcaid` user
- Service layer: 4 services extracted from server.ts
- Discord: per-user cooldowns (submit/pick/list), score validation, transaction safety
- DB: tournament_types normalization migration
**Next:** Commit Sprint 2 changes, then begin Sprint 3 (Redesign).

## Blockers

None.
