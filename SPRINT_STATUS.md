# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Work

**Features: Ranking Groups + UI Themes** — COMPLETE (merged to main)

## Feature Progress — Ranking Groups

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | DB schema (ranking_groups, junction, cache) | `done` | 3 new tables with ON DELETE CASCADE |
| 2 | RankingService (4 ranking methods) | `done` | Max 10, Average Rank, Best Game PAPA, Best Game Linear |
| 3 | API endpoints (CRUD + rankings) | `done` | 8 endpoints, Zod validated |
| 4 | Admin UI management page | `done` | Full CRUD + inline ranking preview |
| 5 | Public scoreboard integration | `done` | Overall Rankings section below game cards |

## Feature Progress — UI Theme System

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | CSS variable theme system | `done` | Original @theme static, overrides via .theme-dark/.theme-light classes |
| 2 | 3 themes (Arcade, Dark, Light) | `done` | daisyUI oklch values mapped to ArcAid semantic tokens |
| 3 | user_preferences table + PreferencesService | `done` | Zod-validated, works for password + Discord auth |
| 4 | API endpoints (GET/POST /me/preferences) | `done` | Per-user theme, UI_THEME global setting, portal endpoint |
| 5 | ThemeProvider + Settings UI | `done` | localStorage first (no flash), global + personal selectors |
| 6 | Light theme adjustments | `done` | Scanlines hidden, glow effects softened |

## Bug Fix

- **TournamentEngine: no-queued-game timeout gap** — When maintenance ran with no QUEUED game, no picker slot was created, so TimeoutManager never triggered auto-selection. Fixed by always creating a QUEUED slot for timeout tracking.

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

**Date:** 2026-03-14
**What happened:** Merged ranking groups and UI theme features. Fixed critical bug in TournamentEngine where maintenance with no QUEUED game failed to create a picker slot, preventing TimeoutManager auto-selection and leaving tournaments dormant.
**Next:** Deploy, monitor DG tournaments for correct auto-selection behavior.

## Blockers

None.
