# ArcAid — Sprint Status

> This file is the live work-in-progress tracker. Updated every session.
> For the full plan, see OVERHAUL_PLAN.md.
> For the task checklist, see TODO.md.

---

## Current Sprint

**Sprint 4 — Phase 8 (New Features)**
**Branch:** `sprint-4/phase8`
**Goal:** Internal leaderboard, WebSocket real-time events, public scoreboard, player/game stats.

## Sprint Progress

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | Add `scores` table | `done` | Supplements submissions, verified flag |
| 2 | Add `leaderboard_cache` table | `done` | Pre-computed rankings, auto-invalidation |
| 3 | LeaderboardService | `done` | Recalculate, cache, invalidate on new score |
| 4 | StatsService | `done` | Player stats, game stats, all-player overview |
| 5 | Update submitscore.ts | `done` | Writes to scores table, invalidates cache |
| 6 | Update listscores.ts | `done` | Reads from LeaderboardService cache |
| 7 | WebSocket server (Socket.io) | `done` | websocket.ts, attached to Express HTTP server |
| 8 | WebSocket events in TournamentEngine | `done` | game:rotated, picker:assigned |
| 9 | WebSocket events in DiscordClient | `done` | bot:status on connect |
| 10 | API: GET /api/leaderboard | `done` | Active game leaderboards |
| 11 | API: GET /api/stats/player/:id | `done` | Player stats with wins, avg, best |
| 12 | API: GET /api/stats/game/:name | `done` | Game stats with all-time high |
| 13 | API: GET /api/stats/players | `done` | All players overview |
| 14 | Leaderboard page (admin) | `done` | Live WebSocket updates, ranked entries |
| 15 | Stats page (admin) | `done` | Player list, detail view, game lookup |
| 16 | Public Scoreboard (/scoreboard) | `done` | Full-screen, auto-rotate, OBS-ready |

## Sprint 3 — COMPLETE
## Sprint 2 — COMPLETE
## Sprint 1 — COMPLETE

## Upcoming Sprints

| Sprint | Name | Goal |
|--------|------|------|
| Sprint 4 | Phase 8 | Internal leaderboard, WebSockets, public scoreboard |

## Last Session

**Date:** 2026-03-09
**What happened:** Completed Sprint 4. All 16 tasks done: scores + leaderboard_cache tables, LeaderboardService with auto-invalidation, StatsService (player/game analytics), Socket.io WebSocket server with events wired into TournamentEngine + DiscordClient, 4 new API endpoints, Leaderboard + Stats admin pages, public Scoreboard at /scoreboard (full-screen, auto-rotating, OBS-ready). Fixed Tailwind CSS build issue (switched from @tailwindcss/vite to @tailwindcss/postcss for Windows compatibility). Fixed Docker volume permissions.
**Next:** UAT testing, then merge to main. Discord UX improvements (embeds, autocomplete) as stretch goals.

## Blockers

None.
