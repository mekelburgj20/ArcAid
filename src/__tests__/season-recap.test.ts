import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * Season recap (B31.4): a tournament's "By the numbers" reduces the bulk run
 * summaries. Opt-outs never win a volume award and never count in a total.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { PreferencesService } = await import('../services/PreferencesService.js');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BASE = Date.parse('2026-11-01T15:00:00.000Z');
const sqliteTs = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);
const U1 = '111111111111111111';
const U2 = '222222222222222222';
const U3 = '333333333333333333';

async function appWith() {
    const app = express();
    app.use(express.json());
    const { default: recapsRouter } = await import('../api/routes/recaps.js');
    app.use('/api', recapsRouter);
    return app;
}

async function addScore(o: { roomId: string; tId: string; name: string; user: string; userId: string; score: number; ms: number; source?: string }) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, submitted_by_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, platform, engine, device, created_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        o.name, o.roomId, o.user, o.userId, o.userId, o.score, o.source ?? 'vpx', o.roomId, o.tId, sqliteTs(o.ms),
    );
}

/** Three finished runs: Ann wins two (six Witness games each), Bob wins one; Cy only plays two tables, typed. */
async function seedSeason() {
    const roomId = await createTestRoom(`r-${crypto.randomUUID().slice(0, 8)}`);
    const tId = await createTestTournament(roomId, { name: 'Season 6' });
    const winners = [U1, U1, U2];
    const tables = ['Alpha', 'Bravo', 'Charlie'];
    for (let r = 0; r < 3; r++) {
        const start = BASE + r * 3 * DAY;
        await createTestGame(tId, {
            name: tables[r]!, status: 'COMPLETED', startDate: new Date(start - 60 * MIN).toISOString(), endDate: new Date(start + 2 * DAY).toISOString(),
        });
        const annTop = winners[r] === U1 ? 2000 : 900;
        const bobTop = winners[r] === U2 ? 2000 : 1000;
        for (let i = 0; i < 6; i++) await addScore({ roomId, tId, name: tables[r]!, user: 'Ann', userId: U1, score: annTop - (5 - i) * 10, ms: start + i * 5 * MIN });
        for (let i = 0; i < 3; i++) await addScore({ roomId, tId, name: tables[r]!, user: 'Bob', userId: U2, score: bobTop - (2 - i) * 10, ms: start + 2 * MIN + i * 5 * MIN });
        if (r < 2) await addScore({ roomId, tId, name: tables[r]!, user: 'Cy', userId: U3, score: 300, ms: start + 90 * MIN, source: 'community' });
    }
    return { roomId, tId };
}

const url = (f: { roomId: string; tId: string }) => `/api/rooms/${f.roomId}/tournaments/${f.tId}/recap`;

beforeEach(async () => { await setupTestDb(); });

describe('GET /rooms/:roomId/tournaments/:tournamentId/recap', () => {
    it('404s for another room or an unknown tournament', async () => {
        const app = await appWith();
        const f = await seedSeason();
        const other = await createTestRoom('other-room');
        expect((await request(app).get(`/api/rooms/${other}/tournaments/${f.tId}/recap`)).status).toBe(404);
        expect((await request(app).get(`/api/rooms/${f.roomId}/tournaments/nope/recap`)).status).toBe(404);
    });

    it('tallies runs, podiums and games, and names the season awards', async () => {
        const app = await appWith();
        const f = await seedSeason();
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Annie')`, U1);
        const res = await request(app).get(url(f));
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ runs: 3, live_runs: 0 });
        const ann = res.body.standings.find((s: { player_key: string }) => s.player_key === U1);
        expect(ann).toMatchObject({ runs_played: 3, runs_won: 2, podiums: 3, games: 18 });
        expect(res.body.standings[0].player_key).toBe(U1);
        const byId = Object.fromEntries(res.body.awards.map((a: { id: string }) => [a.id, a]));
        expect(byId.most_runs_won).toMatchObject({ player_keys: [U1], value: 2 });
        expect(byId.most_games).toMatchObject({ player_keys: [U1], value: 18 });
        // Ann and Bob are in all three runs (Cy missed one).
        expect(byId.played_every_table.player_keys.sort()).toEqual([U1, U2].sort());
        expect(byId.closest_finish.run).toMatchObject({ tournament_id: f.tId });
        expect(byId.closest_finish.detail).toMatch(/% between first and second/);
        expect(res.body.players.find((p: { key: string }) => p.key === U1)).toMatchObject({ display_name: 'Annie', iscored_username: 'Ann' });
        // Details never carry a name.
        for (const a of res.body.awards) expect(a.detail).not.toMatch(/Ann|Bob|Cy/);
    });

    it('an opted-out player wins no volume award and their games leave every total', async () => {
        const app = await appWith();
        const f = await seedSeason();
        await PreferencesService.setRecapPlayStats(U1, false);
        const res = await request(app).get(url(f));
        const ann = res.body.standings.find((s: { player_key: string }) => s.player_key === U1);
        expect(ann).toMatchObject({ runs_won: 2, games: null });
        // Bob has 9 shown games: under the minimum of 10, so nobody wins it.
        expect(res.body.awards.find((a: { id: string }) => a.id === 'most_games')).toBeUndefined();
        const total = res.body.standings.reduce((n: number, s: { games: number | null }) => n + (s.games ?? 0), 0);
        expect(total).toBe(9);
    });

    it('a tournament with no runs answers empty lists', async () => {
        const app = await appWith();
        const roomId = await createTestRoom(`r-${crypto.randomUUID().slice(0, 8)}`);
        const tId = await createTestTournament(roomId, { name: 'Empty' });
        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tId}/recap`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ runs: 0, live_runs: 0, standings: [], awards: [] });
    });
});
