# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Sprint

**Sprint 1 — Stabilize**
**Branch:** `sprint-1/stabilize`
**Goal:** Fix all critical bugs. Get the core maintenance loop working end-to-end.

## Sprint Progress

| # | Task | Status | Branch/Notes |
|---|------|--------|--------------|
| 1 | BUG-01: API client module (fix hardcoded localhost) | `done` | `admin-ui/src/lib/api.ts` + all pages wired |
| 2 | BUG-04: API authentication middleware | `done` | JWT + bcrypt in `src/api/auth.ts`, middleware in `src/api/middleware.ts` |
| 3 | BUG-05: Replace `process.exit()` with graceful reload | `done` | `serverEvents` emitter in `src/api/server.ts`, listener in `src/index.ts` |
| 4 | DB indexes + configurable settings | `done` | 5 indexes, default settings seeding, `created_at` columns |
| 5 | Zod validation on all API endpoints | `done` | `src/api/schemas.ts`, validated on all write endpoints |
| 6 | BUG-02: Implement full `runMaintenance()` | `done` | 4-phase maintenance: lock → scrape → complete → activate → assign picker |
| 7 | BUG-03: TimeoutManager runner-up + auto-select | `done` | Tiered timeouts, pivotToRunnerUp, fallbackToAutoSelection, wired into Scheduler |
| 8 | Fix temp photo file leak in `/submit-score` | `done` | try/finally for temp file + browser session cleanup |

## Sprint 1 — COMPLETE

All 8 tasks done. Ready to merge `sprint-1/stabilize` to `main` and begin Sprint 2.

## Upcoming Sprints

| Sprint | Name | Goal |
|--------|------|------|
| Sprint 2 | Harden | Retry logic, Playwright resilience, log rotation, security |
| Sprint 3 | Redesign | Full frontend overhaul — Tailwind, arcade theme, new pages |
| Sprint 4 | Phase 8 | Internal leaderboard, WebSockets, public scoreboard |

## Last Session

**Date:** 2026-03-08
**What happened:** Completed all Sprint 1 tasks. BUG-03 (TimeoutManager tiered timeouts + Scheduler wiring), admin-ui API client wiring, and submit-score temp file fix all committed. Build is clean.
**Next:** Merge sprint-1/stabilize to main, then begin Sprint 2 (Harden).

## Blockers

None.
