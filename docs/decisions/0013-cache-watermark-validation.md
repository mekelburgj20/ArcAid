---
status: accepted
date: 2026-05-02
deciders: mekelburgj
supersedes:
superseded-by:
---

# Cache validation via data watermark (no manual `invalidate()` calls in mutation paths)

## Context

`ranking_groups_cache` (introduced pre-v2.0) stores precomputed `OverallRanking[]` JSON keyed by `ranking_group_id`. `RankingService.computeRankings(groupId)` is expensive enough (~50-200ms for a typical 5-tournament group) that recomputing on every page view isn't viable. The cache pattern that shipped was: callers explicitly call `RankingService.invalidate(groupId)` or `invalidateAll()` after any data change, and `getRankings(groupId)` reads the cache row blindly.

The pattern broke down because the surface area of "actions that affect rankings" is much larger than the surface area of "code paths that remembered to invalidate." As of pre-v2.10.1, only **two** call sites invalidated:

- `RankingService.update()` (the service itself, when a group's config changed — `best_n`, `rank_method`, `tournament_ids`)
- Discord `/submit-score` command (line 245 of `submitscore.ts`)
- Plus the manual admin "Recompute" button (`POST /:roomId/admin/ranking-groups/:id/recompute`)

Every other code path that mutates underlying ranking data silently skipped invalidation:

- Web score submissions (`/submit-score`, `/freeplay-score`, `/community-scores`)
- v2.9.0 per-row score deletes (`DELETE /api/rooms/:roomId/score-history/:historyId`)
- v2.9.0 admin "wipe player from game" (`DELETE /admin/games/:gameId/submissions/:submissionId`)
- `TournamentEngine.deactivateGame` (status: ACTIVE → COMPLETED)
- `TournamentEngine.deleteGameCompletely`
- `TournamentEngine.runCleanup` (status: COMPLETED → HIDDEN)
- `ScoreSyncPoller.pollOneAccount` (every iScored sync that lands a new score)
- `gameCreation.pinGameToScoreboard` / `unpinGameFromScoreboard`

`computeRankings` filters games via `WHERE status IN ('ACTIVE', 'COMPLETED')`. When Wed maintenance flipped a game to `HIDDEN`, the live computation correctly dropped that game's contribution to ranking points — but the *cached* snapshot still reflected pre-maintenance state. The page showed stale points and standings until someone manually clicked Recompute.

The user (operator) reported the symptom as "I had stale values after maintenance and after manually deleting games" and asked for the long-term robust fix.

The diagnosis identified four candidate approaches: application-level invalidation hooks at every mutation site, SQLite triggers, compute-on-every-read, and a data-watermark pattern. The user explicitly opted for the most robust option, with the framing "What is the best long-term, robust, resilient method? That's what I want implemented."

## Decision

Add a `data_watermark TEXT` column to `ranking_groups_cache` (migration 097). The cache stores a **fingerprint of the underlying data state** at compute time. Every read recomputes the fingerprint cheaply; if it differs from the stored snapshot, the cache silently recomputes. **No code path that mutates score/game data calls `RankingService.invalidate*()`** — the data tells us when the cache is stale.

### Schema (migration 097)

```sql
ALTER TABLE ranking_groups_cache ADD COLUMN data_watermark TEXT;
```

Existing cache rows have `NULL` watermarks. `getRankings` treats NULL as "always stale" (the comparison `currentWatermark === null` is false), so the first read after deploy unconditionally recomputes — exactly the behavior we want for migration.

### Watermark composition

`RankingService.computeDataWatermark(group)` runs one round-trip with five sub-queries against indexed columns:

```sql
SELECT
    (SELECT COUNT(*) FROM games
     WHERE tournament_id IN (?, …)
       AND status IN ('ACTIVE', 'COMPLETED'))           AS eligible_games,
    (SELECT COUNT(*) FROM submissions
     WHERE orphaned_at IS NULL
       AND game_id IN (
         SELECT id FROM games
         WHERE tournament_id IN (?, …)
           AND status IN ('ACTIVE', 'COMPLETED')
       ))                                                AS score_count,
    (SELECT COALESCE(SUM(score), 0) FROM submissions
     WHERE orphaned_at IS NULL
       AND game_id IN (…))                              AS score_sum,
    (SELECT COALESCE(MAX(end_date), '') FROM games
     WHERE tournament_id IN (?, …))                     AS max_game_end,
    (SELECT COALESCE(MAX(start_date), '') FROM games
     WHERE tournament_id IN (?, …))                     AS max_game_start
```

The result is joined with `:` into a single string: `"3:147:2189550000:2026-05-02T03:00:00.000Z:2026-05-02T18:09:22.025Z"`. Stored verbatim in `data_watermark` alongside `rankings` JSON.

Each sub-query exists for a specific class of mutation:

| Component | Captures |
|---|---|
| `eligible_games` (status filter) | maintenance hiding games (ACTIVE/COMPLETED → HIDDEN), new games activating, status flips in either direction |
| `score_count` (non-orphaned, in eligible games) | inserts (rises), deletes (drops), `orphaned_at` flips (drops/rises) |
| `score_sum` | inserts (sum rises), deletes (drops), upsert-to-higher-value (rises). The only mutation it can't detect is an upsert that lands the **same** value as before — which is a no-op anyway |
| `MAX(games.end_date)` | game completions (status flip to COMPLETED writes `end_date`) |
| `MAX(games.start_date)` | game activations (auto-pick / manual / queue rotation; all write `start_date`) |

Cost: sub-10ms over indexed columns for a typical group. The full `computeRankings` is ~50-200ms — the watermark is a small fraction even on every read.

### Read path

```ts
static async getRankings(groupId): Promise<OverallRanking[]> {
    const cached = await db.get(
        'SELECT rankings, data_watermark FROM ranking_groups_cache WHERE ranking_group_id = ?',
        groupId,
    );
    if (cached && cached.data_watermark) {
        const group = await this.getById(groupId);
        if (group) {
            const currentWatermark = await this.computeDataWatermark(group);
            if (currentWatermark === cached.data_watermark) {
                return JSON.parse(cached.rankings);
            }
        }
    }
    return await this.computeRankings(groupId);
}
```

### Write path

`computeRankings` is unchanged in behavior except for the cache write — it now persists the watermark snapshot:

```ts
const watermark = await this.computeDataWatermark(group);
await db.run(
    `INSERT OR REPLACE INTO ranking_groups_cache
     (ranking_group_id, rankings, generated_at, data_watermark)
     VALUES (?, ?, ?, ?)`,
    groupId, JSON.stringify(results), new Date().toISOString(), watermark,
);
```

### Retained explicit invalidations

Two narrow cases still call `RankingService.invalidate*()` directly:

- **`RankingService.update()`** — when a group's config changes (`best_n`, `rank_method`, `tournament_ids`), the data watermark wouldn't capture the shift (config lives in the `ranking_groups` table, not the data tables the watermark probes). Direct invalidate is correct here.
- **The manual admin "Recompute" button** (`POST /:roomId/admin/ranking-groups/:id/recompute`). Retained as a diagnostic escape hatch — no longer load-bearing for routine operation, but useful if the watermark itself ever has a bug, or if an operator wants to force-refresh for any reason. Drops to a one-line `invalidate(groupId)` + recompute.

### Removed redundant invalidation

Discord `/submit-score`'s `RankingService.invalidateAll()` call was removed. Pre-fix it nuked **every** group's cache on every Discord submit, even groups that didn't include the affected tournament. Watermark recomputes only the groups whose data actually changed.

## Consequences

- **Easier:** Adding a new score-mutation endpoint requires zero ranking-related awareness. The data tells `RankingService` when it's stale.
- **Easier:** The user-reported symptom (stale rankings after maintenance / after manual deletes) is solved by a single class of fix that catches all four current code-path families (web submits, deletes, status flips, sync).
- **Easier:** Selective recompute. Pre-fix Discord-submit's `invalidateAll()` blew every group's cache; now each group's cache only recomputes when its own data changes. For a deployment with multiple ranking groups across multiple rooms, the savings are linear in `(number of groups)`.
- **Easier:** Test coverage matches the design. The new tests in `RankingService.test.ts` exercise data mutations directly (insert score, flip status, delete row) and assert that `getRankings` reflects the change without anyone calling `invalidate()`. If the watermark logic regresses, the tests fail.
- **Harder:** Every read pays the watermark query cost. ~5-10ms over indexed columns vs. zero for the pre-fix "blind cache read." Negligible for the read patterns this codebase has (rankings are not on hot paths like score submission), but worth noting if a future feature drives ranking reads to thousands per second.
- **Harder:** The watermark is a *fingerprint*, not a *truth*. There exists a class of mutation that doesn't change any of the five sub-queries — most importantly, an upsert in `submissions` that lands the *same value* (e.g. `score = MAX(score, excluded.score)` where the new score is identical to the existing one). This is correctly classified as a no-op (the cache is still accurate after such an upsert), but a future contributor who *means* to make a meaningful change must be aware that the watermark might not detect it. None of the current code paths exhibit this — every score change either inserts, deletes, or strictly increases a score.
- **Harder:** Display-name updates (`user_profiles.display_name` change) don't invalidate the cache. The cached `OverallRanking[]` carries display names; if a user changes theirs, the rankings page shows the old name until the next data-mutation forces a recompute. Acceptable: name-change frequency is low, ranking pages aren't a primary identity surface, and including `user_profiles` in the watermark would add a JOIN per read for negligible UX benefit.
- **Locked out:** Cannot extend the cache to include data the watermark can't fingerprint cheaply. If a future feature wants the cache to include something derived from non-indexed table columns, the watermark would need a different shape (or a hybrid approach). For the current scope (rankings derived from `games` + `submissions`), the five-tuple is sufficient.

## Alternatives Considered

- **Application-level invalidation hooks at every mutation site (~7 fan-out points).** The straightforward fix: add `RankingService.invalidateForTournament(tournamentId)` calls at every score-mutation point. Rejected because it puts the forgetfulness back on every future contributor. The original bug was *exactly this pattern* — an invalidation hook was the design and people kept forgetting to call it. The robustness goal is to make the bug impossible-by-construction, not just patched in current code.
- **SQLite triggers on `submissions` / `score_history` / `games`.** A trigger that runs `DELETE FROM ranking_groups_cache` on every relevant write would catch every mutation at the storage layer. Rejected because (a) SQLite triggers are opaque — they don't show up in application logs, they're hard to disable for tests/migrations, they fire on every batch operation including bulk imports we don't want to invalidate against; (b) cross-table conditional logic in trigger SQL is ugly (we only want to invalidate caches whose group includes the affected tournament — the trigger would need to look that up); (c) this codebase's debugging culture is "read the JS, log liberally" — pushing logic into triggers fights that.
- **Compute-on-every-read (no cache).** Drop `ranking_groups_cache` entirely. ~50-200ms per read. Rejected because (a) the public scoreboard polls rankings on a regular cadence — repeatedly paying 100ms+ for unchanged data is wasteful; (b) `computeRankings` does N per-game queries (one per eligible game) which scales with the size of the group's tournaments; for a fully-populated group with 100+ historical games, the cost grows; (c) the cache is correct as a design — the failure was the invalidation pattern, not the caching.
- **Version counter on writes.** A single counter row that mutation paths increment; `getRankings` compares the cached counter to the current. Rejected for the same reason as application-level hooks: every mutation site still has to remember to increment. The counter is a smaller surface than the cache itself, but the forgetfulness problem is identical. The watermark eliminates the increment step entirely.
- **Hybrid: short TTL + watermark.** Short TTL (e.g. 30s) bypass — if cache is younger than TTL, return without checking watermark. Past TTL, run watermark check. Considered as an optimization to avoid the watermark query on hot reads. Rejected as premature: the watermark cost is sub-10ms, and adding TTL-vs-fresh logic complicates the read path for no measured benefit. Easy to add later if read volume becomes a problem.
- **Per-tournament invalidation hook + safety-net cron.** Hourly `invalidateAll()` cron as a safety net for missed paths. Rejected because the cron doesn't fix the fundamental architecture — it just bounds staleness to one hour. The user's framing was explicit: forgetfulness is the root cause, not slow recovery.

## Notes

- The watermark format is `${eligible_games}:${score_count}:${score_sum}:${max_game_end}:${max_game_start}`. Plain string compare. No version field — if the format ever changes, bump the migration to clear all existing watermarks (NULL re-trigger) and ship the new shape.
- `score_sum` would overflow JS's `Number.MAX_SAFE_INTEGER` (2^53 - 1 ≈ 9e15) if a single group accumulated billions of high scores. Practical ceiling: a group with 1000 games × 100 players × 100 billion (100B) per score = 10^16, which approaches the limit. This is far beyond any plausible production scale (rtx_pinball's largest group is ~5 tournaments × ~50 games × ~50 players × ~1B-10B scores ≈ 10^13). If it ever matters, switch to `BigInt` arithmetic in the watermark string — but the cache row is plain text, so the change is local to `computeDataWatermark` and `getRankings`.
- The watermark composition deliberately excludes `RankingGroup` config (rank_method, best_n, etc.) because config changes flow through `RankingService.update()` which calls `invalidate()` directly. The data watermark and the config invalidate cover orthogonal concerns: data watermark = "did the underlying data change," config invalidate = "did the rules for ranking change." A future code path that mutates ranking_groups directly (bypassing `update()`) would silently leave caches stale — so don't.
- The watermark does NOT use `submissions.timestamp` because the codebase's UPSERT pattern doesn't update `timestamp` on conflict (only the initial INSERT writes it). `score_sum` carries the equivalent signal robustly. If `timestamp` ever becomes "last update time" semantically, `score_sum` could be replaced with `MAX(timestamp)` for marginal performance — but the current shape is correct.
