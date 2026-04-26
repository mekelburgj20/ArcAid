---
status: accepted
date: 2026-04-21
deciders: Justin Mekelburg
supersedes:
superseded-by:
---

# Pin to Scoreboard uses `games.tournament_id IS NULL`

## Context

The v2.4.0 sprint added a long-requested feature: room admins can put a game on the scoreboard without creating a tournament around it. The use case is a casual league running a single ongoing leaderboard for a fixed set of machines, or a venue spotlighting a new machine for the week, without the rotation/scheduling/cleanup machinery that tournaments bring.

Existing data shape constraints:

- `games` rows are the per-tournament instance of a game. Identity = `(tournament_id, name)`; status moves through `ACTIVE` / `COMPLETED` / `LOCKED` etc. on the tournament cycle.
- `submissions.game_id` and `score_history.game_id` foreign-key to `games.id`.
- The scoreboard renders one card per active `games` row. Tournament cards know their tournament via `tournament_id`.
- A previous half-attempt at "pinned games" had left 5 orphan rows on prod (Walking Dead, Spider-Man, Iron Maiden, 24, Game of Thrones) with `tournament_id = NULL` that the broken `/list-active` Discord command exposed. v2.3.3 patched the symptom; v2.4.0 needed a real schema for the feature.

The decision was: do we add a `pinned_games` table parallel to `games`, or do we overload the existing table?

## Decision

A pinned game is a `games` row with `tournament_id IS NULL`. The same scoreboard, leaderboard, and submission code paths handle it; the absence of a tournament is the only structural difference.

Schema:

```sql
ALTER TABLE games ADD COLUMN game_room_id TEXT;
-- backfilled from tournaments.game_room_id for tournament rows;
-- explicitly set on insert for pinned rows.

ALTER TABLE games ADD COLUMN display_order INTEGER;
-- NULL for tournament rows (inherit from tournament);
-- admin-set for pinned rows.

CREATE UNIQUE INDEX idx_games_pinned_unique ON games (game_room_id, LOWER(name))
    WHERE tournament_id IS NULL;
-- prevents double-pinning the same game in the same room;
-- tournament rows are unaffected (the WHERE excludes them).
```

`game_room_id` is a denormalized convention: for tournament rows it always equals `tournament.game_room_id` and is set at insert time and never mutated. For pinned rows it is the canonical owner. No FK constraint enforces it (SQLite ALTER limitations + rooms-rarely-deleted reality); convention is documented in `CLAUDE.md`.

Cascade on unpin is **application-level**, not `ON DELETE CASCADE`:

```ts
// in the unpin handler:
await db.run(`UPDATE submissions SET game_id = NULL WHERE game_id = ?`, gameId);
await db.run(`UPDATE score_history SET game_id = NULL WHERE game_id = ?`, gameId);
await db.run(`UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?`, gameId);
await db.run(`DELETE FROM games WHERE id = ?`, gameId);
```

Score rows survive the unpin with `game_id = NULL`, preserving history when the pinned game goes away. The same pattern is reused by the v2.4.0 orphan cleanup migration (070).

Rankings naturally exclude pinned games because `RankingService.computeRankings` is scoped by `tournament_ids IN (...)` — a pinned row has no tournament so it can't appear in any ranking group's set. Documented as an invariant + asserted in `src/__tests__/pinEndpoint.test.ts`.

Stats services include pinned-game scores in casual metrics (times-played, last-submission, hottest-game) and exclude them from anything tagged "tournament" or "competition." Each call site in `StatsService` was audited explicitly.

### Key files

- `src/database/database.ts` — migrations 073 (`game_room_id`), 074 (unique partial index), 076 (`display_order`)
- `src/engine/gameCreation.ts` — `createGameWithIScoredSync()` shared helper used by both tournament activation and pin creation
- `src/api/routes/rooms.ts` — `POST /:roomId/games/pin`, `DELETE /:roomId/games/pinned/:gameId`
- `src/services/LeaderboardService.ts` — `isPinned: tournament_id === null` in output type, sort uses `COALESCE(g.display_order, t.display_order, 9999)`
- `admin-ui/src/components/scoreboard/{Banner,Showcase,Minimal}Card.tsx` — "Pinned" chip when `isPinned`
- `src/__tests__/pinEndpoint.test.ts` — pin creates `tournament_id=NULL`, unique index rejects double-pin, unpin unlinks scores

## Consequences

- **Easier:** All scoreboard / submission / leaderboard / fan-out code paths handle pinned games for free — they never branched on tournament presence in the first place. The only feature work was admin UI, the partial unique index, the cascade-on-unpin, and the "Pinned" chip. iScored mirroring reuses the existing `createGameWithIScoredSync` helper; pin eligibility piggybacks on the existing ACTIVE-status protection. Score history survives unpin via the cascade-to-NULL pattern that's symmetric with orphan cleanup.
- **Harder:** Anywhere code reads `games` and assumes "tournament-scoped" needs to be audited. We did the audit during the sprint (StatsService entries, ranking exclusion, Discord read commands), but new code must remain aware. The `is_pinned: boolean` derived field in service-layer outputs is the standard way to keep callers explicit.
- **Locked out:** We can't add a tournament-only column to `games` without it being awkwardly nullable for pinned rows. (`max_active_games`, `cron_schedule`, etc., remain on `tournaments` where they belong.) If a future feature needs pinned-only state that doesn't make sense on tournaments, it goes on a side table keyed by `games.id`, not back into `games`.

## Alternatives Considered

- **Separate `pinned_games` table parallel to `games`.** Rejected. Every consumer of `games` (scoreboard query, submission FK, leaderboard ranking, Discord `/list-active`, iScored sync, fan-out) would need to UNION ALL or branch on source. The blast radius would have been ~15 query sites. The whole reason `games` exists is "things on the scoreboard"; pinned games *are* that.
- **Boolean `is_pinned` column on `games` with `tournament_id` left NULL.** Rejected as redundant. `tournament_id IS NULL` is the natural signal — adding `is_pinned` would create two columns that must agree, which is a future-bug magnet.
- **`ON DELETE CASCADE` from `games` to `submissions` / `score_history`.** Rejected. Score history is the user-facing record of "I played this." Losing it when an admin unpins is a data-loss surprise. The cascade-to-NULL pattern keeps the rows; `game_name` and submission timestamps stay queryable via `score_history` joins.
- **Pin a tournament instead — auto-create a never-rotating "pinned" tournament with a single game.** Rejected. The tournament machinery (Scheduler, TimeoutManager, picker slots, max_active_games guards, cron_schedule) is overhead for a feature whose entire point is "no tournament." It would have required null-check guards in every Scheduler/Timeout path to bypass behavior for these synthetic tournaments — exactly the audit cost we'd otherwise pay on `games` consumers, but in a hotter set of files.
