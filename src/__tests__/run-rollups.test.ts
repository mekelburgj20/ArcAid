import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * Run roll-ups (B31.3): a player's runs and a table's runs, both reduced from
 * RunRecapService.summarizeRuns. Privacy is applied server-side.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { PreferencesService } = await import('../services/PreferencesService.js');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = Date.parse('2026-11-01T15:00:00.000Z');
const RERUN = BASE + 10 * DAY;
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

async function addScore(roomId: string, tId: string, name: string, user: string, userId: string | null, score: number, ms: number, source = 'vpx') {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, submitted_by_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, platform, engine, device, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        name, roomId, user, userId ?? 'SYSTEM', userId, score, source, roomId, tId, sqliteTs(ms),
    );
}

interface Fx { roomId: string; tId: string; runA: string; runB: string }

/** One tournament, the table "Godzilla" run twice (two windows), plus an active "Aliens". */
async function seed(): Promise<Fx> {
    const roomId = await createTestRoom(`r-${crypto.randomUUID().slice(0, 8)}`);
    const tId = await createTestTournament(roomId, { name: 'Weekly' });
    const runA = await createTestGame(tId, {
        name: 'Godzilla', status: 'COMPLETED',
        startDate: new Date(BASE - 60 * MIN).toISOString(), endDate: new Date(BASE + 2 * DAY).toISOString(),
    });
    const runB = await createTestGame(tId, {
        name: 'Godzilla', status: 'COMPLETED',
        startDate: new Date(RERUN - 60 * MIN).toISOString(), endDate: new Date(RERUN + 2 * DAY).toISOString(),
    });
    await createTestGame(tId, { name: 'Aliens', status: 'ACTIVE', startDate: new Date(BASE + 20 * DAY).toISOString() });
    // Run A: Ann 4 games (best 1300), Bob 2 games (best 900), Cy typed 500.
    for (let i = 0; i < 4; i++) await addScore(roomId, tId, 'Godzilla', 'Ann', U1, 1000 + i * 100, BASE + i * 5 * MIN);
    for (let i = 0; i < 2; i++) await addScore(roomId, tId, 'Godzilla', 'Bob', U2, 800 + i * 100, BASE + 2 * MIN + i * 5 * MIN);
    await addScore(roomId, tId, 'Godzilla', 'Cy', null, 500, BASE + 60 * MIN, 'community');
    // Run B (re-run): Bob 3 games (best 2200), Ann 1 game (1500).
    for (let i = 0; i < 3; i++) await addScore(roomId, tId, 'Godzilla', 'Bob', U2, 2000 + i * 100, RERUN + i * 5 * MIN);
    await addScore(roomId, tId, 'Godzilla', 'Ann', U1, 1500, RERUN + 3 * MIN);
    return { roomId, tId, runA, runB };
}

beforeEach(async () => { await setupTestDb(); });

