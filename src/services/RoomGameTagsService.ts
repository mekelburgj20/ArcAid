import { getDatabase } from '../database/database.js';

/**
 * Per-room game tags. Variant-keyed via `global_games.id` so each catalogue
 * variant is tagged independently. Tags are lowercased + trimmed on write;
 * the FE renders display labels via `getPlatformDisplay` (uppercase fallback
 * for ids not in the canonical platform registry, e.g. user-entered "WMS").
 *
 * Acts as a per-room platform overlay: tournament platform rules + the
 * submission picker UNION the room's tags into the effective platform set
 * for any game that carries one.
 *
 * See ADR 0008 for the rationale on choosing a dedicated table over reviving
 * the deprecated `game_room_game_library.custom_platforms` column.
 */
export class RoomGameTagsService {
    private static normalize(tag: string): string {
        return String(tag || '').trim().toLowerCase();
    }

    /** Returns true if the row was inserted (false on duplicate / no-op). */
    static async addTag(roomId: string, globalGameId: string, tag: string): Promise<boolean> {
        const t = this.normalize(tag);
        if (!t) return false;
        const db = await getDatabase();
        const result = await db.run(
            `INSERT OR IGNORE INTO room_game_tags (game_room_id, global_game_id, tag) VALUES (?, ?, ?)`,
            roomId, globalGameId, t,
        );
        return (result.changes || 0) > 0;
    }

    static async removeTag(roomId: string, globalGameId: string, tag: string): Promise<boolean> {
        const t = this.normalize(tag);
        if (!t) return false;
        const db = await getDatabase();
        const result = await db.run(
            `DELETE FROM room_game_tags WHERE game_room_id = ? AND global_game_id = ? AND tag = ?`,
            roomId, globalGameId, t,
        );
        return (result.changes || 0) > 0;
    }

    /** Tags applied to a single catalogue variant in this room. */
    static async getTagsForGame(roomId: string, globalGameId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT tag FROM room_game_tags WHERE game_room_id = ? AND global_game_id = ? ORDER BY tag`,
            roomId, globalGameId,
        ) as Array<{ tag: string }>;
        return rows.map(r => r.tag);
    }

    /**
     * Returns the per-`global_game_id` tag map for an entire room. Used by
     * the library list endpoint to attach `room_tags: string[]` to each row
     * without N+1 queries.
     */
    static async getTagMapForRoom(roomId: string): Promise<Map<string, string[]>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT global_game_id, tag FROM room_game_tags WHERE game_room_id = ?`,
            roomId,
        ) as Array<{ global_game_id: string; tag: string }>;
        const map = new Map<string, string[]>();
        for (const r of rows) {
            const list = map.get(r.global_game_id) ?? [];
            list.push(r.tag);
            map.set(r.global_game_id, list);
        }
        for (const list of map.values()) list.sort();
        return map;
    }

    /** Distinct tags in a room — drives the platform-rules picker + filter chips. */
    static async getDistinctTagsForRoom(roomId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT DISTINCT tag FROM room_game_tags WHERE game_room_id = ? ORDER BY tag`,
            roomId,
        ) as Array<{ tag: string }>;
        return rows.map(r => r.tag);
    }

    /**
     * Returns the union of all tags applied to ANY catalogue variant of the
     * given game name in this room. Used by tournament-rules + submission
     * platform validation (which key on gameName, not globalGameId).
     */
    static async getTagsForGameName(roomId: string, gameName: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT DISTINCT rgt.tag
             FROM room_game_tags rgt
             JOIN global_games gg ON gg.id = rgt.global_game_id
             WHERE rgt.game_room_id = ? AND LOWER(gg.name) = LOWER(?)`,
            roomId, gameName,
        ) as Array<{ tag: string }>;
        return rows.map(r => r.tag);
    }

    /** Returns count of rows actually inserted (skips duplicates). */
    static async bulkAddTag(roomId: string, globalGameIds: string[], tag: string): Promise<number> {
        const t = this.normalize(tag);
        if (!t || globalGameIds.length === 0) return 0;
        const db = await getDatabase();
        let added = 0;
        await db.exec('BEGIN TRANSACTION');
        try {
            for (const id of globalGameIds) {
                const r = await db.run(
                    `INSERT OR IGNORE INTO room_game_tags (game_room_id, global_game_id, tag) VALUES (?, ?, ?)`,
                    roomId, id, t,
                );
                added += r.changes || 0;
            }
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK').catch(() => {});
            throw err;
        }
        return added;
    }

    static async bulkRemoveTag(roomId: string, globalGameIds: string[], tag: string): Promise<number> {
        const t = this.normalize(tag);
        if (!t || globalGameIds.length === 0) return 0;
        const db = await getDatabase();
        const placeholders = globalGameIds.map(() => '?').join(',');
        const result = await db.run(
            `DELETE FROM room_game_tags
             WHERE game_room_id = ? AND tag = ? AND global_game_id IN (${placeholders})`,
            roomId, t, ...globalGameIds,
        );
        return result.changes || 0;
    }
}
