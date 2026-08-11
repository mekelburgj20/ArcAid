import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { RoomMembershipService } from './RoomMembershipService.js';
import { BanService } from './BanService.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { IdentityLinkService } from './IdentityLinkService.js';
import { isDiscordUserId } from '../utils/identityProvider.js';

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

        // v2.80.0 — AUTO_APPROVE_GUILD_MEMBERS. Only reached for a genuinely
        // new request (no existing membership/pending row, checked above).
        if (await JoinRequestService.tryAutoApprove(roomId, userId)) return 'member';

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

    /**
     * Auto-approve check (v2.80.0). Meaningful only when the room has both
     * `AUTO_APPROVE_GUILD_MEMBERS='true'` and a `DISCORD_GUILD_ID` settings
     * key (the settings-table key, not the `game_rooms.discord_guild_id`
     * column). Resolves the requester to a Discord snowflake — token ids are
     * already canonical for Discord logins and linked Google logins;
     * `IdentityLinkService.resolveCanonical` covers the unlinked-Google-login
     * case, and if that still doesn't resolve to a Discord id the check
     * degrades to the manual queue. Any uncertainty (setting off, no guild
     * configured, unresolved identity, gateway down, membership unknown)
     * degrades to the manual queue too — this NEVER auto-denies.
     *
     * The row lands exactly where `approve()` leaves it (`status='approved'`,
     * `resolved_at` set, membership granted via the same
     * `RoomMembershipService.addMember(..., 'self_join')` call) so the admin
     * "resolved" queue shows the audit trail. `resolved_by='auto:guild'`
     * marks it as machine-resolved. The ban check already ran in the route
     * (`requireNotBanned` gates the whole endpoint before `request()` is even
     * called), so this does not re-check bans — it just keeps the write path
     * consistent with `approve()`'s.
     */
    private static async tryAutoApprove(roomId: string, userId: string): Promise<boolean> {
        try {
            const enabled = await GameRoomSettingsService.get(roomId, 'AUTO_APPROVE_GUILD_MEMBERS');
            if (enabled !== 'true') return false;

            const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
            if (!guildId) return false;

            let discordId = userId;
            if (!isDiscordUserId(discordId)) {
                discordId = await IdentityLinkService.resolveCanonical(userId);
                if (!isDiscordUserId(discordId)) return false;
            }

            const { getDiscordClient } = await import('../discord/DiscordClient.js');
            const client = getDiscordClient();
            if (!client) return false;

            const isMember = await client.isMemberOfGuild(guildId, discordId);
            if (!isMember) return false;

            const db = await getDatabase();
            await db.run(
                `INSERT INTO join_requests (game_room_id, user_id, status, resolved_at, resolved_by)
                 VALUES (?, ?, 'approved', datetime('now'), 'auto:guild')`,
                roomId, userId,
            );
            await RoomMembershipService.addMember(userId, roomId, 'self_join');
            return true;
        } catch (err) {
            logError('JoinRequestService.tryAutoApprove', err);
            return false;
        }
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

    /**
     * v2.100.0 (linked-identity role-sync fix) — IN-variant of
     * `getPendingStatus` for a linked-identity candidate set (see
     * `IdentityLinkService.expandCandidates`). A join request may have been
     * filed under either side of a Google<->Discord link.
     */
    static async getPendingStatusAny(roomId: string, userIds: string[]): Promise<'pending' | null> {
        if (userIds.length === 0) return null;
        const db = await getDatabase();
        const placeholders = userIds.map(() => '?').join(', ');
        const row = await db.get(
            `SELECT 1 FROM join_requests WHERE game_room_id = ? AND user_id IN (${placeholders}) AND status = 'pending' LIMIT 1`,
            roomId, ...userIds,
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
     * the request doesn't exist, isn't pending, or isn't in this room.
     *
     * v2.49.0 fix-round (tmp/room-bans-fixes.md #4) — throws a typed
     * `USER_BANNED` error (not a plain `false`) when the requester is
     * currently banned from this room. The room-ban route already denies any
     * pending request for the banned candidate set at ban-time (belt), but a
     * ban placed through some other path, or a request filed in the narrow
     * window around that sweep, must not be silently approvable (braces).
     */
    static async approve(roomId: string, id: number, resolvedBy: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get<JoinRequestRow>(
            `SELECT * FROM join_requests WHERE id = ? AND game_room_id = ? AND status = 'pending'`,
            id, roomId,
        );
        if (!row) return false;

        const banCheck = await BanService.isIdentityBanned(row.user_id, roomId);
        if (banCheck.banned) {
            const err = new Error('This user is banned from this room and cannot be approved.');
            (err as Error & { code?: string }).code = 'USER_BANNED';
            throw err;
        }

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
