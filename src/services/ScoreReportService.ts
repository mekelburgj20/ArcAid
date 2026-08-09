import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { GlobalScoreService } from './GlobalScoreService.js';
import { BanService } from './BanService.js';
import { BanNotificationService } from './BanNotificationService.js';
import { isDiscordUserId } from '../utils/identityProvider.js';
import { deleteScorePhotoFiles } from '../utils/scorePhotoCleanup.js';
import { logInfo, logError } from '../utils/logger.js';

export type ReportResolution = 'dismissed' | 'deleted' | 'banned';

/**
 * Ban → content cascade (ROADMAP "Player Self-Service + Moderation" §C).
 * Chosen per ban-create call: 'hide' (default, soft — reversible on lift),
 * 'delete' (hard — NOT reversible), 'leave' (no action).
 */
export type BanContentAction = 'hide' | 'delete' | 'leave';

export interface ScoreReport {
    id: string;
    score_id: string;
    reporter_discord_id: string;
    reason: string | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution: string | null;
    /** S23.6 — see `ScoreSource`. Pre-S23 rows read 'global' via the column DEFAULT. */
    score_source: ScoreSource;
    /** S23.6 — set only for 'room_history' rows. */
    game_room_id: string | null;
}

/**
 * S23.6 — which table `score_reports.score_id` points at.
 *   'global'       → `global_scores.id` (the pre-S23 shape; the column's DEFAULT)
 *   'room_history' → `score_history.id`, with `game_room_id` set
 */
export type ScoreSource = 'global' | 'room_history';

export interface ScoreReportWithContext extends ScoreReport {
    /** S23.6 — discriminator; 'global' for every pre-S23 row. */
    score_source: ScoreSource;
    /** S23.6 — the reporting room for 'room_history' rows; NULL for global. */
    game_room_id: string | null;
    /** S23.6 — resolved room name, for the Reports page scope column. */
    room_name: string | null;
    // Joined global_scores fields
    global_game_id: string | null;
    player_id: string | null;
    iscored_username: string | null;
    score: number | null;
    photo_url: string | null;
    origin_type: string | null;
    origin_game_room_id: string | null;
    submitted_at: string | null;
    score_deleted_at: string | null;
    game_name: string | null;
    /** v2.49.0 (room-bans contract, Workstream 2) — resolved via user_profiles. */
    reporter_display_name: string | null;
    reporter_username: string | null;
}

export interface UserBan {
    id: string;
    discord_user_id: string;
    reason: string | null;
    banned_by: string;
    banned_at: string;
    expires_at: string | null;
    lifted_at: string | null;
    lifted_by: string | null;
    /** v2.49.0 — room-tier bans. NULL = global ban (pre-v2.49 shape). */
    game_room_id: string | null;
}

/** v2.49.0 (room-bans contract, Workstream 2) — `UserBan` plus resolved
 *  display names for the three identity columns, and the owning room's name
 *  (null for a global ban). Powers the Reports "Bans" tab scope column and
 *  the room-admin bans list — both render names instead of bare snowflakes. */
export interface UserBanEnriched extends UserBan {
    room_name: string | null;
    discord_user_display_name: string | null;
    discord_user_username: string | null;
    banned_by_display_name: string | null;
    banned_by_username: string | null;
    lifted_by_display_name: string | null;
    lifted_by_username: string | null;
}

/**
 * Admin-facing service for managing score reports and user bans.
 *
 * Report flow: user POSTs a report via /api/global/scores/:scoreId/report → admin
 * sees it in the queue → resolves it with one of: dismiss, soft-delete, hard-delete,
 * ban user. Resolution is recorded and the report is hidden from the default queue.
 */
/**
 * S23.6 — one SELECT list serving both report kinds.
 *
 * The two joins are mutually exclusive by `score_source`, so exactly one side
 * is non-NULL per row and the COALESCEs pick it. `CAST(r.score_id AS INTEGER)`
 * is load-bearing: `score_reports.score_id` is TEXT and `score_history.id` is
 * INTEGER, and SQLite compares across storage classes by class rank (every TEXT
 * sorts above every INTEGER) — without the cast the join silently matches
 * nothing.
 */
