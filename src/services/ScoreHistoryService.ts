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
    /** Set once an admin has verified this exact number (S23.7). */
    verified_at?: string | null;
    /** The tournament window this score was submitted during, if any. */
    submitted_during_tournament_id?: string | null;
}

export class ScoreHistoryService {
    /**
     * Would `log` swallow this row as a duplicate?
     *
     * Extracted from `log` in v2.139.0 so the AtGames sync's DRY RUN can report
     * "already had this one" using the EXACT rule the real write uses. Two
     * copies of this predicate would drift, and a dry run that disagrees with
     * the run it is previewing is worse than no dry run at all.
     *
     * v2.135.0 (ADR 0017): when a `gameId` is supplied the dedup is scoped to
     * THAT row. A Live Event can feature the same table in two rounds, and a
     * player who posts an identical score in both is not submitting a
     * duplicate — round 2 would otherwise be silently swallowed and the
     * standings would show them as having missed it. Callers without a gameId
     * (every rotation path) keep the original room-wide behaviour.
     */
    static async isDuplicate(params: {
        gameName: string;
        gameRoomId: string | null;
        gameId?: string;
        username: string;
        score: number;
        /**
         * v2.155.3 — THREE-valued: `undefined` (the parameter simply omitted)
         * means "don't constrain by tournament", preserving every caller's
         * behaviour from before this parameter existed. `null` OR a string
         * means "constrain — the row must carry exactly this
         * `submitted_during_tournament_id`". `null` is a real, meaningful
         * value here (a Global-fallback / no-active-tournament row), so the
         * two "don't care" / "must be null" cases cannot be collapsed into
         * one `? IS NULL OR ...` clause — an explicit flag decides which
         * clause applies.
         *
         * Why this matters: one play may be submitted to EACH tournament
         * currently running the table — Black Rose ACTIVE in both Weekly
         * Grind - VR and Daily Grind is two independent score events, not a
         * duplicate. The SAME score into the SAME tournament is still a
         * re-send and must still be dropped. Dedup that ignored the
         * tournament stamp entirely (pre-v2.155.3) silently swallowed the
         * second tournament's `score_history` row while its `submissions`
         * row (a separate table, deduped differently) still wrote — the
         * game's OWN leaderboard, which reads `score_history` filtered by
         * its own tournament id, never saw the score at all.
         */
        tournamentId?: string | null;
    }): Promise<boolean> {
        const db = await getDatabase();
        const constrainTournament = params.tournamentId !== undefined;
        const existing = await db.get(
            `SELECT id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND LOWER(iscored_username) = LOWER(?) AND score = ?
               AND (? IS NULL OR game_id IS ?)
               AND (? = 0 OR submitted_during_tournament_id IS ?)
             LIMIT 1`,
            params.gameRoomId, params.gameName, params.username, params.score,
            params.gameId ?? null, params.gameId ?? null,
            constrainTournament ? 1 : 0, params.tournamentId ?? null,
        );
        return !!existing;
    }

