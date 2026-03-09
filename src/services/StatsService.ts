import { getDatabase } from '../database/database.js';

export class StatsService {
    /**
     * Get comprehensive stats for a player by Discord user ID.
     */
    static async getPlayerStats(discordUserId: string) {
        const db = await getDatabase();

        // Total games played (unique games they submitted scores for)
        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions
            WHERE discord_user_id = ?
        `, discordUserId);

        // Total wins (games where they had the highest score)
        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                WHERE g.status = 'COMPLETED'
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                AND s.discord_user_id = ?
            )
        `, discordUserId);

        // Average and best score
        const scoreStats = await db.get(`
            SELECT AVG(score) as avg_score, MAX(score) as best_score
            FROM submissions
            WHERE discord_user_id = ?
        `, discordUserId);

        // Best game (game where they got their highest score)
        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            WHERE s.discord_user_id = ?
            ORDER BY s.score DESC
            LIMIT 1
        `, discordUserId);

        // Recent scores (last 10)
        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            WHERE s.discord_user_id = ?
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, discordUserId);

        // Username from mappings
        const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', discordUserId);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;

        return {
            discordUserId,
            iscoredUsername: mapping?.iscored_username || null,
            totalGamesPlayed: totalGames,
            totalWins: totalWins,
            winPercentage: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0,
            averageScore: Math.round(scoreStats?.avg_score ?? 0),
            bestScore: scoreStats?.best_score ?? 0,
            bestGame: bestGame?.game_name || null,
            recentScores,
        };
    }

    /**
     * Get comprehensive stats for a game by name.
     */
    static async getGameStats(gameName: string) {
        const db = await getDatabase();

        // Find all games with this name
        const games = await db.all('SELECT id FROM games WHERE name = ? COLLATE NOCASE', gameName);
        if (games.length === 0) return null;

        const gameIds = games.map((g: any) => g.id);
        const placeholders = gameIds.map(() => '?').join(',');

        // Times played
        const timesPlayed = gameIds.length;

        // Score stats across all instances
        const stats = await db.get(`
            SELECT AVG(score) as avg_score, MAX(score) as high_score,
                   COUNT(DISTINCT discord_user_id) as unique_players
            FROM submissions
            WHERE game_id IN (${placeholders})
        `, ...gameIds);

        // All-time high holder
        const highHolder = await db.get(`
            SELECT iscored_username, score
            FROM submissions
            WHERE game_id IN (${placeholders})
            ORDER BY score DESC
            LIMIT 1
        `, ...gameIds);

        // Recent results (completed games with winner)
        const recentResults = await db.all(`
            SELECT
                t.name as tournament_name,
                s.iscored_username as winner_name,
                s.score as winner_score,
                g.end_date
            FROM games g
            JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN (
                SELECT game_id, iscored_username, score,
                       ROW_NUMBER() OVER (PARTITION BY game_id ORDER BY score DESC) AS rn
                FROM submissions
            ) s ON s.game_id = g.id AND s.rn = 1
            WHERE g.name = ? COLLATE NOCASE AND g.status = 'COMPLETED'
            ORDER BY g.end_date DESC
            LIMIT 10
        `, gameName);

        return {
            gameName,
            timesPlayed,
            avgScore: Math.round(stats?.avg_score ?? 0),
            uniquePlayers: stats?.unique_players ?? 0,
            allTimeHigh: stats?.high_score ?? 0,
            allTimeHighPlayer: highHolder?.iscored_username || null,
            recentResults,
        };
    }

    /**
     * Get all players with their basic stats (for leaderboard overview).
     */
    static async getAllPlayerStats() {
        const db = await getDatabase();
        return db.all(`
            SELECT
                s.discord_user_id,
                um.iscored_username,
                COUNT(DISTINCT s.game_id) as games_played,
                MAX(s.score) as best_score,
                ROUND(AVG(s.score)) as avg_score
            FROM submissions s
            LEFT JOIN user_mappings um ON s.discord_user_id = um.discord_user_id
            GROUP BY s.discord_user_id
            ORDER BY best_score DESC
        `);
    }
}
