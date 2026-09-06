import { logInfo } from '../../utils/logger.js';

/**
 * Migration 176 — backfill the `score_history` row a pre-v2.155.3 dedup
 * silently swallowed for a score submitted to a SECOND tournament running
 * the same table.
 *
 * ## The shape this repairs
 *
 * Before v2.155.3, `ScoreHistoryService.isDuplicate` matched on
 * (room, game name, player, score [, game_id]) and never looked at
 * `submitted_during_tournament_id` at all. With Black Rose ACTIVE in both
 * Weekly Grind - VR and Daily Grind, the owner submitted 945,436,670 on the
 * Daily Grind card (`score_history` stamped Daily Grind), then the SAME
 * score on the WG-VR card 26 seconds later. The second submit's
 * `submissions` upsert landed correctly on the WG-VR game (that half was
 * already resolver-correct — v2.155.1/v2.155.2) but `ScoreHistoryService.log`
 * saw the identical (room, name, player, score) already present for Daily
 * Grind and returned early: no WG-VR history row was ever written, so
 * WG-VR's leaderboard (which reads `score_history` filtered by ITS tournament
 * id) kept showing the older score forever, even though `submissions` said
 * otherwise.
 *
 * ## The match
 *
 * For every `submissions` row `s` on a tournament game `g`
 * (`g.tournament_id NOT NULL`) that has NO `score_history` row already
 * stamped with `s`'s own tournament — i.e. the exact victim shape above —
 * look for a SIBLING history row: same room/name/player/score, but a
 * DIFFERENT tournament stamp (by construction, since step one already ruled
 * out a same-tournament match), within 24 hours of `s.timestamp` (the two
 * submits in the incident were 26 SECONDS apart; 24h is generous slack for
 * clock/format differences, not a loose net for coincidence). The time
 * comparison happens in JS, same discipline as migration 175:
 * `score_history.created_at` is SQLite UTC (`'YYYY-MM-DD HH:MM:SS'`),
 * `submissions.timestamp` is ISO.
 *
 * ## The insert
 *
 * A NEW `score_history` row is cloned from the sibling's provenance
 * (source, platform, engine, device, photo_url, submitted_by_user_id,
 * discord_user_id, submitted_from_room_id, merged_from_anonymous_identity_id,
 * game_room_id, game_name, iscored_username, score) — the sibling is the
 * only place that evidence still exists — but stamped with `s`'s OWN
 * `submitted_during_tournament_id` and timestamped at `s.timestamp` (when
 * THIS tournament's submit actually happened, not the sibling's). `game_id`
 * is left NULL, matching every modern web `score_history` row (v2.75.1
 * doctrine — these key by room+name, not game_id). `g.id`'s leaderboard
 * cache is cleared so the card recomputes with the now-present row.
 *
 * Idempotent: once the backfilled row exists, step one's "no
 * same-tournament history row" check no longer matches `s`, so a re-run
 * inserts 0.
 *
 * Migrations run BEFORE `PRAGMA foreign_keys = ON` (see CLAUDE.md
 * "Database").
 */

type Db = {
    run(sql: string, ...params: unknown[]): Promise<{ changes?: number }>;
    get(sql: string, ...params: unknown[]): Promise<any>;
    all(sql: string, ...params: unknown[]): Promise<any[]>;
    exec(sql: string): Promise<void>;
};

const MAX_DRIFT_MS = 24 * 60 * 60 * 1000;

/** SQLite UTC `'YYYY-MM-DD HH:MM:SS'` -> epoch ms. */
function sqliteUtcToMs(value: string): number {
    return new Date(`${value.replace(' ', 'T')}Z`).getTime();
}

/** ISO 8601 -> epoch ms. */
function isoToMs(value: string): number {
    return new Date(value).getTime();
}

/** ISO 8601 -> SQLite UTC `'YYYY-MM-DD HH:MM:SS'` shape. */
function isoToSqliteUtc(value: string): string {
    const d = new Date(value);
    return d.toISOString().slice(0, 19).replace('T', ' ');
}

interface SubmissionRow {
    submission_id: string;
    s_game_id: string;
    iscored_username: string;
    score: number;
    timestamp: string;
    submitted_during_tournament_id: string | null;
    g_name: string;
    g_room_id: string | null;
}

