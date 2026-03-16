import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import type { GameRoom } from '../types/index.js';

export class GameRoomService {
    static async getAll(): Promise<GameRoom[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM game_rooms ORDER BY created_at ASC');
    }

    static async getPublic(): Promise<GameRoom[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM game_rooms WHERE is_public = 1 ORDER BY name ASC');
    }

    static async getById(id: string): Promise<GameRoom | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM game_rooms WHERE id = ?', id);
    }

    static async getBySlug(slug: string): Promise<GameRoom | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM game_rooms WHERE LOWER(slug) = LOWER(?)', slug);
    }

    static async getByGuildId(guildId: string): Promise<GameRoom | undefined> {
        const db = await getDatabase();
        return db.get('SELECT * FROM game_rooms WHERE discord_guild_id = ?', guildId);
    }

    static async create(data: {
        name: string;
        slug: string;
        description?: string;
        is_public?: boolean;
        logo_url?: string;
        discord_guild_id?: string;
    }): Promise<GameRoom> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO game_rooms (id, name, slug, description, is_public, logo_url, discord_guild_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            id, data.name, data.slug.toLowerCase(),
            data.description || '', data.is_public !== false ? 1 : 0,
            data.logo_url || null, data.discord_guild_id || null
        );
        return (await GameRoomService.getById(id))!;
    }

    static async update(id: string, data: Partial<{
        name: string;
        slug: string;
        description: string;
        is_public: boolean;
        logo_url: string | null;
        discord_guild_id: string | null;
    }>): Promise<boolean> {
        const db = await getDatabase();
        const sets: string[] = [];
        const params: unknown[] = [];

        if (data.name !== undefined) { sets.push('name = ?'); params.push(data.name); }
        if (data.slug !== undefined) { sets.push('slug = ?'); params.push(data.slug.toLowerCase()); }
        if (data.description !== undefined) { sets.push('description = ?'); params.push(data.description); }
        if (data.is_public !== undefined) { sets.push('is_public = ?'); params.push(data.is_public ? 1 : 0); }
        if (data.logo_url !== undefined) { sets.push('logo_url = ?'); params.push(data.logo_url); }
        if (data.discord_guild_id !== undefined) { sets.push('discord_guild_id = ?'); params.push(data.discord_guild_id); }

        if (sets.length === 0) return false;
        params.push(id);

        const result = await db.run(`UPDATE game_rooms SET ${sets.join(', ')} WHERE id = ?`, ...params);
        return (result.changes || 0) > 0;
    }

    static async delete(id: string): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run('DELETE FROM game_rooms WHERE id = ?', id);
        return (result.changes || 0) > 0;
    }
}
