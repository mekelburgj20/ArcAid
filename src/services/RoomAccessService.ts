import type { TokenPayload } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { AdminService } from './AdminService.js';
import { RoomMembershipService } from './RoomMembershipService.js';
import { IdentityLinkService } from './IdentityLinkService.js';

/**
 * `open` - anyone can view and join; a score submit auto-joins.
 * `approval` - invisible to non-members; joining goes through the admin queue.
 * `discord_role` (v2.213.0) - VIEWS like `open`, but only a member of the
 * linked Discord guild holding one of `DISCORD_JOIN_ROLE_IDS` may join, and
 * writes (score submits, picks) require membership.
 */
export type JoinPolicy = 'open' | 'approval' | 'discord_role';

/** Parse the `DISCORD_JOIN_ROLE_IDS` setting (JSON array of role id strings).
 * Anything malformed reads as an empty list. */
export function parseJoinRoleIds(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        const ids = parsed
            .map(v => (typeof v === 'string' || typeof v === 'number') ? String(v).trim() : '')
            .filter(v => /^\d{5,25}$/.test(v));
        return Array.from(new Set(ids));
    } catch {
        return [];
    }
}

/** "A", "A or B", "A, B or C" - for the refusal messages. */
export function formatRoleList(names: string[]): string {
    const quoted = names.map(n => `"${n}"`);
    if (quoted.length <= 1) return quoted.join('');
    return `${quoted.slice(0, -1).join(', ')} or ${quoted[quoted.length - 1]}`;
}

export type WriteAccessResult =
    | { ok: true }
    | { ok: false; code: 'JOIN_REQUIRED'; message: string; policy: JoinPolicy; roleNames?: string[] };

/**
 * Approval-rooms (v2.39.0) — shared "can this viewer see this room" logic.
 *
 * Single source of truth for the HTTP visibility gate (`roomVisibilityGate`
 * in middleware.ts) AND the WebSocket join handlers (websocket.ts) so the two
 * enforcement points can never drift. Both decode a Bearer/auth token
 * independently and pass the resulting payload in here.
 */
export class RoomAccessService {
    /** `'open'` is also the default when the setting is absent. */
    static async getJoinPolicy(roomId: string): Promise<JoinPolicy> {
        const raw = await GameRoomSettingsService.get(roomId, 'JOIN_POLICY');
        if (raw === 'approval') return 'approval';
        if (raw === 'discord_role') return 'discord_role';
        return 'open';
    }

    /** The room's `DISCORD_JOIN_ROLE_IDS` (v2.213.0), parsed. */
    static async getJoinRoleIds(roomId: string): Promise<string[]> {
        return parseJoinRoleIds(await GameRoomSettingsService.get(roomId, 'DISCORD_JOIN_ROLE_IDS'));
    }

    /**
     * Human names for the room's required join roles, from the bot's guild
     * role cache; an id the cache cannot name (bot offline, not in the
     * guild, role deleted) is shown as the id itself. Never throws.
     */
    static async describeJoinRoles(roomId: string, roleIds?: string[]): Promise<string[]> {
        const ids = roleIds ?? await RoomAccessService.getJoinRoleIds(roomId);
        if (ids.length === 0) return [];
        try {
            const guildId = await GameRoomSettingsService.get(roomId, 'DISCORD_GUILD_ID');
            const { getDiscordClient } = await import('../discord/DiscordClient.js');
            const client = getDiscordClient();
            const roles = guildId && client ? client.listGuildRoles(guildId) : [];
            const byId = new Map(roles.map(r => [r.id, r.name]));
            return ids.map(id => byId.get(id) ?? id);
        } catch {
            return ids;
        }
    }

