# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Sprint

**Sprint 5 — Discord UX + Player Portal**
**Branch:** `sprint-5/discord-ux`, `sprint-5/player-portal`
**Goal:** Discord UX improvements + public player portal.

## Sprint Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Consistent embed design | `done` | Color per tournament type, sendChannelEmbed utility |
| 2 | `/pick-game` autocomplete | `done` | Shows eligibility status in option labels |
| 3 | `/list-scores` enhancements | `done` | `@user` filter, pagination, medal icons |
| 4 | `/view-stats` improvements | `done` | Autocomplete, unique players, Discord mention for record holder |
| 5 | `/setup` expansion | `done` | Subcommands: terminology, announcement-channel, admin-role, pick-windows, view |
| 6 | `/my-stats` Discord command | `done` | Personal stats card (wins, win%, avg, best, recent) |
| 7 | Public `/players` page | `done` | Searchable player list, ranked by best score |
| 8 | Public `/players/:id` page | `done` | Player profile: stat cards, recent scores, game links |
| 9 | Public `/games/:name` page | `done` | Game profile: stats, record holder, recent results |

## Sprint 4 — COMPLETE
## Sprint 3 — COMPLETE
## Sprint 2 — COMPLETE
## Sprint 1 — COMPLETE

## Last Session

**Date:** 2026-03-09
**What happened:** Completed Sprint 5. Discord UX: embeds with tournament-type colors, /pick-game eligibility autocomplete, /list-scores @user + pagination, /view-stats autocomplete + record holder mention, /setup subcommands. Player Portal: /my-stats Discord command, public /players page (searchable list), /players/:id (profile with stat cards + recent scores), /games/:name (game stats + record holder + recent results). All public pages bypass auth.
**Next:** UAT testing, Docker rebuild.

## Blockers

None.