const REPORT_CONTEXT_SELECT = `
    SELECT
        r.id, r.score_id, r.reporter_discord_id, r.reason, r.created_at,
        r.resolved_at, r.resolved_by, r.resolution,
        r.score_source, r.game_room_id,
        s.global_game_id,
        COALESCE(s.player_id, sh.submitted_by_user_id) as player_id,
        COALESCE(s.iscored_username, sh.iscored_username) as iscored_username,
        COALESCE(s.score, sh.score) as score,
        COALESCE(s.photo_url, sh.photo_url) as photo_url,
        s.origin_type,
        COALESCE(s.origin_game_room_id, r.game_room_id) as origin_game_room_id,
        COALESCE(s.submitted_at, sh.created_at) as submitted_at,
        s.deleted_at as score_deleted_at,
        COALESCE(gg.name, sh.game_name) as game_name,
        gr.name as room_name,
        up.display_name as reporter_display_name, up.username as reporter_username
     FROM score_reports r
     LEFT JOIN global_scores s ON r.score_source = 'global' AND s.id = r.score_id
     LEFT JOIN global_games gg ON gg.id = s.global_game_id
     LEFT JOIN score_history sh ON r.score_source = 'room_history' AND sh.id = CAST(r.score_id AS INTEGER)
     LEFT JOIN game_rooms gr ON gr.id = r.game_room_id
     LEFT JOIN user_profiles up ON up.discord_user_id = r.reporter_discord_id
`;

export class ScoreReportService {
    /**
     * List pending (unresolved) reports with full context: the reported score,
     * the player, the game, and the originating room.
     */
    static async listPending(limit = 100, offset = 0): Promise<ScoreReportWithContext[]> {
        const db = await getDatabase();
        return db.all(
            `${REPORT_CONTEXT_SELECT}
             WHERE r.resolved_at IS NULL
             ORDER BY r.created_at ASC
             LIMIT ? OFFSET ?`,
            limit, offset
        );
    }

    /**
     * List resolved reports for audit/history views.
     */
    static async listResolved(limit = 100, offset = 0): Promise<ScoreReportWithContext[]> {
        const db = await getDatabase();
        return db.all(
            `${REPORT_CONTEXT_SELECT}
             WHERE r.resolved_at IS NOT NULL
             ORDER BY r.resolved_at DESC
             LIMIT ? OFFSET ?`,
            limit, offset
        );
    }

