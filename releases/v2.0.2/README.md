# ArcAid v2.0.2 — Tournament card routing hotfix

**Released:** 2026-04-18
**Baseline:** v2.0.1 (commit `a9e24b39`)

One-line-data hotfix.

## Fix

**Tournament card title navigated to the wrong URL.**

Clicking a game title in the Scoreboard **Tournaments** tab landed on the room-scoped detail page (`/:slug/games/:name`), while clicking the same game in the **All Games** tab landed on the global catalogue detail (`/games/:globalGameId?from=:slug`). Per Sprint 3 §10 the title should always prefer the shared detail when globally mapped.

Root cause: `LeaderboardService.getActiveLeaderboards()` wasn't selecting `global_game_id`, so the frontend's `linkForTournamentCard` always hit the fallback branch for room-scoped URLs.

Fix: the active + retained-completed games queries now `COALESCE(g.global_game_id, gl.global_game_id) as global_game_id` and include it in the result row. Frontend routing picks up the new field automatically — no client-side changes required.

## Files touched

- `src/services/LeaderboardService.ts` (SELECT + result mapping)

No schema changes. No cache bust required (the field comes from the fresh JOIN, not the cached rankings).

## Upgrade

Drop-in. Redeploy image.

## Rollback

Previous tag: `a9e24b39`. Reverting the image reverts to the pre-fix behavior; no schema or cache artifact to undo.
