/**
 * The ONE rule for "which scores belong to THIS run of a table" (v2.172.0).
 *
 * Tournament boards key `score_history` on (room, `submitted_during_tournament_id`,
 * `LOWER(game_name)`), and web rows carry no `game_id`. That key cannot tell two
 * runs of the same table in the same tournament apart, so when a table came back
 * round its new card opened with the previous run's scores (rtx_pinball Daily
 * Grind, WHO dunnit: ran 2026-08-22, again 2026-10-25 — the new card showed five
 * August scores on top of the two posted that day).
 *
 * A score belongs to the run of game `g` when it was logged at or after `g`
 * started and before the NEXT run of the same table in the same tournament
 * started. Scores logged after `g` ended but before the next run (iScored final
 * sync, late cabinet reports) still belong to `g`, which is why the upper bound
 * is the next run's start and not `g.end_date`.
 *
 * Both boundaries are shifted back by `GAME_RUN_GRACE_SEC`, so consecutive runs
 * still partition the scores with no gap and no overlap. The grace exists
 * because `score_history.created_at` is whole seconds (`CURRENT_TIMESTAMP`)
 * while `games.start_date` carries milliseconds, and cabinet-reported times come
 * from the device clock.
 *
 * A game with no `start_date` (legacy rows) gets no bound — the pre-v2.172.0
 * behaviour. Rows that have not run yet (`QUEUED`, `SCHEDULED`) never bound a
 * run. `julianday()` compares both stored shapes (`YYYY-MM-DD HH:MM:SS` and ISO
 * with `T`/`Z`); a raw string compare would not.
 *
 * Deliberately NOT applied to `TournamentScoresService`, whose per-tournament
 * page merges every run of a table on purpose ("featured N×").
 */

export const GAME_RUN_GRACE_SEC = 60;

/**
 * Predicate: the `score_history` row aliased `sh` belongs to the run of the
 * `games` row aliased `g`. Both aliases must be in scope.
 */
export function gameRunWindowSql(sh: string, g: string): string {
    const grace = `'-${GAME_RUN_GRACE_SEC} seconds'`;
    return `(
        (${g}.start_date IS NULL OR ${sh}.created_at IS NULL
            OR julianday(${sh}.created_at) >= julianday(${g}.start_date, ${grace}))
        AND NOT EXISTS (
            SELECT 1 FROM games next_run
            WHERE next_run.tournament_id = ${g}.tournament_id
              AND LOWER(next_run.name) = LOWER(${g}.name)
              AND next_run.id <> ${g}.id
              AND next_run.start_date IS NOT NULL
              AND next_run.status NOT IN ('QUEUED', 'SCHEDULED')
              AND julianday(next_run.start_date) > julianday(${g}.start_date)
              AND julianday(${sh}.created_at) >= julianday(next_run.start_date, ${grace})
        )
    )`;
}

/**
 * For single-table `score_history` reads that do not join `games`: the same
 * predicate against the game whose id is the ONE bound parameter.
 * `sh` is the alias (or table name) the query uses for `score_history`.
 */
export function gameRunWindowByIdSql(sh: string): string {
    return `EXISTS (SELECT 1 FROM games run_game WHERE run_game.id = ? AND ${gameRunWindowSql(sh, 'run_game')})`;
}