    static async getById(reportId: string): Promise<ScoreReport | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM score_reports WHERE id = ?', reportId);
    }

    /**
     * Dismiss a report — no action taken against the score.
     */
    static async dismiss(reportId: string, adminDiscordId: string): Promise<boolean> {
        return this.resolveReport(reportId, adminDiscordId, 'dismissed');
    }

    /**
     * S23.6 — delete the reported score, whichever table it lives in.
     *
     * `global_scores` supports soft delete (a `deleted_at` tombstone), so both
     * the soft and hard variants below are meaningful there. `score_history`
     * has no soft-delete concept: its removal goes through
     * `ScoreHistoryService.deleteEvent`, the SAME machinery the per-row delete
     * route uses (row drop → photo cleanup → `deleted_score_suppressions`
     * tombstone so the sync poller can't re-import it → `submissions`
     * recompute → invalidate + broadcast). Deliberately reused rather than
     * forked — the recompute is the subtle part.
     */
    private static async removeReportedScore(
        report: ScoreReport, adminDiscordId: string, hard: boolean,
    ): Promise<boolean> {
        if (report.score_source === 'room_history') {
            const { ScoreHistoryService } = await import('./ScoreHistoryService.js');
            const row = await ScoreHistoryService.getDeletableRow(Number(report.score_id));
            // Already gone (e.g. the player self-deleted, or a sibling report
            // removed it first) — still a successful resolution.
            if (row) await ScoreHistoryService.deleteEvent(row, adminDiscordId);
            return true;
        }
        if (hard) {
            await GlobalScoreService.hardDelete(report.score_id);
        } else {
            await GlobalScoreService.softDelete(report.score_id, adminDiscordId);
        }
        return true;
    }

    /**
     * Resolve by soft-deleting the score. Also resolves any other open reports
     * on the same score so the admin doesn't have to dismiss them one by one.
     */
    static async softDeleteScore(reportId: string, adminDiscordId: string): Promise<boolean> {
        const report = await this.getById(reportId);
        if (!report) return false;
        await this.removeReportedScore(report, adminDiscordId, false);
        await this.resolveAllForScore(report.score_id, report.score_source, adminDiscordId, 'deleted');
        logInfo(`Score ${report.score_id} (${report.score_source}) soft-deleted via report ${reportId} by ${adminDiscordId}`);
        return true;
    }

    /**
     * Resolve by hard-deleting the score (permanent, removes photo file too).
     */
    static async hardDeleteScore(reportId: string, adminDiscordId: string): Promise<boolean> {
        const report = await this.getById(reportId);
        if (!report) return false;
        await this.removeReportedScore(report, adminDiscordId, true);
        await this.resolveAllForScore(report.score_id, report.score_source, adminDiscordId, 'deleted');
        logInfo(`Score ${report.score_id} (${report.score_source}) hard-deleted via report ${reportId} by ${adminDiscordId}`);
        return true;
    }

    /**
     * Resolve by banning the player and deleting the score.
     * `durationDays` = null means permanent.
     *
     * S23.6 — for a room report the identity comes from
     * `score_history.submitted_by_user_id`. When that's NULL the score is
     * anonymous and there is NO identity to ban: we refuse rather than guess
     * one from the display name (names are first-claim-wins per room and are
     * not identities).
     */
    static async banUser(
        reportId: string,
        adminDiscordId: string,
        durationDays: number | null,
        banReason?: string,
        contentAction: BanContentAction = 'hide',
    ): Promise<boolean | { error: string }> {
        const report = await this.getById(reportId);
        if (!report) return false;

        const db = await getDatabase();
        let playerId: string | null;
        if (report.score_source === 'room_history') {
            const row = await db.get(
                'SELECT submitted_by_user_id FROM score_history WHERE id = ?',
                Number(report.score_id),
            );
            if (!row) return false;
            playerId = row.submitted_by_user_id ?? null;
            if (!playerId) {
                return { error: 'Cannot ban: this is an anonymous score with no linked account.' };
            }
        } else {
            const score = await db.get('SELECT player_id FROM global_scores WHERE id = ?', report.score_id);
            if (!score) return false;
            playerId = score.player_id;
        }

        await this.ban(
            playerId!, adminDiscordId, durationDays, banReason || report.reason || undefined,
            // A room report bans within that room; a global report bans globally.
            report.score_source === 'room_history' ? report.game_room_id : null,
            contentAction,
        );
        await this.removeReportedScore(report, adminDiscordId, false);
        await this.resolveAllForScore(report.score_id, report.score_source, adminDiscordId, 'banned');
        logInfo(`User ${playerId} banned via report ${reportId} by ${adminDiscordId} (duration: ${durationDays ?? 'permanent'})`);
        return true;
    }

    /**
     * Mark a single report row as resolved.
     */
    private static async resolveReport(
        reportId: string,
        adminDiscordId: string,
        resolution: ReportResolution
    ): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE score_reports
             SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?
             WHERE id = ? AND resolved_at IS NULL`,
            adminDiscordId, resolution, reportId
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Mark ALL unresolved reports for a given score as resolved — used when an
     * admin takes an action that would affect every outstanding report on that score.
     */
    private static async resolveAllForScore(
        scoreId: string,
        scoreSource: ScoreSource,
        adminDiscordId: string,
        resolution: ReportResolution
    ): Promise<void> {
        const db = await getDatabase();
        // S23.6: `score_source` is part of the key. A `score_history.id` is a
        // small integer rendered as text, so without it a room report could in
        // principle sweep an unrelated global report that happened to share the
        // string.
        await db.run(
            `UPDATE score_reports
             SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?
             WHERE score_id = ? AND score_source = ? AND resolved_at IS NULL`,
            adminDiscordId, resolution, scoreId, scoreSource
        );
    }

    // --- User bans ---

    /**
     * Ban a user. `durationDays` = null → permanent, otherwise expires_at is set.
     * `gameRoomId` omitted/null → global ban (pre-v2.49 shape, unaffected).
     * Passed → a room-tier ban (v2.49.0, room-bans contract) that only bites
     * inside that room — see `BanService.isIdentityBanned`'s doc comment.
     *
     * `contentAction` (ban → content cascade, ROADMAP §C) — 'hide' (default),
     * 'delete', or 'leave'. Applied as a follow-on AFTER the ban row commits,
     * not inside a new transaction: the room-ban route (rooms.ts) already
     * wraps this call in its own `BEGIN...COMMIT` on the same shared
     * connection, and this driver/DB has no true nested-transaction support
     * (a known flake source — see CLAUDE.md's "BE nested-transaction family"
     * note) — issuing another BEGIN here would either error or silently
     * merge into the outer one depending on call site, which is exactly the
     * kind of inconsistency to avoid. Piggybacking as sequential statements
     * on the same connection means the room-ban path still gets the cascade
     * INSIDE that route's transaction "for free" (same connection, same
     * uncommitted transaction), while the global-ban path (admin.ts, no
     * surrounding transaction) gets it as an immediately-following statement.
     * Either way, a cascade failure is caught and logged here so it can never
     * fail the ban itself — the ban row is the source of truth for
     * enforcement; the cascade is best-effort cleanup on top of it.
     */
    static async ban(
        discordUserId: string,
        bannedBy: string,
        durationDays: number | null,
        reason?: string,
        gameRoomId?: string | null,
        contentAction: BanContentAction = 'hide',
    ): Promise<UserBan> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        const now = new Date();
        const expiresAt = durationDays !== null
            ? new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
            : null;
        await db.run(
            `INSERT INTO user_bans (id, discord_user_id, reason, banned_by, expires_at, game_room_id)
             VALUES (?, ?, ?, ?, ?, ?)`,
            id, discordUserId, reason || null, bannedBy, expiresAt, gameRoomId ?? null
        );
        // v2.47.0 (S22 follow-ups Workstream 1; L2 hardening) — drop
        // BanService's cache so per-submit enforcement takes effect
        // immediately instead of waiting out the 10s TTL. Full clearCache()
        // rather than invalidate(discordUserId) alone — a linked alias's
        // cached "not banned" result is keyed separately and would otherwise
        // stay stale for up to 10s (see BanService.clearCache doc comment).
        BanService.clearCache();

        // Full identity-link expansion (same graph enforcement checks) so the
        // cascade and DM catch content/DM-ability under a linked alias too —
        // banning a `google:*` id whose linked Discord account authored the
        // scores/comments must still hide them, and DM the Discord side.
        const candidates = await BanService.expandIdentityCandidates(discordUserId);

        try {
            await this.applyBanContentCascade(id, candidates, gameRoomId ?? null, contentAction);
        } catch (err) {
            logError(`ScoreReportService.ban: content cascade failed for ban ${id} (non-fatal — ban still applied):`, err);
        }

        try {
            await this.sendBanNotification(candidates, gameRoomId ?? null, reason, expiresAt);
        } catch (err) {
            logError(`ScoreReportService.ban: DM failed for ban ${id} (non-fatal — ban still applied):`, err);
        }

        return (await db.get('SELECT * FROM user_bans WHERE id = ?', id)) as UserBan;
    }

    /**
     * Lift an active ban (set lifted_at). Doesn't delete the row — we keep the
     * history so a repeat offender's record is visible.
     *
     * Also restores every row this ban's cascade HID (action='hide' in
     * `ban_content_actions`) — deliberate design call: the room-ban precedent
     * ("lifting does not auto-restore membership", rooms.ts decision 1)
     * applies to MEMBERSHIP, not content. Content soft-hide exists FOR
     * reversibility, so restoring it on lift is the whole point of choosing
     * 'hide' over 'delete' in the first place. Rows the cascade DELETED are
     * never restored (gone for good) — `restoredCount` only ever counts the
     * hidden rows that came back.
     */
    static async lift(banId: string, liftedBy: string): Promise<{ lifted: boolean; restoredCount: number }> {
        const db = await getDatabase();
        const ban = await db.get<{ discord_user_id: string }>(
            'SELECT discord_user_id FROM user_bans WHERE id = ?', banId
        );
        const result = await db.run(
            `UPDATE user_bans
             SET lifted_at = datetime('now'), lifted_by = ?
             WHERE id = ? AND lifted_at IS NULL`,
            liftedBy, banId
        );
        const changed = (result.changes ?? 0) > 0;
        // v2.47.0 (S22 follow-ups Workstream 1; L2 hardening) — same
        // cache-freshness rationale as `ban()`: an unban must also take
        // effect immediately, across every linked-alias cache key.
        if (changed && ban?.discord_user_id) BanService.clearCache();
        if (!changed) return { lifted: false, restoredCount: 0 };

        let restoredCount = 0;
        try {
            restoredCount = await this.restoreBanContentActions(banId);
        } catch (err) {
            logError(`ScoreReportService.lift: content restore failed for ban ${banId} (non-fatal — ban still lifted):`, err);
        }
        return { lifted: true, restoredCount };
    }

    /** Tables the content cascade can touch, and which "hidden" column each
     *  uses. Allowlist — `table_name` is only ever written by our own
     *  cascade code below, but names are still validated against this map
     *  before being interpolated into SQL (table names can't be bound
     *  parameters). */
    private static readonly HIDEABLE_TABLES: Record<string, 'orphaned_at' | 'hidden_at'> = {
        submissions: 'orphaned_at',
        community_scores: 'orphaned_at',
        score_history: 'orphaned_at',
        game_comments: 'hidden_at',
        global_game_comments: 'hidden_at',
    };

    /**
     * Ban → content cascade (ROADMAP §C). Hides/deletes/leaves-alone every
     * row across the five content tables that belongs to one of
     * `identityCandidates` (the full identity-link-expanded set), scoped to
     * `gameRoomId` when set (room ban) or everywhere when null (global ban).
     *
     * Score tables (submissions/community_scores/score_history) are matched
     * on `submitted_by_user_id` — the normalized login-identity column every
     * web submission path writes (see CLAUDE.md's identity-layer doctrine).
     * `game_comments` is room-scoped content and is swept by BOTH a room ban
     * (that room only) and a global ban (every room) — `global_game_comments`
     * has no room dimension at all, so it's only ever swept by a global ban.
     */
    private static async applyBanContentCascade(
        banId: string,
        identityCandidates: string[],
        gameRoomId: string | null,
        action: BanContentAction,
    ): Promise<void> {
        if (action === 'leave' || identityCandidates.length === 0) return;
        const db = await getDatabase();
        const placeholders = identityCandidates.map(() => '?').join(', ');

        const scoreTables: Array<{ table: 'submissions' | 'community_scores' | 'score_history'; roomColumn: string }> = [
            { table: 'submissions', roomColumn: 'submitted_from_room_id' },
            { table: 'community_scores', roomColumn: 'game_room_id' },
            { table: 'score_history', roomColumn: 'game_room_id' },
        ];

        for (const { table, roomColumn } of scoreTables) {
            const roomClause = gameRoomId ? `AND ${roomColumn} = ?` : '';
            const params: unknown[] = gameRoomId ? [...identityCandidates, gameRoomId] : [...identityCandidates];
            const rows = await db.all<Array<Record<string, unknown>>>(
                `SELECT * FROM ${table}
                 WHERE submitted_by_user_id IN (${placeholders})
                   AND orphaned_at IS NULL
                   ${roomClause}`,
                ...params,
            );
            if (rows.length === 0) continue;

            const touchedGames = new Map<string, string>(); // gameId -> roomId
            for (const row of rows) {
                const rowId = row.id as string | number;
                if (action === 'hide') {
                    await db.run(`UPDATE ${table} SET orphaned_at = datetime('now') WHERE id = ?`, rowId);
                    await db.run(
                        `INSERT INTO ban_content_actions (ban_id, table_name, row_id, action) VALUES (?, ?, ?, 'hide')`,
                        banId, table, String(rowId),
                    );
                } else {
                    // delete
                    if (table === 'score_history' && row.game_id) {
                        // Tombstone so the iScored sync poller doesn't
                        // re-import this score on its next tick — same
                        // pattern as ScoreHistoryService.deleteEvent /
                        // the admin "wipe player" route.
                        await db.run(
                            `INSERT INTO deleted_score_suppressions
                                (game_id, iscored_username_lower, suppressed_score, deleted_at, deleted_by_user_id)
                             VALUES (?, LOWER(?), ?, datetime('now'), ?)
                             ON CONFLICT(game_id, iscored_username_lower) DO UPDATE SET
                                suppressed_score = MAX(suppressed_score, excluded.suppressed_score),
                                deleted_at = datetime('now'),
                                deleted_by_user_id = excluded.deleted_by_user_id`,
                            row.game_id, row.iscored_username, row.score, banId,
                        );
                    }
                    if (typeof row.photo_url === 'string' || row.photo_url === null) {
                        deleteScorePhotoFiles([row.photo_url as string | null]);
                    }
                    await db.run(`DELETE FROM ${table} WHERE id = ?`, rowId);
                    await db.run(
                        `INSERT INTO ban_content_actions (ban_id, table_name, row_id, action) VALUES (?, ?, ?, 'delete')`,
                        banId, table, String(rowId),
                    );
                }
                if (row.game_id) {
                    const roomForRow = gameRoomId ?? (row[roomColumn] as string | null);
                    if (roomForRow) touchedGames.set(row.game_id as string, roomForRow);
                }
            }

            // Cache invalidation + broadcast — mirrors the admin "wipe
            // player" precedent (DELETE rooms/:roomId/admin/games/:gameId/submissions/:submissionId).
            if (touchedGames.size > 0) {
                const { LeaderboardService } = await import('./LeaderboardService.js');
                const { emitLeaderboardUpdated } = await import('../api/websocket.js');
                for (const [gameId, roomId] of touchedGames) {
                    await LeaderboardService.invalidate(gameId);
                    emitLeaderboardUpdated(roomId, { gameId });
                }
            }
        }

        // game_comments — room-scoped content, swept by both ban tiers.
        await this.cascadeCommentTable(
            db, banId, 'game_comments', 'user_id', identityCandidates, placeholders,
            gameRoomId ? 'AND game_room_id = ?' : '', gameRoomId ? [...identityCandidates, gameRoomId] : [...identityCandidates],
            action,
        );

        // global_game_comments — not room-scoped at all; only a GLOBAL ban touches it.
        if (!gameRoomId) {
            await this.cascadeCommentTable(
                db, banId, 'global_game_comments', 'discord_user_id', identityCandidates, placeholders,
                '', [...identityCandidates],
                action,
            );
        }
    }

    private static async cascadeCommentTable(
        db: Awaited<ReturnType<typeof getDatabase>>,
        banId: string,
        table: 'game_comments' | 'global_game_comments',
        userColumn: string,
        _identityCandidates: string[],
        placeholders: string,
        extraClause: string,
        params: unknown[],
        action: BanContentAction,
    ): Promise<void> {
        const rows = await db.all<Array<{ id: number }>>(
            `SELECT id FROM ${table} WHERE ${userColumn} IN (${placeholders}) AND hidden_at IS NULL ${extraClause}`,
            ...params,
        );
        for (const row of rows) {
            if (action === 'hide') {
                await db.run(`UPDATE ${table} SET hidden_at = datetime('now') WHERE id = ?`, row.id);
                await db.run(
                    `INSERT INTO ban_content_actions (ban_id, table_name, row_id, action) VALUES (?, ?, ?, 'hide')`,
                    banId, table, String(row.id),
                );
            } else {
                await db.run(`DELETE FROM ${table} WHERE id = ?`, row.id);
                await db.run(
                    `INSERT INTO ban_content_actions (ban_id, table_name, row_id, action) VALUES (?, ?, ?, 'delete')`,
                    banId, table, String(row.id),
                );
            }
        }
    }

    /**
     * Restore every row a lifted ban's cascade HID. 'delete' actions are
     * never touched — not restorable by design (the row is gone). Rows are
     * restored via the SAME allowlisted column map the cascade used to hide
     * them, so a hide on `game_comments` clears `hidden_at` and a hide on
     * `score_history` clears `orphaned_at`, etc.
     */
    private static async restoreBanContentActions(banId: string): Promise<number> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ table_name: string; row_id: string }>>(
            `SELECT table_name, row_id FROM ban_content_actions WHERE ban_id = ? AND action = 'hide'`,
            banId,
        );
        let restored = 0;
        for (const row of rows) {
            const column = this.HIDEABLE_TABLES[row.table_name];
            if (!column) continue; // defensive — should never happen, allowlist is closed
            const result = await db.run(
                `UPDATE ${row.table_name} SET ${column} = NULL WHERE id = ?`,
                row.row_id,
            );
            if ((result.changes ?? 0) > 0) restored++;
        }
        // The tracking rows have served their purpose (row is restored) —
        // remove them so a hypothetical future ban on the same identity
        // can't misinterpret them as belonging to ITS cascade. 'delete'
        // action rows for this ban are untouched — they stay forever as the
        // non-restorable audit trail.
        await db.run(`DELETE FROM ban_content_actions WHERE ban_id = ? AND action = 'hide'`, banId);
        return restored;
    }

    /**
     * Ban → Discord DM (ROADMAP §C). Best-effort, never throws (caller
     * already wraps this in try/catch as defense-in-depth, but
     * `BanNotificationService.sendBanDM` itself never throws either).
     *
     * Walks the identity-link-expanded candidate set for a DM-able Discord
     * id — a ban placed on a `google:*` id whose linked Discord account is
     * reachable still gets notified there. No Discord identity anywhere in
     * the graph → silently skipped (no DM channel exists).
     */
    private static async sendBanNotification(
        identityCandidates: string[],
        gameRoomId: string | null,
        reason: string | undefined,
        expiresAt: string | null,
    ): Promise<void> {
        const dmTarget = identityCandidates.find(isDiscordUserId);
        if (!dmTarget) {
            logInfo(`ScoreReportService.ban: no Discord identity to DM among [${identityCandidates.join(', ')}] — skipped.`);
            return;
        }
        let scopeLabel = 'all of Arcaid';
        if (gameRoomId) {
            const db = await getDatabase();
            const room = await db.get<{ name: string }>('SELECT name FROM game_rooms WHERE id = ?', gameRoomId);
            scopeLabel = room?.name ? `the "${room.name}" room` : 'this room';
        }
        await BanNotificationService.sendBanDM({ discordUserId: dmTarget, scopeLabel, reason, expiresAt });
    }

    /**
     * List all bans with optional filter on active-only.
     *
     * m6 fix (S22 Phase 2 adversarial review) — `expires_at` is stored as a
     * `.toISOString()` string (`...T...Z`), and comparing that raw string
     * directly against sqlite's `datetime('now')` (`YYYY-MM-DD HH:MM:SS`,
     * space-separated) is a STRING comparison where `'T'` (0x54) sorts after
     * `' '` (0x20) — so a same-calendar-day expiry that's actually already
     * PAST would still compare as "greater than now" and read as still
     * active. Wrapping both sides in `datetime(...)` normalizes to the same
     * representation first. Same bug BanService.isIdentityBanned had (fixed
     * there first, ported here — see that file's comment for the empirical
     * confirmation).
     */
    /**
     * `gameRoomId` filter (v2.49.0, room-bans contract): `undefined` (the
     * pre-v2.49 default) returns every ban regardless of scope — the
     * super-admin Reports "Bans" tab, which shows both global AND room bans
     * with a scope column. A room-admin caller (rooms.ts) passes their own
     * roomId to see ONLY that room's bans. `null` would mean "global bans
     * only" but no caller needs that today (kept as a valid value for
     * symmetry with `BanService`/`ban()`).
     *
     * Rows are enriched with resolved display names (LEFT JOIN
     * `user_profiles`, same pattern as `RoomRosterService`) so neither the
     * Reports page nor the room-admin bans list has to render bare
     * snowflakes.
     */
    static async listBans(activeOnly = false, gameRoomId?: string | null): Promise<UserBanEnriched[]> {
        const db = await getDatabase();
        const clauses: string[] = [];
        const params: unknown[] = [];
        if (activeOnly) {
            clauses.push(`b.lifted_at IS NULL AND (b.expires_at IS NULL OR datetime(b.expires_at) > datetime('now'))`);
        }
        if (gameRoomId !== undefined) {
            if (gameRoomId === null) {
                clauses.push('b.game_room_id IS NULL');
            } else {
                clauses.push('b.game_room_id = ?');
                params.push(gameRoomId);
            }
        }
        const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
        return db.all<UserBanEnriched[]>(
            `SELECT b.*,
                    gr.name AS room_name,
                    up.display_name AS discord_user_display_name, up.username AS discord_user_username,
                    bp.display_name AS banned_by_display_name, bp.username AS banned_by_username,
                    lp.display_name AS lifted_by_display_name, lp.username AS lifted_by_username
               FROM user_bans b
               LEFT JOIN game_rooms gr ON gr.id = b.game_room_id
               LEFT JOIN user_profiles up ON up.discord_user_id = b.discord_user_id
               LEFT JOIN user_profiles bp ON bp.discord_user_id = b.banned_by
               LEFT JOIN user_profiles lp ON lp.discord_user_id = b.lifted_by
               ${where}
               ORDER BY b.banned_at DESC`,
            ...params,
        );
    }

    static async getBanById(banId: string): Promise<UserBan | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM user_bans WHERE id = ?', banId);
    }
}
