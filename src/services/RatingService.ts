import { getDatabase } from '../database/database.js';

export interface GameRatingInfo {
    game_name: string;
    avg_rating: number;
    rating_count: number;
    user_rating: number | null;
}

export class RatingService {
    /**
     * Set or update a user's rating for a game.
     */
    static async setRating(gameName: string, userId: string, rating: number): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_ratings (game_name, user_id, rating, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(game_name, user_id) DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`,
            gameName, userId, rating
        );
    }

    /**
     * Get a single game's rating info for a specific user.
     */
    static async getGameRating(gameName: string, userId?: string): Promise<GameRatingInfo> {
        const db = await getDatabase();
        const agg = await db.get(
            `SELECT AVG(rating) as avg_rating, COUNT(*) as rating_count FROM game_ratings WHERE game_name = ?`,
            gameName
        );
        let userRating: number | null = null;
        if (userId) {
            const row = await db.get(
                `SELECT rating FROM game_ratings WHERE game_name = ? AND user_id = ?`,
                gameName, userId
            );
            if (row) userRating = row.rating;
        }
        return {
            game_name: gameName,
            avg_rating: agg?.avg_rating ? Math.round(agg.avg_rating * 10) / 10 : 0,
            rating_count: agg?.rating_count || 0,
            user_rating: userRating,
        };
    }

    /**
     * Get ratings for all games (bulk, for game library view).
     * Returns a map of game_name → { avg_rating, rating_count }.
     */
    static async getAllRatings(): Promise<Record<string, { avg_rating: number; rating_count: number }>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT game_name, AVG(rating) as avg_rating, COUNT(*) as rating_count FROM game_ratings GROUP BY game_name`
        );
        const map: Record<string, { avg_rating: number; rating_count: number }> = {};
        for (const r of rows) {
            map[r.game_name] = {
                avg_rating: Math.round(r.avg_rating * 10) / 10,
                rating_count: r.rating_count,
            };
        }
        return map;
    }

    /**
     * Get all ratings by a specific user (for showing their stars in the library).
     */
    static async getUserRatings(userId: string): Promise<Record<string, number>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT game_name, rating FROM game_ratings WHERE user_id = ?`,
            userId
        );
        const map: Record<string, number> = {};
        for (const r of rows) {
            map[r.game_name] = r.rating;
        }
        return map;
    }
}
