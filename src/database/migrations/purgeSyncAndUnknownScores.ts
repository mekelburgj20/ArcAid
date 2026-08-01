import type { Database } from 'sqlite';

/**
 * Migration 128 — purge sync-origin global scores and every unknown-engine
 * score row (ADR 0016 P2 §3d).
 *
 * Two cleanups, one migration. Both are data-only; no schema changes.
 *
 * **Ordering matters.** This migration is meaningful only with §3b's
 * always-`unknown` stamping already in the codebase (`ScoreSyncPoller` and
 * `TournamentEngine.finalSyncScoresForGame` both stopped reading
 * `tournaments.iscored_default_engine`/`_device`) and §3c's service-level
 * rejection of `source: 'sync'` in `GlobalScoreService.fanOutFromRoomSubmission`
 * in place. Otherwise the rows it deletes would immediately grow back.
 *
 * ### 1. Sync-origin rows in `global_scores`
 *
 * `global_scores` has **no `source` column**, so a sync-origin global row can
 * only be identified by matching it back to the `score_history` row the same
 * poller cycle wrote (`ScoreSyncPoller` logs `source='sync'` and then fanned
 * out, in that order, from the same values).
 *
 * The match is deliberately narrow, because a web-submitted row could
 * coincidentally carry the same `(game, username, score)` triple:
 *
 *   - `origin_type = 'game_room'` — a direct Global Scoreboard submission is
 *     `'global'` and was never reachable from the poller at all.
 *   - `origin_game_room_id = score_history.game_room_id` — exact, not
 *     NULL-tolerant. `fanOutFromRoomSubmission` always stamps the origin room.
 *   - game linkage: `score_history.game_id = global_scores.origin_game_id`;
 *     when `origin_game_id` is NULL (ADR 0005 orphaning on unpin/game-delete
 *     sets it NULL) it falls back to any `games` row for the same
 *     `global_game_id`.
 *   - `LOWER(iscored_username)` equal, `score` equal.
 *   - **and `NOT EXISTS` a non-sync `score_history` row matching that same
 *     narrowed tuple.** This is what makes a false positive impossible in the
 *     way that matters: a web submission (tournament or community) always
 *     writes its own `score_history` row with `source` `'tournament'` or
 *     `'community'`. So if any non-sync history row explains the global row,
 *     the global row is left alone — even when a sync row happens to share the
 *     same score value. The only rows deleted are those whose *sole* history
 *     explanation is a sync import.
 *
 * Cleanup 2 would catch most of these anyway (synced scores are
 * `unknown`/`unknown`), but not all: legacy sync rows written before P1 got an
 * engine backfilled from `platform` by migration 125 (a sync row that carried
 * `iscored_default_platform='vpxs'` became `engine='vpx'`), and P1-era rows
 * could have taken an `iscored_default_engine`. Those have a concrete engine and
 * would survive cleanup 2. Cleanup 1 is what removes them.
 *
 * ### 2. All remaining unknown-engine scores
 *
 * Across `score_history`, `submissions`, `community_scores`, `global_scores`.
 * NULL `engine` is treated as unknown: migration 125 asserts no NULLs survive
 * it and every write path defaults to the `'unknown'` sentinel, so a NULL would
 * be a row from a path that predates or bypasses both — exactly as unusable as
 * an explicit `'unknown'`. Counted and reported separately so a real deploy
 * says whether any existed.
 *
 * Authorised by the product owner 2026-07-31: ArcAid is pre-GA and has no
 * scores worth preserving. **That licence covers score DATA only** — the delete
 * discipline in `database.ts` still applies. Checked before writing this:
 *
 *   - Nothing declares a FOREIGN KEY onto `submissions`, `score_history`,
 *     `community_scores` or `global_scores`. All four are FK *children*
 *     (`global_scores.global_game_id` → `global_games`,
 *     `.origin_game_room_id` → `game_rooms`; `submissions.game_id` → `games`;
 *     `score_history`/`community_scores`.`game_room_id` → `game_rooms`), and
 *     deleting a child never trips a constraint in either direction.
 *   - `score_reports.score_id` is a **soft** reference to `global_scores.id`
 *     with no FK (its readers LEFT JOIN, so orphans degrade rather than break).
 *     Left dangling it would put phantom entries in the moderation queue, so
 *     reports whose score no longer exists are removed here too.
 *   - `deleted_score_suppressions` is keyed on `(game_id, username)`, not on a
 *     score row id — untouched and still correct.
 *   - `leaderboard_cache` / `global_leaderboard_cache` hold serialized rankings
 *     that do NOT self-invalidate on row deletion, so both are cleared (same
 *     reasoning as migrations 086/088/127). `ranking_groups_cache` is left
 *     alone: it self-invalidates via its score-count/score-sum watermark
 *     (ADR 0013).
 *
 * Not handled here: on-disk proof photos referenced by `photo_url` on deleted
 * rows are left in `data/score-photos/`. A migration doing filesystem work is a
 * worse trade than a few orphaned pre-GA image files.
 *
 * Idempotent by construction: a re-run finds nothing to delete and returns
 * zeroes.
 */

