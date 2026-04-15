import { getDatabase } from '../database/database.js';
import { v4 as uuidv4 } from 'uuid';

export interface ShelfItem {
    id: string;
    game_room_id: string;
    type: string;
    url: string;
    title: string;
    thumbnail: string | null;
    description: string | null;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

export interface CreateShelfItemParams {
    url: string;
    title: string;
    type?: string;
    thumbnail?: string;
    description?: string;
    sort_order?: number;
}

/** Auto-detect media type from URL domain */
function detectType(url: string): string {
    try {
        const host = new URL(url).hostname.toLowerCase();
        if (host.includes('youtube.com') || host.includes('youtu.be')) return 'youtube';
        if (host.includes('twitch.tv')) return 'twitch_vod';
        if (host.includes('medium.com') || host.includes('substack.com')) return 'article';
    } catch { /* invalid URL */ }
    return 'link';
}

export class CommunityShelfService {
    static async create(gameRoomId: string, params: CreateShelfItemParams): Promise<ShelfItem> {
        const db = await getDatabase();
        const id = uuidv4();
        const type = params.type || detectType(params.url);
        await db.run(
            `INSERT INTO community_shelf_items (id, game_room_id, type, url, title, thumbnail, description, sort_order)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            id, gameRoomId, type,
            params.url, params.title,
            params.thumbnail || null,
            params.description || null,
            params.sort_order ?? 0,
        );
        return (await db.get('SELECT * FROM community_shelf_items WHERE id = ?', id)) as ShelfItem;
    }

    static async update(id: string, params: Partial<CreateShelfItemParams>): Promise<ShelfItem | null> {
        const db = await getDatabase();
        const sets: string[] = [];
        const values: any[] = [];
        for (const [key, val] of Object.entries(params)) {
            sets.push(`${key} = ?`);
            values.push(val ?? null);
        }
        if (sets.length === 0) return this.getById(id);
        sets.push("updated_at = datetime('now')");
        values.push(id);
        await db.run(`UPDATE community_shelf_items SET ${sets.join(', ')} WHERE id = ?`, ...values);
        return this.getById(id);
    }

    static async delete(id: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM community_shelf_items WHERE id = ?', id);
    }

    static async getById(id: string): Promise<ShelfItem | null> {
        const db = await getDatabase();
        return db.get('SELECT * FROM community_shelf_items WHERE id = ?', id) as Promise<ShelfItem | null>;
    }

    static async getAll(gameRoomId: string): Promise<ShelfItem[]> {
        const db = await getDatabase();
        return db.all(
            'SELECT * FROM community_shelf_items WHERE game_room_id = ? ORDER BY sort_order ASC, created_at DESC',
            gameRoomId
        );
    }

    static async reorder(gameRoomId: string, orderedIds: string[]): Promise<void> {
        const db = await getDatabase();
        for (let i = 0; i < orderedIds.length; i++) {
            await db.run(
                'UPDATE community_shelf_items SET sort_order = ? WHERE id = ? AND game_room_id = ?',
                i, orderedIds[i], gameRoomId
            );
        }
    }
}
