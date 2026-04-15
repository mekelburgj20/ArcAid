import { getDatabase } from '../database/database.js';
import { LobbyFeedService } from './LobbyFeedService.js';
import { logError } from '../utils/logger.js';

interface ScoreSubmittedParams {
    gameRoomId: string;
    gameName: string;
    username: string;
    score: number;
    discordUserId?: string;
    source: 'community' | 'tournament' | 'sync';
}

export class LobbyFeedGenerator {
    /**
     * Generate lobby feed events when a score is submitted.
     * Called fire-and-forget from all score submission paths.
     * Never throws — all errors are silently logged.
     */
    static async onScoreSubmitted(params: ScoreSubmittedParams): Promise<void> {
        try {
            const { gameRoomId, gameName, username, score, discordUserId } = params;

            // Check which event types are enabled for this room
            const enabledTypes = await LobbyFeedService.getEnabledTypes(gameRoomId);

            // Get all best scores for this game in this room to determine rank
            const db = await getDatabase();
            const bestScores = await db.all(`
                SELECT LOWER(iscored_username) as player_key, MAX(score) as best_score
                FROM community_scores
                WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)
                GROUP BY LOWER(iscored_username)
                ORDER BY best_score DESC
            `, gameRoomId, gameName);

            // Also check tournament submissions for this game
            const tournamentScores = await db.all(`
                SELECT LOWER(s.iscored_username) as player_key, MAX(s.score) as best_score
                FROM submissions s
                JOIN games g ON g.id = s.game_id
                JOIN tournaments t ON t.id = g.tournament_id
                WHERE t.game_room_id = ? AND LOWER(g.name) = LOWER(?)
                GROUP BY LOWER(s.iscored_username)
            `, gameRoomId, gameName);

            // Merge: take the higher score per player across both tables
            const mergedScores = new Map<string, number>();
            for (const row of bestScores) {
                mergedScores.set(row.player_key, row.best_score);
            }
            for (const row of tournamentScores) {
                const existing = mergedScores.get(row.player_key) || 0;
                if (row.best_score > existing) {
                    mergedScores.set(row.player_key, row.best_score);
                }
            }

            // Sort by score descending to get rankings
            const sorted = Array.from(mergedScores.entries())
                .sort((a, b) => b[1] - a[1]);

            const playerKey = username.toLowerCase();
            const currentRank = sorted.findIndex(([key]) => key === playerKey) + 1;
            const formattedScore = score.toLocaleString();

            // Check for new #1
            if (currentRank === 1 && sorted.length > 1 && isTypeEnabled(enabledTypes, 'new_high_score')) {
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'new_high_score',
                    icon: '🔥',
                    title: `${username} posted ${formattedScore} on ${gameName} — new room #1!`,
                    playerId: discordUserId,
                    gameName,
                    metadata: { score, username },
                });
            } else if (currentRank > 0 && currentRank <= 10 && isTypeEnabled(enabledTypes, 'rank_change')) {
                // Rank change (top 10 only to reduce noise)
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'rank_change',
                    icon: '⬆️',
                    title: `${username} climbed to #${currentRank} on ${gameName}`,
                    playerId: discordUserId,
                    gameName,
                    metadata: { score, newRank: currentRank, username },
                });
            }

            // Always emit score_posted (if enabled)
            if (isTypeEnabled(enabledTypes, 'score_posted')) {
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'score_posted',
                    icon: '🎯',
                    title: `${username} submitted ${formattedScore} on ${gameName}`,
                    playerId: discordUserId,
                    gameName,
                    metadata: { score, username },
                });
            }

            // Check milestones (fire-and-forget)
            import('./MilestoneService.js').then(({ MilestoneService }) => {
                MilestoneService.checkAndEmit(gameRoomId, username, discordUserId).catch(() => {});
            }).catch(() => {});

            // Friend score events (fire-and-forget, targeted per user)
            if (discordUserId) {
                import('./FriendsService.js').then(({ FriendsService }) => {
                    FriendsService.getPlayersWhoFriended(discordUserId!).then(async (friendIds) => {
                        for (const friendId of friendIds) {
                            await LobbyFeedService.emit({
                                gameRoomId,
                                type: 'friend_score',
                                icon: '\u{1F465}',
                                title: `Your friend ${username} posted ${formattedScore} on ${gameName}`,
                                playerId: discordUserId,
                                gameName,
                                targetUserId: friendId,
                                metadata: { score },
                            });
                        }
                    }).catch(() => {});
                }).catch(() => {});
            }

        } catch (error) {
            logError('LobbyFeedGenerator.onScoreSubmitted error:', error);
        }
    }
}

function isTypeEnabled(enabledTypes: string[] | null, type: string): boolean {
    if (!enabledTypes) return true; // null means all enabled
    return enabledTypes.includes(type);
}
