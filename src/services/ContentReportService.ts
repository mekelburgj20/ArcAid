import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

/**
 * S22 Phase 1 content moderation (v2.43.0) — unified reports table for both
 * room reports and player-name reports (same shape, rendered together in the
 * super-admin Reports queue). Mirrors GameFeedbackService's shape/spam-cap
 * pattern; the anti-spam dedup mechanism is a partial UNIQUE index
 * (migration 118, join_requests pattern) rather than an app-level
 * SELECT-then-INSERT race — INSERT and catch the constraint violation.
 *
 * Full remediation "teeth" (suspend room, force-rename, ban enforcement
 * expansion) are Phase 2 (v2.44.0). Phase 1's queue only dismisses/resolves
 * the report row itself; admins act on rooms/names through the existing
 * Game Rooms manager / display-name tools the queue links out to.
 */

export type ContentReportTargetType = 'room' | 'player_name';

/** Mirrors GameFeedbackService.MAX_OPEN_REPORTS_PER_USER. */
export const MAX_OPEN_CONTENT_REPORTS_PER_USER = 20;

const MAX_REASON_LEN = 500;

export interface ContentReportRow {
    id: number;
    target_type: ContentReportTargetType;
    target_key: string;
    game_room_id: string | null;
    target_user_id: string | null;
    target_name: string | null;
    reporter_user_id: string;
    reason: string | null;
    created_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
    resolution: string | null;
}

