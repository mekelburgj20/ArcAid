import { getDatabase } from '../database/database.js';
import { normalizeSubmitterUserId } from './SubmissionContextService.js';
import { RoomMembershipService } from './RoomMembershipService.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import { deleteScorePhotoFiles } from '../utils/scorePhotoCleanup.js';
import { logInfo } from '../utils/logger.js';

/** A `score_history` row as the per-row delete machinery needs to see it. */
export interface DeletableScoreRow {
    id: number;
    game_room_id: string;
    game_id: string | null;
    game_name: string;
    iscored_username: string;
    score: number;
    source: string;
    submitted_by_user_id: string | null;
    photo_url: string | null;
}

export class ScoreHistoryService {
    /**
     * Log a score entry to history. Called alongside every score submission.
     */
    static async log(params: {
        gameName: string;
        gameRoomId: string;
        gameId?: string;
        username: string;
        discordUserId?: string;
        score: number;
        photoUrl?: string;
        source: 'tournament' | 'community' | 'sync';
        tournamentId?: string | null;
        anonymousName?: string | null;
        /**
         * v2.5.0: per-score platform stratification. Required at the API boundary
         * for new submissions; nullable here because the sync poller may not have
         * a platform unless `tournament.iscored_default_platform` is set, and
         * legacy callers pre-v2.5.0 don't pass it.
         */
        platform?: string | null;
        /**
         * v2.53.0 (ADR 0016): split provenance. `engine` decides comparability,
         * `device` is provenance only. Both default to `'unknown'` — a
         * first-class value, NEVER NULL — so sync/legacy callers that can't
         * supply them still write a coherent row.
         */
        engine?: string | null;
        device?: string | null;
        /**
         * S23.4 — bulk CSV score import. Without this, the auto-resolve below
         * would attach an imported historical score to whatever tournament
         * happens to be ACTIVE for that room+game right now, putting it on a
         * live tournament board it was never played in. Imports pass `true`;
         * every interactive submit path leaves it unset.
         */
        skipTournamentLink?: boolean;
    }) {
        const db = await getDatabase();

        // Dedup: skip if an identical (game, player, score, room) entry already exists
        const existing = await db.get(
            `SELECT id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND LOWER(iscored_username) = LOWER(?) AND score = ?
             LIMIT 1`,
            params.gameRoomId, params.gameName, params.username, params.score
        );
        if (existing) return;

        const submittedByUserId = normalizeSubmitterUserId(params.discordUserId);
        const submittedByAnonymousName =
            params.anonymousName ?? (submittedByUserId ? null : params.username);

        // v2.1.0: auto-resolve the active tournament for this room+game so
        // every score_history row carries submitted_during_tournament_id.
        // Tournament leaderboards use this as the primary filter (replaces the
        // submissions table as the source of truth for "best-score-during-
        // this-tournament"). Only populated when the game is ACTIVE — once
        // COMPLETED, the tournament window for that game is closed, so new
        // submissions don't count toward it.
        let submittedTournamentId = params.tournamentId ?? null;
        if (!submittedTournamentId && !params.skipTournamentLink && params.gameRoomId && params.gameName) {
            const activeGame = await db.get(
                `SELECT t.id as tournament_id
                 FROM games g
                 JOIN tournaments t ON t.id = g.tournament_id
                 WHERE LOWER(g.name) = LOWER(?)
                   AND t.game_room_id = ?
                   AND g.status = 'ACTIVE'
                 LIMIT 1`,
                params.gameName, params.gameRoomId,
            );
            submittedTournamentId = activeGame?.tournament_id ?? null;
        }

        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, photo_url, source,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                engine, device
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            params.gameName, params.gameRoomId, params.gameId || null,
            params.username, params.discordUserId || 'SYSTEM',
            params.score, params.photoUrl || null, params.source,
            params.gameRoomId, submittedTournamentId, submittedByUserId, submittedByAnonymousName,
            params.platform ?? null,
            params.engine || UNKNOWN, params.device || UNKNOWN,
        );

