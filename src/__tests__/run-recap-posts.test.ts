import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Routes } from 'discord.js';

/**
 * B31.5 - the run recap post sweep. The REST layer is mocked (as in
 * discord-score-posts.test.ts) so the real sendChannelMessage runs; the recap
 * itself is mocked (its own tests live with RunRecapService).
 */

const { post, get, getRunRecap } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(), getRunRecap: vi.fn() }));

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

vi.mock('../services/RunRecapService.js', () => ({ RunRecapService: { getRunRecap } }));
vi.mock('../utils/runRecapText.js', () => ({
    DISCORD_COPY_MAX: 4000,
    DISCORD_BOT_MAX: 2000,
    buildRunRecapText: () => 'FULL',
    splitRecapForBot: () => ['chunk one', 'chunk two'],
}));

process.env.DISCORD_BOT_TOKEN = 'test-token';
process.env.PUBLIC_URL = 'https://arcaid.test';

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { _resetChannelTypeCacheForTests } = await import('../utils/discord.js');
const { RunRecapPostService, RECAP_POST_SETTLE_MS, RECAP_POST_MAX_AGE_MS } = await import('../services/RunRecapPostService.js');
const { parseRunRecapsEnabled } = await import('../utils/discordRunRecaps.js');

const TEXT = '600000000000000001';
const FORUM = '600000000000000002';
const NEW_THREAD = '600000000000000004';
const ROOM_TOURN = '600000000000000005';
const ROOM_RECAPS = '600000000000000006';

let roomId: string;
let tournamentId: string;
let gameId: string;
const NOW = new Date('2026-11-26T12:00:00.000Z');
const endedAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

