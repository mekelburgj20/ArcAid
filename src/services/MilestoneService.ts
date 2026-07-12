import { getDatabase } from '../database/database.js';
import { LobbyFeedService } from './LobbyFeedService.js';
import { UserProfileService } from './UserProfileService.js';
import { AchievementService } from './AchievementService.js';
import { logDebug } from '../utils/logger.js';

const SCORE_THRESHOLDS = [10, 25, 50, 100, 250, 500, 1000];
const GAME_THRESHOLDS = [5, 10, 25, 50];
const NUMBER_ONE_THRESHOLDS = [1, 5, 10, 25];

type DbHandle = Awaited<ReturnType<typeof getDatabase>>;

export class MilestoneService {
    /**
     * Check and emit milestone events for a player after a score submission.
     *
     * Detection is CROSSED-THRESHOLD (count >= threshold), not exact-equality,
     * so a count that jumps PAST a threshold (e.g. 9 -> 11 from a batch sync or
     * concurrent submits) still fires the 10-score milestone. Each fired
     * (game_room_id, player_key, scope, threshold) is persisted in
     * `player_milestones_fired` (migration 105); the UNIQUE constraint +
     * INSERT OR IGNORE + changes()===1 guard make every milestone fire AT MOST
     * ONCE — even if the count is non-monotonic (score deletes / unpins /
     * dethrones can revisit a threshold from the far side).
     *
     * The de-dup key and the message both use the canonical identity:
     *   playerKey   = discordUserId ?? ('iscored:' + username.toLowerCase())
     *   displayName = UserProfileService.getDisplayName(discordUserId) ?? username
     * so multi-alias Discord users collapse to one player and the message prints
     * the user-chosen display name (display_name ?? iscored_username rule).
     */
    static async checkAndEmit(gameRoomId: string, username: string, discordUserId?: string): Promise<void> {
        const db = await getDatabase();
        // Count partitioning stays alias-keyed (LOWER(iscored_username)); the
        // de-dup / tracking key is the canonical identity so multi-alias Discord
        // users never re-fire the same milestone under a different alias.
        const usernameKey = username.toLowerCase();
        const playerKey = discordUserId ?? ('iscored:' + usernameKey);

        // Resolve the display name once: the user-chosen global name, falling
        // back to the iScored alias when unset (display_name ?? iscored_username).
        const displayName = (discordUserId
            ? await UserProfileService.getDisplayName(discordUserId)
            : null) ?? username;

        // --- scores_submitted ---
        const communityCount = await db.get(
            'SELECT COUNT(*) as cnt FROM community_scores WHERE game_room_id = ? AND LOWER(iscored_username) = ?',
            gameRoomId, usernameKey
        );
        const tournamentCount = await db.get(
            `SELECT COUNT(*) as cnt FROM submissions s
             JOIN games g ON g.id = s.game_id
             JOIN tournaments t ON t.id = g.tournament_id
             WHERE t.game_room_id = ? AND LOWER(s.iscored_username) = ?`,
            gameRoomId, usernameKey
        );
        const totalScores = (communityCount?.cnt || 0) + (tournamentCount?.cnt || 0);

        await MilestoneService.fireIfCrossed(
            db, gameRoomId, playerKey, 'scores_submitted', totalScores, SCORE_THRESHOLDS,
            async (threshold) => {
                logDebug(`MilestoneService: ${displayName} crossed ${threshold} scores in room ${gameRoomId}`);
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'player_milestone',
                    icon: undefined,
                    // Emit the THRESHOLD value, not the raw count, so a 9->11
                    // jump still reads "10th score" not "11th".
                    title: `${displayName} submitted their ${threshold}${ordinal(threshold)} score!`,
                    playerId: discordUserId,
                    metadata: { milestone: 'scores_submitted', count: threshold },
                });
                await AchievementService.award({
                    gameRoomId,
                    discordUserId,
                    iscoredUsername: username,
                    type: 'milestone',
                    metadata: { scope: 'scores_submitted', threshold },
                });
            }
        );

        // --- unique_games ---
        const communityGames = await db.get(
            'SELECT COUNT(DISTINCT LOWER(game_name)) as cnt FROM community_scores WHERE game_room_id = ? AND LOWER(iscored_username) = ?',
            gameRoomId, usernameKey
        );
        const tournamentGames = await db.get(
            `SELECT COUNT(DISTINCT LOWER(g.name)) as cnt FROM submissions s
             JOIN games g ON g.id = s.game_id
             JOIN tournaments t ON t.id = g.tournament_id
             WHERE t.game_room_id = ? AND LOWER(s.iscored_username) = ?`,
            gameRoomId, usernameKey
        );
        // Approximate unique games (may double-count same game in both tables,
        // but close enough). The tracking row prevents re-fire even though this
        // heuristic can oscillate.
        const uniqueGames = Math.max(communityGames?.cnt || 0, tournamentGames?.cnt || 0);

        await MilestoneService.fireIfCrossed(
            db, gameRoomId, playerKey, 'unique_games', uniqueGames, GAME_THRESHOLDS,
            async (threshold) => {
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'player_milestone',
                    icon: undefined,
                    title: `${displayName} has played ${threshold} different games!`,
                    playerId: discordUserId,
                    metadata: { milestone: 'unique_games', count: threshold },
                });
                await AchievementService.award({
                    gameRoomId,
                    discordUserId,
                    iscoredUsername: username,
                    type: 'milestone',
                    metadata: { scope: 'unique_games', threshold },
                });
            }
        );

        // --- number_ones (#1 positions held, community scores only) ---
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
        `, gameRoomId, usernameKey);

        const numOnes = numberOnes?.cnt || 0;

        await MilestoneService.fireIfCrossed(
            db, gameRoomId, playerKey, 'number_ones', numOnes, NUMBER_ONE_THRESHOLDS,
            async (threshold) => {
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'player_milestone',
                    icon: undefined,
                    title: `${displayName} holds #1 on ${threshold} game${threshold > 1 ? 's' : ''}!`,
                    playerId: discordUserId,
                    metadata: { milestone: 'number_ones', count: threshold },
                });
                await AchievementService.award({
                    gameRoomId,
                    discordUserId,
                    iscoredUsername: username,
                    type: 'milestone',
                    metadata: { scope: 'number_ones', threshold },
                });
            }
        );
    }

    /**
     * Emit every threshold the count is at-or-past but hasn't fired yet,
     * recording each in `player_milestones_fired` first. The UNIQUE constraint
     * on (game_room_id, player_key, scope, threshold) + INSERT OR IGNORE means
     * only the FIRST observation of a crossing (changes()===1) emits; re-runs,
     * deleted-then-resubmitted scores, and oscillating unique-games/number-ones
     * counts can never re-fire a threshold whose row already exists.
     */
    private static async fireIfCrossed(
        db: DbHandle,
        gameRoomId: string,
        playerKey: string,
        scope: string,
        count: number,
        thresholds: number[],
        emit: (threshold: number) => Promise<void>,
    ): Promise<void> {
        // Iterate ascending so lower milestones fire before higher ones.
        for (const threshold of [...thresholds].sort((a, b) => a - b)) {
            if (count < threshold) continue; // not crossed yet
            const res = await db.run(
                `INSERT OR IGNORE INTO player_milestones_fired
                    (game_room_id, player_key, scope, threshold)
                 VALUES (?, ?, ?, ?)`,
                gameRoomId, playerKey, scope, threshold,
            );
            if ((res.changes ?? 0) === 1) { // first time only
                await emit(threshold);
            }
        }
    }
}

function ordinal(n: number): string {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return s[(v - 20) % 10] ?? s[v] ?? 'th';
}
