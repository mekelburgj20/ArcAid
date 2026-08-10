import { getDatabase } from '../database/database.js';
import { LobbyFeedService } from './LobbyFeedService.js';
import { NotificationService } from './NotificationService.js';
import { UserProfileService } from './UserProfileService.js';
import { AchievementService } from './AchievementService.js';
import { StatsService } from './StatsService.js';
import { logError } from '../utils/logger.js';
import { emitScoreNew } from '../api/websocket.js';
import { trackBackground } from '../utils/backgroundTasks.js';

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

            // New room #1 (took the top slot over a previous leader). The feed
            // event and the retention DM are INDEPENDENT concerns:
            //   • the `new_high_score` feed event stays gated on the room's
            //     cosmetic toggle (isTypeEnabled);
            //   • the dethrone DM fires whenever a new #1 happens, regardless of
            //     the feed toggle — disabling the cosmetic feed event must never
            //     silently kill the retention notification.
            const isNewRoomTop = currentRank === 1 && sorted.length > 1;

            // S13 — trophy case: room record achievement, independent of the
            // feed toggle (same independence pattern as the dethrone DM below —
            // disabling the cosmetic feed event must never silently lose the
            // achievement).
            if (isNewRoomTop) {
                trackBackground(AchievementService.award({
                    gameRoomId,
                    discordUserId,
                    iscoredUsername: username,
                    type: 'room_record',
                    gameName,
                    metadata: { score },
                }).catch(() => {}));
            }

            if (isNewRoomTop && isTypeEnabled(enabledTypes, 'new_high_score')) {
                await LobbyFeedService.emit({
                    gameRoomId,
                    type: 'new_high_score',
                    icon: undefined,
                    title: `${displayName} posted ${formattedScore} on ${gameName} — new room #1!`,
                    playerId: discordUserId,
                    gameName,
                    metadata: { score, username: displayName },
                });
            }

            if (isNewRoomTop) {
                // Notify dethroned #1 player via DM — NOT gated on the feed toggle.
                const dethronedKey = sorted[1]?.[0]; // previous #1 is now at index 1
                if (dethronedKey && dethronedKey !== playerKey) {
                    const dethronedMapping = await db.get(
                        'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
                        dethronedKey
                    );
                    if (dethronedMapping?.discord_user_id && dethronedMapping.discord_user_id !== discordUserId) {
                        const room = await db.get('SELECT slug FROM game_rooms WHERE id = ?', gameRoomId);
                        // Deep-link to the game page (FE route /:slug/games/:name keys on
                        // the game NAME — confirmed against admin-ui/src/App.tsx:180 +
                        // GameCard.tsx:74). encodeURIComponent handles spaces/punctuation
                        // (e.g. "WHO dunnit?").
                        const link = room?.slug
                            ? NotificationService.buildLink(room.slug, '/games/' + encodeURIComponent(gameName))
                            : '';
                        // Margin over the now-dethroned #1 (sorted[1] is the same row
                        // we keyed dethronedKey from — consistent pairing). New #1 is
                        // strictly >= the old top here.
                        const prevTopScore = sorted[1]?.[1] ?? 0;
                        const margin = score - prevTopScore;
                        const marginStr = margin.toLocaleString();
                        const marginClause = margin > 0
                            ? `(beating you by ${marginStr})`
                            : '(tying your top score)';
                        trackBackground(NotificationService.notify({
                            userId: dethronedMapping.discord_user_id,
                            type: 'rankDethroned',
                            message: `You've been dethroned on **${gameName}**! ${displayName} posted ${formattedScore} ${marginClause} to claim #1.${link ? `\n${link}` : ''}`,
                            roomId: gameRoomId,
                            pushUrl: link || undefined,
                        }).catch(() => {}));
                    }
                }
            }

            if (!isNewRoomTop && currentRank > 1 && currentRank <= 10 && isTypeEnabled(enabledTypes, 'rank_change')) {
                // Rank change (top 10 only to reduce noise). Standalone `if` (not
                // an else-if off new_high_score) so a rank-1 score with the
                // new_high_score feed DISABLED does not leak into this branch.
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

            // Check milestones (fire-and-forget, tracked — the inner promise is
            // RETURNED so the chain settles only when checkAndEmit settles)
            trackBackground(
                import('./MilestoneService.js')
                    .then(({ MilestoneService }) => MilestoneService.checkAndEmit(gameRoomId, username, discordUserId))
                    .catch(() => {}),
            );

            // Rotation-readiness nudge, event trigger (b) — ROADMAP "Next-win
            // disposition + dynasty option + rotation-readiness nudge". This is
            // the shared fan-out point for ALL score submission paths
            // (community/freeplay web submits, the Discord /submit-score
            // command, and iScored sync), so hooking it here covers every
            // trigger-(b) source in one place rather than duplicating the
            // check at each call site. No-ops instantly unless `gameName`
            // matches a tournament's currently ACTIVE slot within an hour of
            // its next rotation AND this submit put `discordUserId` in 1st.
            trackBackground(
                import('./RotationNudgeService.js')
                    .then(({ RotationNudgeService }) => RotationNudgeService.evaluateSubmitter(gameRoomId, gameName, discordUserId))
                    .catch(() => {}),
            );

            // Friend score events + notifications (fire-and-forget, targeted per user)
            //
            // v2.70.0 privacy guard — following is global, rooms are not. A
            // player who follows someone can end up following them INTO an
            // approval-gated room they were never admitted to, and the
            // friend_score fan-out would then hand them the room's game names,
            // player names and scores through the feed and a DM. Both channels
            // are now gated on the follower being able to VIEW the origin room:
            // no view, no event AND no DM (not one or the other — the DM leaks
            // the same three facts on its own).
            //
            // Cost: `getJoinPolicy` is ONE settings read per submission, hoisted
            // out of the loop. Open rooms (the overwhelming majority) short-
            // circuit right there and pay nothing per follower — the
            // membership/admin round-trips inside `canViewRoom` only happen for
            // approval rooms, which is exactly what its own docstring asks
            // callers to do.
            if (discordUserId) {
                trackBackground(
                    import('./FriendsService.js')
                        .then(({ FriendsService }) => FriendsService.getPlayersWhoFriended(discordUserId!))
                        .then(async (friendIds) => {
                            if (friendIds.length === 0) return;

                            const { RoomAccessService } = await import('./RoomAccessService.js');
                            const gated = (await RoomAccessService.getJoinPolicy(gameRoomId)) === 'approval';

                            for (const friendId of friendIds) {
                                if (gated) {
                                    // `canViewRoom` takes a decoded token, not a
                                    // bare id. A follower is always a player by
                                    // definition here, and the real admin /
                                    // membership answers are re-read from the DB
                                    // inside — so an empty `gameRoomIds` costs
                                    // nothing but honesty (we have no token to
                                    // copy claims from).
                                    const canView = await RoomAccessService.canViewRoom(
                                        { role: 'player', gameRoomIds: [], discordId: friendId },
                                        gameRoomId,
                                    ).catch(() => false);
                                    if (!canView) continue;
                                }

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

                                // DM notification for friend score (kept per-friend
                                // best-effort — a failed DM must not skip the rest)
                                await NotificationService.notify({
                                    userId: friendId,
                                    type: 'friendScore',
                                    message: `Your friend **${displayName}** just posted **${formattedScore}** on **${gameName}**!`,
                                }).catch(() => {});
                            }
                        })
                        .catch(() => {}),
                );
            }

            // S14 social loops — weekly participation streak event. Detect
            // "this submission is the player's first score_history row in the
            // current week AND they had at least one row in the immediately-
            // previous week" with a cheap two-count query (the just-submitted
            // row is already in score_history by the time this runs — see
            // callers). Only fires on the week's first score so a player
            // scoring repeatedly in one week doesn't spam the feed.
            {
                const playerKey = discordUserId || `iscored:${username.toLowerCase()}`;
                const weekCounts = await db.get<{ this_week: number; prev_week: number }>(`
                    SELECT
                        SUM(CASE WHEN strftime('%Y-%W', created_at) = strftime('%Y-%W','now') THEN 1 ELSE 0 END) as this_week,
                        SUM(CASE WHEN strftime('%Y-%W', created_at) = strftime('%Y-%W','now','-7 days') THEN 1 ELSE 0 END) as prev_week
                    FROM score_history
                    WHERE game_room_id = ?
                      AND orphaned_at IS NULL
                      AND COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) = ?
                `, gameRoomId, playerKey);

                const isFirstThisWeek = (weekCounts?.this_week ?? 0) === 1;
                const hadPrevWeek = (weekCounts?.prev_week ?? 0) > 0;

                if (isFirstThisWeek && hadPrevWeek) {
                    const { currentWeeks } = await StatsService.getParticipationStreak(playerKey, gameRoomId);
                    if (currentWeeks >= 2 && isTypeEnabled(enabledTypes, 'streak_extended')) {
                        await LobbyFeedService.emit({
                            gameRoomId,
                            type: 'streak_extended',
                            icon: undefined,
                            title: `${displayName} is on a ${currentWeeks}-week streak!`,
                            playerId: discordUserId,
                            metadata: { weeks: currentWeeks },
                        });
                    }
                }
            }

        } catch (error) {
            logError('LobbyFeedGenerator.onScoreSubmitted error:', error);
        }
    }
}

export function isTypeEnabled(enabledTypes: string[] | null, type: string): boolean {
    if (!enabledTypes) return true; // null means all enabled
    return enabledTypes.includes(type);
}
