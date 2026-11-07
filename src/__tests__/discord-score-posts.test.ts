import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Routes } from 'discord.js';

/**
 * E13 (v2.225.0) - Discord posts for top-N scores and dethrones.
 *
 *   - Room switch `DISCORD_SCORE_POSTS_ENABLED` (absent = off) and
 *     `DISCORD_SCORE_POSTS_TOP_N` (1-50, default 10) via the parsers.
 *   - The post is plain text, exact iScored-style wording, no pings.
 *   - A new #1 names who was dethroned; the same player improving their own
 *     #1 does not.
 *   - Forum targets: a stored `games.discord_thread_id` gets the post; with
 *     none, a new post is created and its thread id stored on the game.
 *   - The "Now Active" announcer stores the thread it created in a forum.
 *
 * The REST layer is mocked (as in discord-announce-routes.test.ts), so the
 * real `sendChannelMessage` / `getChannelType` run.
 */

const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));

vi.mock('discord.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('discord.js')>();
    class REST {
        constructor(_opts?: unknown) {}
        setToken() { return this; }
        post = post;
        get = get;
    }
    return { ...actual, REST };
});

process.env.DISCORD_BOT_TOKEN = 'test-token';
process.env.PUBLIC_URL = 'https://arcaid.test';

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { _resetChannelTypeCacheForTests } = await import('../utils/discord.js');
const { parseScorePostsTopN, parseScorePostsEnabled, serializeScorePostsTopN } = await import('../utils/discordScorePosts.js');
const { DiscordScorePostService, _resetScorePostStateForTests } = await import('../services/DiscordScorePostService.js');
const { LobbyFeedGenerator } = await import('../services/LobbyFeedGenerator.js');
const { drainBackgroundTasks } = await import('../utils/backgroundTasks.js');
const { TournamentEngine } = await import('../engine/TournamentEngine.js');

const TEXT = '600000000000000001';
const FORUM = '600000000000000002';
const THREAD = '600000000000000003';
const NEW_THREAD = '600000000000000004';

let roomId: string;
let tournamentId: string;
let gameId: string;

async function setSetting(key: string, value: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
        roomId, key, value,
    );
}

async function setTournamentChannel(channelId: string) {
    const db = await getDatabase();
    await db.run('UPDATE tournaments SET discord_channel_id = ? WHERE id = ?', channelId, tournamentId);
}

function base(overrides: Record<string, unknown> = {}) {
    return {
        roomId, gameName: 'Pizza Time', displayName: 'Scorpio Rising', score: 4688320,
        rank: 3, total: 12, isNewRoomTop: false, tournamentId, ...overrides,
    };
}

const LINK = 'https://arcaid.test/glory-room/games/Pizza%20Time';

beforeEach(async () => {
    await setupTestDb();
    roomId = await createTestRoom('glory-room', 'Glory Room');
    tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    gameId = await createTestGame(tournamentId, { name: 'Pizza Time', status: 'ACTIVE' });
    await setTournamentChannel(TEXT);
    _resetChannelTypeCacheForTests();
    _resetScorePostStateForTests(0);
    post.mockReset().mockImplementation(async (route: string) => {
        if (route === Routes.threads(FORUM)) return { id: NEW_THREAD };
        return { id: 'msg-1' };
    });
    get.mockReset().mockImplementation(async (route: string) => {
        if (route === Routes.channel(FORUM)) return { id: FORUM, type: 15 };
        if (route === Routes.channel(TEXT)) return { id: TEXT, type: 0 };
        if (route === Routes.channel(THREAD)) return { id: THREAD, type: 11 };
        if (route === Routes.channel(NEW_THREAD)) return { id: NEW_THREAD, type: 11 };
        throw new Error('unknown channel');
    });
});

describe('parsers', () => {
    it('parseScorePostsTopN defaults to 10 and clamps to 1-50', () => {
        expect(parseScorePostsTopN(undefined)).toBe(10);
        expect(parseScorePostsTopN(null)).toBe(10);
        expect(parseScorePostsTopN('')).toBe(10);
        expect(parseScorePostsTopN('abc')).toBe(10);
        expect(parseScorePostsTopN('5')).toBe(5);
        expect(parseScorePostsTopN('7.9')).toBe(7);
        expect(parseScorePostsTopN('0')).toBe(1);
        expect(parseScorePostsTopN('-3')).toBe(1);
        expect(parseScorePostsTopN('500')).toBe(50);
        expect(parseScorePostsTopN(25)).toBe(25);
    });

    it('serialize keeps blank as removal and clamps the rest', () => {
        expect(serializeScorePostsTopN('')).toBe('');
        expect(serializeScorePostsTopN('  ')).toBe('');
        expect(serializeScorePostsTopN('99')).toBe('50');
        expect(serializeScorePostsTopN('x')).toBe('10');
    });

    it('enabled only on "true"', () => {
        expect(parseScorePostsEnabled(null)).toBe(false);
        expect(parseScorePostsEnabled('false')).toBe(false);
        expect(parseScorePostsEnabled('true')).toBe(true);
    });
});

