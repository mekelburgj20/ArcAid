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
     *
     * v2.86.0 (migration 139) — room-scoped: the same game name in two
     * different rooms now keeps independent aggregates. `game_ratings`
     * carries `game_room_id` and the UNIQUE constraint is
     * `(game_room_id, game_name, user_id)`.
     */
    static async setRating(roomId: string, gameName: string, userId: string, rating: number): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_ratings (game_room_id, game_name, user_id, rating, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(game_room_id, game_name, user_id) DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`,
            roomId, gameName, userId, rating
        );
    }

    /**
     * Get a single game's rating info for a specific user, scoped to a room.
     */
    static async getGameRating(roomId: string, gameName: string, userId?: string): Promise<GameRatingInfo> {
        const db = await getDatabase();
        const agg = await db.get(
            `SELECT AVG(rating) as avg_rating, COUNT(*) as rating_count FROM game_ratings WHERE game_room_id = ? AND game_name = ?`,
            roomId, gameName
        );
        let userRating: number | null = null;
        if (userId) {
            const row = await db.get(
                `SELECT rating FROM game_ratings WHERE game_room_id = ? AND game_name = ? AND user_id = ?`,
                roomId, gameName, userId
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
     * Get ratings for all games in a room (bulk, for game library view).
     * Returns a map of game_name → { avg_rating, rating_count }.
     */
    static async getAllRatings(roomId: string): Promise<Record<string, { avg_rating: number; rating_count: number }>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT game_name, AVG(rating) as avg_rating, COUNT(*) as rating_count FROM game_ratings WHERE game_room_id = ? GROUP BY game_name`,
            roomId
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
     * Get all ratings by a specific user in a room (for showing their stars in the library).
     */
    static async getUserRatings(roomId: string, userId: string): Promise<Record<string, number>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT game_name, rating FROM game_ratings WHERE game_room_id = ? AND user_id = ?`,
            roomId, userId
        );
        const map: Record<string, number> = {};
        for (const r of rows) {
            map[r.game_name] = r.rating;
        }
        return map;
    }
}
