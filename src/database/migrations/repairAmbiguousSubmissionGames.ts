import { logInfo } from '../../utils/logger.js';

/**
 * Migration 175 — repair `submissions` rows left on the WRONG tournament by
 * the ambiguous-active-games bug (v2.155.1; the WG-VR / Daily Grind
 * "Black Rose" incident, 2026-09-03..06).
 *
 * ## The shape this repairs
 *
 * Before v2.155.1 the submit routes' `submissions` upsert and
 * `ScoreHistoryService.log`'s tournament auto-resolve each ran their OWN name
 * lookup, with different (or no) `ORDER BY`. When a room had two ACTIVE games
 * sharing a name in two different tournaments, the two lookups could pick
 * DIFFERENT winners for the same submit: `submissions` landed on tournament
 * B's game while `score_history.submitted_during_tournament_id` was stamped
 * with tournament A. `score_history` is the source of truth for which
 * tournament a score counts toward, so the `submissions` row (which drives
 * the room leaderboard card for tournament B, and which winner resolution
 * reads) is simply on the wrong game.
 *
 * ## The match
 *
 * For every `submissions` row `s` on a tournament game `g`, look for a
 * `score_history` row `h` that is unmistakably the SAME event: same room,
 * same game name (case-insensitive), same player, same score, a
 * player-witnessed source (`community`/`tournament` — never `sync`, which
 * carries no reliable timestamp correlation), stamped with a DIFFERENT
 * tournament than `g`, and within 5 minutes of `s.timestamp` (the routes and
 * `ScoreHistoryService.log` write both rows back-to-back in the same
 * request, so a real pair is seconds apart — 5 minutes is generous slack for
 * clock/format differences, not a loose net for coincidence). The time
 * comparison happens in JS: `h.created_at` is SQLite UTC
 * (`'YYYY-MM-DD HH:MM:SS'`), `s.timestamp` is ISO — different shapes, and
 * SQL date functions on a mix of the two are exactly the kind of thing that
 * silently gets it wrong.
 *
 * `h`'s stamped tournament then has to actually own a same-named game in an
 * ACTIVE or COMPLETED state (`g2`) — if it doesn't (the tournament since
 * deleted its game, or renamed it), the pair is left alone rather than
 * guessed at.
 *
 * ## The move
 *
 * `s` is retargeted onto `g2`: new id `${g2.id}-${username}`. If a
 * submissions row already holds that id (the player has ALSO played the
 * other tournament's game directly), the higher of the two scores survives
 * — carrying `s`'s OWN `photo_url`/`platform`/`engine`/`device`/
 * `submitted_by_user_id`/`submitted_from_room_id` along with its score and
 * timestamp, never just the bare number. A prod pair proved why: the
 * misfiled higher score has its OWN evidence photo, and a merge that kept
 * only the destination row's stale photo would silently detach a real score
 * from its proof. `game_id`/`submitted_during_tournament_id` on the survivor
 * are always `g2.id`/`g2.tournament_id` — NEVER copied from `s`, whose own
 * stamp is the wrong tournament this whole repair exists to correct. `s` is
 * dropped either way. Both games' `leaderboard_cache` rows are cleared
 * either way, since both cards were built from the now-corrected data.
 *
 * Idempotent: once `s.game_id` agrees with `h.submitted_during_tournament_id`,
 * the `!=` clause in the query no longer matches it, so a re-run moves 0.
 *
 * Migrations run BEFORE `PRAGMA foreign_keys = ON` (see CLAUDE.md
 * "Database"), so retargeting `submissions.game_id` here never trips FK
 * enforcement even mid-move.
 */

type Db = {
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
    get(sql: string, ...params: unknown[]): Promise<any>;
    all(sql: string, ...params: unknown[]): Promise<any[]>;
    exec(sql: string): Promise<void>;
};

const MAX_DRIFT_MS = 300 * 1000;

