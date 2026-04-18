import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';
import { GlobalScoreService } from './GlobalScoreService.js';
import { normalizeSubmitterUserId } from './SubmissionContextService.js';
import { AnonymousIdentityService } from './AnonymousIdentityService.js';
import { emitScoreNewGlobal } from '../api/websocket.js';

export class CommunityScoreService {
    /**
     * Submit a community score for a game.
     * Also fans out to the global scoreboard if the game is linked to the catalogue
     * and the room has GLOBAL_SCOREBOARD_ENABLED != 'false'.
     */
    static async submitScore(
        gameRoomId: string,
        gameName: string,
        username: string,
        score: number,
        discordUserId?: string,
        photoUrl?: string,
        options?: { excludeFromGlobal?: boolean }
    ) {
        const db = await getDatabase();
        const submittedByUserId = normalizeSubmitterUserId(discordUserId);
        const submittedByAnonymousName = submittedByUserId ? null : username;

        let anonymousIdentityId: number | null = null;
        if (!submittedByUserId) {
            const room = await db.get(
                'SELECT discord_guild_id FROM game_rooms WHERE id = ?',
                gameRoomId,
            );
            anonymousIdentityId = await AnonymousIdentityService.upsert({
                roomId: gameRoomId,
                guildId: room?.discord_guild_id ?? null,
                serverNickname: username,
            });
        }

        const result = await db.run(
            `INSERT INTO community_scores (
                game_name, game_room_id, iscored_username, discord_user_id, score, photo_url,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                submitted_by_anonymous_name, merged_from_anonymous_identity_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
            gameName, gameRoomId, username, discordUserId || 'ANON', score, photoUrl || null,
            gameRoomId, submittedByUserId, submittedByAnonymousName
        );

        // Also log to unified score history
        await ScoreHistoryService.log({
            gameName, gameRoomId, username,
            discordUserId, score, photoUrl,
            source: 'community',
        });

        // Fire-and-forget lobby feed event
        import('./LobbyFeedGenerator.js').then(({ LobbyFeedGenerator }) => {
            LobbyFeedGenerator.onScoreSubmitted({
                gameRoomId, gameName, username, score,
                discordUserId, source: 'community',
            }).catch(() => {});
        }).catch(() => {});

        // Fan-out to global scoreboard (best-effort, never throws)
        const fanOut = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId,
            gameName,
            playerId: discordUserId || 'COMMUNITY',
            iscoredUsername: username,
            score,
            photoUrl,
            excludeFromGlobal: options?.excludeFromGlobal,
        });

        if (fanOut && !options?.excludeFromGlobal) {
            // Fetch room name for the WS payload
            const room = await db.get('SELECT name, slug FROM game_rooms WHERE id = ?', gameRoomId);
            emitScoreNewGlobal({
                globalGameId: fanOut.globalGameId,
                gameName: fanOut.gameName,
                playerName: username,
                score,
                originRoomSlug: room?.slug || null,
                originRoomName: room?.name || null,
            });
        }

        return { id: result.lastID, anonymousIdentityId };
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
              AND orphaned_at IS NULL
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
              AND orphaned_at IS NULL
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
              AND orphaned_at IS NULL
            ORDER BY created_at DESC
            LIMIT ?
        `, gameRoomId, limit);
    }
}