    /**
     * Log a score entry to history. Called alongside every score submission.
     */
    static async log(params: {
        gameName: string;
        /**
         * NULL for a Throwdown (v2.136.0, ADR 0018) — a room-less challenge has
         * no game room. Every other caller passes a room, and the column stayed
         * NOT NULL until migration 164 precisely so this could never happen by
         * accident; it is now deliberate and narrow.
         */
        gameRoomId: string | null;
        gameId?: string;
        username: string;
        discordUserId?: string;
        score: number;
        photoUrl?: string;
        /**
         * P7: `'atgames'` is a score Arcaid pulled from an AtGames private
         * tournament. It is deliberately its own value — not `'tournament'`
         * (Arcaid never saw the submit), not `'sync'` (that means iScored, and
         * forces unknown provenance per ADR 0016 P2 while these rows know their
         * cabinet), not `'community'` (these count for standings). Widening the
         * column's CHECK cost a rebuild; see migration 167.
         */
        /**
         * P9: `'vpx'` is a score the Arcaid Witness read out of the VPX
         * launcher's own scoreserver records on a cabinet stick. Nobody
         * submitted it and no third-party board ever held it — AtGames does
         * not know these tables exist — so it is neither `'tournament'` nor
         * `'atgames'`. Widening the column's CHECK cost a second rebuild; see
         * migration 172.
         */
        source: 'tournament' | 'community' | 'sync' | 'atgames' | 'vpx';
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
        /**
         * v2.145.0 (P8) — an explicit `created_at` in SQLite UTC shape
         * (`'YYYY-MM-DD HH:MM:SS'`), for a caller that INGESTS a score somebody
         * else timestamped rather than witnessing the submit itself.
         *
         * The AtGames sync is the only such caller today, and it must pass one:
         * AtGames is exit-to-submit, so its timestamp IS the moment the player
         * left the table. Defaulting to `CURRENT_TIMESTAMP` would stamp the
         * row with the HOST'S "Pull scores" click instead, which breaks two
         * things at once — `elapsed_sec` on the round board would measure the
         * host's clicking, not the play, and `WitnessVerifyService`'s
         * `exit_ts ≈ created_at` join would have nothing real to join on.
         *
         * Deliberately NOT part of `isDuplicate`: the dedup key is
         * (room, game, player, score), so a re-pull still recognises rows that
         * were ingested before this parameter existed.
         */
        createdAt?: string;
    }): Promise<number | null> {
        const db = await getDatabase();

        // v2.1.0: auto-resolve the active tournament for this room+game so
        // every score_history row carries submitted_during_tournament_id.
        // Tournament leaderboards use this as the primary filter (replaces the
        // submissions table as the source of truth for "best-score-during-
        // this-tournament"). Only populated when the game is ACTIVE — once
        // COMPLETED, the tournament window for that game is closed, so new
        // submissions don't count toward it.
        //
        // v2.155.1: this used to run its OWN name lookup with no ORDER BY,
        // which could disagree with the submit routes' `submissions` upsert
        // when a room had two ACTIVE games sharing a name in different
        // tournaments — the row landed on one tournament in `submissions` and
        // a DIFFERENT one here. `resolveSubmissionGame` is now the ONE answer
        // both paths share; see `SubmissionGameResolver.ts`.
        //
        // v2.155.3 — resolved BEFORE the dedup check below (was after), so
        // `isDuplicate` can constrain on the SAME tournament this row is
        // about to be stamped with: one play may be submitted to EACH
        // tournament currently running the table (Black Rose ACTIVE in both
        // Weekly Grind - VR and Daily Grind is two independent score events),
        // and only a re-send into the SAME tournament should be dropped.
        let submittedTournamentId = params.tournamentId ?? null;
        if (!submittedTournamentId && !params.skipTournamentLink && params.gameRoomId && params.gameName) {
            const { resolveSubmissionGame } = await import('./SubmissionGameResolver.js');
            const resolved = await resolveSubmissionGame({
                roomId: params.gameRoomId,
                gameName: params.gameName,
                gameId: params.gameId ?? null,
            });
            submittedTournamentId = resolved && resolved.status === 'ACTIVE' ? resolved.tournament_id : null;
        }

        // v2.125.1: returns the new row's id (null when deduped) so the submit
        // path can exclude it from the "previous best" computation.
        if (await ScoreHistoryService.isDuplicate({ ...params, tournamentId: submittedTournamentId })) return null;

        const submittedByUserId = normalizeSubmitterUserId(params.discordUserId);
        const submittedByAnonymousName =
            params.anonymousName ?? (submittedByUserId ? null : params.username);

        // `created_at` is named in the column list ONLY when the caller
        // supplied one — otherwise the column is left off entirely so the
        // table's `CURRENT_TIMESTAMP` default applies, exactly as before.
        const withCreatedAt = !!params.createdAt;
        const inserted = await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, photo_url, source,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                engine, device${withCreatedAt ? ', created_at' : ''}
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?${withCreatedAt ? ', ?' : ''})`,
            ...[
                params.gameName, params.gameRoomId, params.gameId || null,
                params.username, params.discordUserId || 'SYSTEM',
                params.score, params.photoUrl || null, params.source,
                params.gameRoomId, submittedTournamentId, submittedByUserId, submittedByAnonymousName,
                params.platform ?? null,
                params.engine || UNKNOWN, params.device || UNKNOWN,
                ...(withCreatedAt ? [params.createdAt] : []),
            ],
        );

        // Sprint 6.5: any Discord-authenticated score establishes room membership.
        // addMember is sentinel-aware, so SYSTEM/ANON/etc. calls are no-ops.
        // Skipped entirely for a room-less Throwdown — there is no room to join,
        // and passing null here would write a membership row pointing nowhere.
        if (params.gameRoomId) {
            await RoomMembershipService.addMember(submittedByUserId, params.gameRoomId, 'submission');
        }
        return typeof inserted.lastID === 'number' ? inserted.lastID : null;
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
                    source, submitted_by_user_id, photo_url, verified_at,
                    submitted_during_tournament_id
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
        const resolvedGameId = await this.resolveGameIdForRow(row);

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
    /**
     * Which `games` row does this score belong to?
     *
     * `row.game_id` is a TRANSIENT pointer (v2.75.1 doctrine): web submissions
     * write it as NULL from the start, and rotation NULLs it on synced rows
     * later. Prod evidence (2026-08-14, the Strike scores): every modern web
     * row has game_id NULL, so anything gated on `row.game_id` alone silently
     * skips the common case. Resolve by (room, name) ACTIVE-first instead —
     * the same ORDER BY contract the submit handlers adopted in v2.100.3 —
     * because the poller dedup and winner resolution both operate against the
     * ACTIVE run's game row.
     *
     * `games.game_room_id` is an ALTER-added denormalized column (NULL on rows
     * that predate it), so room scoping goes through
     * COALESCE(g.game_room_id, t.game_room_id) — the LEFT JOIN idiom the admin
     * wipe path uses for its ownedByRoom check.
     */
    private static async resolveGameIdForRow(row: DeletableScoreRow): Promise<string | null> {
        if (row.game_id) return row.game_id;
        const db = await getDatabase();
        const gameRow = await db.get<{ id: string }>(
            `SELECT g.id FROM games g
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE COALESCE(g.game_room_id, t.game_room_id) = ?
               AND LOWER(g.name) = LOWER(?)
             ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.created_at DESC
             LIMIT 1`,
            row.game_room_id, row.game_name,
        );
        return gameRow?.id ?? null;
    }

    /**
     * Admin score CORRECTION — change a score's value in place.
     *
     * ## Why this exists
     *
     * Owner incident, 2026-08-30: a player typed one digit too many
     * (`66,661,589,860` for `6,666,158,980`) on a Daily Grind table that had
     * since rotated to COMPLETED. Arcaid had no edit path at any privilege
     * level, so the only two remedies were both wrong:
     *
     *   - DELETE the row. That writes a `deleted_score_suppressions` tombstone
     *     at the WRONG (inflated) value, drops the player to their previous
     *     best — which in that incident handed the win to a different player —
     *     and there is no way to put the right number back, because every
     *     submit path requires `games.status = 'ACTIVE'`.
     *   - Hand-written SQL against production, across three tables.
     *
     * A typo in an otherwise-valid score is not moderation. It needs an
     * UPDATE, and that is all this is.
     *
     * ## What it deliberately does NOT do
     *
     * No tombstone on the corrected row (a tombstone means "this score should
     * not exist"; this one should, at a different value), no photo cleanup
     * (the evidence still belongs to the score), and none of the submit-time
     * side effects — no lobby-feed event, no score toast, no notifications, no
     * Global fan-out CREATION. A correction is bookkeeping, not a new score,
     * and re-announcing it would tell the room somebody just played.
     *
     * ## The iScored guard
     *
     * `IScoredApiClient` can submit a score but cannot edit or delete one, so
     * on a room mirrored to iScored the old value survives on their board and
     * `ScoreSyncPoller` would re-import it within a cycle — silently undoing
     * the correction. When the value goes DOWN we therefore tombstone at the
     * OLD score, which is exactly what the poller's `score <= suppressed_score`
     * skip needs. The cost is real and bounded: a later genuine score for this
     * player on this game that falls between the new and old values is also
     * suppressed until an admin clears it (Manage Scores → Suppressions).
     * Corrections UPWARD need no guard — the poller only ever raises a score.
     *
     * The guard is skipped entirely when the room resolves to NO iScored
     * credentials, because then the poller never reads that room and the
     * tombstone could only ever cost the admin a future score (owner request,
     * 2026-08-31, after RTX_Pinball dropped iScored). The predicate is
     * `getIScoredCredsForRoom` — the SAME resolution the poller uses to decide
     * whether to poll at all — rather than a bare `ISCORED_ENABLED` read, so
     * "disabled", "partially configured" and "no env fallback" cannot disagree
     * between the two. `deleteEvent`'s tombstone is deliberately left
     * unconditional: there the row is GONE, so a stray suppression is the
     * cheaper mistake.
     *
     * Authorization is the CALLER's job (admins only — see the route).
     */
    static async correctScore(
        row: DeletableScoreRow,
        newScore: number,
        actorId: string,
    ): Promise<{ resolvedGameId: string | null; suppressedAt: number | null }> {
        if (!Number.isInteger(newScore) || newScore < 0) {
            throw new Error('A corrected score must be a non-negative integer');
        }
        const db = await getDatabase();
        const oldScore = row.score;

        // Both twin lookups match on the OLD score, so they run BEFORE the update.
        const communityTwinId = row.source === 'community'
            ? await this.findCommunityScoreTwinId(row)
            : null;
        const globalScoreId = await this.findFannedOutGlobalScoreId(row);

        await db.run('UPDATE score_history SET score = ? WHERE id = ?', newScore, row.id);

        if (communityTwinId !== null) {
            await db.run('UPDATE community_scores SET score = ? WHERE id = ?', newScore, communityTwinId);
            logInfo(`Community cascade: community_scores#${communityTwinId} corrected with score_history#${row.id}`);
        }
        if (globalScoreId !== null) {
            // Direct UPDATE rather than GlobalScoreService: it has no "correct"
            // verb, and its create path would re-run the submit-time side
            // effects this must not.
            await db.run('UPDATE global_scores SET score = ? WHERE id = ?', newScore, globalScoreId);
            const { GlobalLeaderboardService } = await import('./GlobalLeaderboardService.js');
            await GlobalLeaderboardService.invalidateAll();
            logInfo(`Global fan-out: global_scores#${globalScoreId} corrected with score_history#${row.id}`);
        }

        const resolvedGameId = await this.resolveGameIdForRow(row);

        let suppressedAt: number | null = null;
        if (resolvedGameId && newScore < oldScore && await this.roomSyncsToIScored(row.game_room_id)) {
            await db.run(
                `INSERT INTO deleted_score_suppressions
                    (game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)
                 VALUES (?, LOWER(?), ?, datetime('now'), ?)
                 ON CONFLICT(game_id, iscored_username_lower) DO UPDATE SET
                    suppressed_score = MAX(suppressed_score, excluded.suppressed_score),
                    deleted_at = datetime('now'),
                    deleted_by_user_id = excluded.deleted_by_user_id`,
                resolvedGameId, row.iscored_username, oldScore, actorId,
            );
            suppressedAt = oldScore;
        }

        // Recompute best-per-player-per-game across ALL sources, by
        // (room, name) — the same rule `deleteEvent` uses, for the same reason
        // (game_id is NULL on web rows; both the room board and the mirrored
        // iScored board are name-scoped across reruns).
        if (resolvedGameId) {
            const submissionId = `${resolvedGameId}-${row.iscored_username.toLowerCase()}`;
            const best = await db.get<{ score: number; created_at: string }>(
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
            if (best) {
                await db.run(
                    'UPDATE submissions SET score = ?, timestamp = ? WHERE id = ?',
                    best.score, best.created_at, submissionId,
                );
            }
            const { LeaderboardService } = await import('./LeaderboardService.js');
            await LeaderboardService.invalidate(resolvedGameId);
            const { emitLeaderboardUpdated } = await import('../api/websocket.js');
            emitLeaderboardUpdated(row.game_room_id, { gameId: resolvedGameId });
        }

        logInfo(
            `score_history#${row.id} corrected by ${actorId}: ${oldScore} -> ${newScore} ` +
            `(player ${row.iscored_username}, game ${row.game_name})` +
            (suppressedAt !== null ? ` [iScored re-import suppressed at ${suppressedAt}]` : ''),
        );
        return { resolvedGameId, suppressedAt };
    }

    /**
     * May the person who SUBMITTED this score correct it themselves?
     *
     * Owner ruling 2026-08-31: "I want players to be able to edit their own
     * scores just as easily, unless the card is locked — in which case they
     * will need an admin."
     *
     * **"Locked" means the game is no longer ACTIVE.** That is not a new flag:
     * it is the same line the submission sheet already draws
     * (`isCooldownLocked` = `gameStatus !== 'ACTIVE'`), and both admin lock
     * affordances — "Force Complete" and "Lock on iScored" — move a game out of
     * ACTIVE. So a player may fix their own typo while the round is still
     * running, and once it closes and the result is settled the correction
     * becomes an admin action. Adding a separate `games.locked` column would
     * have created a second, drifting answer to the same question.
     *
     * The ACTIVE game is matched by (room, name) — `game_id` is NULL on every
     * modern web row (v2.75.1) — and, when the score carries a tournament
     * stamp, that stamp must match the active game's tournament. Without that
     * second clause a table rotating back round would silently re-open editing
     * on a player's scores from the PREVIOUS run of it.
     *
     * An admin-VERIFIED row is closed to its owner regardless: an admin
     * asserted that exact number, and letting the owner change it afterwards
     * would leave the verification badge attached to a value nobody checked.
     *
     * Returns the reason on refusal so the route can say which rule applied.
     * Admins bypass this entirely — see the route's tiers.
     */
    static async ownerCorrectionWindow(
        row: DeletableScoreRow,
    ): Promise<{ open: true } | { open: false; reason: 'locked' | 'verified' }> {
        if (row.verified_at) return { open: false, reason: 'verified' };
        const db = await getDatabase();
        const active = await db.get<{ id: string; tournament_id: string | null }>(
            `SELECT g.id, g.tournament_id FROM games g
             LEFT JOIN tournaments t ON t.id = g.tournament_id
             WHERE COALESCE(g.game_room_id, t.game_room_id) = ?
               AND LOWER(g.name) = LOWER(?)
               AND g.status = 'ACTIVE'
             ORDER BY g.created_at DESC
             LIMIT 1`,
            row.game_room_id, row.game_name,
        );
        if (!active) return { open: false, reason: 'locked' };
        const stamp = row.submitted_during_tournament_id ?? null;
        if (stamp && stamp !== active.tournament_id) return { open: false, reason: 'locked' };
        return { open: true };
    }

    /**
     * Does `ScoreSyncPoller` actually read this room from iScored?
     *
     * Answered by the poller's own credential resolution, so a room that is
     * switched off, half-configured, or relying on an absent env fallback all
     * give the same answer here as they do there. A NULL room (a Throwdown —
     * `score_history.game_room_id` is nullable since migration 164) is never
     * synced: Throwdowns have no iScored integration by construction, and
     * falling through to the env account would be wrong on top of that.
     *
     * Never throws — a settings-read failure degrades to "yes, it might sync",
     * which keeps the protective tombstone rather than dropping it on an error.
     */
    private static async roomSyncsToIScored(gameRoomId: string | null): Promise<boolean> {
        if (!gameRoomId) return false;
        try {
            const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
            return !!(await getIScoredCredsForRoom(gameRoomId));
        } catch (err) {
            logDebug(`iScored creds check failed for room ${gameRoomId}; assuming it syncs: ${err instanceof Error ? err.message : String(err)}`);
            return true;
        }
    }

    private static async findCommunityScoreTwinId(row: DeletableScoreRow): Promise<number | null> {
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
            return null;
        }
        return candidates[0]!.id;
    }

    private static async deleteCommunityScoreTwin(row: DeletableScoreRow): Promise<void> {
        try {
            const id = await this.findCommunityScoreTwinId(row);
            if (id === null) return;
            const db = await getDatabase();
            await db.run('DELETE FROM community_scores WHERE id = ?', id);
            logInfo(`Community cascade: community_scores#${id} deleted with score_history#${row.id}`);
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
    private static async findFannedOutGlobalScoreId(row: DeletableScoreRow): Promise<string | null> {
        if (!row.submitted_by_user_id) return null;
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
            return null;
        }
        return candidates[0]!.id;
    }

    private static async softDeleteFannedOutGlobalScore(row: DeletableScoreRow, actorId: string): Promise<void> {
        if (!row.submitted_by_user_id) return;
        try {
            const id = await this.findFannedOutGlobalScoreId(row);
            if (id === null) return;
            const { GlobalScoreService } = await import('./GlobalScoreService.js');
            const ok = await GlobalScoreService.softDelete(id, actorId);
            if (ok) logInfo(`Global fan-out cleanup: global_scores#${id} soft-deleted with score_history#${row.id}`);
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
