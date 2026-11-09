import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { signToken } from '../api/auth.js';
import { PreferencesService, PINNED_PILES_MAX } from '../services/PreferencesService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { SetPilePinnedSchema } from '../api/schemas.js';
import { getDatabase } from '../database/database.js';

/**
 * v2.236.0 (B23) — the public board stacks a tournament's retained COMPLETED
 * cards into one "past games" pile under its live card. A viewer can pin a
 * pile open, and that choice is remembered for the USER (not the device):
 * `scoreboard_prefs.pinnedPiles`, a list of tournament ids beside the device
 * blobs and `roomThemes`.
 *
 * What these tests hold:
 *   1. pins round-trip, unpin removes, re-pin moves to the newest end, cap;
 *   2. a pin write and the two older writers (device prefs, room theme)
 *      cannot clobber each other in either direction;
 *   3. the board ships the grouping key (`tournamentId`) and the recency key
 *      (`endedAt`, COMPLETED cards only) the pile needs.
 */

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

async function rawBlob(discordUserId: string): Promise<Record<string, unknown>> {
    const db = await getDatabase();
    const row = await db.get('SELECT scoreboard_prefs FROM user_preferences WHERE discord_user_id = ?', discordUserId);
    return JSON.parse(row?.scoreboard_prefs ?? '{}');
}

describe('SetPilePinnedSchema', () => {
    it('accepts a boolean and rejects anything else', () => {
        expect(SetPilePinnedSchema.safeParse({ pinned: true }).success).toBe(true);
        expect(SetPilePinnedSchema.safeParse({ pinned: false }).success).toBe(true);
        expect(SetPilePinnedSchema.safeParse({ pinned: 'yes' }).success).toBe(false);
        expect(SetPilePinnedSchema.safeParse({}).success).toBe(false);
    });
});

describe('PreferencesService pinned piles', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('is empty for a user who never pinned one', async () => {
        expect(await PreferencesService.getPinnedPiles('pp-1')).toEqual([]);
    });

    it('pins, unpins, and moves a re-pin to the newest end', async () => {
        await PreferencesService.setPilePinned('pp-2', 't-a', true);
        await PreferencesService.setPilePinned('pp-2', 't-b', true);
        expect(await PreferencesService.getPinnedPiles('pp-2')).toEqual(['t-a', 't-b']);

        await PreferencesService.setPilePinned('pp-2', 't-a', true);
        expect(await PreferencesService.getPinnedPiles('pp-2')).toEqual(['t-b', 't-a']);

        await PreferencesService.setPilePinned('pp-2', 't-b', false);
        expect(await PreferencesService.getPinnedPiles('pp-2')).toEqual(['t-a']);

        // Unpinning something that was never pinned is a no-op, not an error.
        await PreferencesService.setPilePinned('pp-2', 't-zzz', false);
        expect(await PreferencesService.getPinnedPiles('pp-2')).toEqual(['t-a']);
    });

    it('caps the list, dropping the pins touched longest ago', async () => {
        const db = await getDatabase();
        const full = Array.from({ length: PINNED_PILES_MAX }, (_, i) => `t-${i}`);
        await db.run(
            'INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)',
            'pp-3', JSON.stringify({ desktop: {}, mobile: {}, roomThemes: {}, pinnedPiles: full }),
        );
        const after = await PreferencesService.setPilePinned('pp-3', 't-new', true);
        expect(after).toHaveLength(PINNED_PILES_MAX);
        expect(after[0]).toBe('t-1');
        expect(after[after.length - 1]).toBe('t-new');
    });

    it('drops junk stored directly in the list', async () => {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_preferences (discord_user_id, scoreboard_prefs) VALUES (?, ?)',
            'pp-4', JSON.stringify({ desktop: {}, mobile: {}, pinnedPiles: ['t-a', 7, '', '  ', null, 't-a', 'x'.repeat(101), 't-b'] }),
        );
        expect(await PreferencesService.getPinnedPiles('pp-4')).toEqual(['t-a', 't-b']);
    });

    it('a device-pref save (incl. Reset All) keeps the pins', async () => {
        await PreferencesService.setPilePinned('pp-5', 't-a', true);
        await PreferencesService.setScoreboardPrefs('pp-5', { SCOREBOARD_STYLE: 'banner' }, 'desktop');
        await PreferencesService.setScoreboardPrefs('pp-5', { SCOREBOARD_STYLE: null as unknown as string }, 'desktop');
        expect(await PreferencesService.getPinnedPiles('pp-5')).toEqual(['t-a']);
    });

    it('a room-theme save keeps the pins, and a pin keeps the room theme and device prefs', async () => {
        await PreferencesService.setScoreboardPrefs('pp-6', { SCOREBOARD_STYLE: 'minimal' }, 'mobile');
        await PreferencesService.setRoomTheme('pp-6', 'room-a', 'plasma');
        await PreferencesService.setPilePinned('pp-6', 't-a', true);
        await PreferencesService.setRoomTheme('pp-6', 'room-b', 'midnight');

        const blob = await rawBlob('pp-6');
        expect(blob.pinnedPiles).toEqual(['t-a']);
        expect(blob.roomThemes).toEqual({ 'room-a': 'plasma', 'room-b': 'midnight' });
        expect(blob.mobile).toEqual({ SCOREBOARD_STYLE: 'minimal' });
    });

    it('refuses an empty or oversized id', async () => {
        await expect(PreferencesService.setPilePinned('pp-7', '   ', true)).rejects.toThrow();
        await expect(PreferencesService.setPilePinned('pp-7', 'x'.repeat(101), true)).rejects.toThrow();
    });
});

