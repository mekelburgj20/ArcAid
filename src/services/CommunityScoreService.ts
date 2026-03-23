import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';

export class CommunityScoreService {
    /**
     * Submit a community score for a game.
     */
    static async submitScore(
        gameRoomId: string,
        gameName: string,
        username: string,
        score: number,
        discordUserId?: string,
        photoUrl?: string
    ) {
        const db = await getDatabase();
        const result = await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, discord_user_id, score, photo_url)
             VALUES (?, ?, ?, ?, ?, ?)`,
            gameName, gameRoomId, username, discordUserId || 'ANON', score, photoUrl || null
        );

        // Also log to unified score history
        await ScoreHistoryService.log({
            gameName, gameRoomId, username,
            discordUserId, score, photoUrl,
            source: 'community',
        });

        return { id: result.lastID };
    }

    /**
     * Get community leaderboard for a game (best score per player).
     */
    static async getGameLeaderboard(gameRoomId: string, gameName: string) {
        const db = await getDatabase();
        return db.all(`
            SELECT
                LOWER(iscored_username) as player_key,
                iscored_username,
                MAX(score) as best_score,
                COUNT(*) as times_played,
                MAX(created_at) as last_played
            FROM community_scores
            WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
            GROUP BY LOWER(iscored_username)
            ORDER BY best_score DESC
        `, gameRoomId, gameName);
    }

    /**
     * Get recent community score submissions for a game.
     */
    static async getGameHistory(gameRoomId: string, gameName: string, page = 1, limit = 20) {
        const db = await getDatabase();
        const offset = (page - 1) * limit;
        return db.all(`
            SELECT id, iscored_username, score, photo_url, created_at
            FROM community_scores
            WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
            ORDER BY created_at DESC
            LIMIT ? OFFSET ?
        `, gameRoomId, gameName, limit, offset);
    }

    /**
     * Get recent activity across all games in a room.
     */
    static async getRecentActivity(gameRoomId: string, limit = 20) {
        const db = await getDatabase();
        return db.all(`
            SELECT id, game_name, iscored_username, score, created_at
            FROM community_scores
            WHERE game_room_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        `, gameRoomId, limit);
    }
}