    /**
     * v2.213.0 - THE one write gate for room membership. Under `open` every
     * logged-in player may write (a submit auto-joins). Under `discord_role`
     * and `approval` a NON-member is refused with `JOIN_REQUIRED` before any
     * write; members, room admins and super admins pass. Called by the three
     * web submit routes, web `/pick-game`, and Discord `/submit-score` +
     * `/pick-game`. A NULL room (a Throwdown) is never gated. A settings or
     * DB failure fails OPEN, matching `roomVisibilityGate`.
     */
    static async checkMayWrite(
        roomId: string | null | undefined,
        userId: string | null | undefined,
        token?: TokenPayload | null,
    ): Promise<WriteAccessResult> {
        if (!roomId) return { ok: true };
        let policy: JoinPolicy;
        try {
            policy = await RoomAccessService.getJoinPolicy(roomId);
        } catch {
            return { ok: true };
        }
        if (policy === 'open') return { ok: true };
        try {
            if (token?.role === 'super_admin') return { ok: true };
            if (token?.gameRoomIds?.includes(roomId)) return { ok: true };
            if (userId) {
                const adminRoomIds = await AdminService.getRoomsForDiscordUser(userId);
                if (adminRoomIds.includes(roomId)) return { ok: true };
                const candidates = Array.from(await IdentityLinkService.expandCandidates(userId));
                if (await RoomMembershipService.isMemberAny(candidates, roomId)) return { ok: true };
            }
        } catch {
            return { ok: true };
        }

        let roomName = 'this room';
        try {
            const row = await (await getDatabase()).get<{ name: string }>('SELECT name FROM game_rooms WHERE id = ?', roomId);
            if (row?.name) roomName = row.name;
        } catch { /* keep the generic name */ }

        if (policy === 'discord_role') {
            const roleNames = await RoomAccessService.describeJoinRoles(roomId);
            const roleText = roleNames.length > 0
                ? ` Only members with the Discord role ${formatRoleList(roleNames)} can join.`
                : '';
            return {
                ok: false, code: 'JOIN_REQUIRED', policy, roleNames,
                message: `Join ${roomName} first to submit here.${roleText}`,
            };
        }
        return {
            ok: false, code: 'JOIN_REQUIRED', policy,
            message: `Join ${roomName} first to submit here. Ask to join from the room page.`,
        };
    }

    /**
     * S22 Phase 2 (v2.44.0) — super-admin room suspension
     * (`game_rooms.suspended_at`). Single source of truth consulted by
     * `roomVisibilityGate` (HTTP) and `canJoinRoomChannel` (WebSocket) so the
     * two enforcement points can never drift, mirroring the `getJoinPolicy` /
     * `canViewRoom` pairing above.
     */
    static async isSuspended(roomId: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get<{ suspended_at: string | null }>(
            'SELECT suspended_at FROM game_rooms WHERE id = ?', roomId,
        );
        return !!row?.suspended_at;
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
        //
        // v2.100.0 (linked-identity role-sync fix) — expand the token id once
        // per call so the membership leg checks the WHOLE linked-identity
        // candidate set, not just the raw id the token happens to carry. A
        // membership row may sit on either side of a Google<->Discord link
        // (see RoomMembershipService.isMemberAny's doc comment); the admin
        // leg (`getRoomsForDiscordUser`) is already link-aware internally.
        if (token.discordId) {
            const adminRoomIds = await AdminService.getRoomsForDiscordUser(token.discordId);
            if (adminRoomIds.includes(roomId)) return true;
            const candidates = Array.from(await IdentityLinkService.expandCandidates(token.discordId));
            if (await RoomMembershipService.isMemberAny(candidates, roomId)) return true;
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
            // v2.100.0 (linked-identity role-sync fix) — same candidate-set
            // expansion as canViewRoom above, applied to both the membership
            // and pending-join-request legs.
            const candidates = Array.from(await IdentityLinkService.expandCandidates(token.discordId));
            if (await RoomMembershipService.isMemberAny(candidates, roomId)) return 'member';
            const { JoinRequestService } = await import('./JoinRequestService.js');
            const pending = await JoinRequestService.getPendingStatusAny(roomId, candidates);
            if (pending) return 'pending';
        }

        return 'none';
    }
}
