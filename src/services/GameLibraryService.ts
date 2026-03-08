import { getDatabase } from '../database/database.js';

export class GameLibraryService {
    /**
     * Returns all games in the library.
     */
    static async getAll(): Promise<any[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM game_library');
    }

    /**
     * Imports an array of games into the library (upsert).
     * Runs in a transaction for atomicity.
     */
    static async importGames(games: Array<{
        name: string;
        aliases?: string;
        style_id?: string;
        css_title?: string;
        css_initials?: string;
        css_scores?: string;
        css_box?: string;
        bg_color?: string;
        tournament_types?: string;
    }>): Promise<number> {
        const db = await getDatabase();

        await db.exec('BEGIN TRANSACTION');
        try {
            for (const game of games) {
                await db.run(
                    `INSERT OR REPLACE INTO game_library
                    (name, aliases, style_id, css_title, css_initials, css_scores, css_box, bg_color, tournament_types)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    game.name, game.aliases || '', game.style_id || '',
                    game.css_title || '', game.css_initials || '',
                    game.css_scores || '', game.css_box || '',
                    game.bg_color || '', game.tournament_types || ''
                );
            }
            await db.exec('COMMIT');
            return games.length;
        } catch (error) {
            await db.exec('ROLLBACK').catch(() => {});
            throw error;
        }
    }
}
