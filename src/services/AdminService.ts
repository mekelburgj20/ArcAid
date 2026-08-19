import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../database/database.js';
import type { LocalAdmin, GameRoomAdmin, SuperAdmin } from '../types/index.js';
import { IdentityLinkService } from './IdentityLinkService.js';

/** v2.49.0 — `GameRoomAdmin` plus resolved display fields (see
 *  `getRoomDiscordAdmins`'s doc comment). `display_name`/`username` are
 *  `null` when no `user_profiles` row exists AND the Discord REST fallback
 *  also came up empty (bot not configured, user left Discord, etc.) — the FE
 *  renders the raw `discord_user_id` in that case. */
export interface GameRoomAdminEnriched extends GameRoomAdmin {
    display_name: string | null;
    username: string | null;
}

export class AdminService {
    // --- Super Admins ---

    static async getSuperAdmins(): Promise<SuperAdmin[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM super_admins ORDER BY granted_at ASC');
    }

    static async isSuperAdmin(discordUserId: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get('SELECT 1 FROM super_admins WHERE discord_user_id = ?', discordUserId);
        return !!row;
    }

    static async addSuperAdmin(discordUserId: string, username?: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'INSERT OR REPLACE INTO super_admins (discord_user_id, username) VALUES (?, ?)',
            discordUserId, username || null
        );
    }

    static async removeSuperAdmin(discordUserId: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run('DELETE FROM super_admins WHERE discord_user_id = ?', discordUserId);
        return (result.changes || 0) > 0;
    }

    // --- Game Room Admins (Discord) ---

    /**
     * v2.49.0 (room-bans contract, Workstream 2) — resolves each admin's
     * display name so `Settings.tsx`'s Discord Admins card doesn't render a
     * bare snowflake. LEFT JOIN `user_profiles` first (the fast, common
     * path); for rows with no profile row at all (the admin was granted
     * access but has never logged into Arcaid) falls back to a best-effort
     * Discord REST lookup via `fetchDiscordUserInfo` (1h in-memory cache —
     * cheap even for a room with several never-logged-in admins). A
     * `google:*` id with no profile has no Discord user to look up and stays
     * `null` — the FE renders the truncated raw id in that case.
     */
    static async getRoomDiscordAdmins(gameRoomId: string): Promise<GameRoomAdminEnriched[]> {
        const db = await getDatabase();
        const rows = await db.all<GameRoomAdminEnriched[]>(
            `SELECT gra.game_room_id, gra.discord_user_id, gra.role,
                    up.display_name AS display_name, up.username AS username
               FROM game_room_admins gra
               LEFT JOIN user_profiles up ON up.discord_user_id = gra.discord_user_id
              WHERE gra.game_room_id = ?
              ORDER BY gra.role DESC`,
            gameRoomId
        );

        const { fetchDiscordUserInfo } = await import('../utils/discord.js');
        return Promise.all(rows.map(async (r) => {
            if (r.display_name || r.username) return r;
            const info = await fetchDiscordUserInfo(r.discord_user_id);
            if (!info) return r;
            return { ...r, username: info.username, display_name: info.globalName ?? info.username };
        }));
    }

    /**
     * v2.100.0 (linked-identity role-sync fix) — link-aware. A room-admin grant
     * recorded on one side of a Google<->Discord identity link (`createLink`
     * moves `game_room_admins` rows onto the canonical snowflake, but a grant
     * added directly against a pasted `google:*` id via `POST
     * /:roomId/admins/discord` never gets normalized — see rooms.ts's ban
     * route doc comment) must still be found regardless of which linked
     * identity is presented at login/refresh time. Expands via the same
     * link-graph walk `BanService`'s room-ban route already proved out at
     * rooms.ts:5061-5065 (raw id + canonical + every sibling alias).
     */
    static async getRoomsForDiscordUser(discordUserId: string): Promise<string[]> {
        const db = await getDatabase();
        const candidates = Array.from(await IdentityLinkService.expandCandidates(discordUserId));
        const placeholders = candidates.map(() => '?').join(', ');
        const rows = await db.all(
            `SELECT DISTINCT game_room_id FROM game_room_admins WHERE discord_user_id IN (${placeholders})`,
            ...candidates
        );
        return rows.map((r: any) => r.game_room_id);
    }

    /**
     * Slugs for a set of room ids, in the SAME order as the input — the FE
     * treats roomSlugs[0] as the room-admin's primary room when routing a
     * login that carries no room context (the generic /login page's
     * `state=__super__` flow). Rooms that no longer exist are skipped.
     */
    static async getRoomSlugs(roomIds: string[]): Promise<string[]> {
        if (roomIds.length === 0) return [];
        const db = await getDatabase();
        const placeholders = roomIds.map(() => '?').join(', ');
        const rows = await db.all(
            `SELECT id, slug FROM game_rooms WHERE id IN (${placeholders})`,
            ...roomIds
        );
        const slugById = new Map<string, string>(rows.map((r: any) => [r.id, r.slug]));
        return roomIds.map(id => slugById.get(id)).filter((s): s is string => !!s);
    }

    static async addRoomDiscordAdmin(
        gameRoomId: string, discordUserId: string, role: 'admin' | 'owner' = 'admin'
    ): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'INSERT OR REPLACE INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, ?)',
            gameRoomId, discordUserId, role
        );
        // Sprint 6.5: room admin grants imply membership.
        const { RoomMembershipService } = await import('./RoomMembershipService.js');
        await RoomMembershipService.addMember(discordUserId, gameRoomId, 'admin_invite');
    }

    static async removeRoomDiscordAdmin(gameRoomId: string, discordUserId: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            'DELETE FROM game_room_admins WHERE game_room_id = ? AND discord_user_id = ?',
            gameRoomId, discordUserId
        );
        return (result.changes || 0) > 0;
    }

    // --- Local Admins (per-room username/password) ---

    static async getLocalAdmins(gameRoomId: string): Promise<LocalAdmin[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT id, game_room_id, username, display_name, created_at
             FROM local_admins WHERE game_room_id = ? ORDER BY created_at ASC`,
            gameRoomId
        );
    }

    static async getLocalAdminByUsername(gameRoomId: string, username: string): Promise<(LocalAdmin & { password_hash: string }) | undefined> {
        const db = await getDatabase();
        return db.get(
            'SELECT * FROM local_admins WHERE game_room_id = ? AND LOWER(username) = LOWER(?)',
            gameRoomId, username
        );
    }

    static async getLocalAdminById(id: string): Promise<(LocalAdmin & { password_hash: string }) | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM local_admins WHERE id = ?', id);
    }

    static async createLocalAdmin(
        gameRoomId: string, username: string, password: string, displayName?: string
    ): Promise<LocalAdmin> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        const passwordHash = await bcrypt.hash(password, 12);
        await db.run(
            `INSERT INTO local_admins (id, game_room_id, username, password_hash, display_name)
             VALUES (?, ?, ?, ?, ?)`,
            id, gameRoomId, username, passwordHash, displayName || username
        );
        return { id, game_room_id: gameRoomId, username, display_name: displayName || username, created_at: new Date().toISOString() };
    }

    static async deleteLocalAdmin(id: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run('DELETE FROM local_admins WHERE id = ?', id);
        return (result.changes || 0) > 0;
    }

    static async resetLocalAdminPassword(id: string, newPassword: string): Promise<boolean> {
        const db = await getDatabase();
        const hash = await bcrypt.hash(newPassword, 12);
        const result = await db.run('UPDATE local_admins SET password_hash = ? WHERE id = ?', hash, id);
        return (result.changes || 0) > 0;
    }

    static async verifyLocalAdminPassword(admin: { password_hash: string }, password: string): Promise<boolean> {
        return bcrypt.compare(password, admin.password_hash);
    }

    // --- Admin Invites ---

    static async createInvite(
        gameRoomId: string, displayName: string, createdBy?: string, discordUserId?: string, expiresInHours = 48
    ): Promise<{ id: string; token: string; expires_at: string }> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        const token = crypto.randomBytes(32).toString('base64url');
        const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString();
        await db.run(
            `INSERT INTO admin_invites (id, token, game_room_id, display_name, discord_user_id, created_by, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id, token, gameRoomId, displayName, discordUserId || null, createdBy || null, expiresAt
        );
        return { id, token, expires_at: expiresAt };
    }

    static async getPendingInvites(gameRoomId: string): Promise<Array<{
        id: string; token: string; display_name: string; discord_user_id: string | null;
        created_by: string | null; expires_at: string; created_at: string;
    }>> {
        const db = await getDatabase();
        return db.all(
            `SELECT id, token, display_name, discord_user_id, created_by, expires_at, created_at
             FROM admin_invites
             WHERE game_room_id = ? AND accepted_at IS NULL AND expires_at > datetime('now')
             ORDER BY created_at DESC`,
            gameRoomId
        );
    }

    static async getInviteByToken(token: string): Promise<{
        id: string; token: string; game_room_id: string; display_name: string;
        discord_user_id: string | null; expires_at: string; accepted_at: string | null;
    } | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM admin_invites WHERE token = ?', token);
    }

    static async acceptInvite(token: string, username: string, password: string): Promise<LocalAdmin> {
        const db = await getDatabase();
        const invite = await this.getInviteByToken(token);
        if (!invite) throw new Error('Invite not found');
        if (invite.accepted_at) throw new Error('Invite already used');
        if (new Date(invite.expires_at) < new Date()) throw new Error('Invite expired');

        // Check username doesn't already exist
        const existing = await this.getLocalAdminByUsername(invite.game_room_id, username);
        if (existing) throw new Error('Username already exists for this room');

        // Create the local admin
        const admin = await this.createLocalAdmin(invite.game_room_id, username, password, invite.display_name);

        // Mark invite as accepted
        await db.run('UPDATE admin_invites SET accepted_at = datetime(\'now\') WHERE token = ?', token);
        return admin;
    }

    static async cancelInvite(id: string, gameRoomId: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            'DELETE FROM admin_invites WHERE id = ? AND game_room_id = ?',
            id, gameRoomId
        );
        return (result.changes || 0) > 0;
    }
}
