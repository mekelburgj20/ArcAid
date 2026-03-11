# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Sprint

**Sprint 8 — Public Player Portal** — COMPLETE
**Branch:** `sprint-8/player-portal`
**Goal:** Slug-based public portal routing, shared nav bar, game room branding, setup wizard integration.

## Sprint Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | `GET /api/portal` endpoint | `done` | Returns `{ slug, name }` from settings (no auth) |
| 2 | `GAME_ROOM_NAME` / `GAME_ROOM_SLUG` settings | `done` | Stored in settings table |
| 3 | Setup Wizard: Game Room step | `done` | Step 2 (4 steps now), auto-generates slug from name |
| 4 | Settings: Game Room category | `done` | Editable name + slug in Admin Settings |
| 5 | `PublicLayout` component | `done` | Shared nav bar with game room branding |
| 6 | Slug-based routing (`/:slug/*`) | `done` | Scoreboard, Players, PlayerDetail, GameDetail |
| 7 | Legacy route redirects | `done` | `/scoreboard`, `/players/*`, `/games/*` → slug paths |
| 8 | Public pages updated | `done` | Removed standalone headers/scanlines, use slug links |
| 9 | Activate Game (admin) | `done` | API + Discord `/activate-game` + UI modal in Game Library |
| 10 | Deactivate Game | `done` | API + Discord `/deactivate-game` + UI in Tournaments |
| 11 | Multiple active games per tournament | `done` | `activateGame(completeExisting=false)` for admin use |
| 12 | Create Backup button | `done` | `POST /api/backups` + UI button on Backups page |
| 13 | Active Games list | `done` | `GET /api/games/active` + card in Tournaments page |
| 14 | Platform filter in Game Library | `done` | Toggleable platform chips, "Clear" button |
| 15 | VPS auto-import | `done` | `POST /api/game_library/import-vps` fetches vpsdb.json, maps platforms |
| 16 | 5-star rating system | `done` | `game_ratings` table, per-user ratings, community averages, StarRating component |
| 17 | ArcAid logo | `done` | Login, admin sidebar, public nav bar, favicon |
| 18 | Mobile responsive | `done` | Hamburger sidebar, responsive grids/cards/tables, overflow-safe |
| 19 | Bug fixes | `done` | ScoreDisplay null crash, crypto.randomUUID fallback for non-HTTPS |
| 20 | Docker rebuild and testing | `done` | All features verified in container |

## Sprint 8 — COMPLETE
## Sprint 7 — COMPLETE
## Sprint 6 — COMPLETE
## Sprint 5 — COMPLETE
## Sprint 4 — COMPLETE
## Sprint 3 — COMPLETE
## Sprint 2 — COMPLETE
## Sprint 1 — COMPLETE

## Last Session

**Date:** 2026-03-10
**What happened:** Sprint 8 complete. Public player portal with slug-based routing, shared nav bar, game room branding. Activate/deactivate game (admin API + Discord + UI). Create backup button. Platform filter, VPS auto-import, 5-star rating system. ArcAid logo added (login, sidebar, public nav, favicon). Full mobile-responsive overhaul: hamburger sidebar, responsive grids/cards/tables. Fixed ScoreDisplay null crash and crypto.randomUUID fallback for non-HTTPS contexts.
**Next:** Sprint 9 planning.

## Blockers

None.
