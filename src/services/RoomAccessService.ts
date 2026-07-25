import type { TokenPayload } from '../api/auth.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { AdminService } from './AdminService.js';
import { RoomMembershipService } from './RoomMembershipService.js';

export type JoinPolicy = 'open' | 'approval';

/**
 * Approval-rooms (v2.39.0) — shared "can this viewer see this room" logic.
 *
 * Single source of truth for the HTTP visibility gate (`roomVisibilityGate`
 * in middleware.ts) AND the WebSocket join handlers (websocket.ts) so the two
 * enforcement points can never drift. Both decode a Bearer/auth token
 * independently (mirroring `conditionalRequireDiscordUser`'s pattern) and
 * pass the resulting payload in here.
 */
export class RoomAccessService {
    /** `'open'` is also the default when the setting is absent. */
    static async getJoinPolicy(roomId: string): Promise<JoinPolicy> {
        const raw = await GameRoomSettingsService.get(roomId, 'JOIN_POLICY');
        return raw === 'approval' ? 'approval' : 'open';
    }

    /**
     * True when `token` (already-decoded JWT payload, or null for a guest)
     * may view an 'approval'-policy room. Callers should short-circuit on
     * `getJoinPolicy() === 'open'` before calling this — it always does the
     * membership/admin checks and is only meaningful for approval rooms.
     */
    static async canViewRoom(token: TokenPayload | null, roomId: string): Promise<boolean> {
        if (!token) return false;
        if (token.role === 'super_admin') return true;
        if (token.gameRoomIds?.includes(roomId)) return true;

        const userId = token.discordId ?? token.localAdminId;
        if (!userId) return false;

        // Token may be stale relative to a just-granted admin role or a
        // just-recorded membership row — re-check the DB, not just the JWT.
        if (token.discordId) {
            const adminRoomIds = await AdminService.getRoomsForDiscordUser(token.discordId);
            if (adminRoomIds.includes(roomId)) return true;
            if (await RoomMembershipService.isMember(token.discordId, roomId)) return true;
        }

        return false;
    }

    /**
     * Portal `viewer_status` for a room: 'admin' (super_admin, room admin via
     * token OR DB) > 'member' (room_members row) > 'pending' (an outstanding
     * join request) > 'none'. Meaningful for any room, not just 'approval'
     * ones — callers only act on it when the policy is 'approval'.
     */
    static async getViewerStatus(
        token: TokenPayload | null,
        roomId: string,
    ): Promise<'admin' | 'member' | 'pending' | 'none'> {
        if (!token) return 'none';
        if (token.role === 'super_admin') return 'admin';
        if (token.gameRoomIds?.includes(roomId)) return 'admin';

        if (token.discordId) {
            const adminRoomIds = await AdminService.getRoomsForDiscordUser(token.discordId);
            if (adminRoomIds.includes(roomId)) return 'admin';
            if (await RoomMembershipService.isMember(token.discordId, roomId)) return 'member';
            const { JoinRequestService } = await import('./JoinRequestService.js');
            const pending = await JoinRequestService.getPendingStatus(roomId, token.discordId);
            if (pending) return 'pending';
        }

        return 'none';
    }
}