/** SQLite UTC `'YYYY-MM-DD HH:MM:SS'` -> epoch ms. */
function sqliteUtcToMs(value: string): number {
    return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

/** ISO 8601 -> epoch ms. */
function isoToMs(value: string): number {
    return new Date(value).getTime();
}

interface SubmissionRow {
    submission_id: string;
    s_game_id: string;
    iscored_username: string;
    score: number;
    timestamp: string;
    photo_url: string | null;
    platform: string | null;
    engine: string | null;
    device: string | null;
    submitted_by_user_id: string | null;
    g_name: string;
    g_tournament_id: string;
    g_room_id: string | null;
}

interface HistoryCandidate {
    id: number;
    created_at: string;
    submitted_during_tournament_id: string;
}

interface Game2Row {
    id: string;
    tournament_id: string;
    status: string;
}

export async function repairAmbiguousSubmissionGames(db: Db): Promise<{ moved: number }> {
    let moved = 0;

    await db.exec('BEGIN');
    try {
        const submissionRows = (await db.all(`
            SELECT s.id as submission_id, s.game_id as s_game_id, s.iscored_username,
                   s.score, s.timestamp, s.submitted_from_room_id,
                   s.photo_url, s.platform, s.engine, s.device, s.submitted_by_user_id,
                   g.name as g_name, g.tournament_id as g_tournament_id,
                   COALESCE(g.game_room_id, t.game_room_id) as g_room_id
            FROM submissions s
            JOIN games g ON g.id = s.game_id
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.tournament_id IS NOT NULL
              AND s.iscored_username IS NOT NULL
        `)) as Array<SubmissionRow & { submitted_from_room_id: string | null }>;

        for (const s of submissionRows) {
            const roomId = s.submitted_from_room_id ?? s.g_room_id;
            if (!roomId) continue;

            const historyCandidates = (await db.all(
                `SELECT id, created_at, submitted_during_tournament_id
                 FROM score_history
                 WHERE game_room_id = ?
                   AND LOWER(game_name) = LOWER(?)
                   AND LOWER(iscored_username) = LOWER(?)
                   AND score = ?
                   AND source IN ('community', 'tournament')
                   AND submitted_during_tournament_id IS NOT NULL
                   AND submitted_during_tournament_id != ?`,
                roomId, s.g_name, s.iscored_username, s.score, s.g_tournament_id,
            )) as HistoryCandidate[];
            if (historyCandidates.length === 0) continue;

            const sMs = isoToMs(s.timestamp);
            if (Number.isNaN(sMs)) continue;

            let best: HistoryCandidate | null = null;
            let bestDrift = Infinity;
            for (const h of historyCandidates) {
                const hMs = sqliteUtcToMs(h.created_at);
                if (Number.isNaN(hMs)) continue;
                const drift = Math.abs(hMs - sMs);
                if (drift <= MAX_DRIFT_MS && drift < bestDrift) {
                    best = h;
                    bestDrift = drift;
                }
            }
            if (!best) continue;

            const g2 = (await db.get(
                `SELECT id, tournament_id, status
                 FROM games
                 WHERE tournament_id = ? AND LOWER(name) = LOWER(?)
                   AND status IN ('ACTIVE', 'COMPLETED')
                 ORDER BY CASE status WHEN 'ACTIVE' THEN 0 ELSE 1 END, created_at DESC
                 LIMIT 1`,
                best.submitted_during_tournament_id, s.g_name,
            )) as Game2Row | undefined;
            if (!g2) continue;

            const newId = `${g2.id}-${s.iscored_username.toLowerCase()}`;
            const existingAtNewId = await db.get(
                `SELECT id, score FROM submissions WHERE id = ?`, newId,
            ) as { id: string; score: number } | undefined;

            if (existingAtNewId) {
                if (s.score > existingAtNewId.score) {
                    // The misfiled row is the higher score, so ITS evidence
                    // (photo/platform/engine/device/submitter) is what
                    // actually backs this number — carry all of it onto the
                    // survivor. `game_id`/`submitted_during_tournament_id`
                    // stay pinned to g2, never copied from `s`.
                    await db.run(
                        `UPDATE submissions SET
                            score = ?, timestamp = ?, game_id = ?, submitted_during_tournament_id = ?,
                            photo_url = ?, platform = ?, engine = ?, device = ?,
                            submitted_by_user_id = ?, submitted_from_room_id = ?
                         WHERE id = ?`,
                        s.score, s.timestamp, g2.id, g2.tournament_id,
                        s.photo_url, s.platform, s.engine, s.device,
                        s.submitted_by_user_id, roomId,
                        newId,
                    );
                }
                await db.run(`DELETE FROM submissions WHERE id = ?`, s.submission_id);
            } else {
                await db.run(
                    `UPDATE submissions SET id = ?, game_id = ?, submitted_during_tournament_id = ? WHERE id = ?`,
                    newId, g2.id, g2.tournament_id, s.submission_id,
                );
            }

            await db.run(
                `DELETE FROM leaderboard_cache WHERE game_id IN (?, ?)`,
                s.s_game_id, g2.id,
            );

            moved++;
            logInfo(
                `[migration] 175: moved submission for "${s.iscored_username}" on "${s.g_name}" ` +
                `from tournament ${s.g_tournament_id} (game ${s.s_game_id}) ` +
                `to tournament ${best.submitted_during_tournament_id} (game ${g2.id}), ` +
                `matched score_history#${best.id} (drift ${Math.round(bestDrift / 1000)}s)`,
            );
        }

        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }

    if (moved > 0) {
        logInfo(`[migration] 175_repair_ambiguous_submission_games: repaired ${moved} submissions row(s)`);
    }
    return { moved };
}
