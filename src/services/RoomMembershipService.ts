import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';

export type RoomMemberSource = 'submission' | 'admin_invite' | 'claim' | 'backfill' | 'self_join';

export interface RoomForUser {
    roomId: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    joinedAt: string;
    source: RoomMemberSource;
    lastActivityAt: string | null;
}

const SENTINEL_USER_IDS = new Set(['SYSTEM', 'COMMUNITY', 'ANON', '']);

function isRealUserId(userId: string | null | undefined): userId is string {
    return !!userId && !SENTINEL_USER_IDS.has(userId);
}

export class RoomMembershipService {
    /**
     * Idempotent upsert. No-op when userId is a sentinel (SYSTEM/COMMUNITY/ANON).
     * Existing rows are left alone — first source wins so 'admin_invite' isn't
     * downgraded to 'submission' on later score writes.
     */
    static async addMember(
        userId: string | null | undefined,
        roomId: string,
        source: RoomMemberSource,
    ): Promise<void> {
        if (!isRealUserId(userId)) return;
        if (!roomId) return;
        try {
            const db = await getDatabase();
            await db.run(
                `INSERT OR IGNORE INTO room_members (user_id, room_id, joined_at, source)
                 VALUES (?, ?, datetime('now'), ?)`,
                userId, roomId, source
            );
        } catch (err) {
            logError('RoomMembershipService.addMember', err);
        }
    }

    /**
     * Explicit "leave" (v2.38.0). Deletes only the room_members row — deliberately
     * does NOT touch game_room_admins. Admin/owner grants are a separate table;
     * an owner who leaves just drops the room from their "My Game Rooms" list,
     * they keep their admin rights and can still manage the room. Idempotent:
     * deleting a non-existent row is a no-op, not an error.
     */
    static async removeMember(userId: string, roomId: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'DELETE FROM room_members WHERE user_id = ? AND room_id = ?',
            userId, roomId
        );
    }

    static async isMember(userId: string, roomId: string): Promise<boolean> {
        if (!isRealUserId(userId) || !roomId) return false;
        const db = await getDatabase();
        const row = await db.get(
            'SELECT 1 FROM room_members WHERE user_id = ? AND room_id = ? LIMIT 1',
            userId, roomId
        );
        return !!row;
    }

    /**
     * Rooms a user belongs to, ordered by most-recent activity. lastActivityAt is
     * the max of submissions.timestamp / community_scores.created_at scoped to the
     * (user, room) pair. Falls back to joined_at when the user has no scores yet
     * (e.g. backfilled admin who never submitted).
     */
    static async listRoomsForUser(userId: string): Promise<RoomForUser[]> {
        if (!isRealUserId(userId)) return [];
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT
                rm.room_id     AS roomId,
                rm.joined_at   AS joinedAt,
                rm.source      AS source,
                gr.name        AS name,
                gr.slug        AS slug,
                gr.logo_url    AS logoUrl,
                -- Latest-activity across submissions + community_scores. MAX() over
                -- a UNION ALL preserves NULL when both legs are empty (so the
                -- ORDER BY fallback to joined_at still fires). Timestamps are ISO,
                -- so lex and chronological ordering agree.
                (
                    SELECT MAX(ts) FROM (
                        SELECT MAX(s.timestamp) AS ts
                          FROM submissions s
                          JOIN games g ON g.id = s.game_id
                          JOIN tournaments t ON t.id = g.tournament_id
                         WHERE t.game_room_id = rm.room_id AND s.discord_user_id = rm.user_id
                        UNION ALL
                        SELECT MAX(cs.created_at) AS ts
                          FROM community_scores cs
                         WHERE cs.game_room_id = rm.room_id AND cs.discord_user_id = rm.user_id
                    )
                ) AS lastActivityAt
             FROM room_members rm
             JOIN game_rooms gr ON gr.id = rm.room_id
             WHERE rm.user_id = ?
             ORDER BY COALESCE(lastActivityAt, joinedAt) DESC`,
            userId
        );
        return rows as RoomForUser[];
    }
}
