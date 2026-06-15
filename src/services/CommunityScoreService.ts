import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';
import { GlobalScoreService } from './GlobalScoreService.js';
import { normalizeSubmitterUserId } from './SubmissionContextService.js';
import { AnonymousIdentityService } from './AnonymousIdentityService.js';
import { RoomNameClaimService } from './RoomNameClaimService.js';
import { ScoreRankService, type SubmitRankResult } from './ScoreRankService.js';
import { emitScoreNewGlobal } from '../api/websocket.js';

export class CommunityScoreService {
    /**
     * Submit a community score for a game.
     * Also fans out to the global scoreboard if the game is linked to the catalogue
     * and the room has GLOBAL_SCOREBOARD_ENABLED != 'false'.
     *
     * v2.2.0: routes the requested username through `RoomNameClaimService` so
     * collisions auto-suffix (`Bob`, `Bob_2`, …). The returned `displayName` is
     * the actual stored name — callers should surface it to the user when
     * `suffixed === true` so they know "Bob" became "Bob_2".
     */
    static async submitScore(
        gameRoomId: string,
        gameName: string,
        username: string,
        score: number,
        discordUserId?: string,
        photoUrl?: string,
        options?: { excludeFromGlobal?: boolean; anonToken?: string | null; platform?: string | null }
    ) {
        const db = await getDatabase();

        // First-claim-wins: resolve a per-room display name. Same claimant gets
        // the same name back; new arrivals collide → auto-suffix.
        const claimant = RoomNameClaimService.buildClaimant({
            discordUserId,
            anonToken: options?.anonToken,
        });
        const resolved = await RoomNameClaimService.resolveAndClaim(gameRoomId, username, claimant);
        const effectiveUsername = resolved.displayName;

        const submittedByUserId = normalizeSubmitterUserId(discordUserId);
        const submittedByAnonymousName = submittedByUserId ? null : effectiveUsername;

        let anonymousIdentityId: number | null = null;
        if (!submittedByUserId) {
            const room = await db.get(
                'SELECT discord_guild_id FROM game_rooms WHERE id = ?',
                gameRoomId,
            );
            anonymousIdentityId = await AnonymousIdentityService.upsert({
                roomId: gameRoomId,
                guildId: room?.discord_guild_id ?? null,
                serverNickname: effectiveUsername,
            });
        }

        const result = await db.run(
            `INSERT INTO community_scores (
                game_name, game_room_id, iscored_username, discord_user_id, score, photo_url,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?)`,
            gameName, gameRoomId, effectiveUsername, discordUserId || 'ANON', score, photoUrl || null,
            gameRoomId, submittedByUserId, submittedByAnonymousName, options?.platform ?? null,
        );

        // Also log to unified score history
        await ScoreHistoryService.log({
            gameName, gameRoomId, username: effectiveUsername,
            discordUserId, score, photoUrl,
            source: 'community',
            platform: options?.platform ?? null,
        });

        // Fire-and-forget lobby feed event
        import('./LobbyFeedGenerator.js').then(({ LobbyFeedGenerator }) => {
            LobbyFeedGenerator.onScoreSubmitted({
                gameRoomId, gameName, username: effectiveUsername, score,
                discordUserId, source: 'community',
            }).catch(() => {});
        }).catch(() => {});

        // Fan-out to global scoreboard (best-effort, never throws). Will early-
        // return inside fanOutFromRoomSubmission when the playerId is a guest
        // sentinel — guest scores never reach global.
        const fanOut = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId,
            gameName,
            playerId: discordUserId || 'COMMUNITY',
            iscoredUsername: effectiveUsername,
            score,
            photoUrl,
            excludeFromGlobal: options?.excludeFromGlobal,
            platform: options?.platform ?? null,
        });

        if (fanOut && !options?.excludeFromGlobal) {
            // Fetch room name for the WS payload
            const room = await db.get('SELECT name, slug FROM game_rooms WHERE id = ?', gameRoomId);
            emitScoreNewGlobal({
                globalGameId: fanOut.globalGameId,
                gameName: fanOut.gameName,
                playerName: effectiveUsername,
                score,
                originRoomSlug: room?.slug || null,
                originRoomName: room?.name || null,
            });
        }

        // Submit-moment rank ("you are #N of M"). Best-effort: a failure here
        // must NEVER fail the insert (which already committed above). The helper
        // is itself best-effort (returns all-null on error); the extra try/catch
        // guards the await boundary. partitionKey is the canonical room key the
        // INSERT used — submittedByUserId, else the iscored: fallback keyed on
        // the suffixed name actually stored in iscored_username.
        let rank: SubmitRankResult | null = null;
        try {
            const partitionKey = submittedByUserId ?? `iscored:${effectiveUsername.toLowerCase()}`;
            rank = await ScoreRankService.computeRoomRank({
                gameRoomId,
                gameName,
                partitionKey,
                submittedScore: score,
                excludeCommunityScoreId: result.lastID,
            });
        } catch {
            rank = null;
        }

        return {
            id: result.lastID,
            anonymousIdentityId,
            displayName: effectiveUsername,
            suffixed: resolved.suffixed,
            requested: resolved.requested,
            rank,
        };
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
