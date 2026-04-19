# ArcAid v2.1.0 — Score-history tournament scoring, multi-score view, Stats Combo

**Released:** 2026-04-18
**Baseline:** v2.0.3 (commit `cafd836e`)

First **minor** bump. Three net-new capabilities that together reframe how scores are recorded, displayed, and summarized.

## 1. Tournament leaderboards read `score_history`

**Problem.** Before v2.1.0, tournament card leaderboards read from `submissions`, which stores only the best-ever score per (game, user). During a tournament window, a player might legitimately submit a score below their all-time personal best — it's still their best *this tournament*. The old model silently dropped that submission from the Tournament card, because it didn't exceed the previous personal best row in `submissions`.

**Fix.** `LeaderboardService.recalculate()` now reads from `score_history` filtered by `submitted_during_tournament_id = <this tournament>` + `game_name` match. Best-per-player within the tournament window wins, regardless of all-time personal best. ROW_NUMBER() keeps the winning row's photo + discord_user_id.

Dual-write preserved: every submission still writes `submissions` + `community_scores` for back-compat with anything still reading those tables directly (Stats, Rankings, etc.). The tournament card is the only read site that switches.

**Supporting plumbing.** `ScoreHistoryService.log()` now auto-resolves `submitted_during_tournament_id` by querying the active tournament game for the room+game name at log time. Only populated when the game is `ACTIVE` — once `COMPLETED`, the tournament window is closed and new submissions don't count toward it. Callers don't need to pass `tournamentId` explicitly.

**Backfill.** Migration 063 walks existing `score_history` rows with `game_id` set but `submitted_during_tournament_id` NULL and backfills from the games→tournaments join. Rows without `game_id` (community-only submissions) stay null — they weren't tournament-scoped anyway. Cache truncated so the new SQL runs on next read.

## 2. Multi-score inline expand on leaderboards

**Click a username on the Game Detail leaderboard → inline expand.**

- Small sparkline of all of that player's submissions for this game, chronological, so improvement is visible at a glance.
- When any score links to an active tournament, the list splits into **"This tournament"** (filtered to `submitted_during_tournament_id = <active>`) and **"All time"** (everything else). Makes the tournament-vs-personal-best distinction explicit.
- Each row shows: score, source pill (tournament / community / sync), proof-photo link when present, date.
- Backend: `ScoreHistoryService.getPlayerGameHistory()` now joins tournaments + returns `tournament_id`, `tournament_name`, `tournament_active`. Same endpoint (`GET /:roomId/score-history/:gameName/player/:identifier`) — richer payload.

## 3. Stats page Combo redesign

**Top of `/:slug/stats`:** 4-card overview row giving a quick pulse of the room's last 7 days:

- **Plays this week** — total `score_history` rows in the last 7 days (sub: player count)
- **Active players** — distinct `iscored_username` in the last 7 days
- **Hottest game** — game with most submissions last 7 days
- **Latest** — the most recent submission (score + player + relative time)

Below the cards, the existing **Players / Games** tabs stay (URL state `?view=players|games` unchanged), plus a one-line purpose statement: *"How this room's doing. Pulse of the week above; drill into players and games below."*

**New backend:** `GET /:roomId/stats/overview` returning the 4 metrics. All computed off `score_history` so tournament + community + sync submissions all count uniformly.

## Schema

- Migration **063** — `score_history` backfill of `submitted_during_tournament_id` + `leaderboard_cache` truncation. Idempotent.

## Files touched

- `src/services/LeaderboardService.ts` — read path shifted to score_history
- `src/services/ScoreHistoryService.ts` — auto-resolves tournament context on write; richer per-player history query
- `src/services/StatsService.ts` — new `getRoomOverview()` method
- `src/api/routes/rooms.ts` — new `/stats/overview` endpoint
- `src/__tests__/helpers.ts` + `src/__tests__/LeaderboardService.test.ts` — helper now dual-writes submissions + score_history; one test refactored to rely on it
- `src/database/database.ts` — migration 063
- `admin-ui/src/pages/PublicStats.tsx` — overview row + purpose statement + `OverviewCard`
- `admin-ui/src/pages/GameDetail.tsx` — leaderboard expand split with sparkline + tournament/all-time grouping + `ScoreHistoryRow`

## Upgrade notes

Drop-in. Migration 063 runs once on startup (backfill + cache flush). No config changes.

## Rollback

Previous tag: `cafd836e`. Migration 063's backfill writes `submitted_during_tournament_id` onto existing rows but rollback code still works against them — the column existed before v2.1.0 (added Sprint 1). The only behavior difference on rollback: tournament leaderboards go back to reading `submissions` (all-time bests). The populated `submitted_during_tournament_id` values stay (harmless).
