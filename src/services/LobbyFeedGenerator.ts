import { getDatabase } from '../database/database.js';
import { LobbyFeedService } from './LobbyFeedService.js';
import { NotificationService } from './NotificationService.js';
import { UserProfileService } from './UserProfileService.js';
import { logError } from '../utils/logger.js';
import { emitScoreNew } from '../api/websocket.js';

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

            // Resolve the user-chosen global display name when the submitter is
            // Discord-linked; otherwise fall back to the iScored alias. All
            // user-facing strings below render `displayName`.
            const displayName = discordUserId
                ? (await UserProfileService.getDisplayName(discordUserId)) ?? username
                : username;

            // S4: live scoreboard toast (room-scoped, fire-and-forget). Separate
            // from the lobby-feed config below — the toast fires for every new
            // score regardless of which feed event types a room has enabled.
            try { emitScoreNew(gameRoomId, { gameName, playerName: displayName, score }); } catch { /* never block on a toast */ }

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
                    icon: undefined,
                    title: `${displayName} posted ${formattedScore} on ${gameName} — new room #1!`,
                    playerId: discordUserId,
                    gameName,
                    metadata: { score, username: displayName },
                });

                // Notify dethroned #1 player via DM
                const dethronedKey = sorted[1]?.[0]; // previous #1 is now at index 1
                if (dethronedKey && dethronedKey !== playerKey) {
                    const dethronedMapping = await db.get(
                        'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
                        dethronedKey
                    );
                    if (dethronedMapping?.discord_user_id && dethronedMapping.discord_user_id !== discordUserId) {
                        const room = await db.get('SELECT slug FROM game_rooms WHERE id = ?', gameRoomId);
                        const link = room?.slug ? NotificationService.buildLink(room.slug) : '';
                        NotificationService.notify({
                            userId: dethronedMapping.discord_user_id,
                            type: 'rankDethroned',
                            message: `You've been dethroned on **${gameName}**! ${displayName} posted ${formattedScore} to claim #1.${link ? `\n${link}` : ''}`,
                        }).catch(() => {});
                    }
                }
            } else if (currentRank > 0 && currentRank <= 10 && isTypeEnabled(enabledTypes, 'rank_change')) {
                // Rank change (top 10 only to reduce noise)
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'rank_change',
                    icon: undefined,
                    title: `${displayName} climbed to #${currentRank} on ${gameName}`,
                    playerId: discordUserId,
                    gameName,
                    metadata: { score, newRank: currentRank, username: displayName },
                });
            }

            // Always emit score_posted (if enabled)
            if (isTypeEnabled(enabledTypes, 'score_posted')) {
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'score_posted',
                    icon: undefined,
                    title: `${displayName} submitted ${formattedScore} on ${gameName}`,
                    playerId: discordUserId,
                    gameName,
                    metadata: { score, username: displayName },
                });
            }

            // Check milestones (fire-and-forget)
            import('./MilestoneService.js').then(({ MilestoneService }) => {
                MilestoneService.checkAndEmit(gameRoomId, username, discordUserId).catch(() => {});
            }).catch(() => {});

            // Friend score events + notifications (fire-and-forget, targeted per user)
            if (discordUserId) {
                import('./FriendsService.js').then(({ FriendsService }) => {
                    FriendsService.getPlayersWhoFriended(discordUserId!).then(async (friendIds) => {
                        for (const friendId of friendIds) {
                            await LobbyFeedService.emit({
                                gameRoomId,
                                type: 'friend_score',
                                icon: undefined,
                                title: `Your friend ${displayName} posted ${formattedScore} on ${gameName}`,
                                playerId: discordUserId,
                                gameName,
                                targetUserId: friendId,
                                metadata: { score },
                            });

                            // DM notification for friend score
                            NotificationService.notify({
                                userId: friendId,
                                type: 'friendScore',
                                message: `Your friend **${displayName}** just posted **${formattedScore}** on **${gameName}**!`,
                            }).catch(() => {});
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
