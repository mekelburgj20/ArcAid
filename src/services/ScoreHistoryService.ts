import { getDatabase } from '../database/database.js';
import { normalizeSubmitterUserId } from './SubmissionContextService.js';
import { RoomMembershipService } from './RoomMembershipService.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import { deleteScorePhotoFiles } from '../utils/scorePhotoCleanup.js';
import { logInfo, logDebug } from '../utils/logger.js';

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
     * decided.
     *
     * v2.108.0 widens the accepted sources from `('tournament','sync')` to
     * include `'community'`, and adds the two cascades that gap implied:
     * `deleteCommunityScoreRow` (the community_scores twin of the deleted
     * score_history row) and `softDeleteFannedOutGlobalScore` (the
     * global_scores fan-out). Both are best-effort and CONSERVATIVE — an
     * ambiguous match deletes nothing.
     */
    static async deleteEvent(row: DeletableScoreRow, actorId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM score_history WHERE id = ?', row.id);

        // S12: remove the score's evidence photo from disk now that its row is
        // gone (best-effort, never throws; a no-op when the row carried no photo).
        deleteScorePhotoFiles([row.photo_url]);

        // v2.108.0 (B1) — community cascade. `community_scores` is the ONLY
        // score table `score_history` does not already stand in for: the admin
        // "wipe player from game" path deliberately leaves it alone so
        // `RoomScoresService` can read `score_history` alone without a UNION
        // resurrecting wiped rows. Per-row self-delete is the opposite case —
        // the player asked for THIS score to be gone — so here (and ONLY here)
        // the twin row goes too. The wipe path's semantics are untouched.
        if (row.source === 'community') {
            await this.deleteCommunityScoreTwin(row);
        }

        // v2.108.0 (B2) — global fan-out cleanup, every source. One-way by
        // design: the reverse direction (global self-delete → room tables) is
        // still not wired.
        await this.softDeleteFannedOutGlobalScore(row, actorId);

        // ── Resolve the game ROW this score belongs to ──
        //
        // `row.game_id` is a TRANSIENT pointer (v2.75.1 doctrine): web
        // submissions write it as NULL from the start, and rotation NULLs it
        // on synced rows later. Prod evidence (2026-08-14, the Strike scores
        // that prompted this feature): every modern web row has game_id NULL —
        // so any cleanup gated on `row.game_id` alone silently skips the
        // common case. Resolve by (room, name) ACTIVE-first instead — the
        // same ORDER BY contract the submit handlers adopted in v2.100.3 —
        // because the poller's dedup and winner resolution both operate
        // against the ACTIVE run's game row.
        // `games.game_room_id` is an ALTER-added denormalized column — NULL on
        // rows that predate it — so room scoping goes through
        // COALESCE(g.game_room_id, t.game_room_id), the same LEFT JOIN idiom
        // the admin wipe path uses for its ownedByRoom check.
        const gameRow = row.game_id
            ? { id: row.game_id }
            : await db.get<{ id: string }>(
                `SELECT g.id FROM games g
                 LEFT JOIN tournaments t ON t.id = g.tournament_id
                 WHERE COALESCE(g.game_room_id, t.game_room_id) = ?
                   AND LOWER(g.name) = LOWER(?)
                 ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.created_at DESC
                 LIMIT 1`,
                row.game_room_id, row.game_name,
            );
        const resolvedGameId = gameRow?.id ?? null;

        // Tombstone for the sync poller (see deleted_score_suppressions doc),
        // suppressing at MAX(existing, deleted_score) so a player who deletes
        // their 5000, then their 4000, doesn't accidentally lower the
        // threshold and let iScored re-import the 5000 on the next poll.
        //
        // Written for EVERY source, not just sync/tournament: web submissions
        // (source='community' since the login-mandate era) are pushed to
        // iScored too (IScoredSubmitSync), so on a mirrored board the poller
        // would re-import a deleted community score just the same. On rooms
        // with iScored off the tombstone is inert — cheap insurance either way.
        if (resolvedGameId) {
            await db.run(
                `INSERT INTO deleted_score_suppressions
                    (game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)
                 VALUES (?, LOWER(?), ?, datetime('now'), ?)
                 ON CONFLICT(game_id, iscored_username_lower) DO UPDATE SET
                    suppressed_score = MAX(suppressed_score, excluded.suppressed_score),
                    deleted_at = datetime('now'),
                    deleted_by_user_id = excluded.deleted_by_user_id`,
                resolvedGameId, row.iscored_username, row.score, actorId,
            );
        }

        // Recompute the submissions row for this (game, player). Submissions
        // is best-per-player-per-game and EVERY submit path writes it —
        // including the community-source web paths (that's how the poller
        // knows not to re-import a score the site pushed to iScored). So the
        // recompute must consider ALL sources: filtering to tournament/sync
        // here would wipe a player's submissions row while their remaining
        // community scores still show on the board — and winner resolution
        // reads submissions. Remaining rows are matched by (room, name), the
        // v2.75.1 name+attribution doctrine, NOT by game_id (NULL on web
        // rows; and both the room board and the mirrored iScored board are
        // name-scoped across reruns).
        if (resolvedGameId) {
            const submissionId = `${resolvedGameId}-${row.iscored_username.toLowerCase()}`;
            const remaining = await db.get(
                `SELECT score, created_at
                 FROM score_history
                 WHERE game_room_id = ?
                   AND LOWER(game_name) = LOWER(?)
                   AND LOWER(iscored_username) = LOWER(?)
                   AND orphaned_at IS NULL
                 ORDER BY score DESC, created_at ASC
                 LIMIT 1`,
                row.game_room_id, row.game_name, row.iscored_username,
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
            await LeaderboardService.invalidate(resolvedGameId);
        }

        // Broadcast when a game row resolved (the payload type requires a
        // gameId). A name with NO games row left renders on fetch-on-load
        // surfaces only, so there is no live board to nudge anyway.
        if (resolvedGameId) {
            const { emitLeaderboardUpdated } = await import('../api/websocket.js');
            emitLeaderboardUpdated(row.game_room_id, { gameId: resolvedGameId });
        }

        logInfo(`score_history#${row.id} deleted by ${actorId} (player ${row.iscored_username}, score ${row.score}, game ${row.game_id || row.game_name})`);
    }

    /**
     * v2.108.0 (B1) — delete the `community_scores` row that
     * `CommunityScoreService.submitScore` wrote alongside this `score_history`
     * row.
     *
     * ## The match key, and why it is this one
     *
     * `submitScore` dual-writes both tables from the SAME locals in one call,
     * so the columns that are guaranteed byte-identical across the pair are:
     * `game_room_id`, `game_name`, `iscored_username` (both get
     * `effectiveUsername`, the first-claim-resolved name), `score`, and
     * `submitted_by_user_id` (both get `normalizeSubmitterUserId(discordUserId)`).
     * The key below is exactly that set.
     *
     * Deliberately EXCLUDED: `discord_user_id` — the two writers use different
     * guest sentinels for the same submission (`'SYSTEM'` in score_history,
     * `'ANON'` in community_scores), so matching on it would miss every guest
     * row. Also excluded: `created_at` proximity — the shared columns already
     * identify the pair, and a timestamp window would only add a way to miss.
     *
     * `submitted_by_user_id` is compared with `IS` (NULL-safe in SQLite) so an
     * anonymous row matches its anonymous twin and never a logged-in row that
     * happens to share the name and score.
     *
     * CONSERVATIVE: deletes only on an EXACTLY-ONE match. Zero matches is
     * normal and fine (pre-dual-write legacy rows, freeplay paths that log
     * `source='community'` without a community_scores twin) — logged at DEBUG.
     * Two or more matches means a genuine duplicate exists in community_scores
     * that score_history's insert-time dedup collapsed to one row; there is no
     * way to tell which twin is this one, so NOTHING is deleted.
     */
    private static async deleteCommunityScoreTwin(row: DeletableScoreRow): Promise<void> {
        try {
            const db = await getDatabase();
            const candidates = await db.all<Array<{ id: number }>>(
                `SELECT id FROM community_scores
                 WHERE game_room_id = ?
                   AND LOWER(game_name) = LOWER(?)
                   AND LOWER(iscored_username) = LOWER(?)
                   AND score = ?
                   AND submitted_by_user_id IS ?
                   AND orphaned_at IS NULL`,
                row.game_room_id, row.game_name, row.iscored_username, row.score,
                row.submitted_by_user_id,
            );
            if (candidates.length !== 1) {
                logDebug(
                    `Community cascade skipped for score_history#${row.id}: ${candidates.length} community_scores candidates ` +
                    `(room ${row.game_room_id}, game "${row.game_name}", player "${row.iscored_username}", score ${row.score})`,
                );
                return;
            }
            await db.run('DELETE FROM community_scores WHERE id = ?', candidates[0]!.id);
            logInfo(`Community cascade: community_scores#${candidates[0]!.id} deleted with score_history#${row.id}`);
        } catch (err) {
            // Best-effort: the score_history row is already gone and that is
            // the delete the caller asked for.
            logDebug(`Community cascade failed for score_history#${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    /**
     * v2.108.0 (B2) — soft-delete the `global_scores` row that
     * `GlobalScoreService.fanOutFromRoomSubmission` created from this room
     * submission, closing the "delete it in the room, it lives forever on the
     * Global Scoreboard" asymmetry.
     *
     * ## The match key
     *
     * The fan-out's OWN uniqueness key is
     * `(global_game_id, origin_game_room_id, LOWER(iscored_username), score)`
     * (see the dedup guard in `fanOutFromRoomSubmission`), so the reverse
     * lookup uses the same columns plus `player_id`, which the fan-out set from
     * the submitter's Discord id. `global_game_id` is only added to the
     * predicate when it is resolvable from the `games` row — the other four
     * columns already scope the search to one room and one player.
     *
     * Gated on `row.submitted_by_user_id` being non-null: fan-out early-returns
     * for guest submissions, so a row without an attributed submitter has no
     * global twin by construction, and searching on name alone could reach a
     * different person's row.
     *
     * CONSERVATIVE: acts only on an EXACTLY-ONE match, and only on rows that
     * are not already soft-deleted. Soft delete (not hard) so the actor is
     * recorded and an admin can restore. `GlobalScoreService.softDelete`
     * invalidates `global_leaderboard_cache` itself.
     */
    private static async softDeleteFannedOutGlobalScore(row: DeletableScoreRow, actorId: string): Promise<void> {
        if (!row.submitted_by_user_id) return;
        try {
            const db = await getDatabase();

            let globalGameId: string | null = null;
            if (row.game_id) {
                const g = await db.get('SELECT global_game_id FROM games WHERE id = ?', row.game_id);
                globalGameId = g?.global_game_id ?? null;
            }

            const clauses = [
                'origin_game_room_id = ?',
                'player_id = ?',
                'LOWER(iscored_username) = LOWER(?)',
                'score = ?',
                'deleted_at IS NULL',
            ];
            const params: any[] = [
                row.game_room_id, row.submitted_by_user_id, row.iscored_username, row.score,
            ];
            if (globalGameId) {
                clauses.push('global_game_id = ?');
                params.push(globalGameId);
            }

            const candidates = await db.all<Array<{ id: string }>>(
                `SELECT id FROM global_scores WHERE ${clauses.join(' AND ')}`,
                ...params,
            );
            if (candidates.length !== 1) {
                logDebug(
                    `Global fan-out cleanup skipped for score_history#${row.id}: ${candidates.length} global_scores candidates ` +
                    `(room ${row.game_room_id}, player "${row.iscored_username}", score ${row.score})`,
                );
                return;
            }

            const { GlobalScoreService } = await import('./GlobalScoreService.js');
            const ok = await GlobalScoreService.softDelete(candidates[0]!.id, actorId);
            if (ok) logInfo(`Global fan-out cleanup: global_scores#${candidates[0]!.id} soft-deleted with score_history#${row.id}`);
        } catch (err) {
            logDebug(`Global fan-out cleanup failed for score_history#${row.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
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
