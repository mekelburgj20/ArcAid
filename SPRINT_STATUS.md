# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Work

**Feature: Ranking Groups** — IN PROGRESS
**Branch:** `feature/ranking-groups`
**Goal:** Cross-tournament overall player rankings with configurable grouping and 4 iScored-compatible ranking methods.

## Feature Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | DB schema (ranking_groups, junction, cache) | `done` | 3 new tables with ON DELETE CASCADE |
| 2 | RankingService (4 ranking methods) | `done` | Max 10, Average Rank, Best Game PAPA, Best Game Linear |
| 3 | API endpoints (CRUD + rankings) | `done` | 8 endpoints, Zod validated |
| 4 | Admin UI management page | `done` | Full CRUD + inline ranking preview |
| 5 | Public scoreboard integration | `done` | Overall Rankings section below game cards |

## Up Next

**Feature: UI Theme System** — PLANNED
**Branch:** `feature/ui-themes` (not started)

## Sprint 9 — ABANDONED (Gemini implementation had critical issues)
## Sprint 8 — COMPLETE
## Sprint 7 — COMPLETE
## Sprint 6 — COMPLETE
## Sprint 5 — COMPLETE
## Sprint 4 — COMPLETE
## Sprint 3 — COMPLETE
## Sprint 2 — COMPLETE
## Sprint 1 — COMPLETE

## Last Session

**Date:** 2026-03-13
**What happened:** Analyzed Gemini's theme branches (feature/per-user-themes, feature/ui-themes) — found critical issues (broken Tailwind v4 @theme, no Zod validation, no service layer, changed default colors). Discarded all changes, deleted stale branches. Started fresh with ranking groups feature.
**Next:** Implement RankingService, API endpoints, Admin UI, and public scoreboard integration.

## Blockers

None.
