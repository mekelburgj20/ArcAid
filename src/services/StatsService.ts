import { getDatabase } from '../database/database.js';

export class StatsService {
    /**
     * Get comprehensive stats for a player by Discord user ID.
     */
    static async getPlayerStats(discordUserId: string, gameRoomId?: string) {
        const db = await getDatabase();

        // Build room-scoped subquery for game IDs
        const gameIdFilter = gameRoomId
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE t.game_room_id = ?)`
            : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        // Total games played (unique games they submitted scores for)
        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE discord_user_id = ? ${gameIdFilter}
        `, discordUserId, ...roomParams);

        // Total wins (games where they had the highest score)
        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
                WHERE g.status = 'COMPLETED'
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                AND s.discord_user_id = ?
                ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            )
        `, discordUserId, ...roomParams);

        // Average and best score
        const scoreStats = await db.get(`
            SELECT AVG(score) as avg_score, MAX(score) as best_score
            FROM submissions s
            WHERE discord_user_id = ? ${gameIdFilter}
        `, discordUserId, ...roomParams);

        // Best game (game where they got their highest score)
        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE s.discord_user_id = ?
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY s.score DESC
            LIMIT 1
        `, discordUserId, ...roomParams);

        // Recent scores (last 10)
        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE s.discord_user_id = ?
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, discordUserId, ...roomParams);

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
     * Get comprehensive stats for a player by iScored username.
     */
    static async getPlayerStatsByUsername(username: string, gameRoomId?: string) {
        const db = await getDatabase();

        const gameIdFilter = gameRoomId
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE t.game_room_id = ?)`
            : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE LOWER(iscored_username) = LOWER(?) ${gameIdFilter}
        `, username, ...roomParams);

        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
                WHERE g.status = 'COMPLETED'
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                AND LOWER(s.iscored_username) = LOWER(?)
                ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            )
        `, username, ...roomParams);

        const scoreStats = await db.get(`
            SELECT AVG(score) as avg_score, MAX(score) as best_score
            FROM submissions s
            WHERE LOWER(iscored_username) = LOWER(?) ${gameIdFilter}
        `, username, ...roomParams);

        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY s.score DESC
            LIMIT 1
        `, username, ...roomParams);

        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : ''}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, username, ...roomParams);

        // Try to find a discord_user_id for this username
        const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)', username);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;

        return {
            discordUserId: mapping?.discord_user_id || null,
            iscoredUsername: username,
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
    static async getGameStats(gameName: string, gameRoomId?: string) {
        const db = await getDatabase();

        // Find all games with this name, optionally filtered by room
        let games;
        if (gameRoomId) {
            games = await db.all(
                `SELECT g.id FROM games g
                 JOIN tournaments t ON g.tournament_id = t.id
                 WHERE g.name = ? COLLATE NOCASE AND t.game_room_id = ?`,
                gameName, gameRoomId
            );
        } else {
            games = await db.all('SELECT id FROM games WHERE name = ? COLLATE NOCASE', gameName);
        }
        if (games.length === 0) return null;

        const gameIds = games.map((g: any) => g.id);
        const placeholders = gameIds.map(() => '?').join(',');

        // Times played
        const timesPlayed = gameIds.length;

        // Score stats across all instances
        const stats = await db.get(`
            SELECT AVG(score) as avg_score, MAX(score) as high_score,
                   COUNT(DISTINCT LOWER(iscored_username)) as unique_players
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
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY g.end_date DESC
            LIMIT 10
        `, gameName, ...(gameRoomId ? [gameRoomId] : []));

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
     * Get enhanced stats for a single player by Discord user ID.
     * Returns finish positions, top-5 rate, champion streak, and recent scores.
     */
    static async getEnhancedPlayerStats(discordUserId: string, gameRoomId?: string) {
        const db = await getDatabase();

        const gameIdFilter = gameRoomId
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE t.game_room_id = ?)`
            : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';

        // Total games played
        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE discord_user_id = ? ${gameIdFilter}
        `, discordUserId, ...roomParams);

        // Total wins
        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status = 'COMPLETED'
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                AND s.discord_user_id = ?
                ${roomWhere}
            )
        `, discordUserId, ...roomParams);

        // Average finish position and top-5 rate
        const finishStats = await db.all(`
            SELECT s.game_id,
                   (SELECT COUNT(*) + 1 FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.score > s.score) as finish_position,
                   (SELECT COUNT(*) FROM submissions s2 WHERE s2.game_id = s.game_id) as total_players
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE g.status = 'COMPLETED' AND s.discord_user_id = ?
            ${roomWhere}
        `, discordUserId, ...roomParams);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;
        const avgFinish = finishStats.length > 0
            ? finishStats.reduce((sum: number, r: any) => sum + r.finish_position, 0) / finishStats.length
            : 0;
        const top5Count = finishStats.filter((r: any) => r.finish_position <= 5).length;
        const top5Rate = finishStats.length > 0 ? top5Count / finishStats.length : 0;

        // Champion streak: consecutive most-recent wins
        const recentGames = await db.all(`
            SELECT g.id as game_id, g.end_date,
                   (SELECT s2.discord_user_id FROM submissions s2 WHERE s2.game_id = g.id ORDER BY s2.score DESC LIMIT 1) as winner_id
            FROM games g
            ${roomJoin}
            WHERE g.status = 'COMPLETED'
            ${roomWhere}
            ORDER BY g.end_date DESC
        `, ...roomParams);

        let championStreak = 0;
        for (const game of recentGames) {
            if ((game as any).winner_id === discordUserId) {
                championStreak++;
            } else {
                break;
            }
        }

        // Best game
        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE s.discord_user_id = ?
            ${roomWhere}
            ORDER BY s.score DESC
            LIMIT 1
        `, discordUserId, ...roomParams);

        // Recent scores
        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE s.discord_user_id = ?
            ${roomWhere}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, discordUserId, ...roomParams);

        const mapping = await db.get('SELECT iscored_username FROM user_mappings WHERE discord_user_id = ?', discordUserId);

        return {
            discordUserId,
            iscoredUsername: mapping?.iscored_username || null,
            totalGamesPlayed: totalGames,
            totalWins: totalWins,
            winPercentage: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0,
            avg_finish_position: Math.round(avgFinish * 10) / 10,
            top5_rate: Math.round(top5Rate * 100) / 100,
            champion_streak: championStreak,
            bestGame: bestGame?.game_name || null,
            recentScores,
        };
    }

    /**
     * Get enhanced stats for a single player by iScored username.
     */
    static async getEnhancedPlayerStatsByUsername(username: string, gameRoomId?: string) {
        const db = await getDatabase();

        const gameIdFilter = gameRoomId
            ? `AND s.game_id IN (SELECT g.id FROM games g JOIN tournaments t ON g.tournament_id = t.id WHERE t.game_room_id = ?)`
            : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';

        const gamesPlayed = await db.get(`
            SELECT COUNT(DISTINCT game_id) as total
            FROM submissions s
            WHERE LOWER(iscored_username) = LOWER(?) ${gameIdFilter}
        `, username, ...roomParams);

        const wins = await db.get(`
            SELECT COUNT(*) as total FROM (
                SELECT s.game_id
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status = 'COMPLETED'
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                AND LOWER(s.iscored_username) = LOWER(?)
                ${roomWhere}
            )
        `, username, ...roomParams);

        const finishStats = await db.all(`
            SELECT s.game_id,
                   (SELECT COUNT(*) + 1 FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.score > s.score) as finish_position,
                   (SELECT COUNT(*) FROM submissions s2 WHERE s2.game_id = s.game_id) as total_players
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE g.status = 'COMPLETED' AND LOWER(s.iscored_username) = LOWER(?)
            ${roomWhere}
        `, username, ...roomParams);

        const totalGames = gamesPlayed?.total ?? 0;
        const totalWins = wins?.total ?? 0;
        const avgFinish = finishStats.length > 0
            ? finishStats.reduce((sum: number, r: any) => sum + r.finish_position, 0) / finishStats.length
            : 0;
        const top5Count = finishStats.filter((r: any) => r.finish_position <= 5).length;
        const top5Rate = finishStats.length > 0 ? top5Count / finishStats.length : 0;

        // Champion streak by username
        const recentGames = await db.all(`
            SELECT g.id as game_id, g.end_date,
                   (SELECT LOWER(s2.iscored_username) FROM submissions s2 WHERE s2.game_id = g.id ORDER BY s2.score DESC LIMIT 1) as winner_username
            FROM games g
            ${roomJoin}
            WHERE g.status = 'COMPLETED'
            ${roomWhere}
            ORDER BY g.end_date DESC
        `, ...roomParams);

        let championStreak = 0;
        for (const game of recentGames) {
            if ((game as any).winner_username === username.toLowerCase()) {
                championStreak++;
            } else {
                break;
            }
        }

        const bestGame = await db.get(`
            SELECT g.name as game_name, s.score
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            ${roomWhere}
            ORDER BY s.score DESC
            LIMIT 1
        `, username, ...roomParams);

        const recentScores = await db.all(`
            SELECT g.name as game_name, s.score, s.timestamp as date
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            ${roomWhere}
            ORDER BY s.timestamp DESC
            LIMIT 10
        `, username, ...roomParams);

        const mapping = await db.get('SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)', username);

        return {
            discordUserId: mapping?.discord_user_id || null,
            iscoredUsername: username,
            totalGamesPlayed: totalGames,
            totalWins: totalWins,
            winPercentage: totalGames > 0 ? Math.round((totalWins / totalGames) * 100) : 0,
            avg_finish_position: Math.round(avgFinish * 10) / 10,
            top5_rate: Math.round(top5Rate * 100) / 100,
            champion_streak: championStreak,
            bestGame: bestGame?.game_name || null,
            recentScores,
        };
    }

    /**
     * Get enhanced stats for all players (with wins, finish position, top-5 rate, streak).
     */
    static async getEnhancedAllPlayerStats(gameRoomId?: string) {
        const db = await getDatabase();

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        // Get all players with games played and wins
        const players = await db.all(`
            SELECT
                LOWER(s.iscored_username) as player_key,
                COALESCE(um.iscored_username, s.iscored_username) as iscored_username,
                CASE WHEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END) IS NOT NULL
                     THEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END)
                     ELSE s.discord_user_id
                END as discord_user_id,
                COUNT(DISTINCT s.game_id) as games_played
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
            WHERE g.status = 'COMPLETED'
            ${roomWhere}
            GROUP BY LOWER(s.iscored_username)
        `, ...roomParams);

        // Get finish positions for all players in completed games
        const allFinishes = await db.all(`
            SELECT LOWER(s.iscored_username) as player_key,
                   s.game_id,
                   (SELECT COUNT(*) + 1 FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.score > s.score) as finish_position
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE g.status = 'COMPLETED'
            ${roomWhere}
        `, ...roomParams);

        // Build finish stats map
        const finishMap = new Map<string, number[]>();
        for (const row of allFinishes) {
            const key = (row as any).player_key;
            if (!finishMap.has(key)) finishMap.set(key, []);
            finishMap.get(key)!.push((row as any).finish_position);
        }

        // Get wins per player
        const winRows = await db.all(`
            SELECT LOWER(s.iscored_username) as player_key, COUNT(*) as wins
            FROM (
                SELECT s.game_id, s.iscored_username
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE g.status = 'COMPLETED'
                AND s.score = (SELECT MAX(s2.score) FROM submissions s2 WHERE s2.game_id = s.game_id)
                ${roomWhere}
            ) s
            GROUP BY LOWER(s.iscored_username)
        `, ...roomParams);

        const winMap = new Map<string, number>();
        for (const row of winRows) {
            winMap.set((row as any).player_key, (row as any).wins);
        }

        // Champion streak: recent completed games
        const recentGames = await db.all(`
            SELECT g.id as game_id,
                   (SELECT LOWER(s2.iscored_username) FROM submissions s2 WHERE s2.game_id = g.id ORDER BY s2.score DESC LIMIT 1) as winner_key
            FROM games g
            ${roomJoin}
            WHERE g.status = 'COMPLETED'
            ${roomWhere}
            ORDER BY g.end_date DESC
        `, ...roomParams);

        // Calculate streak for each player
        const streakMap = new Map<string, number>();
        for (const player of players) {
            const key = (player as any).player_key;
            let streak = 0;
            for (const game of recentGames) {
                if ((game as any).winner_key === key) {
                    streak++;
                } else {
                    break;
                }
            }
            if (streak > 0) streakMap.set(key, streak);
        }

        // Assemble results
        const results = players.map((p: any) => {
            const finishes = finishMap.get(p.player_key) || [];
            const avgFinish = finishes.length > 0
                ? finishes.reduce((a: number, b: number) => a + b, 0) / finishes.length
                : 0;
            const top5Count = finishes.filter((f: number) => f <= 5).length;
            const top5Rate = finishes.length > 0 ? top5Count / finishes.length : 0;

            return {
                discord_user_id: p.discord_user_id,
                iscored_username: p.iscored_username,
                games_played: p.games_played,
                wins: winMap.get(p.player_key) || 0,
                avg_finish_position: Math.round(avgFinish * 10) / 10,
                top5_rate: Math.round(top5Rate * 100) / 100,
                champion_streak: streakMap.get(p.player_key) || 0,
            };
        });

        // Sort by wins DESC
        results.sort((a: any, b: any) => b.wins - a.wins);
        return results;
    }

    /**
     * Get a specific player's stats for a specific game.
     */
    static async getPlayerGameStats(username: string, gameName: string, gameRoomId?: string) {
        const db = await getDatabase();

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        // All submissions for this player + game
        const submissions = await db.all(`
            SELECT s.score, s.timestamp as date, g.id as game_id, g.end_date,
                   (SELECT COUNT(*) + 1 FROM submissions s2 WHERE s2.game_id = s.game_id AND s2.score > s.score) as finish_position,
                   (SELECT COUNT(*) FROM submissions s2 WHERE s2.game_id = s.game_id) as total_players
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            WHERE LOWER(s.iscored_username) = LOWER(?)
            AND LOWER(g.name) = LOWER(?)
            AND g.status IN ('ACTIVE', 'COMPLETED')
            ${roomWhere}
            ORDER BY g.end_date DESC
        `, username, gameName, ...roomParams);

        if (submissions.length === 0) return null;

        const scores = submissions.map((s: any) => s.score);
        const positions = submissions.map((s: any) => s.finish_position);
        const timesPlayed = submissions.length;
        const bestScore = Math.max(...scores);
        const worstScore = Math.min(...scores);
        const avgRank = positions.reduce((a: number, b: number) => a + b, 0) / positions.length;
        const wins = positions.filter((p: number) => p === 1).length;

        // Score trend: chronological {date, score, rank}
        const trend = submissions.reverse().map((s: any) => ({
            date: s.date || s.end_date,
            score: s.score,
            rank: s.finish_position,
        }));

        return {
            times_played: timesPlayed,
            best_score: bestScore,
            worst_score: worstScore,
            avg_rank: Math.round(avgRank * 10) / 10,
            wins,
            trend,
        };
    }

    /**
     * Get all players with their basic stats (for leaderboard overview).
     */
    static async getAllPlayerStats(gameRoomId?: string) {
        const db = await getDatabase();

        if (gameRoomId) {
            return db.all(`
                SELECT
                    CASE WHEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END) IS NOT NULL
                         THEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END)
                         ELSE s.discord_user_id
                    END as discord_user_id,
                    COALESCE(um.iscored_username, s.iscored_username) as iscored_username,
                    COUNT(DISTINCT s.game_id) as games_played,
                    MAX(s.score) as best_score,
                    ROUND(AVG(s.score)) as avg_score
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                JOIN tournaments t ON g.tournament_id = t.id
                LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
                WHERE t.game_room_id = ?
                GROUP BY LOWER(s.iscored_username)
                ORDER BY best_score DESC
            `, gameRoomId);
        }

        return db.all(`
            SELECT
                CASE WHEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END) IS NOT NULL
                     THEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END)
                     ELSE s.discord_user_id
                END as discord_user_id,
                COALESCE(um.iscored_username, s.iscored_username) as iscored_username,
                COUNT(DISTINCT s.game_id) as games_played,
                MAX(s.score) as best_score,
                ROUND(AVG(s.score)) as avg_score
            FROM submissions s
            LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
            GROUP BY LOWER(s.iscored_username)
            ORDER BY best_score DESC
        `);
    }
}
