import { getDatabase } from '../database/database.js';
import { v4 as uuidv4 } from 'uuid';

export interface Announcement {
    id: string;
    game_room_id: string;
    title: string;
    body: string | null;
    image_url: string | null;
    cta_url: string | null;
    cta_label: string | null;
    type: string;
    event_datetime: string | null;
    display_from: string;
    display_until: string | null;
    sort_order: number;
    created_by: string | null;
    created_at: string;
    updated_at: string;
}

export interface CreateAnnouncementParams {
    title: string;
    body?: string;
    image_url?: string;
    cta_url?: string;
    cta_label?: string;
    type?: string;
    event_datetime?: string;
    display_from?: string;
    display_until?: string;
    sort_order?: number;
    created_by?: string;
}

export class AnnouncementService {
    static async create(gameRoomId: string, params: CreateAnnouncementParams): Promise<Announcement> {
        const db = await getDatabase();
        const id = uuidv4();
        await db.run(
            `INSERT INTO lobby_announcements
                (id, game_room_id, title, body, image_url, cta_url, cta_label, type, event_datetime, display_from, display_until, sort_order, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, gameRoomId,
            params.title,
            params.body || null,
            params.image_url || null,
            params.cta_url || null,
            params.cta_label || null,
            params.type || 'announcement',
            params.event_datetime || null,
            params.display_from || new Date().toISOString(),
            params.display_until || null,
            params.sort_order ?? 0,
            params.created_by || null,
        );
        return (await db.get('SELECT * FROM lobby_announcements WHERE id = ?', id)) as Announcement;
    }

    static async update(id: string, params: Partial<CreateAnnouncementParams>): Promise<Announcement | null> {
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
        await db.run(`UPDATE lobby_announcements SET ${sets.join(', ')} WHERE id = ?`, ...values);
        return this.getById(id);
    }

    static async delete(id: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM lobby_announcements WHERE id = ?', id);
    }

    static async getById(id: string): Promise<Announcement | null> {
        const db = await getDatabase();
        return db.get('SELECT * FROM lobby_announcements WHERE id = ?', id) as Promise<Announcement | null>;
    }

    /** Active announcements: display_from <= now AND (display_until IS NULL OR > now) */
    static async getActive(gameRoomId: string): Promise<Announcement[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM lobby_announcements
             WHERE game_room_id = ?
               AND display_from <= datetime('now')
               AND (display_until IS NULL OR display_until > datetime('now'))
             ORDER BY sort_order ASC, created_at DESC`,
            gameRoomId
        );
    }

    /** All announcements for admin view (includes expired/scheduled) */
    static async getAll(gameRoomId: string): Promise<Announcement[]> {
        const db = await getDatabase();
        return db.all(
            'SELECT * FROM lobby_announcements WHERE game_room_id = ? ORDER BY sort_order ASC, created_at DESC',
            gameRoomId
        );
    }
}