function log(line: string): void {
    // eslint-disable-next-line no-console
    console.log(`[migration] 128: ${line}`);
}

/** Score tables carrying an `engine` column (migration 125). */
const SCORE_TABLES = ['score_history', 'submissions', 'community_scores', 'global_scores'] as const;

/**
 * Correlated EXISTS body matching a `global_scores` row (`gs`) against a
 * `score_history` row of the given source class. `op` is `=` for the
 * sync-origin probe and `<>` for the "is it explained by a web submission?"
 * exclusion, so both halves are guaranteed to use the identical join.
 */
function historyMatch(alias: string, op: '=' | '<>'): string {
    return `
        SELECT 1 FROM score_history ${alias}
         WHERE ${alias}.source ${op} 'sync'
           AND ${alias}.score = gs.score
           AND LOWER(${alias}.iscored_username) = LOWER(gs.iscored_username)
           AND ${alias}.game_room_id = gs.origin_game_room_id
           AND (
                 ${alias}.game_id = gs.origin_game_id
              OR (gs.origin_game_id IS NULL
                  AND ${alias}.game_id IN (SELECT g.id FROM games g WHERE g.global_game_id = gs.global_game_id))
           )`;
}

const SYNC_ORIGIN_GLOBAL_SCORES = `
    SELECT gs.id FROM global_scores gs
     WHERE gs.origin_type = 'game_room'
       AND gs.origin_game_room_id IS NOT NULL
       AND gs.iscored_username IS NOT NULL
       AND EXISTS (${historyMatch('sh', '=')})
       AND NOT EXISTS (${historyMatch('sh2', '<>')})`;

export interface PurgeCounts {
    /** global_scores rows deleted as sync-origin (cleanup 1). */
    syncOriginGlobalScores: number;
    /** Per-table unknown-engine rows deleted (cleanup 2). */
    unknownEngine: Record<string, number>;
    /** Per-table rows that had a NULL (rather than 'unknown') engine. */
    nullEngine: Record<string, number>;
    /** score_reports rows removed because their global_scores row is gone. */
    orphanedScoreReports: number;
}

export async function purgeSyncAndUnknownScores(db: Database): Promise<PurgeCounts> {
    const counts: PurgeCounts = {
        syncOriginGlobalScores: 0,
        unknownEngine: {},
        nullEngine: {},
        orphanedScoreReports: 0,
    };

    await db.exec('BEGIN');
    try {
        // --- Cleanup 1: sync-origin global rows -------------------------
        const syncOrigin = await db.run(
            `DELETE FROM global_scores WHERE id IN (${SYNC_ORIGIN_GLOBAL_SCORES})`,
        );
        counts.syncOriginGlobalScores = syncOrigin.changes ?? 0;

        // --- Cleanup 2: every remaining unknown-engine row --------------
        for (const table of SCORE_TABLES) {
            const nulls = (await db.get(
                `SELECT COUNT(*) AS n FROM ${table} WHERE engine IS NULL`,
            )) as { n: number };
            counts.nullEngine[table] = nulls.n;

            const res = await db.run(
                `DELETE FROM ${table} WHERE engine IS NULL OR engine = 'unknown'`,
            );
            counts.unknownEngine[table] = res.changes ?? 0;
        }

        // --- Referential tidy-up ----------------------------------------
        const reports = await db.run(
            `DELETE FROM score_reports
              WHERE score_id NOT IN (SELECT id FROM global_scores)`,
        );
        counts.orphanedScoreReports = reports.changes ?? 0;

        // --- Cache bust --------------------------------------------------
        await db.exec('DELETE FROM leaderboard_cache');
        await db.exec('DELETE FROM global_leaderboard_cache');

        await db.exec('COMMIT');

        // One line, every per-table count, always emitted on a run that did
        // something. A no-op run (every test DB init, and any re-deploy after
        // the first) stays silent so it does not drown the startup log.
        const total = counts.syncOriginGlobalScores + counts.orphanedScoreReports
            + Object.values(counts.unknownEngine).reduce((a, b) => a + b, 0);
        if (total > 0) {
            const perTable = SCORE_TABLES
                .map((t) => {
                    const nulls = counts.nullEngine[t] ?? 0;
                    return `${t}=${counts.unknownEngine[t] ?? 0}${nulls > 0 ? ` (${nulls} NULL engine)` : ''}`;
                })
                .join(', ');
            log(
                `deleted ${counts.syncOriginGlobalScores} sync-origin global_scores row(s); `
                + `unknown-engine rows deleted: ${perTable}; `
                + `orphaned score_reports removed: ${counts.orphanedScoreReports}; `
                + 'leaderboard caches cleared',
            );
        }
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }

    return counts;
}
