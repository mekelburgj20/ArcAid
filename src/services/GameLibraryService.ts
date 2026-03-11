import { getDatabase } from '../database/database.js';

interface GameData {
    name: string;
    aliases?: string;
    style_id?: string;
    mode?: string;
    css_title?: string;
    css_initials?: string;
    css_scores?: string;
    css_box?: string;
    bg_color?: string;
    platforms?: string;
}

export class GameLibraryService {
    /**
     * Returns all games in the library.
     */
    static async getAll(): Promise<any[]> {
        const db = await getDatabase();
        return db.all('SELECT * FROM game_library');
    }

    /**
     * Updates a single game by its original name.
     */
    static async updateGame(originalName: string, game: GameData): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_library SET name = ?, aliases = ?, style_id = ?, mode = ?, css_title = ?, css_initials = ?, css_scores = ?, css_box = ?, bg_color = ?, platforms = ? WHERE name = ?`,
            game.name, game.aliases || '', game.style_id || '',
            game.mode || 'pinball',
            game.css_title || '', game.css_initials || '',
            game.css_scores || '', game.css_box || '',
            game.bg_color || '', game.platforms || '[]',
            originalName
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Updates only the style fields for a game (preserves other fields).
     * Used by the style learning loop during maintenance.
     */
    static async updateStyles(name: string, styles: {
        style_id?: string | null;
        css_title?: string;
        css_initials?: string;
        css_scores?: string;
        css_box?: string;
        bg_color?: string;
    }): Promise<boolean> {
        const db = await getDatabase();
        const result = await db.run(
            `UPDATE game_library SET
                style_id = COALESCE(?, style_id),
                css_title = COALESCE(?, css_title),
                css_initials = COALESCE(?, css_initials),
                css_scores = COALESCE(?, css_scores),
                css_box = COALESCE(?, css_box),
                bg_color = COALESCE(?, bg_color)
            WHERE name = ?`,
            styles.style_id || null,
            styles.css_title || null,
            styles.css_initials || null,
            styles.css_scores || null,
            styles.css_box || null,
            styles.bg_color || null,
            name
        );
        return (result.changes ?? 0) > 0;
    }

    /**
     * Imports an array of games into the library (upsert).
     * Runs in a transaction for atomicity.
     */
    static async importGames(games: GameData[]): Promise<number> {
        const db = await getDatabase();

        await db.exec('BEGIN TRANSACTION');
        try {
            for (const game of games) {
                await db.run(
                    `INSERT OR REPLACE INTO game_library
                    (name, aliases, style_id, mode, css_title, css_initials, css_scores, css_box, bg_color, platforms)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    game.name, game.aliases || '', game.style_id || '',
                    game.mode || 'pinball',
                    game.css_title || '', game.css_initials || '',
                    game.css_scores || '', game.css_box || '',
                    game.bg_color || '', game.platforms || '[]'
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
