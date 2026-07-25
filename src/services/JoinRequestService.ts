import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { RoomMembershipService } from './RoomMembershipService.js';

export type JoinRequestStatus = 'pending' | 'approved' | 'denied';

export interface JoinRequestRow {
    id: number;
    game_room_id: string;
    user_id: string;
    status: JoinRequestStatus;
    requested_at: string;
    resolved_at: string | null;
    resolved_by: string | null;
}

/**
 * Approval-rooms (v2.39.0) join-request queue. One room admin approve/deny
 * workflow, backed by migration 116's `join_requests` table.
 */
export class JoinRequestService {
    /**
     * Idempotent create: already-member → 'member' (no-op, no row). Existing
     * pending request → 'pending' (no-op — the partial unique index on
     * (game_room_id, user_id) WHERE status='pending' also backstops races).
     * A prior denied request does NOT block a fresh one.
     */
    static async request(roomId: string, userId: string): Promise<'member' | 'pending'> {
        if (await RoomMembershipService.isMember(userId, roomId)) return 'member';

        const db = await getDatabase();
        const existing = await db.get<JoinRequestRow>(
            `SELECT * FROM join_requests WHERE game_room_id = ? AND user_id = ? AND status = 'pending'`,
            roomId, userId,
        );
        if (existing) return 'pending';

        try {
            await db.run(
                `INSERT INTO join_requests (game_room_id, user_id, status) VALUES (?, ?, 'pending')`,
                roomId, userId,
            );
        } catch (err) {
            // Race: another request from the same tab landed between the SELECT
            // above and this INSERT — the partial unique index rejects the
            // duplicate. Treat as success (the pending row exists either way).
            logError('JoinRequestService.request (treated as idempotent race)', err);
        }
        return 'pending';
    }

    /** Pending status for a user in a room, or null if none. Used by the
     * portal's `viewer_status` computation. */
    static async getPendingStatus(roomId: string, userId: string): Promise<'pending' | null> {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT 1 FROM join_requests WHERE game_room_id = ? AND user_id = ? AND status = 'pending' LIMIT 1`,
            roomId, userId,
        );
        return row ? 'pending' : null;
    }

    static async listPending(roomId: string): Promise<JoinRequestRow[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM join_requests WHERE game_room_id = ? AND status = 'pending' ORDER BY requested_at ASC`,
            roomId,
        );
    }

    static async listResolved(roomId: string, limit = 50): Promise<JoinRequestRow[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM join_requests WHERE game_room_id = ? AND status IN ('approved','denied')
             ORDER BY resolved_at DESC LIMIT ?`,
            roomId, limit,
        );
    }

    static async countPending(roomId: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ c: number }>(
            `SELECT COUNT(*) AS c FROM join_requests WHERE game_room_id = ? AND status = 'pending'`,
            roomId,
        );
        return row?.c ?? 0;
    }

    /** Marks the request approved and grants membership (source='self_join' —
     * approval is still a self-initiated join, just gated). Returns false if
     * the request doesn't exist, isn't pending, or isn't in this room. */
    static async approve(roomId: string, id: number, resolvedBy: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get<JoinRequestRow>(
            `SELECT * FROM join_requests WHERE id = ? AND game_room_id = ? AND status = 'pending'`,
            id, roomId,
        );
        if (!row) return false;

        await db.run(
            `UPDATE join_requests SET status = 'approved', resolved_at = datetime('now'), resolved_by = ? WHERE id = ?`,
            resolvedBy, id,
        );
        await RoomMembershipService.addMember(row.user_id, roomId, 'self_join');
        return true;
    }

    static async deny(roomId: string, id: number, resolvedBy: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE join_requests SET status = 'denied', resolved_at = datetime('now'), resolved_by = ?
             WHERE id = ? AND game_room_id = ? AND status = 'pending'`,
            resolvedBy, id, roomId,
        );
        return (result.changes ?? 0) > 0;
    }
}
