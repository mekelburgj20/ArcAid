import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';

/**
 * Run recaps (B31.1): the three public routes and the service behind them.
 * Rotation rows are exactly the run board's rows; an event round's are the round
 * board's; privacy is applied server-side; nothing is cached.
 */

const { setupTestDb, createTestRoom, createTestTournament, createTestGame } = await import('./helpers.js');
const { getDatabase } = await import('../database/database.js');
const { EventService } = await import('../services/EventService.js');
const { LeaderboardService } = await import('../services/LeaderboardService.js');
const { PreferencesService } = await import('../services/PreferencesService.js');

const MIN = 60_000;
const BASE = Date.parse('2026-11-20T15:00:00.000Z');
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

async function addScore(o: {
    roomId: string; tournamentId: string | null; name: string; user: string; userId: string | null; score: number;
    ms: number; source?: string; gameId?: string | null;
}): Promise<number> {
    const db = await getDatabase();
    const res = await db.run(
        `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, submitted_by_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, platform, engine, device, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'vpx', 'vpx', 'pc', ?)`,
        o.name, o.roomId, o.gameId ?? null, o.user, o.userId ?? 'SYSTEM', o.userId, o.score, o.source ?? 'vpx',
        o.roomId, o.tournamentId, sqliteTs(o.ms),
    );
    return res.lastID as number;
}

interface Fx { roomId: string; tId: string; gameId: string }

async function rotation(over: { status?: string; start?: number } = {}): Promise<Fx> {
    const roomId = await createTestRoom(`r-${crypto.randomUUID().slice(0, 8)}`);
    const tId = await createTestTournament(roomId, { name: 'Weekly' });
    const gameId = await createTestGame(tId, {
        name: 'Godzilla', status: over.status ?? 'COMPLETED', startDate: new Date(over.start ?? BASE - 60 * MIN).toISOString(),
        endDate: over.status === 'ACTIVE' ? undefined : new Date(BASE + 2 * 24 * 60 * MIN).toISOString(),
    });
    return { roomId, tId, gameId };
}

/** Three players: U1 six Witness games + a typed best, U2 four games, U3 typed only. */
async function seedBoard(fx: Fx) {
    for (let i = 0; i < 6; i++) await addScore({ ...base(fx), user: 'Ann', userId: U1, score: 1000 + i * 100, ms: BASE + i * 5 * MIN });
    for (let i = 0; i < 4; i++) await addScore({ ...base(fx), user: 'Bob', userId: U2, score: 800 + i * 150, ms: BASE + 2 * MIN + i * 5 * MIN });
    await addScore({ ...base(fx), user: 'Cy', userId: U3, score: 300, ms: BASE + 90 * MIN, source: 'community' });
}
const base = (fx: Fx) => ({ roomId: fx.roomId, tournamentId: fx.tId, name: 'Godzilla' });

const url = (fx: Fx, tail = '') => `/api/rooms/${fx.roomId}/runs/${fx.gameId}/recap${tail}`;

beforeEach(async () => { await setupTestDb(); });