        // Sprint 6.5: any Discord-authenticated score establishes room membership.
        // addMember is sentinel-aware, so SYSTEM/ANON/etc. calls are no-ops.
        await RoomMembershipService.addMember(submittedByUserId, params.gameRoomId, 'submission');
    }

    /**
     * Fetch the columns the per-row delete machinery needs. Separate from
     * `deleteEvent` so callers can run their own authorization/ownership checks
     * against the row before deleting it.
     */
    static async getDeletableRow(historyId: number): Promise<DeletableScoreRow | undefined> {
        const db = await getDatabase();
        return db.get<DeletableScoreRow>(
            `SELECT id, game_room_id, game_id, game_name, iscored_username, score,
                    source, submitted_by_user_id, photo_url
             FROM score_history WHERE id = ?`,
            historyId,
        );
    }

    /**
     * v2.9.0 per-row score deletion, extracted from the
     * `DELETE /:roomId/score-history/:historyId` route in S23.6 so the score-report
     * resolution path can reuse it instead of forking the recompute.
     *
     * Does, in order: drop the row → delete its evidence photo from disk →
     * write the `deleted_score_suppressions` tombstone (so `ScoreSyncPoller`
     * can't re-import it on the next cycle) → recompute the corresponding
     * `submissions` row from what's left → invalidate + broadcast.
     *
     * Authorization is the CALLER's job — this method assumes it's already been
     * decided. Same for the `source IN ('tournament','sync')` restriction the
     * route enforces.
     */
    static async deleteEvent(row: DeletableScoreRow, actorId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM score_history WHERE id = ?', row.id);

        // S12: remove the score's evidence photo from disk now that its row is
        // gone (best-effort, never throws; a no-op when the row carried no photo).
        deleteScorePhotoFiles([row.photo_url]);

        // Tombstone for the sync poller (see deleted_score_suppressions doc).
        // We suppress at MAX(existing, deleted_score) so a player who deletes
        // their 5000, then their 4000, doesn't accidentally lower the
        // threshold and let iScored re-import the 5000 on the next poll.
        if (row.game_id && (row.source === 'sync' || row.source === 'tournament')) {
            await db.run(
                `INSERT INTO deleted_score_suppressions
                    (game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)
                 VALUES (?, LOWER(?), ?, datetime('now'), ?)
                 ON CONFLICT(game_id, iscored_username_lower) DO UPDATE SET
                    suppressed_score = MAX(suppressed_score, excluded.suppressed_score),
                    deleted_at = datetime('now'),
                    deleted_by_user_id = excluded.deleted_by_user_id`,
                row.game_id, row.iscored_username, row.score, actorId,
            );
        }

        // Recompute the submissions row for this (game, player). Submissions is
        // best-per-player-per-game; sync+tournament sources both feed it. We
        // grab score+created_at from the same row (highest score, earliest
        // timestamp on tie) so the submissions timestamp continues to reflect
        // when the *displayed* score was set, not just the latest activity.
        if (row.game_id) {
            const submissionId = `${row.game_id}-${row.iscored_username.toLowerCase()}`;
            const remaining = await db.get(
                `SELECT score, created_at
                 FROM score_history
                 WHERE game_id = ?
                   AND LOWER(iscored_username) = LOWER(?)
                   AND orphaned_at IS NULL
                   AND source IN ('tournament','sync')
                 ORDER BY score DESC, created_at ASC
                 LIMIT 1`,
                row.game_id, row.iscored_username,
            );
            if (remaining) {
                await db.run(
                    `UPDATE submissions SET score = ?, timestamp = ? WHERE id = ?`,
                    remaining.score, remaining.created_at, submissionId,
                );
            } else {
                await db.run('DELETE FROM submissions WHERE id = ?', submissionId);
            }
            const { LeaderboardService } = await import('./LeaderboardService.js');
            await LeaderboardService.invalidate(row.game_id);
            const { emitLeaderboardUpdated } = await import('../api/websocket.js');
            emitLeaderboardUpdated(row.game_room_id, { gameId: row.game_id });
        }

        logInfo(`score_history#${row.id} deleted by ${actorId} (player ${row.iscored_username}, score ${row.score}, game ${row.game_id || row.game_name})`);
    }

    /**
     * Get all score history for a specific player + game in a room.
     * Returns both tournament and community submissions.
     *
     * v2.1.0: joins to tournaments so the inline-expand UI on leaderboards can
     * show which tournament each score counts for. `tournament_active` lets
     * the UI split "This tournament" vs "All time" without a second query.
     */
    static async getPlayerGameHistory(
        gameRoomId: string,
        gameName: string,
        username: string,
        limit = 50,
    ) {
        const db = await getDatabase();
        return db.all(`
            SELECT sh.id, sh.score, sh.source, sh.photo_url, sh.created_at, sh.game_id,
                   sh.iscored_username,
                   -- S23.7: verification state drives the checkmark + the
                   -- admin verify/unverify toggle on the history-expand rows.
                   sh.verified_by, sh.verified_at,
                   up.display_name,
                   sh.submitted_by_user_id,
                   sh.submitted_during_tournament_id as tournament_id,
                   t.name as tournament_name,
                   CASE WHEN t.is_active = 1 THEN 1 ELSE 0 END as tournament_active
            FROM score_history sh
            LEFT JOIN tournaments t ON t.id = sh.submitted_during_tournament_id
            LEFT JOIN user_mappings um ON LOWER(um.iscored_username) = LOWER(sh.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(sh.submitted_by_user_id, um.discord_user_id)
            WHERE sh.game_room_id = ?
            AND LOWER(sh.game_name) = LOWER(?)
            AND LOWER(sh.iscored_username) = LOWER(?)
            AND sh.orphaned_at IS NULL
            ORDER BY sh.created_at DESC
            LIMIT ?
        `, gameRoomId, gameName, username, limit);
    }

    /**
     * Get all score history entries for a specific game (all players).
     */
    static async getGameHistory(
        gameRoomId: string,
        gameName: string,
        limit = 100,
    ) {
        const db = await getDatabase();
        return db.all(`
            SELECT sh.id, sh.iscored_username, up.display_name, sh.score, sh.source, sh.created_at
            FROM score_history sh
            LEFT JOIN user_mappings um ON LOWER(um.iscored_username) = LOWER(sh.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(sh.submitted_by_user_id, um.discord_user_id)
            WHERE sh.game_room_id = ?
            AND LOWER(sh.game_name) = LOWER(?)
            AND sh.orphaned_at IS NULL
            ORDER BY sh.created_at DESC
            LIMIT ?
        `, gameRoomId, gameName, limit);
    }

    /**
     * Get all submissions for a specific game_id (tournament game instance).
     * Returns every score submitted by each player, not just the best.
     */
    static async getGameSubmissions(gameRoomId: string, gameId: string) {
        const db = await getDatabase();
        return db.all(`
            SELECT sh.id, sh.iscored_username, up.display_name, sh.score, sh.source, sh.photo_url, sh.created_at,
                   sh.verified_by, sh.verified_at
            FROM score_history sh
            LEFT JOIN user_mappings um ON LOWER(um.iscored_username) = LOWER(sh.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(sh.submitted_by_user_id, um.discord_user_id)
            WHERE sh.game_room_id = ? AND sh.game_id = ?
            AND sh.orphaned_at IS NULL
            ORDER BY sh.score DESC, sh.created_at ASC
        `, gameRoomId, gameId);
    }

    /**
     * Get score counts per player for a specific game instance.
     * Returns { username: count } for players with more than 1 score.
     */
    static async getPlayerScoreCounts(gameRoomId: string, gameId: string): Promise<Record<string, number>> {
        const db = await getDatabase();
        // Look up game name so we can match score_history entries that have game_id=NULL
        // (e.g. community scores logged without a game_id)
        const game = await db.get('SELECT name FROM games WHERE id = ?', gameId);
        const gameName = game?.name;

        const rows = await db.all(`
            SELECT LOWER(iscored_username) as player_key, COUNT(*) as cnt
            FROM score_history
            WHERE game_room_id = ? AND (game_id = ? ${gameName ? 'OR (game_id IS NULL AND LOWER(game_name) = LOWER(?))' : ''})
            GROUP BY LOWER(iscored_username)
            HAVING cnt > 1
        `, ...(gameName ? [gameRoomId, gameId, gameName] : [gameRoomId, gameId]));
        const map: Record<string, number> = {};
        for (const row of rows) {
            map[(row as any).player_key] = (row as any).cnt;
        }
        return map;
    }
}
