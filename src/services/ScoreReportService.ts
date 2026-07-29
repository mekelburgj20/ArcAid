import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { GlobalScoreService } from './GlobalScoreService.js';
import { BanService } from './BanService.js';
import { logInfo } from '../utils/logger.js';

export type ReportResolution = 'dismissed' | 'deleted' | 'banned';

export interface ScoreReport {
    id: string;
    score_id: string;
    reporter_discord_id: string;
    reason: string | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution: string | null;
}

export interface ScoreReportWithContext extends ScoreReport {
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
export class ScoreReportService {
    /**
     * List pending (unresolved) reports with full context: the reported score,
     * the player, the game, and the originating room.
     */
    static async listPending(limit = 100, offset = 0): Promise<ScoreReportWithContext[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT
                r.id, r.score_id, r.reporter_discord_id, r.reason, r.created_at,
                r.resolved_at, r.resolved_by, r.resolution,
                s.global_game_id, s.player_id, s.iscored_username, s.score,
                s.photo_url, s.origin_type, s.origin_game_room_id, s.submitted_at,
                s.deleted_at as score_deleted_at,
                gg.name as game_name,
                up.display_name as reporter_display_name, up.username as reporter_username
             FROM score_reports r
             LEFT JOIN global_scores s ON s.id = r.score_id
             LEFT JOIN global_games gg ON gg.id = s.global_game_id
             LEFT JOIN user_profiles up ON up.discord_user_id = r.reporter_discord_id
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
            `SELECT
                r.id, r.score_id, r.reporter_discord_id, r.reason, r.created_at,
                r.resolved_at, r.resolved_by, r.resolution,
                s.global_game_id, s.player_id, s.iscored_username, s.score,
                s.photo_url, s.origin_type, s.origin_game_room_id, s.submitted_at,
                s.deleted_at as score_deleted_at,
                gg.name as game_name,
                up.display_name as reporter_display_name, up.username as reporter_username
             FROM score_reports r
             LEFT JOIN global_scores s ON s.id = r.score_id
             LEFT JOIN global_games gg ON gg.id = s.global_game_id
             LEFT JOIN user_profiles up ON up.discord_user_id = r.reporter_discord_id
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
     * Resolve by soft-deleting the score. Also resolves any other open reports
     * on the same score so the admin doesn't have to dismiss them one by one.
     */
    static async softDeleteScore(reportId: string, adminDiscordId: string): Promise<boolean> {
        const report = await this.getById(reportId);
        if (!report) return false;
        await GlobalScoreService.softDelete(report.score_id, adminDiscordId);
        await this.resolveAllForScore(report.score_id, adminDiscordId, 'deleted');
        logInfo(`Score ${report.score_id} soft-deleted via report ${reportId} by ${adminDiscordId}`);
        return true;
    }

    /**
     * Resolve by hard-deleting the score (permanent, removes photo file too).
     */
    static async hardDeleteScore(reportId: string, adminDiscordId: string): Promise<boolean> {
        const report = await this.getById(reportId);
        if (!report) return false;
        await GlobalScoreService.hardDelete(report.score_id);
        await this.resolveAllForScore(report.score_id, adminDiscordId, 'deleted');
        logInfo(`Score ${report.score_id} hard-deleted via report ${reportId} by ${adminDiscordId}`);
        return true;
    }

    /**
     * Resolve by banning the player and soft-deleting the score.
     * `durationDays` = null means permanent.
     */
    static async banUser(
        reportId: string,
        adminDiscordId: string,
        durationDays: number | null,
        banReason?: string
    ): Promise<boolean> {
        const report = await this.getById(reportId);
        if (!report) return false;

        const db = await getDatabase();
        const score = await db.get('SELECT player_id FROM global_scores WHERE id = ?', report.score_id);
        if (!score) return false;

        await this.ban(score.player_id, adminDiscordId, durationDays, banReason || report.reason || undefined);
        await GlobalScoreService.softDelete(report.score_id, adminDiscordId);
        await this.resolveAllForScore(report.score_id, adminDiscordId, 'banned');
        logInfo(`User ${score.player_id} banned via report ${reportId} by ${adminDiscordId} (duration: ${durationDays ?? 'permanent'})`);
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
        adminDiscordId: string,
        resolution: ReportResolution
    ): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE score_reports
             SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?
             WHERE score_id = ? AND resolved_at IS NULL`,
            adminDiscordId, resolution, scoreId
        );
    }

    // --- User bans ---

    /**
     * Ban a user. `durationDays` = null → permanent, otherwise expires_at is set.
     * `gameRoomId` omitted/null → global ban (pre-v2.49 shape, unaffected).
     * Passed → a room-tier ban (v2.49.0, room-bans contract) that only bites
     * inside that room — see `BanService.isIdentityBanned`'s doc comment.
     */
    static async ban(
        discordUserId: string,
        bannedBy: string,
        durationDays: number | null,
        reason?: string,
        gameRoomId?: string | null,
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
        return (await db.get('SELECT * FROM user_bans WHERE id = ?', id)) as UserBan;
    }

    /**
     * Lift an active ban (set lifted_at). Doesn't delete the row — we keep the
     * history so a repeat offender's record is visible.
     */
    static async lift(banId: string, liftedBy: string): Promise<boolean> {
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
        return changed;
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
