import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';

export class TournamentService {
    /**
     * Returns all tournaments.
     */
    static async getAll(): Promise<any[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM tournaments');
    }

    /**
     * Creates a new tournament.
     */
    static async create(data: {
        id: string;
        name: string;
        type: string;
        cadence: any;
        guild_id?: string;
        discord_channel_id?: string;
        discord_role_id?: string;
        is_active?: boolean;
    }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO tournaments (id, name, type, cadence, guild_id, discord_channel_id, discord_role_id, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            data.id, data.name, data.type, JSON.stringify(data.cadence),
            data.guild_id, data.discord_channel_id, data.discord_role_id,
            data.is_active ? 1 : 0
        );
    }

    /**
     * Updates an existing tournament by ID.
     */
    static async update(id: string, data: {
        name: string;
        type: string;
        cadence: any;
        guild_id?: string;
        discord_channel_id?: string;
        discord_role_id?: string;
        is_active?: boolean;
    }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'UPDATE tournaments SET name = ?, type = ?, cadence = ?, guild_id = ?, discord_channel_id = ?, discord_role_id = ?, is_active = ? WHERE id = ?',
            data.name, data.type, JSON.stringify(data.cadence),
            data.guild_id, data.discord_channel_id, data.discord_role_id,
            data.is_active ? 1 : 0, id
        );
    }

    /**
     * Deletes a tournament by ID.
     */
    static async delete(id: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM tournaments WHERE id = ?', id);
    }
}
