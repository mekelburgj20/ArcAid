import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { getDatabase } from '../database/database.js';
import type { LocalAdmin, GameRoomAdmin, SuperAdmin } from '../types/index.js';

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

    static async getRoomDiscordAdmins(gameRoomId: string): Promise<GameRoomAdmin[]> {
        const db = await getDatabase();
        return db.all(
            'SELECT * FROM game_room_admins WHERE game_room_id = ? ORDER BY role DESC',
            gameRoomId
        );
    }

    static async getRoomsForDiscordUser(discordUserId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all(
            'SELECT game_room_id FROM game_room_admins WHERE discord_user_id = ?',
            discordUserId
        );
        return rows.map((r: any) => r.game_room_id);
    }

    static async addRoomDiscordAdmin(
        gameRoomId: string, discordUserId: string, role: 'admin' | 'owner' = 'admin'
    ): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'INSERT OR REPLACE INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, ?)',
            gameRoomId, discordUserId, role
        );
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
}