describe('DiscordScorePostService.onScoreRanked', () => {
    it('switch off (absent) -> no post', async () => {
        await DiscordScorePostService.onScoreRanked(base());
        expect(post).not.toHaveBeenCalled();
    });

    it('rank above the top N -> no post', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setSetting('DISCORD_SCORE_POSTS_TOP_N', '2');
        await DiscordScorePostService.onScoreRanked(base({ rank: 3 }));
        expect(post).not.toHaveBeenCalled();
    });

    it('rank 11 with the default top 10 -> no post', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await DiscordScorePostService.onScoreRanked(base({ rank: 11 }));
        expect(post).not.toHaveBeenCalled();
    });

    it('rank within the top N -> one plain-text post with the exact wording, no pings', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await DiscordScorePostService.onScoreRanked(base());
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]![0]).toBe(Routes.channelMessages(TEXT));
        expect(post.mock.calls[0]![1].body).toEqual({
            content: `**Scorpio Rising** just scored **4,688,320** on **Pizza Time**! (Rank: 3)\nFull scoreboard is at ${LINK}`,
            allowed_mentions: { parse: [] },
        });
    });

    it('a new #1 adds the dethrone clause', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await DiscordScorePostService.onScoreRanked(base({ rank: 1, isNewRoomTop: true, previousTopName: 'Mox' }));
        expect(post.mock.calls[0]![1].body.content).toBe(
            `**Scorpio Rising** just scored **4,688,320** on **Pizza Time**! (Rank: 1) — took #1 from **Mox**\nFull scoreboard is at ${LINK}`,
        );
    });

    it('falls back to the room routes when the tournament has no channel', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentChannel('');
        await setSetting('DISCORD_ANNOUNCEMENT_CHANNEL_ID', TEXT);
        await DiscordScorePostService.onScoreRanked(base());
        expect(post.mock.calls[0]![0]).toBe(Routes.channelMessages(TEXT));
    });

    it("a tournament on 'none' posts nothing", async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentChannel('none');
        await DiscordScorePostService.onScoreRanked(base());
        expect(post).not.toHaveBeenCalled();
    });

    // E16 (v2.226.0) - top-score posts are kind `scores`.
    async function setTournamentRoutes(routes: Record<string, string>) {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET discord_announce_routes = ? WHERE id = ?',
            JSON.stringify({ version: 1, routes }), tournamentId);
    }

    it("a tournament whose scores route is 'none' posts nothing while its tournament kind still resolves", async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentRoutes({ scores: 'none' });
        await DiscordScorePostService.onScoreRanked(base());
        expect(post).not.toHaveBeenCalled();
        const { resolveAnnouncementChannelId } = await import('../utils/discord.js');
        const db = await getDatabase();
        const t = await db.get<{ discord_channel_id: string; discord_announce_routes: string }>(
            'SELECT discord_channel_id, discord_announce_routes FROM tournaments WHERE id = ?', tournamentId);
        expect(await resolveAnnouncementChannelId(roomId, t!.discord_channel_id, 'tournament', t!.discord_announce_routes)).toBe(TEXT);
    });

    it('a per-tournament scores route sends the post there, not to the catch-all', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentRoutes({ scores: '600000000000000009' });
        await DiscordScorePostService.onScoreRanked(base());
        expect(post.mock.calls[0]![0]).toBe(Routes.channelMessages('600000000000000009'));
    });

    it('a room scores route is used, and without one the room tournament route', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentChannel('');
        await setSetting('DISCORD_ANNOUNCE_ROUTES', JSON.stringify({ version: 1, routes: { tournament: TEXT } }));
        await DiscordScorePostService.onScoreRanked(base());
        expect(post.mock.calls[0]![0]).toBe(Routes.channelMessages(TEXT));
        _resetScorePostStateForTests(0);
        await setSetting('DISCORD_ANNOUNCE_ROUTES', JSON.stringify({ version: 1, routes: { tournament: TEXT, scores: '600000000000000008' } }));
        await DiscordScorePostService.onScoreRanked(base({ displayName: 'Mox' }));
        expect(post.mock.calls[1]![0]).toBe(Routes.channelMessages('600000000000000008'));
    });

    it('a scores forum separate from the tournament channel never reuses or overwrites the activation thread', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentRoutes({ scores: FORUM });
        const db = await getDatabase();
        await db.run('UPDATE games SET discord_thread_id = ? WHERE id = ?', THREAD, gameId);
        await DiscordScorePostService.onScoreRanked(base());
        expect(post.mock.calls[0]![0]).toBe(Routes.threads(FORUM));
        const row = await db.get<{ discord_thread_id: string | null }>('SELECT discord_thread_id FROM games WHERE id = ?', gameId);
        expect(row!.discord_thread_id).toBe(THREAD);
        // The next score goes into the in-memory scores thread.
        await DiscordScorePostService.onScoreRanked(base({ displayName: 'Mox', rank: 4 }));
        expect(post.mock.calls[1]![0]).toBe(Routes.channelMessages(NEW_THREAD));
    });

    it('forum with a stored thread posts into that thread', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentChannel(FORUM);
        const db = await getDatabase();
        await db.run('UPDATE games SET discord_thread_id = ? WHERE id = ?', THREAD, gameId);
        await DiscordScorePostService.onScoreRanked(base());
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]![0]).toBe(Routes.channelMessages(THREAD));
    });

    it('forum without a thread creates a post named after the game and stores its id', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await setTournamentChannel(FORUM);
        await DiscordScorePostService.onScoreRanked(base());
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]![0]).toBe(Routes.threads(FORUM));
        expect(post.mock.calls[0]![1].body.name).toBe('Pizza Time');
        expect(post.mock.calls[0]![1].body.message.content).toContain('just scored');
        const db = await getDatabase();
        const row = await db.get<{ discord_thread_id: string | null }>('SELECT discord_thread_id FROM games WHERE id = ?', gameId);
        expect(row!.discord_thread_id).toBe(NEW_THREAD);

        // The next score goes into that thread, not a new post.
        await DiscordScorePostService.onScoreRanked(base({ displayName: 'Mox', rank: 4 }));
        expect(post).toHaveBeenCalledTimes(2);
        expect(post.mock.calls[1]![0]).toBe(Routes.channelMessages(NEW_THREAD));
    });

    it('coalesces a burst on one game: the second post waits', async () => {
        vi.useFakeTimers();
        try {
            _resetScorePostStateForTests(20_000);
            await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
            await DiscordScorePostService.onScoreRanked(base());
            await DiscordScorePostService.onScoreRanked(base({ displayName: 'Mox', rank: 4 }));
            expect(post).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(20_000);
            await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('via LobbyFeedGenerator.onScoreSubmitted (the one hook)', () => {
    async function community(name: string, score: number) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO community_scores (game_name, game_room_id, iscored_username, score) VALUES ('Pizza Time', ?, ?, ?)`,
            roomId, name, score,
        );
        await db.run(
            `INSERT INTO score_history (game_name, game_room_id, iscored_username, score, source) VALUES ('Pizza Time', ?, ?, ?, 'community')`,
            roomId, name, score,
        );
    }

    async function submit(name: string, score: number) {
        await community(name, score);
        await LobbyFeedGenerator.onScoreSubmitted({ gameRoomId: roomId, gameName: 'Pizza Time', username: name, score, source: 'community' });
        await drainBackgroundTasks();
    }

    it('a new #1 over another player names them', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await community('Mox', 1000);
        await submit('Scorpio', 2000);
        const contents = post.mock.calls.map(c => c[1].body.content as string);
        expect(contents).toHaveLength(1);
        expect(contents[0]).toContain('**Scorpio** just scored **2,000** on **Pizza Time**! (Rank: 1) — took #1 from **Mox**');
    });

    it('the same player improving their own #1 has no dethrone clause', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await community('Mox', 1000);
        await community('Scorpio', 2000);
        await submit('Scorpio', 3000);
        const contents = post.mock.calls.map(c => c[1].body.content as string);
        expect(contents).toHaveLength(1);
        expect(contents[0]).toContain('(Rank: 1)');
        expect(contents[0]).not.toContain('took #1');
    });

    it('a score below the player\'s own best does not post', async () => {
        await setSetting('DISCORD_SCORE_POSTS_ENABLED', 'true');
        await community('Scorpio', 5000);
        await submit('Scorpio', 100);
        expect(post).not.toHaveBeenCalled();
    });

    it('switch off -> the hook posts nothing', async () => {
        await community('Mox', 1000);
        await submit('Scorpio', 2000);
        expect(post).not.toHaveBeenCalled();
    });
});

describe('activation announcer stores the forum thread', () => {
    it('announceGameActivated into a forum stores the new post as the game thread', async () => {
        await setTournamentChannel(FORUM);
        await TournamentEngine.getInstance().announceGameActivated({ tournamentId, gameName: 'Pizza Time' });
        expect(post.mock.calls[0]![0]).toBe(Routes.threads(FORUM));
        const db = await getDatabase();
        const row = await db.get<{ discord_thread_id: string | null }>('SELECT discord_thread_id FROM games WHERE id = ?', gameId);
        expect(row!.discord_thread_id).toBe(NEW_THREAD);
    });

    it('a text channel stores nothing', async () => {
        await TournamentEngine.getInstance().announceGameActivated({ tournamentId, gameName: 'Pizza Time' });
        const db = await getDatabase();
        const row = await db.get<{ discord_thread_id: string | null }>('SELECT discord_thread_id FROM games WHERE id = ?', gameId);
        expect(row!.discord_thread_id).toBeNull();
    });
});

describe('migration 207', () => {
    it('adds games.discord_thread_id and records itself', async () => {
        const db = await getDatabase();
        const cols = (await db.all(`PRAGMA table_info(games)`)) as Array<{ name: string }>;
        expect(cols.some(c => c.name === 'discord_thread_id')).toBe(true);
        const applied = await db.get(`SELECT name FROM schema_migrations WHERE name = '207_games_discord_thread_id'`);
        expect(applied).toBeTruthy();
    });
});
