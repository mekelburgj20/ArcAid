import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';
import { resolveSubmissionGame } from './SubmissionGameResolver.js';
import {
    resolveAnnouncementChannelId, getChannelType, isForumChannelType, sendChannelMessage,
    type ChannelSendResult,
} from '../utils/discord.js';
import {
    DISCORD_SCORE_POSTS_ENABLED_KEY, DISCORD_SCORE_POSTS_TOP_N_KEY,
    parseScorePostsEnabled, parseScorePostsTopN,
} from '../utils/discordScorePosts.js';
import { gamePageUrl } from '../utils/publicLinks.js';
import { logInfo, logError } from '../utils/logger.js';

/**
 * Discord posts for top-N scores and dethrones (v2.225.0, E13).
 *
 * The iScored bot's "a bit of glory" post, rebuilt: when a score lands in the
 * top N of a game in a room, the bot writes into the room's Tournament posts
 * channel
 *
 *   **Scorpio Rising** just scored **4,688,320** on **Pizza Time**! (Rank: 3)
 *   Full scoreboard is at https://arcaid.app/<slug>/games/Pizza%20Time
 *
 * and a new #1 over a different player appends " — took #1 from **Name**".
 * Plain text (not an embed) so it reads like the iScored post; nothing pings
 * (`allowed_mentions: {parse: []}`, names are bold text, never `<@id>`).
 *
 * - **The one hook** is `LobbyFeedGenerator.onScoreSubmitted` (every submit
 *   path calls it, every `source` posts); it computes rank and names and calls
 *   `onScoreRanked` fire-and-forget. The room switch is the only gate
 *   (`DISCORD_SCORE_POSTS_ENABLED`, absent = off; `DISCORD_SCORE_POSTS_TOP_N`,
 *   default 10, read only through `src/utils/discordScorePosts.ts`).
 * - **Channel**: kind `scores` (v2.226.0, E16) through
 *   `resolveAnnouncementChannelId(room, tournamentChannel, 'scores', tournamentRoutes)`:
 *   the tournament's per-kind route, else its catch-all, else the room's
 *   `scores` route, else the room's `tournament` route, else the room default.
 * - **Forums**: one post per score would be noise, so a forum target posts
 *   into the game's own thread, `games.discord_thread_id` (migration 207).
 *   The "Now Active" announcers store it (`rememberActivationThread`); when
 *   none is stored the first score post creates a post titled with the game
 *   and stores ITS thread id. A game with no `games` row (free play) keeps
 *   its thread in memory only.
 * - **Coalescing**: posts for one (room, game) are spaced at least
 *   `COALESCE_MS` (20 s) apart with a `setTimeout`, so a burst does not
 *   interleave and a forum's lazily-created thread exists before the next
 *   post looks for it. In memory only; nothing is queued beyond that.
 * - Never throws: every failure is logged and swallowed.
 */

export interface ScoreRankedParams {
    roomId: string;
    gameName: string;
    /** Already resolved through the label chain; never a raw id. */
    displayName: string;
    score: number;
    rank: number;
    total: number;
    isNewRoomTop: boolean;
    /** Label of the player this score took #1 from; null when it took #1 from nobody else. */
    previousTopName?: string | null;
    /**
     * Lazy alternative to `previousTopName` (the hook passes this so the
     * lookup only runs once the room switch and top-N have passed).
     */
    resolvePreviousTopName?: () => Promise<string | null>;
    tournamentId?: string | null;
    gameId?: string | null;
}

let COALESCE_MS = 20_000;
const nextSlotAt = new Map<string, number>();
/** Forum threads for games with no `games` row, keyed `${forumId}|${lower(game)}`. */
const memoryThreads = new Map<string, string>();

/** Tests only. */
export function _resetScorePostStateForTests(coalesceMs = 0): void {
    COALESCE_MS = coalesceMs;
    nextSlotAt.clear();
    memoryThreads.clear();
}