describe('GET /rooms/:roomId/runs/:gameId/recap', () => {
    it('404s for a wrong room, a pinned board, a queued game and an unknown game', async () => {
        const app = await appWith();
        const fx = await rotation();
        const other = await createTestRoom('other-room');
        expect((await request(app).get(`/api/rooms/${other}/runs/${fx.gameId}/recap`)).status).toBe(404);
        expect((await request(app).get(`/api/rooms/${fx.roomId}/runs/nope/recap`)).status).toBe(404);

        const db = await getDatabase();
        const pinned = crypto.randomUUID();
        await db.run(`INSERT INTO games (id, tournament_id, name, status, game_room_id) VALUES (?, NULL, 'Pinned', 'ACTIVE', ?)`, pinned, fx.roomId);
        expect((await request(app).get(`/api/rooms/${fx.roomId}/runs/${pinned}/recap`)).status).toBe(404);

        const queued = await createTestGame(fx.tId, { name: 'Later', status: 'QUEUED' });
        expect((await request(app).get(`/api/rooms/${fx.roomId}/runs/${queued}/recap`)).status).toBe(404);
    });

    it('ranks like the board, with names resolved at read, and ids never in the text', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        const db = await getDatabase();
        await db.run(`INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Annie')`, U1);

        const res = await request(app).get(url(fx));
        expect(res.status).toBe(200);
        const standings = (await LeaderboardService.getRunStandings([fx.gameId])).get(fx.gameId)!;
        expect(res.body.players.map((p: { rank: number; best: number }) => [p.rank, p.best]))
            .toEqual(standings.map(s => [s.rank, s.score]));
        expect(res.body.players[0]).toMatchObject({ display_name: 'Annie', iscored_username: 'Ann', best: 1500, games: 6, play_stats: 'shown' });
        expect(res.body.totals).toMatchObject({ players: 3, witness_games: 10, witness_players: 2, other_only_players: 1 });
        expect(res.body.run).toMatchObject({ state: 'completed', format: 'rotation', game_name: 'Godzilla' });
        expect(res.body.discord_text).toContain('Annie');
        expect(res.body.discord_text).not.toContain(U1);
        expect(res.body.discord_text).toContain('recap=1');
        expect(res.body.version).toBe(1);
    });

    it('answers an active run as "active" with no wins_it', async () => {
        const app = await appWith();
        const fx = await rotation({ status: 'ACTIVE' });
        await seedBoard(fx);
        const res = await request(app).get(url(fx));
        expect(res.body.run.state).toBe('active');
        expect(res.body.lead_changes.every((c: { wins_it: boolean }) => c.wins_it === false)).toBe(true);
        expect(res.body.discord_text).toContain('so far');
    });

    it('a re-run of the table: each recap holds only its own window', async () => {
        const app = await appWith();
        const fx = await rotation({ start: BASE - 60 * MIN });
        await seedBoard(fx);
        // Second run of the same table in the same tournament, started two days later.
        const second = await createTestGame(fx.tId, { name: 'Godzilla', status: 'ACTIVE', startDate: new Date(BASE + 2 * 24 * 60 * MIN).toISOString() });
        await addScore({ ...base(fx), user: 'Ann', userId: U1, score: 77, ms: BASE + 2 * 24 * 60 * MIN + 5 * MIN });
        const first = (await request(app).get(url(fx))).body;
        const next = (await request(app).get(`/api/rooms/${fx.roomId}/runs/${second}/recap`)).body;
        expect(first.totals.witness_games).toBe(10);
        expect(next.totals.witness_games).toBe(1);
        expect(next.players[0].best).toBe(77);
    });

    it('is read live: a delete and a correction show on the next read', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        const db = await getDatabase();
        expect((await request(app).get(url(fx))).body.players[0].best).toBe(1500);
        // The real delete / correct paths invalidate the board cache; a raw SQL edit must do it by hand.
        await db.run(`DELETE FROM score_history WHERE iscored_username = 'Ann' AND score = 1500`);
        await LeaderboardService.invalidateAll();
        const afterDelete = (await request(app).get(url(fx))).body;
        expect(afterDelete.players[0]).toMatchObject({ best: 1400, games: 5 });
        await db.run(`UPDATE score_history SET score = 5000 WHERE iscored_username = 'Bob' AND score = 1250`);
        await LeaderboardService.invalidateAll();
        expect((await request(app).get(url(fx))).body.players[0]).toMatchObject({ best: 5000, iscored_username: 'Bob' });
    });

    it('an opted-out player has null stats and leaves the totals and per-day, still ranked', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        await PreferencesService.setRecapPlayStats(U1, false);
        const body = (await request(app).get(url(fx))).body;
        const ann = body.players.find((p: { iscored_username: string }) => p.iscored_username === 'Ann');
        expect(ann).toMatchObject({
            rank: 1, best: 1500, play_stats: 'hidden', games: null, average: null, median: null, sessions: null,
            personal_bests: null, days_played: null, best_game_no: null, attempts_used: null,
        });
        expect(body.totals).toMatchObject({ witness_games: 4, witness_players: 1, hidden_players: 1 });
        expect(body.hero).toMatchObject({ winner_key: U1, best: 1500, winner_games: null, winning_game_no: null });
        expect(body.discord_text).toContain('1 player keeps their play stats private.');
    });

    it('time of day is opt-in: the detail carries times only after the opt-in', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        const detailUrl = url(fx, `/players/${encodeURIComponent(U1)}`);
        let d = (await request(app).get(detailUrl)).body;
        expect(d.hours).toBeNull();
        expect(d.games.every((g: { time: string | null }) => g.time === null)).toBe(true);
        await PreferencesService.setRecapTimeOfDay(U1, true);
        d = (await request(app).get(detailUrl)).body;
        expect(d.hours).toHaveLength(24);
        expect(d.games[0].time).toMatch(/^\d\d:\d\d$/);
        expect(d.games).toHaveLength(6);
        expect(d.sessions).toHaveLength(1);
        expect(d.timezone).toBe('America/Chicago');
    });

    it('player detail: 404 for an unknown key; hidden players get empty games', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        expect((await request(app).get(url(fx, '/players/nobody'))).status).toBe(404);
        await PreferencesService.setRecapPlayStats(U2, false);
        const d = (await request(app).get(url(fx, `/players/${U2}`))).body;
        expect(d.games).toEqual([]);
        expect(d.player).toMatchObject({ play_stats: 'hidden', best: 1250 });
    });

    it('a player key containing a percent sign resolves (decoded once, never twice)', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        const odd = 'we%rd 100%';
        await addScore({ ...base(fx), user: 'Dee', userId: odd, score: 5000, ms: BASE + 3 * MIN });
        await addScore({ ...base(fx), user: 'Dee', userId: odd, score: 5100, ms: BASE + 9 * MIN });
        const res = await request(app).get(url(fx, `/players/${encodeURIComponent(odd)}`));
        expect(res.status).toBe(200);
        expect(res.body.player).toMatchObject({ key: odd, best: 5100 });
    });

    it('limited tournaments add attempts_used', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET max_attempts = 10 WHERE id = ?`, fx.tId);
        for (let i = 0; i < 7; i++) {
            await db.run(
                `INSERT INTO attempts (tournament_id, game_id, game_room_id, canonical_user_id, device_id, attempt_key, attempt_no, status, started_ts)
                 VALUES (?, ?, ?, ?, 'dev', ?, ?, 'scored', ?)`, fx.tId, fx.gameId, fx.roomId, U1, `k${i}`, i + 1, 1000 + i);
        }
        const body = (await request(app).get(url(fx))).body;
        expect(body.run.max_attempts).toBe(10);
        expect(body.players.find((p: { key: string }) => p.key === U1).attempts_used).toBe(7);
        // Unlimited: always null.
        await db.run(`UPDATE tournaments SET max_attempts = NULL WHERE id = ?`, fx.tId);
        expect((await request(app).get(url(fx))).body.players[0].attempts_used).toBeNull();
    });

    it('a signed-out read of an approval room is refused', async () => {
        const app = await appWith();
        const fx = await rotation();
        await seedBoard(fx);
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        await GameRoomSettingsService.set(fx.roomId, 'JOIN_POLICY', 'approval');
        const res = await request(app).get(url(fx));
        expect(res.status).toBe(403);
    });
});

describe('GET /rooms/:roomId/tournaments/:tournamentId/runs/live', () => {
    it('lists the open cards of the tournament, 404 for another room', async () => {
        const app = await appWith();
        const fx = await rotation({ status: 'ACTIVE' });
        await createTestGame(fx.tId, { name: 'Done', status: 'COMPLETED', endDate: new Date().toISOString() });
        const res = await request(app).get(`/api/rooms/${fx.roomId}/tournaments/${fx.tId}/runs/live`);
        expect(res.status).toBe(200);
        expect(res.body.runs.map((r: { game_name: string }) => r.game_name)).toEqual(['Godzilla']);
        const other = await createTestRoom('elsewhere');
        expect((await request(app).get(`/api/rooms/${other}/tournaments/${fx.tId}/runs/live`)).status).toBe(404);
    });
});

describe('event rounds', () => {
    const GAME = 'Medieval Madness';
    const EBASE = Date.parse('2026-09-01T20:00:00.000Z');

    async function witnessed(f: { roomId: string; tId: string; roundId: string }, user: string, userId: string, score: number, launch: number, exit: number) {
        const db = await getDatabase();
        const res = await db.run(
            `INSERT INTO score_history (game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id, platform, engine, device, created_at)
             VALUES (?, ?, ?, ?, ?, ?, 'vpx', ?, ?, ?, 'vpxs', 'vpx', 'atgames', ?)`,
            GAME, f.roomId, f.roundId, user, userId, score, f.roomId, f.tId, userId, sqliteTs(exit));
        await db.run(
            `INSERT INTO witness_observations (atgames_unique_id, canonical_user_id, table_name, launch_ts, exit_ts, duration_sec, via, kind)
             VALUES (?, ?, 'mm_109c', ?, ?, ?, 'live', 'game')`,
            `dev-${userId}`, userId, Math.floor(launch / 1000), Math.floor(exit / 1000), Math.floor((exit - launch) / 1000));
        return res.lastID as number;
    }

    async function event(mode: 'prevent' | 'flag') {
        const db = await getDatabase();
        const roomId = await createTestRoom(`e-${crypto.randomUUID().slice(0, 8)}`);
        const tId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, witness_flag_mode)
             VALUES (?, 'Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', ?)`, tId, roomId, mode);
        const rounds = await EventService.createOrUpdateEvent(tId, {
            rounds: [{ roundNo: 1, gameName: GAME, scheduledStartAt: new Date(EBASE).toISOString(), scheduledEndAt: new Date(EBASE + 30 * MIN).toISOString() }],
            checkinRequired: false,
        });
        const roundId = rounds[0]!.id;
        await db.run(`UPDATE games SET status = 'ACTIVE', start_date = ? WHERE id = ?`, sqliteTs(EBASE), roundId);
        const f = { roomId, tId, roundId };
        // A geared up (launched 5 min before the round): flagged. Then a clean 500. B a clean 700.
        await witnessed(f, 'Tomato', U1, 900, EBASE - 5 * MIN, EBASE + 10 * MIN);
        await witnessed(f, 'Tomato', U1, 500, EBASE + 16 * MIN, EBASE + 20 * MIN);
        await witnessed(f, 'Bee', U2, 700, EBASE + 8 * MIN, EBASE + 12 * MIN);
        return f;
    }

    it('under flag the flagged score stays', async () => {
        const app = await appWith();
        const flag = await event('flag');
        const f = (await request(app).get(`/api/rooms/${flag.roomId}/runs/${flag.roundId}/recap`)).body;
        expect(f.players.map((x: { iscored_username: string; best: number }) => [x.iscored_username, x.best])).toEqual([['Tomato', 900], ['Bee', 700]]);
        expect(f.totals.witness_games).toBe(3);
    });

    it('under prevent the flagged score leaves the recap everywhere', async () => {
        const app = await appWith();
        const prevent = await event('prevent');
        const p = (await request(app).get(`/api/rooms/${prevent.roomId}/runs/${prevent.roundId}/recap`)).body;
        expect(p.run).toMatchObject({ format: 'event', round_no: 1 });
        expect(p.players.map((x: { iscored_username: string; best: number }) => [x.iscored_username, x.best])).toEqual([['Bee', 700], ['Tomato', 500]]);
        expect(p.totals.witness_games).toBe(2);
        expect(p.players.find((x: { iscored_username: string }) => x.iscored_username === 'Tomato').games).toBe(1);
    });
});

