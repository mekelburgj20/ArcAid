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
| 1 | BUG-01: API client module (fix hardcoded localhost) | `todo` | Frontend only — `admin-ui/src/lib/api.ts` |
| 2 | BUG-04: API authentication middleware | `todo` | Backend only — `src/api/` |
| 3 | BUG-05: Replace `process.exit()` with graceful reload | `todo` | `src/index.ts`, `src/api/server.ts` |
| 4 | DB indexes + configurable settings | `todo` | `src/database/database.ts` |
| 5 | Zod validation on all API endpoints | `todo` | `src/api/server.ts` |
| 6 | BUG-02: Implement full `runMaintenance()` | `todo` | `src/engine/TournamentEngine.ts` + iScored + Discord |
| 7 | BUG-03: TimeoutManager runner-up + auto-select | `todo` | `src/engine/TimeoutManager.ts` |
| 8 | Fix temp photo file leak in `/submit-score` | `todo` | `src/discord/commands/submitscore.ts` |

## Upcoming Sprints

| Sprint | Name | Goal |
|--------|------|------|
| Sprint 2 | Harden | Retry logic, Playwright resilience, log rotation, security |
| Sprint 3 | Redesign | Full frontend overhaul — Tailwind, arcade theme, new pages |
| Sprint 4 | Phase 8 | Internal leaderboard, WebSockets, public scoreboard |

## Last Session

**Date:** 2026-03-08
**What happened:** Plan approved. Set up branch strategy, state tracking files, and memory. Sprint 1 ready to begin.
**Next:** Begin Sprint 1 — run parallel agents for tasks 1–4, then tackle BUG-02/03 in main thread.

## Blockers

None.
