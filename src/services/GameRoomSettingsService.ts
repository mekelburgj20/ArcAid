import { getDatabase } from '../database/database.js';

export class GameRoomSettingsService {
    static async get(gameRoomId: string, key: string): Promise<string | null> {
        const db = await getDatabase();
        const row = await db.get(
            'SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
        return row?.value ?? null;
    }

    static async getAll(gameRoomId: string): Promise<Record<string, string>> {
        const db = await getDatabase();
        const rows = await db.all(
            'SELECT key, value FROM game_room_settings WHERE game_room_id = ?',
            gameRoomId
        );
        return rows.reduce((acc: Record<string, string>, row: any) => {
            acc[row.key] = row.value;
            return acc;
        }, {});
    }

    static async set(gameRoomId: string, key: string, value: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
            gameRoomId, key, value
        );
    }

    static async saveMany(gameRoomId: string, settings: Record<string, string>): Promise<void> {
        const db = await getDatabase();
        for (const [key, value] of Object.entries(settings)) {
            if (value === '') continue;
            await db.run(
                'INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)',
                gameRoomId, key, value
            );
        }
    }

    static async delete(gameRoomId: string, key: string): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'DELETE FROM game_room_settings WHERE game_room_id = ? AND key = ?',
            gameRoomId, key
        );
    }
}
