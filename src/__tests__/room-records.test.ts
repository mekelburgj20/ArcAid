import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * Room records (B31.4): the cache is keyed by a watermark (score count, max id,
 * score sum, finished-game count/last end, recap-prefs version), stores ids only,
 * and names resolve after the cache read.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { PreferencesService } = await import('../services/PreferencesService.js');
const { RunRecapService } = await import('../services/RunRecapService.js');
const { SeasonRecapService, clearRoomRecordsCache } = await import('../services/SeasonRecapService.js');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = Date.parse('2026-11-01T15:00:00.000Z');
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const U1 = '111111111111111111';
const U2 = '222222222222222222';

async function appWith() {
    const app = express();
    app.use(express.json());
    const { default: recapsRouter } = await import('../api/routes/recaps.js');
    app.use('/api', recapsRouter);
    return app;
}

async function addScore(roomId: string, tId: string, name: string, user: string, userId: string, score: number, ms: number): Promise<number> {
    const db = await getDatabase();
    const res = await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, submitted_by_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, platform, engine, device, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'vpx', ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        name, roomId, user, userId, userId, score, roomId, tId, sqliteTs(ms),
    );
    return res.lastID as number;
}

/** One finished run: Ann plays 12 games in one session (a streak and the most games), Bob plays 3. */
async function seed() {
    const roomId = await createTestRoom(`r-${crypto.randomUUID().slice(0, 8)}`);
    const tId = await createTestTournament(roomId, { name: 'Weekly' });
    await createTestGame(tId, { name: 'Alpha', status: 'COMPLETED', startDate: new Date(BASE - 60 * MIN).toISOString(), endDate: new Date(BASE + 2 * DAY).toISOString() });
    const ids: number[] = [];
    for (let i = 0; i < 12; i++) ids.push(await addScore(roomId, tId, 'Alpha', 'Ann', U1, 1000 + i * 10, BASE + i * 5 * MIN));
    for (let i = 0; i < 3; i++) ids.push(await addScore(roomId, tId, 'Alpha', 'Bob', U2, 900 + i * 10, BASE + 2 * MIN + i * 5 * MIN));
    return { roomId, tId, ids };
}

beforeEach(async () => { await setupTestDb(); clearRoomRecordsCache(); });

describe('GET /rooms/:roomId/stats/records', () => {
    it('lists the records with their run links, names resolved at read', async () => {
        const app = await appWith();
        const f = await seed();
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Annie')`, U1);
        const res = await request(app).get(`/api/rooms/${f.roomId}/stats/records`);
        expect(res.status).toBe(200);
        const byId = Object.fromEntries(res.body.records.map((r: { id: string }) => [r.id, r]));
        expect(byId.longest_streak).toMatchObject({ player_keys: [U1], value: 12 });
        expect(byId.most_games_in_run).toMatchObject({ player_keys: [U1], value: 12 });
        expect(byId.longest_streak.run).toMatchObject({ game_name: 'Alpha', tournament_id: f.tId });
        expect(res.body.players.find((p: { key: string }) => p.key === U1)).toMatchObject({ display_name: 'Annie', iscored_username: 'Ann' });
    });

    it('reuses the cache while nothing changed, and drops it on a delete, a correction and an opt-out', async () => {
        const f = await seed();
        const spy = vi.spyOn(RunRecapService, 'summarizeRuns');
        const db = await getDatabase();

        await SeasonRecapService.roomRecords(f.roomId);
        await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(1);

        // A name change is not in the watermark and never needs a recompute.
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Annie')`, U1);
        const named = await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(1);
        expect(named.players.find(p => p.key === U1)?.display_name).toBe('Annie');

        // A correction changes SUM(score).
        await db.run('UPDATE score_history SET score = score + 1 WHERE id = ?', f.ids[0]);
        await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(2);

        // A delete changes COUNT(*).
        await db.run('DELETE FROM score_history WHERE id = ?', f.ids[1]);
        const afterDelete = await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(3);
        expect(afterDelete.records.find(r => r.id === 'longest_streak')?.value).toBe(11);

        // An opt-out bumps the prefs version: the opted-out player leaves every record.
        await PreferencesService.setRecapPlayStats(U1, false);
        const afterOptOut = await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(4);
        expect(afterOptOut.records.find(r => r.id === 'longest_streak')).toBeUndefined();
        expect(afterOptOut.records.find(r => r.id === 'most_games_in_run')).toBeUndefined();
        spy.mockRestore();
    });

    it('a room with no finished runs answers an empty list', async () => {
        const app = await appWith();
        const roomId = await createTestRoom(`r-${crypto.randomUUID().slice(0, 8)}`);
        const res = await request(app).get(`/api/rooms/${roomId}/stats/records`);
        expect(res.status).toBe(200);
        expect(res.body.records).toEqual([]);
    });
});
