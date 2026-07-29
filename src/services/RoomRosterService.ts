import { getDatabase } from '../database/database.js';
import { RoomAccessService } from './RoomAccessService.js';

/**
 * Room Members/Players page (v2.42.0, tmp/room-members-page-contract.md).
 *
 * Two disjoint data sources depending on the room's JOIN_POLICY — never
 * mixed, never unioned:
 *
 *  - 'approval' rooms: the roster IS `room_members` (approved members —
 *    owner + admins + approved joiners all get a row via their respective
 *    grant paths: `GameRoomService.create`, `AdminService.addRoomDiscordAdmin`,
 *    `JoinRequestService.approve`). Deliberately NOT UNIONed with
 *    `game_room_admins` directly — every admin already has a `room_members`
 *    row from their grant path, so the only gap is a hand-inserted
 *    `game_room_admins` row with no accompanying membership grant (not a
 *    real code path today) — noted, not worth the extra query.
 *  - 'open' rooms: `room_members` is NOT used as the roster (its `source` is
 *    first-write-wins so it's unreliable, and it includes non-posting
 *    bookmarkers who joined via "My Game Rooms" without ever scoring). The
 *    roster is instead the distinct set of IDENTIFIED (non-guest)
 *    score-posters from `score_history`.
 *
 * Both paths batch-resolve display info via a single LEFT JOIN on
 * `user_profiles` (no N+1). Display name resolution mirrors the v2.40.0
 * join-requests precedent: `display_name ?? username ?? iscoredUsername ?? userId`.
 */

export type RoomRosterMode = 'approval' | 'open';

export interface RoomRosterEntry {
    userId: string;
    displayName: string;
    username: string | null;
    iscoredUsername: string | null;
    avatarHash: string | null;
    avatarUrl: string | null;
    /** Approval rooms only. */
    joinedAt?: string;
    /** Open rooms only. */
    firstSeenAt?: string;
    /** Open rooms only. */
    lastSeenAt?: string;
    /** Open rooms only. */
    scoreCount?: number;
    isOwner?: boolean;
    isAdmin?: boolean;
}

export class RoomRosterService {
    /** Which data source this room's roster comes from. Exposed so callers
     *  (the route handler) can ship it alongside the roster for the FE to
     *  pick labels without a second round trip. */
    static async getMode(roomId: string): Promise<RoomRosterMode> {
        const policy = await RoomAccessService.getJoinPolicy(roomId);
        return policy === 'approval' ? 'approval' : 'open';
    }

    static async getRoster(roomId: string): Promise<{ mode: RoomRosterMode; members: RoomRosterEntry[] }> {
        const mode = await this.getMode(roomId);
        const members = mode === 'approval'
            ? await this.getApprovalRoster(roomId)
            : await this.getOpenRoster(roomId);

        // v2.49.0 fix-round (tmp/room-bans-fixes.md #7) — an active room ban
        // strips the target's `room_members` row, so 'approval' rooms
        // already drop them from the roster as a side effect. 'open' rooms
        // derive their roster from `score_history`, which a room-membership
        // strip never touches — without this filter a banned player stayed
        // visible in the Players list right alongside the Banned section,
        // contradicting the FE confirm dialog's own "removes them from the
        // room" copy. Filtered here (server-side, both paths) rather than
        // relying on the FE's optimistic post-ban removal, which doesn't
        // survive a reload. A GLOBAL ban also hides someone from every room's
        // roster — consistent with `BanService.isIdentityBanned`'s "a global
        // ban bites everywhere" semantics.
        const bannedIds = await this.getActiveBanIds(roomId);
        if (bannedIds.size === 0) return { mode, members };
        return { mode, members: members.filter(m => !bannedIds.has(m.userId)) };
    }

    private static async getActiveBanIds(roomId: string): Promise<Set<string>> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ discord_user_id: string }>>(
            `SELECT discord_user_id FROM user_bans
              WHERE (game_room_id IS NULL OR game_room_id = ?)
                AND lifted_at IS NULL
                AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
            roomId,
        );
        return new Set(rows.map(r => r.discord_user_id));
    }

    private static async getApprovalRoster(roomId: string): Promise<RoomRosterEntry[]> {
        const db = await getDatabase();
        const rows = await db.all(`
            SELECT
                rm.user_id      AS userId,
                rm.joined_at    AS joinedAt,
                up.display_name AS displayName,
                up.username     AS username,
                up.avatar_hash  AS avatarHash,
                up.avatar_url   AS avatarUrl,
                gra.role        AS adminRole,
                (SELECT um.iscored_username FROM user_mappings um
                  WHERE um.discord_user_id = rm.user_id LIMIT 1) AS iscoredUsername
            FROM room_members rm
            LEFT JOIN user_profiles up ON up.discord_user_id = rm.user_id
            LEFT JOIN game_room_admins gra ON gra.game_room_id = rm.room_id AND gra.discord_user_id = rm.user_id
            WHERE rm.room_id = ?
            ORDER BY rm.joined_at DESC
        `, roomId) as Array<{
            userId: string;
            joinedAt: string;
            displayName: string | null;
            username: string | null;
            avatarHash: string | null;
            avatarUrl: string | null;
            adminRole: string | null;
            iscoredUsername: string | null;
        }>;

        return rows.map(r => ({
            userId: r.userId,
            displayName: r.displayName ?? r.username ?? r.iscoredUsername ?? r.userId,
            username: r.username,
            iscoredUsername: r.iscoredUsername,
            avatarHash: r.avatarHash,
            avatarUrl: r.avatarUrl,
            joinedAt: r.joinedAt,
            isOwner: r.adminRole === 'owner',
            isAdmin: r.adminRole === 'admin',
        }));
    }

    private static async getOpenRoster(roomId: string): Promise<RoomRosterEntry[]> {
        const db = await getDatabase();
        const rows = await db.all(`
            SELECT
                sh.submitted_by_user_id AS userId,
                MIN(sh.created_at)      AS firstSeenAt,
                MAX(sh.created_at)      AS lastSeenAt,
                COUNT(*)                AS scoreCount,
                (SELECT sh2.iscored_username FROM score_history sh2
                  WHERE sh2.submitted_by_user_id = sh.submitted_by_user_id
                    AND sh2.game_room_id = sh.game_room_id
                  ORDER BY sh2.created_at DESC LIMIT 1) AS iscoredUsername,
                up.display_name AS displayName,
                up.username     AS username,
                up.avatar_hash  AS avatarHash,
                up.avatar_url   AS avatarUrl
            FROM score_history sh
            LEFT JOIN user_profiles up ON up.discord_user_id = sh.submitted_by_user_id
            WHERE sh.game_room_id = ? AND sh.submitted_by_user_id IS NOT NULL AND sh.orphaned_at IS NULL
            GROUP BY sh.submitted_by_user_id
            ORDER BY lastSeenAt DESC
        `, roomId) as Array<{
            userId: string;
            firstSeenAt: string;
            lastSeenAt: string;
            scoreCount: number;
            iscoredUsername: string | null;
            displayName: string | null;
            username: string | null;
            avatarHash: string | null;
            avatarUrl: string | null;
        }>;

        return rows.map(r => ({
            userId: r.userId,
            displayName: r.displayName ?? r.username ?? r.iscoredUsername ?? r.userId,
            username: r.username,
            iscoredUsername: r.iscoredUsername,
            avatarHash: r.avatarHash,
            avatarUrl: r.avatarUrl,
            firstSeenAt: r.firstSeenAt,
            lastSeenAt: r.lastSeenAt,
            scoreCount: r.scoreCount,
        }));
    }
}