describe('GET/PUT /api/me/pinned-piles', () => {
    async function createApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    it('requires a signed-in player', async () => {
        const app = await createApp();
        expect((await request(app).get('/api/me/pinned-piles')).status).toBe(401);
        expect((await request(app).put('/api/me/pinned-piles/t-a').send({ pinned: true })).status).toBe(401);
    }, 30000);

    it('round-trips a pin and an unpin', async () => {
        const app = await createApp();
        const token = playerToken('pp-api-1');

        expect((await request(app).get('/api/me/pinned-piles').set('Authorization', `Bearer ${token}`)).body)
            .toEqual({ pinnedPiles: [] });

        const pin = await request(app)
            .put('/api/me/pinned-piles/t-a')
            .set('Authorization', `Bearer ${token}`)
            .send({ pinned: true });
        expect(pin.status).toBe(200);
        expect(pin.body).toEqual({ pinnedPiles: ['t-a'] });

        const unpin = await request(app)
            .put('/api/me/pinned-piles/t-a')
            .set('Authorization', `Bearer ${token}`)
            .send({ pinned: false });
        expect(unpin.body).toEqual({ pinnedPiles: [] });
    }, 30000);

    it('rejects a body without a boolean with 400', async () => {
        const app = await createApp();
        const res = await request(app)
            .put('/api/me/pinned-piles/t-a')
            .set('Authorization', `Bearer ${playerToken('pp-api-2')}`)
            .send({ pinned: 'please' });
        expect(res.status).toBe(400);
    }, 30000);
});

describe('room board carries the pile keys', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('ships tournamentId on every tournament card and endedAt on COMPLETED cards only', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tid = await createTestTournament(roomId, { name: 'Daily Grind' });
        await db.run('UPDATE tournaments SET cleanup_rule = ? WHERE id = ?',
            JSON.stringify({ mode: 'retain', count: 3 }), tid);
        const live = await createTestGame(tid, { name: 'Monster Bash' });
        const ended = new Date(2026, 10, 3, 22).toISOString();
        const old = await createTestGame(tid, { name: 'Darius', status: 'COMPLETED', endDate: ended });

        const boards = await LeaderboardService.getActiveLeaderboards(roomId);
        const byId = new Map(boards.map(b => [b.gameId, b]));
        expect(byId.get(live)).toMatchObject({ tournamentId: tid, endedAt: null, gameStatus: 'ACTIVE' });
        expect(byId.get(old)).toMatchObject({ tournamentId: tid, endedAt: ended, gameStatus: 'COMPLETED' });
    });
});