async function setSetting(key: string, value: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)`, roomId, key, value);
}
async function ledger() {
    const db = await getDatabase();
    return db.all<{ game_id: string; status: string; reason: string | null; message_ids: string | null }>(
        'SELECT game_id, status, reason, message_ids FROM run_recap_posts');
}

beforeEach(async () => {
    await setupTestDb();
    roomId = await createTestRoom('recap-room', 'Recap Room');
    tournamentId = await createTestTournament(roomId, { name: 'Daily Grind' });
    gameId = await createTestGame(tournamentId, { name: 'Pizza Time', status: 'COMPLETED', endDate: endedAgo(RECAP_POST_SETTLE_MS + 60_000) });
    const db = await getDatabase();
    await db.run('UPDATE tournaments SET discord_channel_id = ? WHERE id = ?', TEXT, tournamentId);
    await setSetting('DISCORD_RUN_RECAPS_ENABLED', 'true');
    _resetChannelTypeCacheForTests();
    getRunRecap.mockReset().mockResolvedValue({ players: [{ key: 'a' }] });
    post.mockReset().mockImplementation(async (route: string) => {
        if (route === Routes.threads(FORUM)) return { id: NEW_THREAD };
        return { id: 'msg-' + Math.random() };
    });
    get.mockReset().mockImplementation(async (route: string) => {
        if (route === Routes.channel(FORUM)) return { id: FORUM, type: 15 };
        if (route === Routes.channel(TEXT)) return { id: TEXT, type: 0 };
        if (route === Routes.channel(ROOM_TOURN)) return { id: ROOM_TOURN, type: 0 };
        if (route === Routes.channel(ROOM_RECAPS)) return { id: ROOM_RECAPS, type: 0 };
        if (route === Routes.channel(NEW_THREAD)) return { id: NEW_THREAD, type: 11 };
        throw new Error('unknown channel');
    });
});

describe('RunRecapPostService.sweep', () => {
    it('parser: on only for "true"', () => {
        expect(parseRunRecapsEnabled(undefined)).toBe(false);
        expect(parseRunRecapsEnabled('false')).toBe(false);
        expect(parseRunRecapsEnabled('true')).toBe(true);
    });

    it('off by default: no post and no ledger row', async () => {
        await setSetting('DISCORD_RUN_RECAPS_ENABLED', '');
        expect(await RunRecapPostService.sweep(NOW)).toEqual({ posted: 0, skipped: 0, failed: 0 });
        expect(post).not.toHaveBeenCalled();
        expect(await ledger()).toEqual([]);
    });

    it('on: posts every chunk with mentions disabled, then a second sweep is a no-op', async () => {
        expect(await RunRecapPostService.sweep(NOW)).toEqual({ posted: 1, skipped: 0, failed: 0 });
        expect(post).toHaveBeenCalledTimes(2);
        for (const call of post.mock.calls) {
            expect(call[1].body.allowed_mentions).toEqual({ parse: [] });
            expect(call[1].body.content.length).toBeLessThanOrEqual(2000);
        }
        const rows = await ledger();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ game_id: gameId, status: 'posted' });
        expect(JSON.parse(rows[0].message_ids!)).toHaveLength(2);
        post.mockClear();
        expect(await RunRecapPostService.sweep(NOW)).toEqual({ posted: 0, skipped: 0, failed: 0 });
        expect(post).not.toHaveBeenCalled();
    });

    it('concurrent sweeps send once', async () => {
        await Promise.all([RunRecapPostService.sweep(NOW), RunRecapPostService.sweep(NOW)]);
        expect(post).toHaveBeenCalledTimes(2); // one run, two chunks
        expect(await ledger()).toHaveLength(1);
    });

    it('settle and max-age bounds', async () => {
        const db = await getDatabase();
        await db.run('UPDATE games SET end_date = ? WHERE id = ?', endedAgo(RECAP_POST_SETTLE_MS - 60_000), gameId);
        await RunRecapPostService.sweep(NOW);
        expect(post).not.toHaveBeenCalled();
        await db.run('UPDATE games SET end_date = ? WHERE id = ?', endedAgo(RECAP_POST_MAX_AGE_MS + 60_000), gameId);
        await RunRecapPostService.sweep(NOW);
        expect(post).not.toHaveBeenCalled();
        expect(await ledger()).toEqual([]);
    });

    it('never an active, pinned or throwdown game', async () => {
        const db = await getDatabase();
        await db.run("UPDATE games SET status = 'ACTIVE' WHERE id = ?", gameId);
        await RunRecapPostService.sweep(NOW);
        expect(post).not.toHaveBeenCalled();
    });

    it("a 'none' recaps route skips the run", async () => {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET discord_announce_routes = ? WHERE id = ?',
            JSON.stringify({ version: 1, routes: { recaps: 'none' } }), tournamentId);
        expect(await RunRecapPostService.sweep(NOW)).toEqual({ posted: 0, skipped: 1, failed: 0 });
        expect(post).not.toHaveBeenCalled();
        expect(await ledger()).toMatchObject([{ status: 'skipped', reason: 'no_channel' }]);
    });

    it('no players -> skipped no_scores', async () => {
        getRunRecap.mockResolvedValue({ players: [] });
        expect(await RunRecapPostService.sweep(NOW)).toMatchObject({ skipped: 1 });
        expect(await ledger()).toMatchObject([{ status: 'skipped', reason: 'no_scores' }]);
    });

    it('room routes: recaps route, else the Tournament posts route', async () => {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET discord_channel_id = NULL WHERE id = ?', tournamentId);
        await setSetting('DISCORD_ANNOUNCE_ROUTES', JSON.stringify({ version: 1, routes: { tournament: ROOM_TOURN } }));
        await RunRecapPostService.sweep(NOW);
        expect(post.mock.calls[0][0]).toBe(Routes.channelMessages(ROOM_TOURN));

        await db.run('DELETE FROM run_recap_posts');
        post.mockClear();
        await setSetting('DISCORD_ANNOUNCE_ROUTES', JSON.stringify({ version: 1, routes: { tournament: ROOM_TOURN, recaps: ROOM_RECAPS } }));
        await RunRecapPostService.sweep(NOW);
        expect(post.mock.calls[0][0]).toBe(Routes.channelMessages(ROOM_RECAPS));
    });

    it('forum: one post titled "<game> · Arcaid Recap", the rest into its thread', async () => {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET discord_channel_id = ? WHERE id = ?', FORUM, tournamentId);
        await RunRecapPostService.sweep(NOW);
        expect(post.mock.calls[0][0]).toBe(Routes.threads(FORUM));
        expect(post.mock.calls[0][1].body.name).toBe('Pizza Time · Arcaid Recap');
        expect(post.mock.calls[1][0]).toBe(Routes.channelMessages(NEW_THREAD));
        expect(post.mock.calls[1][1].body.content).toBe('chunk two');
    });

    it('a failed send records failed and is not retried', async () => {
        post.mockReset().mockRejectedValue(new Error('boom'));
        expect(await RunRecapPostService.sweep(NOW)).toEqual({ posted: 0, skipped: 0, failed: 1 });
        expect(await ledger()).toMatchObject([{ status: 'failed', reason: 'send_failed' }]);
        post.mockClear();
        await RunRecapPostService.sweep(NOW);
        expect(post).not.toHaveBeenCalled();
    });
});
