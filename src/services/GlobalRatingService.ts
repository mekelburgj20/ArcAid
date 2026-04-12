import { getDatabase } from '../database/database.js';

export interface GlobalGameRatingInfo {
    global_game_id: string;
    avg_rating: number;
    rating_count: number;
    user_rating: number | null;
}

export class GlobalRatingService {
    /**
     * Set or update a Discord user's rating for a global game.
     */
    static async setRating(globalGameId: string, discordUserId: string, rating: number): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_game_ratings (global_game_id, discord_user_id, rating, updated_at)
             VALUES (?, ?, ?, datetime('now'))
             ON CONFLICT(global_game_id, discord_user_id) DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`,
            globalGameId, discordUserId, rating
        );
    }

    /**
     * Get a single game's rating info, optionally with a specific user's rating.
     */
    static async getGameRating(globalGameId: string, discordUserId?: string): Promise<GlobalGameRatingInfo> {
        const db = await getDatabase();
        const agg = await db.get(
            `SELECT AVG(rating) as avg_rating, COUNT(*) as rating_count FROM global_game_ratings WHERE global_game_id = ?`,
            globalGameId
        );
        let userRating: number | null = null;
        if (discordUserId) {
            const row = await db.get(
                `SELECT rating FROM global_game_ratings WHERE global_game_id = ? AND discord_user_id = ?`,
                globalGameId, discordUserId
            );
            if (row) userRating = row.rating;
        }
        return {
            global_game_id: globalGameId,
            avg_rating: agg?.avg_rating ? Math.round(agg.avg_rating * 10) / 10 : 0,
            rating_count: agg?.rating_count || 0,
            user_rating: userRating,
        };
    }

    /**
     * Bulk ratings for the scoreboard page — returns a map of globalGameId →
     * { avg_rating, rating_count }. Optionally includes the user's ratings.
     */
    static async getBulkRatings(discordUserId?: string): Promise<{
        ratings: Record<string, { avg_rating: number; rating_count: number }>;
        userRatings: Record<string, number>;
    }> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT global_game_id, AVG(rating) as avg_rating, COUNT(*) as rating_count
             FROM global_game_ratings GROUP BY global_game_id`
        );
        const ratings: Record<string, { avg_rating: number; rating_count: number }> = {};
        for (const r of rows) {
            ratings[r.global_game_id] = {
                avg_rating: Math.round(r.avg_rating * 10) / 10,
                rating_count: r.rating_count,
            };
        }

        const userRatings: Record<string, number> = {};
        if (discordUserId) {
            const userRows = await db.all(
                `SELECT global_game_id, rating FROM global_game_ratings WHERE discord_user_id = ?`,
                discordUserId
            );
            for (const r of userRows) {
                userRatings[r.global_game_id] = r.rating;
            }
        }

        return { ratings, userRatings };
    }
}