describe('GET /rooms/:roomId/players/:identifier/runs', () => {
    it('finds runs by provider id, newest first, with finish and field', async () => {
        const app = await appWith();
        const fx = await seed();
        const res = await request(app).get(`/api/rooms/${fx.roomId}/players/${U1}/runs`);
        expect(res.status).toBe(200);
        expect(res.body.play_stats).toBe('shown');
        expect(res.body.player).toMatchObject({ iscored_username: 'Ann' });
        expect(res.body.runs.map((r: { game_id: string }) => r.game_id)).toEqual([fx.runB, fx.runA]);
        expect(res.body.runs[0]).toMatchObject({ best: 1500, finish: 2, field: 2, games: 1 });
        expect(res.body.runs[1]).toMatchObject({ best: 1300, finish: 1, field: 3, games: 4, game_name: 'Godzilla' });
        expect(res.body.runs[1].average).toBe(1150);
        expect(res.body.runs[1].best_game_no).toBe(4);
    });

    it('finds a player by name through the alias, and by the bare iScored name', async () => {
        const app = await appWith();
        const fx = await seed();
        const db = await getDatabase();
        await db.run(`INSERT INTO user_mappings (iscored_username, discord_user_id) VALUES ('Ann', ?)`, U1);
        const byName = await request(app).get(`/api/rooms/${fx.roomId}/players/${encodeURIComponent('ann')}/runs`);
        expect(byName.body.runs).toHaveLength(2);
        const bare = await request(app).get(`/api/rooms/${fx.roomId}/players/Cy/runs`);
        expect(bare.body.runs).toHaveLength(1);
        // Typed only: no games, a best and a finish.
        expect(bare.body.runs[0]).toMatchObject({ games: null, best: 500, finish: 3, field: 3 });
    });

    it('answers an empty list and a null player for a stranger', async () => {
        const app = await appWith();
        const fx = await seed();
        const res = await request(app).get(`/api/rooms/${fx.roomId}/players/Nobody/runs`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ player: null, play_stats: 'shown', runs: [] });
    });

    it('puts null on games, average and best_game_no for a hidden player', async () => {
        const app = await appWith();
        const fx = await seed();
        await PreferencesService.setRecapPlayStats(U1, false);
        const res = await request(app).get(`/api/rooms/${fx.roomId}/players/${U1}/runs`);
        expect(res.body.play_stats).toBe('hidden');
        for (const r of res.body.runs) {
            expect(r.games).toBeNull();
            expect(r.average).toBeNull();
            expect(r.best_game_no).toBeNull();
        }
        expect(res.body.runs[1]).toMatchObject({ best: 1300, finish: 1, field: 3 });
    });
});

describe('GET /rooms/:roomId/tables/:gameName/runs', () => {
    it('counts completed runs only, with medians over visible games and the busiest run', async () => {
        const app = await appWith();
        const fx = await seed();
        const res = await request(app).get(`/api/rooms/${fx.roomId}/tables/${encodeURIComponent('godzilla')}/runs`);
        expect(res.status).toBe(200);
        expect(res.body.runs).toBe(2);
        expect(res.body.game_name).toBe('Godzilla');
        // Winning scores 1300 and 2200 -> 1750.
        expect(res.body.typical_winning_score).toBe(1750);
        // Witness games: 1000,1100,1200,1300, 800,900, 2000,2100,2200, 1500 -> median of 10 = (1200+1300)/2.
        expect(res.body.median_game).toBe(1250);
        expect(res.body.most_games_in_run).toMatchObject({ games: 4, game_id: fx.runA, player: { iscored_username: 'Ann' } });
        expect(res.body.recent.map((r: { game_id: string }) => r.game_id)).toEqual([fx.runB, fx.runA]);
        expect(res.body.recent[0]).toMatchObject({ winning_score: 2200, players: 2, witness_games: 4 });
        expect(res.body.recent[0].winner.iscored_username).toBe('Bob');
    });

    it('leaves a hidden player out of the medians and the busiest run', async () => {
        const app = await appWith();
        const fx = await seed();
        await PreferencesService.setRecapPlayStats(U1, false);
        const res = await request(app).get(`/api/rooms/${fx.roomId}/tables/Godzilla/runs`);
        // Only Bob's five games: 800,900,2000,2100,2200 -> 2000.
        expect(res.body.median_game).toBe(2000);
        expect(res.body.most_games_in_run).toMatchObject({ games: 3, game_id: fx.runB, player: { iscored_username: 'Bob' } });
        // Standings facts stay.
        expect(res.body.typical_winning_score).toBe(1750);
    });

    it('is empty for a table with only an active run', async () => {
        const app = await appWith();
        const fx = await seed();
        const res = await request(app).get(`/api/rooms/${fx.roomId}/tables/Aliens/runs`);
        expect(res.body).toMatchObject({ runs: 0, typical_winning_score: null, median_game: null, most_games_in_run: null, recent: [] });
    });
});
