import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * B31 integration review fixes: identity changes invalidate the room-records cache,
 * route params are not double-decoded, ASCII-only lowercasing agrees with SQLite,
 * and summarizeRuns({keys}) pre-selects runs.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { RunRecapService } = await import('../services/RunRecapService.js');
const { RunRollupService } = await import('../services/RunRollupService.js');
const { IdentityLinkService } = await import('../services/IdentityLinkService.js');
const { IdentityAliasEffectsService } = await import('../services/IdentityAliasEffectsService.js');
const { SeasonRecapService, clearRoomRecordsCache } = await import('../services/SeasonRecapService.js');
const { sqliteLower } = await import('../utils/sqliteLower.js');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = Date.parse('2026-11-01T15:00:00.000Z');
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const U1 = '111111111111111111';
const U2 = '222222222222222222';
const G1 = 'google:hidden-1';

async function appWith() {
    const app = express();
    app.use(express.json());
    const { default: recapsRouter } = await import('../api/routes/recaps.js');
    app.use('/api', recapsRouter);
    return app;
}

async function addScore(roomId: string, tId: string, game: string, user: string, userId: string | null, score: number, ms: number) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, submitted_by_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, platform, engine, device, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, 'vpx', ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        game, roomId, user, userId ?? 'SYSTEM', userId, score, roomId, tId, sqliteTs(ms),
    );
}

async function run(tId: string, name: string, offsetDays = 0) {
    return createTestGame(tId, {
        name, status: 'COMPLETED',
        startDate: new Date(BASE + offsetDays * DAY - 60 * MIN).toISOString(),
        endDate: new Date(BASE + offsetDays * DAY + 2 * DAY).toISOString(),
    });
}

const newRoom = () => createTestRoom(`r-${crypto.randomUUID().slice(0, 8)}`);

beforeEach(async () => { await setupTestDb(); clearRoomRecordsCache(); });

describe('room records cache sees identity changes', () => {
    async function seedRecords() {
        const roomId = await newRoom();
        const tId = await createTestTournament(roomId, { name: 'Weekly' });
        await run(tId, 'Alpha');
        for (let i = 0; i < 12; i++) await addScore(roomId, tId, 'Alpha', 'Ann', U1, 1000 + i * 10, BASE + i * 5 * MIN);
        for (let i = 0; i < 3; i++) await addScore(roomId, tId, 'Alpha', 'Bob', U2, 900 + i * 10, BASE + 2 * MIN + i * 5 * MIN);
        return { roomId, tId };
    }

    it('linking a hidden google account into the record holder drops their records', async () => {
        const f = await seedRecords();
        const db = await getDatabase();
        await db.run('INSERT INTO user_preferences (discord_user_id, recap_play_stats) VALUES (?, 0)', G1);
        const before = await SeasonRecapService.roomRecords(f.roomId);
        expect(before.records.find(r => r.id === 'longest_streak')?.player_keys).toEqual([U1]);

        await IdentityLinkService.createLink(G1, U1);
        const after = await SeasonRecapService.roomRecords(f.roomId);
        expect(after.records.find(r => r.id === 'longest_streak')).toBeUndefined();
        expect(after.records.find(r => r.id === 'most_games_in_run')).toBeUndefined();
    });

    it('unlinking and alias link/unlink each invalidate the cache', async () => {
        const f = await seedRecords();
        const spy = vi.spyOn(RunRecapService, 'summarizeRuns');
        await SeasonRecapService.roomRecords(f.roomId);
        await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(1);

        await IdentityAliasEffectsService.onAliasLinked(U1, 'Ann', { skipHydration: true });
        await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(2);

        await IdentityAliasEffectsService.onAliasUnlinked(U1, 'Ann');
        await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(3);

        const db = await getDatabase();
        await db.run('INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)', G1, U1);
        await IdentityLinkService.deleteLink(G1);
        await SeasonRecapService.roomRecords(f.roomId);
        expect(spy).toHaveBeenCalledTimes(4);
        spy.mockRestore();
    });
});

describe('route params are decoded once (Express 5 already did)', () => {
    it('serves a table named "100% Pin" and one containing "%41"', async () => {
        const app = await appWith();
        const roomId = await newRoom();
        const tId = await createTestTournament(roomId, { name: 'Weekly' });
        await run(tId, '100% Pin', 0);
        await run(tId, 'Cat %41 Mouse', 20);
        await addScore(roomId, tId, '100% Pin', 'Ann', U1, 1000, BASE);
        await addScore(roomId, tId, 'Cat %41 Mouse', 'Ann', U1, 2000, BASE + 20 * DAY);

        const a = await request(app).get(`/api/rooms/${roomId}/tables/${encodeURIComponent('100% Pin')}/runs`);
        expect(a.status).toBe(200);
        expect(a.body.game_name).toBe('100% Pin');
        expect(a.body.runs).toBe(1);
        const b = await request(app).get(`/api/rooms/${roomId}/tables/${encodeURIComponent('Cat %41 Mouse')}/runs`);
        expect(b.status).toBe(200);
        expect(b.body.game_name).toBe('Cat %41 Mouse');
        expect(b.body.runs).toBe(1);
    });

    it('serves a player whose name has a percent sign', async () => {
        const app = await appWith();
        const roomId = await newRoom();
        const tId = await createTestTournament(roomId, { name: 'Weekly' });
        await run(tId, 'Alpha');
        await addScore(roomId, tId, 'Alpha', '100%Ann', null, 1000, BASE);
        const res = await request(app).get(`/api/rooms/${roomId}/players/${encodeURIComponent('100%Ann')}/runs`);
        expect(res.status).toBe(200);
        expect(res.body.runs).toHaveLength(1);
    });
});

describe('ASCII-only lowercasing matches SQLite LOWER()', () => {
    it('sqliteLower folds A-Z only', () => {
        expect(sqliteLower('ÉRIC Smith')).toBe('Éric smith');
    });

    it('playerRuns finds a non-ASCII synthetic player', async () => {
        const roomId = await newRoom();
        const tId = await createTestTournament(roomId, { name: 'Weekly' });
        await run(tId, 'Alpha');
        await addScore(roomId, tId, 'Alpha', 'ÉRIC', null, 1000, BASE);
        const out = await RunRollupService.playerRuns(roomId, 'ÉRIC');
        expect(out.runs).toHaveLength(1);
    });
});

describe('summarizeRuns({keys}) pre-selects runs', () => {
    it('returns only runs the key played, each computed from all of its rows', async () => {
        const roomId = await newRoom();
        const tId = await createTestTournament(roomId, { name: 'Weekly' });
        const rA = await run(tId, 'Alpha', 0);
        await run(tId, 'Beta', 20);
        await addScore(roomId, tId, 'Alpha', 'Ann', U1, 1000, BASE);
        await addScore(roomId, tId, 'Alpha', 'Bob', U2, 2000, BASE + MIN);
        await addScore(roomId, tId, 'Beta', 'Bob', U2, 500, BASE + 20 * DAY);
        const out = await RunRecapService.summarizeRuns(roomId, { keys: [U1] });
        expect(out.runs.map(r => r.run.game_id)).toEqual([rA]);
        expect(out.runs[0]!.recap.players.map(p => p.key).sort()).toEqual([U1, U2].sort());
    });
});