describe('RunRecapService.summarizeRuns', () => {
    it('computes every run of the room in bulk, with refs for the keys seen and the key filter', async () => {
        const { RunRecapService } = await import('../services/RunRecapService.js');
        const fx = await rotation();
        await seedBoard(fx);
        const second = await createTestGame(fx.tId, { name: 'Eight Ball', status: 'COMPLETED', startDate: new Date(BASE - 60 * MIN).toISOString(), endDate: new Date(BASE + 24 * 60 * MIN).toISOString() });
        void second;
        await addScore({ roomId: fx.roomId, tournamentId: fx.tId, name: 'Eight Ball', user: 'Bob', userId: U2, score: 42, ms: BASE });

        const all = await RunRecapService.summarizeRuns(fx.roomId, {});
        expect(all.runs).toHaveLength(2);
        const godzilla = all.runs.find(r => r.run.game_name === 'Godzilla')!;
        expect(godzilla.recap.totals.witness_games).toBe(10);
        expect(all.refs.get(U1)).toMatchObject({ iscored_username: 'Ann' });

        const mine = await RunRecapService.summarizeRuns(fx.roomId, { keys: [U3] });
        expect(mine.runs.map(r => r.run.game_name)).toEqual(['Godzilla']);
        expect((await RunRecapService.summarizeRuns(fx.roomId, { gameName: 'eight ball' })).runs).toHaveLength(1);
        expect((await RunRecapService.summarizeRuns(fx.roomId, { statuses: ['ACTIVE'] })).runs).toHaveLength(0);
    });
});
