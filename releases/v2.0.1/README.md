# ArcAid v2.0.1 — Smoke-test follow-ups

**Released:** 2026-04-18
**Baseline:** v2.0.0 (commit `595d9b0f`)
**Verification:** `tmp/manual-test-playbook-v2.0.1.md`

Patch release covering the 7 issues surfaced in v2.0.0 manual testing. Focus: privacy correctness (anon avatar leak), OAuth-cancel resilience, unified submission across remaining surfaces, and shareable Mystery Award URL.

## Fixes

### 1. Avatar leak for anonymous submissions (**privacy regression, highest priority**)
`LeaderboardService`, `GlobalLeaderboardService`, `RankingService`, and the `/api/global/scores-recent` endpoint all had a `LEFT JOIN user_mappings` username-fallback that matched rows tagged `COMMUNITY`/`ANON` to existing user_mappings by case-insensitive username. A guest submission using a name that happened to match an existing Discord user's nickname (e.g. the viewer's own name from a prior OAuth session) inherited that user's avatar on the leaderboard. Fixed: the fallback is now limited to `iscored:*`-prefixed rows (legitimate iScored-sync attribution), never `COMMUNITY`/`ANON`. Migration 062 flushes both cached leaderboards once so clients don't keep rendering stale pre-fix attribution.

### 2. OAuth-cancel detection when Discord's X is clicked
Discord's consent screen doesn't always surface a Cancel button, and the X that closes the tab doesn't redirect back with `error=access_denied`. `PendingSubmissionWatcher` now also watches the implicit case — user returns to the origin URL with sessionStorage draft intact but no `?submit-draft=` or `?submit-cancelled=` query param. After an 800ms settling delay it surfaces the "Submit as guest?" modal instead of letting the draft silently expire via the 5-min TTL.

### 3. Room GameDetail Community tab uses SubmissionSheet
`/:slug/games/:name` → Community tab had its own inline submit form with no photo upload and a failure on every submission (sending JSON to a multipart endpoint). Replaced with the unified `SubmissionSheet` — photo upload works, anon-claim prompt fires, login gate enforced upfront when the room requires it, OAuth-draft resume lands correctly.

### 4. Immediate login gate for REQUIRE_DISCORD_LOGIN
`SubmissionSheet` gained a `requireLogin` prop. When true + the viewer has no player token + target isn't global, the sheet opens in a new `loginRequired` phase instead of the form — a small dialog explaining that the room requires login with a one-click "Log in with Discord" CTA. Saves users from typing name + score + photo only to be rejected server-side. Callers (Scoreboard, GamesTabView, GameDetail, GlobalGameDetail when `?from=<slug>`) pass the flag from `REQUIRE_DISCORD_LOGIN` config.

### 5. Global GameDetail respects room context for Submit
`/games/:id?from=<slug>` previously forced Discord OAuth on Submit even when the originating room didn't require login. Now resolves the `from` slug to the room's `id` + `REQUIRE_DISCORD_LOGIN` on mount and uses a `freeplay` target scoped to that room. Direct Global Scoreboard submissions (no `?from=`) still require Discord login by design.

### 6. Internal CATALOGUE / COMMUNITY labels no longer surface
`tournamentName: 'Catalogue'` / `'Community'` were leaking onto card labels for rows that have no meaningful tournament context. Now empty strings at the source (`catalogueToLeaderboard`, `community-leaderboards` endpoint) and all card templates (Banner / Minimal / Showcase / legacy ScoreboardComponents) hide the label when empty instead of rendering an ugly blank badge.

### 7. Mystery Award — direct URL + login hint
New route `/:slug/mystery-award` renders the Mystery Award full-screen as a standalone, shareable page. Fetches the active tournament's available-games list, wires the existing MysteryAward component, respects `ENABLE_GAME_PICK_AWARD` (redirects to scoreboard if off). Unauthenticated viewers see a "Log in to queue" CTA in the header and an inline "Log in to queue this game" hint next to the winner instead of the missing Add-to-Queue button. Share this URL in Discord for a drop-in randomizer.

## Schema

Migration 062 — `leaderboard_cache` + `global_leaderboard_cache` truncation. One-shot. Idempotent. No column changes.

## Files touched

- Backend: `src/services/LeaderboardService.ts`, `src/services/GlobalLeaderboardService.ts`, `src/services/RankingService.ts`, `src/api/routes/global.ts`, `src/api/routes/rooms.ts`, `src/database/database.ts`
- Frontend: `src/components/SubmissionSheet.tsx`, `src/components/PendingSubmissionWatcher.tsx`, `src/components/MysteryAward.tsx`, `src/components/GamesTabView.tsx`, `src/components/ScoreboardComponents.tsx`, `src/components/scoreboard/BannerCard.tsx`, `src/components/scoreboard/MinimalCard.tsx`, `src/components/scoreboard/ShowcaseCard.tsx`, `src/pages/Scoreboard.tsx`, `src/pages/GameDetail.tsx`, `src/pages/GlobalGameDetail.tsx`, `src/pages/MysteryAwardPage.tsx` (new), `src/App.tsx`

## Deferred to a future release

- **Stats page rework** — you flagged Players vs Games as needing a dedicated sprint to clarify purpose. Not touched here.
- **All Games search includes tournament-only games** — e.g. "Battle Deluxe (Combat Deluxe)" on Tournaments tab but missing from All Games search. Root cause is data: the game isn't in `global_games`. Options: auto-upsert tournament games to global catalogue, or extend All Games query to union with room `game_library`. Needs a decision.
- **Unify room vs global GameDetail pages** — currently two pages (`/:slug/games/:name` and `/games/:id`). v2.0.0 plan canonicalized the global one; room-scoped stays as fallback for games with no global mapping. Full consolidation is a design decision, not a bug.

## Upgrade notes

1. Bring up the new image — migration 062 runs on startup, idempotent.
2. Caches get flushed once; first hits on Scoreboard + Global Scoreboard trigger a recompute. No visible latency.
3. No env-var changes.

## Rollback

Previous tag: `595d9b0f`. Migration 062 is non-destructive. Reverting the image doesn't require rolling back the schema (caches will simply rebuild with the older code's output).