/** Bold-safe text: a name with `*` or `_` must not break the markdown around it. */
function escapeMd(text: string): string {
    return text.replace(/([\\*_~|`])/g, '\\$1');
}

export function formatScorePost(p: {
    displayName: string; score: number; gameName: string; rank: number;
    previousTopName?: string | null; link?: string | null;
}): string {
    let line = `**${escapeMd(p.displayName)}** just scored **${p.score.toLocaleString('en-US')}** on **${escapeMd(p.gameName)}**! (Rank: ${p.rank})`;
    if (p.previousTopName) line += ` — took #1 from **${escapeMd(p.previousTopName)}**`;
    return p.link ? `${line}\nFull scoreboard is at ${p.link}` : line;
}

interface GameTarget {
    id: string;
    discord_thread_id: string | null;
    tournament_channel_id: string | null;
    /** Raw `tournaments.discord_announce_routes` (E16); parsed only by the resolver. */
    tournament_announce_routes: string | null;
}

async function resolveGameTarget(params: ScoreRankedParams): Promise<GameTarget | null> {
    const db = await getDatabase();
    const select = `SELECT g.id, g.discord_thread_id, t.discord_channel_id AS tournament_channel_id,
                           t.discord_announce_routes AS tournament_announce_routes
                      FROM games g LEFT JOIN tournaments t ON t.id = g.tournament_id`;
    if (params.gameId) {
        const row = await db.get<GameTarget>(`${select} WHERE g.id = ?`, params.gameId);
        if (row) return row;
    }
    if (params.tournamentId) {
        const row = await db.get<GameTarget>(
            `${select} WHERE g.tournament_id = ? AND LOWER(g.name) = LOWER(?) AND g.status IN ('ACTIVE', 'COMPLETED')
              ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.created_at DESC LIMIT 1`,
            params.tournamentId, params.gameName,
        );
        if (row) return row;
    }
    const resolved = await resolveSubmissionGame({ roomId: params.roomId, gameName: params.gameName });
    if (!resolved) return null;
    return (await db.get<GameTarget>(`${select} WHERE g.id = ?`, resolved.id)) ?? null;
}

export class DiscordScorePostService {
    /**
     * Called by `LobbyFeedGenerator.onScoreSubmitted` once rank is known.
     * Returns once the post is sent (or scheduled, when coalesced).
     */
    static async onScoreRanked(params: ScoreRankedParams): Promise<void> {
        try {
            if (!params.roomId || !params.gameName || !(params.rank >= 1)) return;
            const enabled = parseScorePostsEnabled(await GameRoomSettingsService.get(params.roomId, DISCORD_SCORE_POSTS_ENABLED_KEY));
            if (!enabled) return;
            const topN = parseScorePostsTopN(await GameRoomSettingsService.get(params.roomId, DISCORD_SCORE_POSTS_TOP_N_KEY));
            if (params.rank > topN) return;

            const key = `${params.roomId}|${params.gameName.toLowerCase()}`;
            const now = Date.now();
            const sendAt = Math.max(now, nextSlotAt.get(key) ?? 0);
            nextSlotAt.set(key, sendAt + COALESCE_MS);
            if (sendAt > now) {
                setTimeout(() => { void this.post(params); }, sendAt - now);
                return;
            }
            await this.post(params);
        } catch (err) {
            logError('DiscordScorePostService.onScoreRanked failed:', err);
        }
    }

    private static async post(params: ScoreRankedParams): Promise<void> {
        try {
            const db = await getDatabase();
            const game = await resolveGameTarget(params);
            // v2.226.0 (E16): top-score posts are their own kind, `scores`;
            // with no route of their own they follow the Tournament posts.
            const channelId = await resolveAnnouncementChannelId(
                params.roomId, game?.tournament_channel_id ?? null, 'scores', game?.tournament_announce_routes ?? null,
            );
            if (!channelId) return;

            let previousTopName: string | null = null;
            if (params.isNewRoomTop) {
                previousTopName = params.previousTopName
                    ?? (params.resolvePreviousTopName ? await params.resolvePreviousTopName().catch(() => null) : null);
            }
            const room = await db.get<{ slug: string | null }>('SELECT slug FROM game_rooms WHERE id = ?', params.roomId);
            const content = formatScorePost({
                displayName: params.displayName,
                score: params.score,
                gameName: params.gameName,
                rank: params.rank,
                previousTopName,
                link: room?.slug ? gamePageUrl(room.slug, params.gameName) : null,
            });

            let where = channelId;
            if (isForumChannelType(await getChannelType(channelId))) {
                const memKey = `${channelId}|${params.gameName.toLowerCase()}`;
                // The stored thread is the "Now Active" post, which lives in the
                // TOURNAMENT-kind channel. Only reuse it (and only store into
                // it) when score posts land in that same channel; a separate
                // scores forum keeps its per-game thread in memory.
                const tournamentChannelId = await resolveAnnouncementChannelId(
                    params.roomId, game?.tournament_channel_id ?? null, 'tournament', game?.tournament_announce_routes ?? null,
                );
                const sharesThread = !!game && tournamentChannelId === channelId;
                const threadId = (sharesThread ? game?.discord_thread_id : null) ?? memoryThreads.get(memKey) ?? null;
                let sent: ChannelSendResult | void = undefined;
                if (threadId) {
                    sent = await sendChannelMessage(threadId, content, { noMentions: true });
                    where = threadId;
                }
                if (!sent) {
                    // No thread yet (or the stored one is gone): a new post
                    // named after the game, this score as its first message.
                    sent = await sendChannelMessage(channelId, content, { threadName: params.gameName, noMentions: true });
                    if (sent?.threadId) {
                        where = sent.threadId;
                        if (game && sharesThread) {
                            await db.run('UPDATE games SET discord_thread_id = ? WHERE id = ?', sent.threadId, game.id);
                        } else {
                            memoryThreads.set(memKey, sent.threadId);
                        }
                    }
                }
                if (!sent) return;
            } else {
                const sent = await sendChannelMessage(channelId, content, { noMentions: true });
                if (!sent) return;
            }
            logInfo(`Score post: ${params.displayName} ${params.score} on ${params.gameName} (rank ${params.rank}/${params.total}) -> ${where}`);
        } catch (err) {
            logError('DiscordScorePostService post failed:', err);
        }
    }

    /**
     * The "Now Active" announcers call this with their send result: when the
     * announcement became a NEW forum post, that post is the game's thread and
     * later score posts go into it. Never throws.
     */
    static async rememberActivationThread(
        sent: ChannelSendResult | void,
        tournamentId: string | null | undefined,
        gameName: string,
    ): Promise<void> {
        if (!sent?.threadId || !tournamentId) return;
        try {
            const db = await getDatabase();
            await db.run(
                `UPDATE games SET discord_thread_id = ?
                  WHERE id = (SELECT id FROM games WHERE tournament_id = ? AND LOWER(name) = LOWER(?) AND status = 'ACTIVE'
                              ORDER BY created_at DESC LIMIT 1)`,
                sent.threadId, tournamentId, gameName,
            );
        } catch (err) {
            logError('DiscordScorePostService.rememberActivationThread failed:', err);
        }
    }
}
