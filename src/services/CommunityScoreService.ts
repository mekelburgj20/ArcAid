import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';
import { GlobalScoreService } from './GlobalScoreService.js';
import { normalizeSubmitterUserId } from './SubmissionContextService.js';
import { AnonymousIdentityService } from './AnonymousIdentityService.js';
import { RoomNameClaimService } from './RoomNameClaimService.js';
import { ScoreRankService, type SubmitRankResult } from './ScoreRankService.js';
import { emitScoreNewGlobal } from '../api/websocket.js';
import { trackBackground } from '../utils/backgroundTasks.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';

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
        options?: {
            excludeFromGlobal?: boolean;
            anonToken?: string | null;
            platform?: string | null;
            /** v2.53.0 (ADR 0016) — split provenance; defaults to 'unknown', never NULL. */
            engine?: string | null;
            device?: string | null;
        }
    ) {
        const db = await getDatabase();
        const engine = options?.engine || UNKNOWN;
        const device = options?.device || UNKNOWN;

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
                submitted_by_anonymous_name, merged_from_anonymous_identity_id, platform,
                engine, device
             ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
            gameName, gameRoomId, effectiveUsername, discordUserId || 'ANON', score, photoUrl || null,
            gameRoomId, submittedByUserId, submittedByAnonymousName, options?.platform ?? null,
            engine, device,
        );

        // Also log to unified score history
        const historyId = await ScoreHistoryService.log({
            gameName, gameRoomId, username: effectiveUsername,
            discordUserId, score, photoUrl,
            source: 'community',
            platform: options?.platform ?? null,
            engine, device,
        });

        // Fire-and-forget lobby feed event (tracked so tests can drain it —
        // the inner promise is RETURNED from the .then so the tracked chain
        // settles only when onScoreSubmitted itself settles).
        trackBackground(
            import('./LobbyFeedGenerator.js')
                .then(({ LobbyFeedGenerator }) => LobbyFeedGenerator.onScoreSubmitted({
                    gameRoomId, gameName, username: effectiveUsername, score,
                    discordUserId, source: 'community',
                }))
                .catch(() => {}),
        );

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
            engine, device,
            // Matches the `source: 'community'` this method logs to
            // score_history above (ADR 0016 P2 §3c).
            source: 'community',
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
                excludeHistoryId: historyId,
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
     *
     * Collapses multi-alias players to one row via the standard identity key
     * (`COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))` —
     * see LeaderboardService.recalculate). Pre-this-fix the GROUP BY was on
     * LOWER(iscored_username) alone, so a logged-in Discord user submitting
     * under two typed names held two separate ranks on the same board.
     * `iscored_username` on the collapsed row is the alias from that player's
     * single best-scoring submission (ROW_NUMBER, not a MAX() string pick).
     */
    static async getGameLeaderboard(gameRoomId: string, gameName: string) {
        const db = await getDatabase();
        return db.all(`
            SELECT
                best.player_key,
                best.iscored_username,
                best.best_score,
                agg.times_played,
                agg.last_played,
                up.display_name
            FROM (
                SELECT
                    COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) as player_key,
                    iscored_username,
                    submitted_by_user_id,
                    score as best_score,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM community_scores
                WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
                  AND orphaned_at IS NULL
            ) best
            JOIN (
                SELECT
                    COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) as player_key,
                    COUNT(*) as times_played,
                    MAX(created_at) as last_played
                FROM community_scores
                WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
                  AND orphaned_at IS NULL
                GROUP BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
            ) agg ON agg.player_key = best.player_key
            LEFT JOIN user_mappings um ON (
                best.player_key LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(best.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(best.submitted_by_user_id, um.discord_user_id)
            WHERE best.rn = 1
            ORDER BY best.best_score DESC
        `, gameRoomId, gameName, gameRoomId, gameName);
    }

    /**
     * Get recent community score submissions for a game.
     */
    static async getGameHistory(gameRoomId: string, gameName: string, page = 1, limit = 20) {
        const db = await getDatabase();
        const offset = (page - 1) * limit;
        return db.all(`
            SELECT cs.id, cs.iscored_username, up.display_name, cs.score, cs.photo_url, cs.created_at
            FROM community_scores cs
            LEFT JOIN user_mappings um ON LOWER(um.iscored_username) = LOWER(cs.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(cs.submitted_by_user_id, um.discord_user_id)
            WHERE cs.game_room_id = ? AND LOWER(cs.game_name) = LOWER(?)
              AND cs.orphaned_at IS NULL
            ORDER BY cs.created_at DESC
            LIMIT ? OFFSET ?
        `, gameRoomId, gameName, limit, offset);
    }

    /**
     * Get recent activity across all games in a room.
     */
    static async getRecentActivity(gameRoomId: string, limit = 20) {
        const db = await getDatabase();
        return db.all(`
            SELECT cs.id, cs.game_name, cs.iscored_username, up.display_name, cs.score, cs.created_at
            FROM community_scores cs
            LEFT JOIN user_mappings um ON LOWER(um.iscored_username) = LOWER(cs.iscored_username)
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(cs.submitted_by_user_id, um.discord_user_id)
            WHERE cs.game_room_id = ?
              AND cs.orphaned_at IS NULL
            ORDER BY cs.created_at DESC
            LIMIT ?
        `, gameRoomId, limit);
    }
}
