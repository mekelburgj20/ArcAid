import { getDatabase } from '../database/database.js';
import { trackBackground } from '../utils/backgroundTasks.js';

export interface RoomEvent {
    id: number;
    game_room_id: string;
    event_type: string;
    event_data: Record<string, any>;
    created_at: string;
}

export class RoomEventService {
    /**
     * Callers fire this without awaiting (`.catch(() => {})`), so the write is
     * registered with the background-task tracker: tests drain it before
     * resetting the shared in-memory DB. Awaiting callers see identical
     * behavior — the original promise (and its rejection) is returned.
     */
    static log(gameRoomId: string, eventType: string, eventData: Record<string, any> = {}): Promise<void> {
        return trackBackground(this.writeEvent(gameRoomId, eventType, eventData));
    }

    private static async writeEvent(gameRoomId: string, eventType: string, eventData: Record<string, any>): Promise<void> {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO room_events (game_room_id, event_type, event_data) VALUES (?, ?, ?)',
            gameRoomId, eventType, JSON.stringify(eventData)
        );
    }

    static async getRecent(gameRoomId: string, limit: number = 50, offset: number = 0): Promise<RoomEvent[]> {
        const db = await getDatabase();
        const rows = await db.all(
            'SELECT * FROM room_events WHERE game_room_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
            gameRoomId, limit, offset
        );
        return rows.map((r: any) => ({
            ...r,
            event_data: JSON.parse(r.event_data || '{}'),
        }));
    }

    static async cleanup(retentionDays: number = 7): Promise<number> {
        const db = await getDatabase();
        const result = await db.run(
            "DELETE FROM room_events WHERE created_at < datetime('now', ?)",
            `-${retentionDays} days`
        );
        return result.changes || 0;
    }
}