export interface ContentReportEnriched extends ContentReportRow {
    room_name: string | null;
    room_slug: string | null;
    reporter_display_name: string | null;
    reporter_username: string | null;
    target_display_name: string | null;
    target_username: string | null;
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

/**
 * n4 (S22 Phase 1 adversarial review) — normalizes the name part of a
 * room+name-keyed `target_key` so trivial variation (extra internal
 * whitespace, differing Unicode compatibility forms, case) doesn't dodge the
 * dedup index. NFKC (compose, not decompose — this is a dedup key, not the
 * blocklist matcher; no need to strip diacritics here) → trim → collapse
 * internal whitespace runs → lowercase.
 */
function normalizeNameForKey(name: string): string {
    return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

export class ContentReportService {
    /**
     * File a report against a room. Throws coded errors: `ROOM_NOT_FOUND`,
     * `REPORT_LIMIT` (reporter has too many open reports), `DUPLICATE_REPORT`
     * (already has an open report on this exact target).
     */
    static async submitRoomReport(params: {
        roomId: string;
        reporterUserId: string;
        reason?: string | null;
    }): Promise<{ id: number }> {
        const db = await getDatabase();
        const room = await db.get<{ id: string; name: string }>(
            'SELECT id, name FROM game_rooms WHERE id = ?',
            params.roomId,
        );
        if (!room) throw codedError('Room not found', 'ROOM_NOT_FOUND');

        await this.assertUnderOpenCap(params.reporterUserId);

        const targetKey = `room:${params.roomId}`;
        const reason = normalizeReason(params.reason);
        try {
            const result = await db.run(
                `INSERT INTO content_reports
                    (target_type, target_key, game_room_id, target_name, reporter_user_id, reason)
                 VALUES ('room', ?, ?, ?, ?, ?)`,
                targetKey, params.roomId, room.name, params.reporterUserId, reason,
            );
            logInfo(`Room ${params.roomId} reported by ${params.reporterUserId}`);
            return { id: result.lastID as number };
        } catch (err) {
            throw this.mapInsertError(err);
        }
    }

    /**
     * File a report against a player name. `targetUserId`, when known, keys
     * the dedup on identity (so renaming doesn't dodge a duplicate-report
     * block); otherwise keys on (room, name-as-typed). Throws the same coded
     * errors as `submitRoomReport`, plus `ROOM_NOT_FOUND` when a `roomId` is
     * supplied but doesn't exist.
     */
    static async submitNameReport(params: {
        roomId?: string | null;
        targetUserId?: string | null;
        targetName: string;
        reporterUserId: string;
        reason?: string | null;
    }): Promise<{ id: number }> {
        const db = await getDatabase();
        if (params.roomId) {
            const room = await db.get('SELECT id FROM game_rooms WHERE id = ?', params.roomId);
            if (!room) throw codedError('Room not found', 'ROOM_NOT_FOUND');
        }

        await this.assertUnderOpenCap(params.reporterUserId);

        const targetKey = params.targetUserId
            ? `name:${params.targetUserId}`
            : `name:${params.roomId ?? 'global'}:${normalizeNameForKey(params.targetName)}`;
        const reason = normalizeReason(params.reason);

        try {
            const result = await db.run(
                `INSERT INTO content_reports
                    (target_type, target_key, game_room_id, target_user_id, target_name, reporter_user_id, reason)
                 VALUES ('player_name', ?, ?, ?, ?, ?, ?)`,
                targetKey, params.roomId ?? null, params.targetUserId ?? null,
                params.targetName, params.reporterUserId, reason,
            );
            logInfo(`Player name "${params.targetName}" reported by ${params.reporterUserId}`);
            return { id: result.lastID as number };
        } catch (err) {
            throw this.mapInsertError(err);
        }
    }

    /**
     * List reports for the super-admin queue, enriched with reporter + target
     * display context the same way `GET /:roomId/admin/join-requests` does
     * (rooms.ts) — a raw snowflake is never rendered to the admin.
     */
    static async list(opts: {
        status: 'pending' | 'resolved';
        type?: ContentReportTargetType;
        limit?: number;
        offset?: number;
    }): Promise<ContentReportEnriched[]> {
        const db = await getDatabase();
        const limit = Math.min(opts.limit ?? 100, 500);
        const offset = opts.offset ?? 0;

        const clauses: string[] = [opts.status === 'resolved' ? 'r.resolved_at IS NOT NULL' : 'r.resolved_at IS NULL'];
        const params: unknown[] = [];
        if (opts.type) {
            clauses.push('r.target_type = ?');
            params.push(opts.type);
        }
        const order = opts.status === 'resolved' ? 'r.resolved_at DESC' : 'r.created_at ASC';

        const rows = await db.all<ContentReportRow[]>(
            `SELECT r.*, gr.name AS room_name, gr.slug AS room_slug
               FROM content_reports r
               LEFT JOIN game_rooms gr ON gr.id = r.game_room_id
              WHERE ${clauses.join(' AND ')}
              ORDER BY ${order}
              LIMIT ? OFFSET ?`,
            ...params, limit, offset,
        ) as Array<ContentReportRow & { room_name: string | null; room_slug: string | null }>;

        return Promise.all(rows.map(async (r) => {
            const reporterProfile = await db.get<{ display_name: string | null; username: string | null }>(
                'SELECT display_name, username FROM user_profiles WHERE discord_user_id = ?',
                r.reporter_user_id,
            );
            const targetProfile = r.target_user_id
                ? await db.get<{ display_name: string | null; username: string | null }>(
                    'SELECT display_name, username FROM user_profiles WHERE discord_user_id = ?',
                    r.target_user_id,
                )
                : null;
            return {
                ...r,
                reporter_display_name: reporterProfile?.display_name ?? null,
                reporter_username: reporterProfile?.username ?? null,
                target_display_name: targetProfile?.display_name ?? null,
                target_username: targetProfile?.username ?? null,
            };
        }));
    }

    /** Dismiss an open report — no action taken against the target. */
    static async dismiss(id: number, adminId: string): Promise<boolean> {
        return this.resolveRow(id, adminId, 'dismissed');
    }

    /** Resolve an open report with an admin-supplied note. */
    static async resolve(id: number, adminId: string, resolution: string): Promise<boolean> {
        return this.resolveRow(id, adminId, resolution);
    }

    private static async resolveRow(id: number, adminId: string, resolution: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE content_reports
                SET resolved_at = datetime('now'), resolved_by = ?, resolution = ?
              WHERE id = ? AND resolved_at IS NULL`,
            adminId, resolution, id,
        );
        return (result.changes ?? 0) > 0;
    }

    /** Open (unresolved) content_reports count — the route layer adds score_reports' open count. */
    static async pendingCount(): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM content_reports WHERE resolved_at IS NULL',
        );
        return row?.n ?? 0;
    }

    private static async assertUnderOpenCap(reporterUserId: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(
            'SELECT COUNT(*) AS n FROM content_reports WHERE reporter_user_id = ? AND resolved_at IS NULL',
            reporterUserId,
        );
        if ((row?.n ?? 0) >= MAX_OPEN_CONTENT_REPORTS_PER_USER) {
            throw codedError('Too many open reports', 'REPORT_LIMIT');
        }
    }

    private static mapInsertError(err: unknown): Error {
        const sqlErr = err as { code?: string; message?: string };
        const message = String(sqlErr?.message || '');
        // Tightened (S22 Phase 1 adversarial review): require BOTH the SQLite
        // UNIQUE-constraint code AND the table name in the message before
        // mapping to 409. `code === 'SQLITE_CONSTRAINT'` alone also fires for
        // CHECK/NOT NULL/FK violations on this table (e.g. a bad target_type)
        // — those are real bugs and must surface as a 500, not be
        // misreported to the caller as "you already reported this".
        if (
            sqlErr?.code === 'SQLITE_CONSTRAINT' &&
            message.includes('UNIQUE constraint failed') &&
            message.includes('content_reports')
        ) {
            return codedError('You already have an open report on this target', 'DUPLICATE_REPORT');
        }
        return err as Error;
    }
}
