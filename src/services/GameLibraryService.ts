import { getDatabase } from '../database/database.js';
import { nameRankSqlCase, nameRankSqlParams } from '../utils/searchRank.js';

export class GameLibraryService {
    /**
     * Searches the catalogue by name (partial, case-insensitive). Powers the
     * Add Game autocomplete on the per-room library page. Ranked
     * nearest-exact-match first (search-relevance work package, 2026-08-13).
     */
    static async search(query: string, limit: number = 10): Promise<Array<{ name: string; mode: string; platforms: string }>> {
        const db = await getDatabase();
        // Empty query → existing default order, untouched (search-relevance
        // work package, 2026-08-13).
        const trimmed = (query || '').trim();
        const orderBy = trimmed ? `${nameRankSqlCase('name')}, name COLLATE NOCASE` : 'name';
        const orderParams = trimmed ? nameRankSqlParams(trimmed) : [];
        return db.all(
            `SELECT name, type AS mode, platforms FROM global_games
             WHERE status = 'approved' AND name LIKE ? COLLATE NOCASE
             GROUP BY LOWER(name)
             ORDER BY ${orderBy}
             LIMIT ?`,
            `%${query}%`, ...orderParams, limit,
        );
    }

    /**
     * Set or clear the per-room default catalogue style for a game. Writes the
     * `game_room_game_library` overlay row; the table itself is on the way out
     * (step 2e), at which point this method's storage moves elsewhere.
     */
    static async setRoomGameStyle(gameRoomId: string, gameName: string, catalogueStyleId: string | null, headerDisabled: boolean = false): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_room_game_library SET catalogue_style_id = ?, style_header_disabled = ?
             WHERE game_room_id = ? AND game_name = ?`,
            catalogueStyleId, headerDisabled ? 1 : 0, gameRoomId, gameName
        );
        return (result.changes || 0) > 0;
    }

    /**
     * Get the per-room default catalogue style for a game.
     */
    static async getRoomGameStyle(gameRoomId: string, gameName: string): Promise<{ catalogue_style_id: string | null; logo_style_id: string | null; bg_style_id: string | null; style_header_disabled: number } | undefined> {
        const db = await getDatabase();
        return db.get(
            `SELECT catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled FROM game_room_game_library
             WHERE game_room_id = ? AND game_name = ?`,
            gameRoomId, gameName
        );
    }
}
