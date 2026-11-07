import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Routes, EmbedBuilder } from 'discord.js';

/**
 * E8 (v2.221.0) - per-kind announcement channels and forum targets.
 *
 *   - `parseAnnounceRoutes` is tolerant and never throws.
 *   - `resolveAnnouncementChannelId(room, tournamentChannel, kind)` precedence:
 *     Discord off -> 'none' -> tournament channel -> route[kind] -> room default -> env.
 *   - `sendChannelEmbed` / `sendChannelMessage` create a forum POST when the
 *     target is a forum; a text channel is posted exactly as before.
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

const { setupTestDb, createTestRoom } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { parseAnnounceRoutes, serializeAnnounceRoutes, DISCORD_ANNOUNCE_ROUTES_KEY } = await import('../utils/discordAnnounceRoutes.js');
const {
    resolveAnnouncementChannelId, ANNOUNCE_NONE, sendChannelEmbed, sendChannelMessage,
    _resetChannelTypeCacheForTests, forumPostName,
} = await import('../utils/discord.js');

const DEFAULT = '111111111111111111';
const PICKS = '222222222222222222';
const POLLS = '333333333333333333';
const TOURN = '444444444444444444';
const FORUM = '555555555555555555';
const TEXT = '666666666666666666';

describe('parseAnnounceRoutes', () => {
    it('reads every route of a valid value', () => {
        expect(parseAnnounceRoutes(JSON.stringify({ version: 1, routes: { tournament: TOURN, picks: PICKS, polls: POLLS } })))
            .toEqual({ tournament: TOURN, picks: PICKS, polls: POLLS, scores: null });
    });

    it('every route is optional', () => {
        expect(parseAnnounceRoutes(JSON.stringify({ version: 1, routes: { picks: PICKS } })))
            .toEqual({ tournament: null, picks: PICKS, polls: null, scores: null });
    });

    it('bad JSON, wrong version, wrong shapes and non-id values are null, never a throw', () => {
        const none = { tournament: null, picks: null, polls: null, scores: null };
        expect(parseAnnounceRoutes(null)).toEqual(none);
        expect(parseAnnounceRoutes(undefined)).toEqual(none);
        expect(parseAnnounceRoutes('')).toEqual(none);
        expect(parseAnnounceRoutes('{not json')).toEqual(none);
        expect(parseAnnounceRoutes('[]')).toEqual(none);
        expect(parseAnnounceRoutes('"x"')).toEqual(none);
        expect(parseAnnounceRoutes(JSON.stringify({ version: 2, routes: { picks: PICKS } }))).toEqual(none);
        expect(parseAnnounceRoutes(JSON.stringify({ version: 1, routes: [PICKS] }))).toEqual(none);
        expect(parseAnnounceRoutes(JSON.stringify({ version: 1, routes: { picks: 222, polls: 'general', tournament: '' } })))
            .toEqual(none);
        expect(parseAnnounceRoutes(JSON.stringify({ version: 1, routes: { picks: PICKS, polls: { id: POLLS } } })))
            .toEqual({ tournament: null, picks: PICKS, polls: null, scores: null });
    });

    it('serialize drops unusable routes and empties to ""', () => {
        expect(serializeAnnounceRoutes(JSON.stringify({ version: 1, routes: { picks: PICKS, polls: 'nope', extra: TOURN } })))
            .toBe(JSON.stringify({ version: 1, routes: { picks: PICKS } }));
        expect(serializeAnnounceRoutes(JSON.stringify({ version: 1, routes: {} }))).toBe('');
        expect(serializeAnnounceRoutes('garbage')).toBe('');
    });
});

describe('resolveAnnouncementChannelId with a kind', () => {
    let roomId: string;

    async function setSetting(key: string, value: string) {
        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`,
            roomId, key, value,
        );
    }

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        delete process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
    });

    it('room Discord disabled -> null, whatever is routed', async () => {
        await setSetting('DISCORD_ENABLED', 'false');
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, JSON.stringify({ version: 1, routes: { picks: PICKS } }));
        expect(await resolveAnnouncementChannelId(roomId, null, 'picks')).toBeNull();
        expect(await resolveAnnouncementChannelId(roomId, TOURN, 'picks')).toBeNull();
    });

    it("tournament 'none' -> null before any route", async () => {
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, JSON.stringify({ version: 1, routes: { picks: PICKS } }));
        expect(await resolveAnnouncementChannelId(roomId, ANNOUNCE_NONE, 'picks')).toBeNull();
    });

    it("the tournament's own channel beats the room's routes", async () => {
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, JSON.stringify({ version: 1, routes: { tournament: POLLS, picks: PICKS, polls: POLLS } }));
        await setSetting('DISCORD_ANNOUNCEMENT_CHANNEL_ID', DEFAULT);
        for (const kind of ['tournament', 'picks', 'polls'] as const) {
            expect(await resolveAnnouncementChannelId(roomId, TOURN, kind)).toBe(TOURN);
        }
    });

    it('picks route set, tournament route unset -> picks go to the picks channel, Now Active to the room default', async () => {
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, JSON.stringify({ version: 1, routes: { picks: PICKS } }));
        await setSetting('DISCORD_ANNOUNCEMENT_CHANNEL_ID', DEFAULT);
        expect(await resolveAnnouncementChannelId(roomId, null, 'picks')).toBe(PICKS);
        expect(await resolveAnnouncementChannelId(roomId, '', 'tournament')).toBe(DEFAULT);
        expect(await resolveAnnouncementChannelId(roomId, null)).toBe(DEFAULT); // default kind = tournament
        expect(await resolveAnnouncementChannelId(roomId, null, 'polls')).toBe(DEFAULT);
    });

    it('a malformed routes value falls through to the room default', async () => {
        await setSetting(DISCORD_ANNOUNCE_ROUTES_KEY, '{oops');
        await setSetting('DISCORD_ANNOUNCEMENT_CHANNEL_ID', DEFAULT);
        expect(await resolveAnnouncementChannelId(roomId, null, 'polls')).toBe(DEFAULT);
    });

    it('no route and no room default -> env, else null', async () => {
        expect(await resolveAnnouncementChannelId(roomId, null, 'picks')).toBeNull();
        process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID = DEFAULT;
        expect(await resolveAnnouncementChannelId(roomId, null, 'picks')).toBe(DEFAULT);
        delete process.env.DISCORD_ANNOUNCEMENT_CHANNEL_ID;
    });
});

describe('forum-aware senders', () => {
    beforeEach(() => {
        _resetChannelTypeCacheForTests();
        post.mockReset().mockResolvedValue({ id: 'm1' });
        get.mockReset().mockImplementation(async (route: string) => {
            if (route === Routes.channel(FORUM)) return { id: FORUM, type: 15 };
            if (route === Routes.channel(TEXT)) return { id: TEXT, type: 0 };
            throw new Error('unknown channel');
        });
    });

    it('an embed into a text channel is the same bare message as before', async () => {
        const embed = new EmbedBuilder().setTitle('Now Active: Medieval Madness').setDescription('Go');
        await sendChannelEmbed(TEXT, embed, { pingUserIds: ['123456789012345678'] });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]![0]).toBe(Routes.channelMessages(TEXT));
        expect(post.mock.calls[0]![1].body).toEqual({
            embeds: [embed.toJSON()],
            content: '<@123456789012345678>',
            allowed_mentions: { users: ['123456789012345678'] },
        });
    });

    it('an unknown channel type (lookup failed) posts as a text channel', async () => {
        await sendChannelMessage('777777777777777777', 'hello');
        expect(post.mock.calls[0]![0]).toBe(Routes.channelMessages('777777777777777777'));
        expect(post.mock.calls[0]![1].body).toEqual({ content: 'hello' });
    });

    it('an embed into a forum creates a post titled with the embed title', async () => {
        const embed = new EmbedBuilder().setTitle('Pick Needed — Weekly Grind').setDescription('You won');
        await sendChannelEmbed(FORUM, embed, { pingUserIds: ['123456789012345678'] });
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0]![0]).toBe(Routes.threads(FORUM));
        expect(post.mock.calls[0]![1].body).toEqual({
            name: 'Pick Needed — Weekly Grind',
            message: {
                embeds: [embed.toJSON()],
                content: '<@123456789012345678>',
                allowed_mentions: { users: ['123456789012345678'] },
            },
        });
    });

    it('a message into a forum creates a post named from its first line, no raw ids, 100 chars max', async () => {
        await sendChannelMessage(FORUM, '<@123456789012345678> — you have next pick for **Weekly Grind**!\nmore');
        expect(post.mock.calls[0]![0]).toBe(Routes.threads(FORUM));
        expect(post.mock.calls[0]![1].body).toEqual({
            name: 'you have next pick for Weekly Grind!',
            message: { content: '<@123456789012345678> — you have next pick for **Weekly Grind**!\nmore' },
        });
        expect(forumPostName('x'.repeat(250))).toHaveLength(100);
        expect(forumPostName('<@1234567890>')).toBe('Arcaid announcement');
    });

    it('the channel type is looked up once per channel', async () => {
        await sendChannelMessage(FORUM, 'one');
        await sendChannelMessage(FORUM, 'two');
        expect(get.mock.calls.filter(c => c[0] === Routes.channel(FORUM))).toHaveLength(1);
    });
});
