import { getDatabase } from '../database/database.js';
import { LobbyFeedService } from './LobbyFeedService.js';
import { logDebug } from '../utils/logger.js';

const SCORE_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1000];
const GAME_THRESHOLDS = [5, 10, 25, 50];
const NUMBER_ONE_THRESHOLDS = [1, 5, 10, 25];

export class MilestoneService {
    /**
     * Check and emit milestone events for a player after a score submission.
     * Uses "exactly equals threshold" to avoid re-emitting (no separate tracking table).
     */
    static async checkAndEmit(gameRoomId: string, username: string, discordUserId?: string): Promise<void> {
        const db = await getDatabase();
        const playerKey = username.toLowerCase();

        // Count total scores submitted across both tables
        const communityCount = await db.get(
            'SELECT COUNT(*) as cnt FROM community_scores WHERE game_room_id = ? AND LOWER(iscored_username) = ?',
            gameRoomId, playerKey
        );
        const tournamentCount = await db.get(
            `SELECT COUNT(*) as cnt FROM submissions s
             JOIN games g ON g.id = s.game_id
             JOIN tournaments t ON t.id = g.tournament_id
             WHERE t.game_room_id = ? AND LOWER(s.iscored_username) = ?`,
            gameRoomId, playerKey
        );
        const totalScores = (communityCount?.cnt || 0) + (tournamentCount?.cnt || 0);

        if (SCORE_THRESHOLDS.includes(totalScores)) {
            logDebug(`MilestoneService: ${username} hit ${totalScores} scores in room ${gameRoomId}`);
            await LobbyFeedService.emit({
                gameRoomId,
                type: 'player_milestone',
                icon: undefined,
                title: `${username} submitted their ${totalScores}${ordinal(totalScores)} score!`,
                playerId: discordUserId,
                metadata: { milestone: 'scores_submitted', count: totalScores },
            });
        }

        // Count unique games played
        const communityGames = await db.get(
            'SELECT COUNT(DISTINCT LOWER(game_name)) as cnt FROM community_scores WHERE game_room_id = ? AND LOWER(iscored_username) = ?',
            gameRoomId, playerKey
        );
        const tournamentGames = await db.get(
            `SELECT COUNT(DISTINCT LOWER(g.name)) as cnt FROM submissions s
             JOIN games g ON g.id = s.game_id
             JOIN tournaments t ON t.id = g.tournament_id
             WHERE t.game_room_id = ? AND LOWER(s.iscored_username) = ?`,
            gameRoomId, playerKey
        );
        // Approximate unique games (may double-count same game in both tables, but close enough)
        const uniqueGames = Math.max(communityGames?.cnt || 0, tournamentGames?.cnt || 0);

        if (GAME_THRESHOLDS.includes(uniqueGames)) {
            await LobbyFeedService.emit({
                gameRoomId,
                type: 'player_milestone',
                icon: undefined,
                title: `${username} has played ${uniqueGames} different games!`,
                playerId: discordUserId,
                metadata: { milestone: 'unique_games', count: uniqueGames },
            });
        }

        // Count #1 positions held (community scores only for simplicity)
        const numberOnes = await db.get(`
            SELECT COUNT(*) as cnt FROM (
                SELECT LOWER(game_name) as gn
                FROM community_scores
                WHERE game_room_id = ?
                GROUP BY LOWER(game_name)
                HAVING LOWER(iscored_username) = (
                    SELECT LOWER(cs2.iscored_username)
                    FROM community_scores cs2
                    WHERE cs2.game_room_id = community_scores.game_room_id
                      AND LOWER(cs2.game_name) = LOWER(community_scores.game_name)
                    GROUP BY LOWER(cs2.iscored_username)
                    ORDER BY MAX(cs2.score) DESC
                    LIMIT 1
                ) AND LOWER(iscored_username) = ?
            )
        `, gameRoomId, playerKey);

        const numOnes = numberOnes?.cnt || 0;
        if (NUMBER_ONE_THRESHOLDS.includes(numOnes)) {
            await LobbyFeedService.emit({
                gameRoomId,
                type: 'player_milestone',
                icon: undefined,
                title: `${username} holds #1 on ${numOnes} game${numOnes > 1 ? 's' : ''}!`,
                playerId: discordUserId,
                metadata: { milestone: 'number_ones', count: numOnes },
            });
        }
    }
}

function ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] ?? s[v] ?? 'th';
}
