import { getDatabase } from '../database/database.js';
import { CommentService } from './CommentService.js';
import { logInfo } from '../utils/logger.js';

/**
 * v2.47.0 — S22 follow-ups Workstream 2: comment reports. Mirrors
 * `ContentReportService`'s shape (dedup via a partial UNIQUE index rather
 * than an app-level SELECT-then-INSERT race — INSERT and catch the
 * constraint violation). Targets room-scoped `game_comments` rows
 * (CommentService), NOT `global_game_comments` — GameDetail.tsx (the room
 * game-detail page, where the Flag button ships) renders room comments.
 *
 * Queue is super-admin-only (matches the existing Reports page
 * authorization) — room-admin visibility is future work.
 */

const MAX_REASON_LEN = 500;

/** Mirrors ContentReportService.MAX_OPEN_CONTENT_REPORTS_PER_USER. */
export const MAX_OPEN_COMMENT_REPORTS_PER_USER = 20;

export interface CommentReportRow {
    id: number;
    comment_id: number;
    reporter_discord_id: string;
    reason: string | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution: string | null;
}

export interface CommentReportEnriched extends CommentReportRow {
    comment_body: string | null;
    comment_type: 'comment' | 'tip' | null;
    comment_display_name: string | null;
    comment_user_id: string | null;
    game_name: string | null;
    game_room_id: string | null;
    room_name: string | null;
    room_slug: string | null;
    /** v2.49.0 (room-bans contract, Workstream 2) — resolved via user_profiles.
     *  The comment AUTHOR already has `comment_display_name`; this is the
     *  REPORTER's resolved name. */
    reporter_display_name: string | null;
    reporter_username: string | null;
}

function codedError(message: string, code: string): Error & { code: string } {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    return err;
}

function normalizeReason(reason?: string | null): string | null {
    if (!reason) return null;
    const trimmed = reason.trim().slice(0, MAX_REASON_LEN);
    return trimmed || null;
}

export class CommentReportService {
    /**
     * File a report against a room-scoped comment. Throws coded errors:
     * `COMMENT_NOT_FOUND`, `REPORT_LIMIT` (reporter has too many open
     * reports), `DUPLICATE_REPORT` (already has an open report on this exact
     * comment).
     */
    static async create(params: {
        commentId: number;
        reporterDiscordId: string;
        reason?: string | null;
    }): Promise<{ id: number }> {
        const db = await getDatabase();
        const comment = await CommentService.getCommentById(params.commentId);
        if (!comment) throw codedError('Comment not found', 'COMMENT_NOT_FOUND');

        await this.assertUnderOpenCap(params.reporterDiscordId);

        const reason = normalizeReason(params.reason);
        try {
            const result = await db.run(
                `INSERT INTO comment_reports (comment_id, reporter_discord_id, reason)
                 VALUES (?, ?, ?)`,
                params.commentId, params.reporterDiscordId, reason,
            );
            logInfo(`Comment ${params.commentId} reported by ${params.reporterDiscordId}`);
            return { id: result.lastID as number };
        } catch (err) {
            throw this.mapInsertError(err);
        }
    }

    /**
     * List reports for the super-admin queue, enriched with the comment body
     * + game/room context (LEFT JOINed — a "Remove"-resolved report's comment
     * row is gone, so those columns render null rather than dropping the row).
     */
    static async list(opts: {
        status: 'pending' | 'resolved';
        limit?: number;
        offset?: number;
    }): Promise<CommentReportEnriched[]> {
        const db = await getDatabase();
        const limit = Math.min(opts.limit ?? 100, 500);
        const offset = opts.offset ?? 0;
        const statusClause = opts.status === 'resolved' ? 'r.resolved_at IS NOT NULL' : 'r.resolved_at IS NULL';
        const order = opts.status === 'resolved' ? 'r.resolved_at DESC' : 'r.created_at ASC';

        return db.all<CommentReportEnriched[]>(
            `SELECT r.*,
                    c.body AS comment_body,
                    c.type AS comment_type,
                    c.display_name AS comment_display_name,
                    c.user_id AS comment_user_id,
                    c.game_name AS game_name,
                    c.game_room_id AS game_room_id,
                    gr.name AS room_name,
                    gr.slug AS room_slug,
                    up.display_name AS reporter_display_name,
                    up.username AS reporter_username
               FROM comment_reports r
               LEFT JOIN game_comments c ON c.id = r.comment_id
               LEFT JOIN game_rooms gr ON gr.id = c.game_room_id
               LEFT JOIN user_profiles up ON up.discord_user_id = r.reporter_discord_id
              WHERE ${statusClause}
              ORDER BY ${order}
              LIMIT ? OFFSET ?`,
            limit, offset,
        );
    }

    /** Dismiss an open report — no action taken against the comment. */
    static async dismiss(id: number, adminId: string): Promise<boolean> {
        return this.resolveRow(id, adminId, 'dismissed');
    }

    /**
     * Resolve by deleting the reported comment.
     *
     * v2.47.0 (S22 follow-ups L4+L5) — atomic (delete + resolve share a
     * transaction, so a crash between them can't leave a resolved report
     * pointing at a comment that's still live, or a deleted comment with a
     * still-open report) AND sweeps every OTHER open report on the same
     * `comment_id` — a popular comment can collect multiple reports before an
     * admin acts; resolving only the acted-on row left the siblings dangling
     * in the queue forever, pointed at a comment that no longer exists.
     */
    static async remove(id: number, adminId: string): Promise<boolean> {
        const db = await getDatabase();
        const report = await db.get<{ comment_id: number }>(
            'SELECT comment_id FROM comment_reports WHERE id = ? AND resolved_at IS NULL', id,
        );
        if (!report) return false;

        await db.run('BEGIN');
        try {
            await CommentService.deleteComment(report.comment_id);
            // Single UPDATE resolves the acted-on report AND every sibling
            // still-open report on the same comment_id in one shot.
            await db.run(
                `UPDATE comment_reports
                    SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?
                  WHERE comment_id = ? AND resolved_at IS NULL`,
                adminId, 'removed', report.comment_id,
            );
            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
        logInfo(`Comment ${report.comment_id} removed via report ${id} by ${adminId}`);
        return true;
    }

    /** Open (unresolved) comment_reports count — for a future combined pending-count badge. */
    static async pendingCount(): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM comment_reports WHERE resolved_at IS NULL',
        );
        return row?.n ?? 0;
    }

    private static async resolveRow(id: number, adminId: string, resolution: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE comment_reports
                SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?
              WHERE id = ? AND resolved_at IS NULL`,
            adminId, resolution, id,
        );
        return (result.changes ?? 0) > 0;
    }

    private static async assertUnderOpenCap(reporterDiscordId: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM comment_reports WHERE reporter_discord_id = ? AND resolved_at IS NULL',
            reporterDiscordId,
        );
        if ((row?.n ?? 0) >= MAX_OPEN_COMMENT_REPORTS_PER_USER) {
            throw codedError('Too many open reports', 'REPORT_LIMIT');
        }
    }

    private static mapInsertError(err: unknown): Error {
        const sqlErr = err as { code?: string; message?: string };
        const message = String(sqlErr?.message || '');
        if (
            sqlErr?.code === 'SQLITE_CONSTRAINT' &&
            message.includes('UNIQUE constraint failed') &&
            message.includes('comment_reports')
        ) {
            return codedError('You already have an open report on this comment', 'DUPLICATE_REPORT');
        }
        return err as Error;
    }
}