interface SiblingRow {
    id: number;
    created_at: string;
    source: string;
    platform: string | null;
    engine: string | null;
    device: string | null;
    photo_url: string | null;
    submitted_by_user_id: string | null;
    discord_user_id: string | null;
    submitted_from_room_id: string | null;
    merged_from_anonymous_identity_id: number | null;
    game_room_id: string | null;
    game_name: string;
    iscored_username: string;
    score: number;
}

export async function backfillHistoryForDedupVictims(db: Db): Promise<{ inserted: number }> {
    let inserted = 0;

    await db.exec('BEGIN');
    try {
        const submissionRows = (await db.all(`
            SELECT s.id as submission_id, s.game_id as s_game_id, s.iscored_username,
                   s.score, s.timestamp, s.submitted_during_tournament_id,
                   s.submitted_from_room_id,
                   g.name as g_name,
                   COALESCE(s.submitted_from_room_id, g.game_room_id, t.game_room_id) as g_room_id
            FROM submissions s
            JOIN games g ON g.id = s.game_id
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.tournament_id IS NOT NULL
              AND s.iscored_username IS NOT NULL
        `)) as Array<SubmissionRow & { submitted_from_room_id: string | null }>;

        for (const s of submissionRows) {
            const roomId = s.g_room_id;
            if (!roomId) continue;

            // Already correctly represented for THIS tournament — nothing to do.
            const already = await db.get(
                `SELECT id FROM score_history
                 WHERE game_room_id = ?
                   AND LOWER(game_name) = LOWER(?)
                   AND LOWER(iscored_username) = LOWER(?)
                   AND score = ?
                   AND submitted_during_tournament_id IS ?
                 LIMIT 1`,
                roomId, s.g_name, s.iscored_username, s.score, s.submitted_during_tournament_id,
            );
            if (already) continue;

            // A sibling row for the SAME event, stamped with a DIFFERENT
            // tournament (guaranteed different — the query above already
            // ruled out a match on s's own stamp).
            const siblings = (await db.all(
                `SELECT id, created_at, source, platform, engine, device, photo_url,
                        submitted_by_user_id, discord_user_id, submitted_from_room_id,
                        merged_from_anonymous_identity_id, game_room_id, game_name,
                        iscored_username, score
                 FROM score_history
                 WHERE game_room_id = ?
                   AND LOWER(game_name) = LOWER(?)
                   AND LOWER(iscored_username) = LOWER(?)
                   AND score = ?`,
                roomId, s.g_name, s.iscored_username, s.score,
            )) as SiblingRow[];
            if (siblings.length === 0) continue;

            const sMs = isoToMs(s.timestamp);
            if (Number.isNaN(sMs)) continue;

            let best: SiblingRow | null = null;
            let bestDrift = Infinity;
            for (const sib of siblings) {
                const hMs = sqliteUtcToMs(sib.created_at);
                if (Number.isNaN(hMs)) continue;
                const drift = Math.abs(hMs - sMs);
                if (drift <= MAX_DRIFT_MS && drift < bestDrift) {
                    best = sib;
                    bestDrift = drift;
                }
            }
            if (!best) continue;

            await db.run(
                `INSERT INTO score_history (
                    game_name, game_room_id, game_id, iscored_username, discord_user_id, score, photo_url,
                    source, submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                    merged_from_anonymous_identity_id, platform, engine, device, created_at
                 ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                best.game_name, best.game_room_id, best.iscored_username, best.discord_user_id, best.score,
                best.photo_url, best.source, best.submitted_from_room_id, s.submitted_during_tournament_id,
                best.submitted_by_user_id, best.merged_from_anonymous_identity_id, best.platform,
                best.engine, best.device, isoToSqliteUtc(s.timestamp),
            );

            await db.run(`DELETE FROM leaderboard_cache WHERE game_id = ?`, s.s_game_id);

            inserted++;
            logInfo(
                `[migration] 176: backfilled score_history for "${s.iscored_username}" on "${s.g_name}" ` +
                `-> tournament ${s.submitted_during_tournament_id ?? 'NULL'} (game ${s.s_game_id}), ` +
                `cloned from score_history#${best.id} (drift ${Math.round(bestDrift / 1000)}s)`,
            );
        }

        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }

    if (inserted > 0) {
        logInfo(`[migration] 176_backfill_history_for_dedup_victims: inserted ${inserted} score_history row(s)`);
    }
    return { inserted };
}
