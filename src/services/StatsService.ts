import { getDatabase } from '../database/database.js';
import { AchievementService } from './AchievementService.js';

/**
 * v2.4.0 note on pinned games:
 *
 * Every query in this service that takes a `gameRoomId` scopes via
 * `INNER JOIN tournaments t ON g.tournament_id = t.id` (+ `t.game_room_id = ?`).
 * Pinned games (tournament_id IS NULL) are therefore IMPLICITLY EXCLUDED from
 * room-scoped stats — a deliberate conservative default. Rationale:
 *
 *   - Rankings are tournament-scoped by design (confirmed in sprint planning).
 *   - "Tournament stats" like completed-rounds / win-percentage lose meaning
 *     for a continuously-active pinned game.
 *   - Pinned-game scores still surface in the per-game card leaderboard and
 *     the global scoreboard fan-out, so the data isn't lost — just absent
 *     from aggregate stats cards.
 *
 * If future work decides to include pinned games here, switch each JOIN to
 * LEFT JOIN and scope via `COALESCE(t.game_room_id, g.game_room_id)`; the
 * denormalized `games.game_room_id` column (migration 073) already exists
 * to support that path.
 */
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
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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

        // Find all games with this name, optionally filtered by room. Still used for
        // timesPlayed ('times featured') and recentResults (genuine tournament outcomes) —
        // those stay games/submissions-based.
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

        // Times played
        const timesPlayed = gameIds.length;

        // Score stats sourced from score_history — the physical union of every submission
        // path (tournament + community/freeplay + sync). `submissions` only reflects the
        // tournament path; community/freeplay submits write score_history ONLY, so a big
        // community score was previously invisible to All-Time High / unique players.
        // Keyed by (game_room_id, game_name) rather than the games.id list above so it
        // also picks up scores logged against unpinned/no-longer-active game rows.
        const roomFilter = gameRoomId ? 'AND game_room_id = ?' : '';
        const scoreParams = gameRoomId ? [gameName, gameRoomId] : [gameName];

        // avg_score mirrors the CURRENT aggregate meaning: the prior query had no
        // per-player GROUP BY (`AVG(score) FROM submissions WHERE game_id IN (...)`) —
        // it averaged every matching row as-is (submissions happens to hold one row per
        // player-per-game-instance via its own upsert semantics, but the SQL itself does
        // a flat average). This mirrors that: a flat AVG over every matching score_history
        // row (i.e. every score event, not deduped to per-player bests).
        const stats = await db.get(`
            SELECT AVG(score) as avg_score,
                   COUNT(DISTINCT COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))) as unique_players
            FROM score_history
            WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
              AND orphaned_at IS NULL
        `, ...scoreParams);

        // All-time high holder
        const highHolder = await db.get(`
            SELECT iscored_username, score
            FROM score_history
            WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
              AND orphaned_at IS NULL
            ORDER BY score DESC, created_at ASC
            LIMIT 1
        `, ...scoreParams);

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
            WHERE g.name = ? COLLATE NOCASE AND g.status IN ('COMPLETED', 'ARCHIVED')
            ${gameRoomId ? 'AND t.game_room_id = ?' : ''}
            ORDER BY g.end_date DESC
            LIMIT 10
        `, gameName, ...(gameRoomId ? [gameRoomId] : []));

        return {
            gameName,
            timesPlayed,
            avgScore: Math.round(stats?.avg_score ?? 0),
            uniquePlayers: stats?.unique_players ?? 0,
            allTimeHigh: highHolder?.score ?? 0,
            allTimeHighPlayer: highHolder?.iscored_username || null,
            recentResults,
        };
    }

    /**
     * Get all-time player rankings for a specific game (all instances, any status).
     * Returns every player's best score, total plays, and last played date.
     */
    static async getGamePlayerRankings(gameName: string, gameRoomId?: string) {
        const db = await getDatabase();

        // Sourced from score_history (same rationale as getGameStats above) so community/
        // freeplay-only scores — which never touch `submissions` — are represented. Keyed
        // by (game_room_id, game_name); no gameRoomId falls back to all rooms by name.
        const roomFilter = gameRoomId ? 'AND game_room_id = ?' : '';
        const params = gameRoomId ? [gameName, gameRoomId] : [gameName];

        // Canonical player partition (mirrors LeaderboardService.recalculate): collapse by
        // submitted_by_user_id when set (multi-alias Discord users → one row), else by
        // lowercased anon name. The best row is picked via ROW_NUMBER, NOT a bare column
        // next to MAX() — SQLite only guarantees bare-column/max row binding with exactly
        // ONE min/max aggregate, and a merged user's groups span different usernames, so
        // the bare-column form can attach the wrong alias to the best score.
        const rows = await db.all(`
            SELECT
                best.iscored_username,
                best.score as best_score,
                agg.times_played,
                agg.last_played
            FROM (
                SELECT
                    COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) as player_key,
                    iscored_username,
                    score,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM score_history
                WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
                  AND orphaned_at IS NULL
            ) best
            JOIN (
                SELECT
                    COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) as player_key,
                    COUNT(*) as times_played,
                    MAX(created_at) as last_played
                FROM score_history
                WHERE LOWER(game_name) = LOWER(?) ${roomFilter}
                  AND orphaned_at IS NULL
                GROUP BY player_key
            ) agg ON agg.player_key = best.player_key
            WHERE best.rn = 1
            ORDER BY best.score DESC
        `, ...params, ...params);

        return rows.map((r: any, i: number) => ({
            rank: i + 1,
            iscored_username: r.iscored_username,
            best_score: r.best_score,
            times_played: r.times_played,
            last_played: r.last_played,
        }));
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
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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
            WHERE g.status IN ('COMPLETED', 'ARCHIVED') AND s.discord_user_id = ?
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
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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

        // S13 trophy case: achievements delegate to AchievementService.getForPlayer
        // verbatim (do not reimplement); personalBests is a room-scoped
        // best-per-game ranking derived from `submissions`.
        const achievements = gameRoomId
            ? await AchievementService.getForPlayer(gameRoomId, {
                discordUserId,
                username: mapping?.iscored_username || '',
            })
            : { tournamentWins: 0, milestones: 0, roomRecords: 0, recent: [] };
        const personalBests = await StatsService.getPersonalBests(discordUserId, gameRoomId);

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
            achievements,
            personalBests,
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
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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
            WHERE g.status IN ('COMPLETED', 'ARCHIVED') AND LOWER(s.iscored_username) = LOWER(?)
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
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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

        // S13 trophy case: canonical partition key mirrors every other
        // room-scoped ranking query — the real Discord id when this alias is
        // mapped, else the 'iscored:<username>' synthetic fallback.
        const playerKey = mapping?.discord_user_id || `iscored:${username.toLowerCase()}`;
        const achievements = gameRoomId
            ? await AchievementService.getForPlayer(gameRoomId, {
                discordUserId: mapping?.discord_user_id || null,
                username,
            })
            : { tournamentWins: 0, milestones: 0, roomRecords: 0, recent: [] };
        const personalBests = await StatsService.getPersonalBests(playerKey, gameRoomId);

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
            achievements,
            personalBests,
        };
    }

    /**
     * S13 trophy case: the player's best score per game in a room, ranked
     * against every other player's best on the same game.
     *
     * Room-scoping mirrors getEnhancedPlayerStats/getEnhancedPlayerStatsByUsername
     * verbatim (`JOIN tournaments t ON g.tournament_id = t.id AND t.game_room_id = ?`)
     * — `submissions` has no `game_room_id` column of its own, so pinned games
     * (tournament_id IS NULL) are implicitly excluded here too, consistent with
     * every other room-scoped query in this file (see file-header note).
     *
     * `playerKey` is the canonical partition used everywhere else in the
     * codebase: COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)).
     * room_rank/total_players are computed over that same partition per game so
     * multi-alias players collapse to one ranked row, matching LeaderboardService.
     */
    private static async getPersonalBests(playerKey: string, gameRoomId?: string) {
        const db = await getDatabase();

        const roomJoin = gameRoomId ? 'JOIN tournaments t ON g.tournament_id = t.id' : '';
        const roomWhere = gameRoomId ? 'AND t.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        const rows = await db.all(`
            WITH scoped AS (
                SELECT s.game_id AS game_id, g.name AS game_name, s.score AS score, s.timestamp AS timestamp,
                       COALESCE(s.submitted_by_user_id, 'iscored:' || LOWER(s.iscored_username)) AS player_key
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                ${roomJoin}
                WHERE s.orphaned_at IS NULL
                ${roomWhere}
            ),
            best_per_player AS (
                SELECT game_id, game_name, player_key, score, timestamp,
                       ROW_NUMBER() OVER (PARTITION BY game_id, player_key ORDER BY score DESC, timestamp DESC) AS rn
                FROM scoped
            ),
            top AS (
                SELECT game_id, game_name, player_key, score AS best_score, timestamp AS achieved_at
                FROM best_per_player WHERE rn = 1
            ),
            ranked AS (
                SELECT game_id, game_name, player_key, best_score, achieved_at,
                       RANK() OVER (PARTITION BY game_id ORDER BY best_score DESC) AS room_rank,
                       COUNT(*) OVER (PARTITION BY game_id) AS total_players
                FROM top
            )
            SELECT game_name, best_score, room_rank, total_players, achieved_at
            FROM ranked
            WHERE player_key = ?
            ORDER BY room_rank ASC, game_name ASC
            LIMIT 50
        `, ...roomParams, playerKey);

        return rows;
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
                up.display_name,
                CASE WHEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END) IS NOT NULL
                     THEN MAX(CASE WHEN s.discord_user_id != 'SYSTEM' THEN s.discord_user_id END)
                     ELSE s.discord_user_id
                END as discord_user_id,
                COUNT(DISTINCT s.game_id) as games_played
            FROM submissions s
            JOIN games g ON s.game_id = g.id
            ${roomJoin}
            LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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
                WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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
            WHERE g.status IN ('COMPLETED', 'ARCHIVED')
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
                    up.display_name,
                    up.avatar_hash,
                    COUNT(DISTINCT s.game_id) as games_played,
                    MAX(s.score) as best_score,
                    ROUND(AVG(s.score)) as avg_score
                FROM submissions s
                JOIN games g ON s.game_id = g.id
                JOIN tournaments t ON g.tournament_id = t.id
                LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
                LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
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
                up.display_name,
                up.avatar_hash,
                COUNT(DISTINCT s.game_id) as games_played,
                MAX(s.score) as best_score,
                ROUND(AVG(s.score)) as avg_score
            FROM submissions s
            LEFT JOIN user_mappings um ON LOWER(s.iscored_username) = LOWER(um.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
            GROUP BY LOWER(s.iscored_username)
            ORDER BY best_score DESC
        `);
    }

    /**
     * Per-game activity stats for the public Stats page (Games view).
     * Counts submissions from the tournament `submissions` table and
     * `community_scores`, excluding orphaned rows (Sprint 6).
     *
     * SQLite lacks FULL OUTER JOIN, so we UNION ALL per-row stats from both
     * sources and collapse in an outer GROUP BY. Note: COUNT(DISTINCT) across
     * both tables isn't expressible this way, so `players` is an upper bound
     * (a player who submitted tournament + community scores counts twice).
     * Acceptable for a Stats overview page.
     */
    static async getGameActivityStats(gameRoomId: string) {
        const db = await getDatabase();
        return db.all(`
            SELECT
                name,
                SUM(submissions) AS submissions,
                SUM(players) AS players,
                MAX(top_score) AS top_score,
                MAX(last_activity) AS last_activity
            FROM (
                SELECT
                    g.name AS name,
                    LOWER(g.name) AS name_key,
                    COUNT(*) AS submissions,
                    COUNT(DISTINCT LOWER(s.iscored_username)) AS players,
                    MAX(s.score) AS top_score,
                    MAX(s.timestamp) AS last_activity
                FROM submissions s
                JOIN games g ON g.id = s.game_id
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE t.game_room_id = ?
                  AND s.orphaned_at IS NULL
                GROUP BY LOWER(g.name)

                UNION ALL

                SELECT
                    cs.game_name AS name,
                    LOWER(cs.game_name) AS name_key,
                    COUNT(*) AS submissions,
                    COUNT(DISTINCT LOWER(cs.iscored_username)) AS players,
                    MAX(cs.score) AS top_score,
                    MAX(cs.created_at) AS last_activity
                FROM community_scores cs
                WHERE cs.game_room_id = ?
                  AND cs.orphaned_at IS NULL
                GROUP BY LOWER(cs.game_name)
            )
            GROUP BY name_key
            ORDER BY submissions DESC, last_activity DESC
        `, gameRoomId, gameRoomId);
    }

    /**
     * v2.1.0 Stats overview — the 4 cards at the top of /:slug/stats.
     *
     * All "this week" metrics use a rolling 7-day window. Pulls from
     * `score_history` which carries every submission (tournament + community +
     * sync). Hottest game is by submission count; latest is by timestamp.
     */
    static async getRoomOverview(gameRoomId: string): Promise<{
        totalPlaysWeek: number;
        activePlayersWeek: number;
        hottestGame: { name: string; submissions: number } | null;
        latestSubmission: { iscored_username: string; display_name: string | null; score: number; game_name: string; created_at: string } | null;
    }> {
        const db = await getDatabase();
        const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

        const plays = await db.get<{ total: number }>(
            `SELECT COUNT(*) as total FROM score_history
             WHERE game_room_id = ? AND created_at >= ? AND orphaned_at IS NULL`,
            gameRoomId, weekAgo,
        );
        const players = await db.get<{ total: number }>(
            `SELECT COUNT(DISTINCT LOWER(iscored_username)) as total FROM score_history
             WHERE game_room_id = ? AND created_at >= ? AND orphaned_at IS NULL`,
            gameRoomId, weekAgo,
        );
        const hottest = await db.get<{ game_name: string; submissions: number }>(
            `SELECT game_name, COUNT(*) as submissions FROM score_history
             WHERE game_room_id = ? AND created_at >= ? AND orphaned_at IS NULL
             GROUP BY LOWER(game_name)
             ORDER BY submissions DESC
             LIMIT 1`,
            gameRoomId, weekAgo,
        );
        // v2.8.2: pull display_name so the FE renders the user's chosen name.
        // submitted_by_user_id is the definitive Discord linkage; user_mappings
        // resolves iscored:* synthetic ids; user_profiles holds the chosen name.
        const latest = await db.get<{ iscored_username: string; display_name: string | null; score: number; game_name: string; created_at: string }>(
            `SELECT sh.iscored_username, sh.score, sh.game_name, sh.created_at, up.display_name
             FROM score_history sh
             LEFT JOIN user_mappings um ON (
                sh.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(sh.iscored_username)
             )
             LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(sh.submitted_by_user_id, um.discord_user_id)
             WHERE sh.game_room_id = ? AND sh.orphaned_at IS NULL
             ORDER BY sh.created_at DESC
             LIMIT 1`,
            gameRoomId,
        );

        return {
            totalPlaysWeek: plays?.total ?? 0,
            activePlayersWeek: players?.total ?? 0,
            hottestGame: hottest ? { name: hottest.game_name, submissions: hottest.submissions } : null,
            latestSubmission: latest
                ? { iscored_username: latest.iscored_username, display_name: latest.display_name ?? null, score: latest.score, game_name: latest.game_name, created_at: latest.created_at }
                : null,
        };
    }
}
