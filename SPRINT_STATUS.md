# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Sprint

**Sprint 7 — Platform & Mode System** — IN PROGRESS
**Branch:** `sprint-2/harden` (continuation)
**Goal:** Per-tournament mode (pinball/videogame), platform rules, game mode, terminology per tournament.

## Sprint Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Per-tournament mode (`pinball`/`videogame`) | `done` | Replaces server-wide `TERMINOLOGY_MODE` |
| 2 | Per-game mode field | `done` | Single mode per game library entry |
| 3 | Platform master list in settings | `done` | JSON array, seeded with `["AtGames","VPXS","VR","IRL"]` |
| 4 | Platform rules per tournament | `done` | `required`/`excluded`/`restrictedText` fields |
| 5 | Platform-aware game filtering | `done` | pick-game autocomplete + TimeoutManager auto-select |
| 6 | Per-tournament terminology | `done` | `getTerminology(mode)` — pinball=Table/Grind, videogame=Game/Tournament |
| 7 | Admin UI: Game Library mode + platforms | `done` | Mode filter toggles, edit modal, platform chips |
| 8 | Admin UI: Tournament platform rules editor | `done` | Toggle buttons for required/excluded per platform |
| 9 | Admin UI: Settings platforms editor | `done` | Add/rename/remove platforms from master list |
| 10 | Admin UI: Setup wizard simplified | `done` | Removed terminology step (3 steps now) |
| 11 | DB migrations | `done` | `mode`, `platform_rules`, `platforms` columns added |
| 12 | Remove TERMINOLOGY_MODE | `done` | Removed from settings categories, server.ts, setup command |

## Sprint 6 — COMPLETE
## Sprint 5 — COMPLETE
## Sprint 4 — COMPLETE
## Sprint 3 — COMPLETE
## Sprint 2 — COMPLETE
## Sprint 1 — COMPLETE

## Last Session

**Date:** 2026-03-09
**What happened:** Implemented full platform & mode system. Added per-tournament mode (pinball/videogame) replacing server-wide TERMINOLOGY_MODE. Added platform rules (required/excluded/restrictedText) per tournament. Game library entries now have a single mode and platforms field. pick-game filtering and TimeoutManager auto-select respect mode + platform rules. Admin UI updated: Game Library has mode filter toggles and edit modal, Tournaments has PlatformRulesEditor, Settings has Platforms master list editor, SetupWizard simplified to 3 steps.
**Next:** Sprint 8 — Public Player Portal (game room slug routing, public nav, setup wizard integration).

## Blockers

None.
