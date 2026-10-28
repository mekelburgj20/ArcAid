import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { ATTEMPT_REFUSAL_TEXT } from '../services/AttemptService.js';

/**
 * W45 (v2.188.0, ADR 0033 §4) — `GET /api/witness/attempt-start`, the device
 * twin of the web "Start attempts" button.
 *
 *   - Same device-token auth and bare 401 as /witness/attempt.
 *   - The tables pressed are `openLimitedGames`' start-required games: the
 *     ingest's own candidates / routing / entry / window / device filters, so
 *     a press can never start a table a play from this device would not land on.
 *   - A named table narrows the press through the score call's `match`.
 *   - Writes `source='device'`; first press wins.
 *   - Nothing changes in ingest: a play that STARTED at/after the press counts,
 *     one that started before it is still `not_started`.
 */

const USER = '123456789012345678';
const DESKTOP = 'castcade-install-uuid-w45';
const MINUTE = 60_000;

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

async function pairDevice(app: express.Express, device: string, type?: 'desktop') {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device, username: 'Owner', ...(type ? { type } : {}) });
    return pairRes.body.token as string;
}

async function addMember(roomId: string, userId: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`,
        userId, roomId,
    );
}

async function createLimitedGame(
    roomId: string, maxAttempts: number | null, name = 'Bad Cats', requireStart = true,
) {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, max_attempts, require_attempt_start)
         VALUES (?, 'Five Shots', 'WG', 'pinball', '{}', 1, ?, 'rotation', ?, ?)`,
        tournamentId, roomId, maxAttempts, requireStart ? 1 : 0,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

async function startRows() {
    const db = await getDatabase();
    return db.all<Array<{ game_id: string; tournament_id: string; started_ts: number; source: string }>>(
        'SELECT game_id, tournament_id, started_ts, source FROM attempt_starts ORDER BY rowid',
    );
}

async function attemptRows(gameId: string) {
    const db = await getDatabase();
    return db.all<Array<{ status: string; attempt_no: number }>>(
        'SELECT status, attempt_no FROM attempts WHERE game_id = ? ORDER BY id', gameId,
    );
}

const BAD_CATS = { table: 'Bad Cats (Williams 1989)', rom: 'bcats_l5', slug: 'vpx-badcats' };

describe('GET /api/witness/attempt-start (W45)', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;
    const press = (query: Record<string, unknown> = {}) =>
        request(app).get('/api/witness/attempt-start').query({ device: DESKTOP, token, ...query });

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        await addMember(roomId, USER);
        token = await pairDevice(app, DESKTOP, 'desktop');
    });

    it('keeps the bare 401 on a bad or missing token, and writes nothing', async () => {
        await createLimitedGame(roomId, 2);
        const bad = await press({ token: 'not-the-token' });
        expect(bad.status).toBe(401);
        expect(bad.body).toEqual({ ok: false });
        const missing = await request(app).get('/api/witness/attempt-start').query({ device: DESKTOP });
        expect(missing.status).toBe(401);
        expect(missing.body).toEqual({ ok: false });
        const unknown = await press({ device: 'no-such-device' });
        expect(unknown.status).toBe(401);
        expect(await startRows()).toHaveLength(0);
    });

    it('nothing_to_start (with a reason) and no rows when no start-required limited table is open', async () => {
        await createLimitedGame(roomId, null, 'Unlimited Table', false);
        const res = await press();
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, status: 'nothing_to_start', started: [] });
        expect(typeof res.body.reason).toBe('string');
        expect(typeof res.body.sendingTo).toBe('string');
        expect(await startRows()).toHaveLength(0);
    });

    it('presses the one open start-required table: a device row, started now', async () => {
        const { tournamentId, gameId } = await createLimitedGame(roomId, 2);
        const before = Math.floor(Date.now() / 1000);
        const res = await press();
        const after = Math.floor(Date.now() / 1000);
        expect(res.body).toMatchObject({
            ok: true, status: 'started',
            started: [{ game: 'Bad Cats', gameId, tournamentId, alreadyStarted: false }],
        });
        const ts = res.body.started[0].startedTs as number;
        expect(ts).toBeGreaterThanOrEqual(before);
        expect(ts).toBeLessThanOrEqual(after);
        expect(await startRows()).toEqual([{ game_id: gameId, tournament_id: tournamentId, started_ts: ts, source: 'device' }]);
    });

    it('the service writes started_ts == now exactly', async () => {
        const { gameId } = await createLimitedGame(roomId, 2);
        const { WitnessService } = await import('../services/WitnessService.js');
        const out = await WitnessService.startAttemptsFromDevice({ atgamesUniqueId: DESKTOP, token, nowSec: 1_900_000_000 });
        expect(out).toMatchObject({ status: 'started', started: [{ gameId, startedTs: 1_900_000_000, alreadyStarted: false }] });
        expect(await WitnessService.startAttemptsFromDevice({ atgamesUniqueId: DESKTOP, token: 'wrong' })).toBeNull();
    });

    it('a second press keeps the first time, says alreadyStarted, and leaves one row', async () => {
        const { WitnessService } = await import('../services/WitnessService.js');
        await createLimitedGame(roomId, 2);
        await WitnessService.startAttemptsFromDevice({ atgamesUniqueId: DESKTOP, token, nowSec: 1_900_000_000 });
        const again = await press();
        expect(again.body).toMatchObject({
            status: 'started', started: [{ startedTs: 1_900_000_000, alreadyStarted: true }],
        });
        expect(await startRows()).toHaveLength(1);
    });

    it('a limited tournament that does NOT require the press is not pressed', async () => {
        await createLimitedGame(roomId, 3, 'Bad Cats', false);
        const res = await press();
        expect(res.body.status).toBe('nothing_to_start');
        expect(await startRows()).toHaveLength(0);
    });

    it('a table in a room the player is not a member of (and not entered in) is not pressed', async () => {
        const stranger = await createTestRoom('w45-stranger', 'Stranger Room');
        await createLimitedGame(stranger, 2);
        const res = await press();
        expect(res.body.status).toBe('nothing_to_start');
        expect(await startRows()).toHaveLength(0);
    });

    it('a device pinned to ANOTHER room does not press this room\'s table', async () => {
        const other = await createTestRoom('w45-other', 'Other Room');
        await addMember(other, USER);
        const { WitnessService } = await import('../services/WitnessService.js');
        await WitnessService.setDeviceTarget(USER, DESKTOP, { roomId: other, tournamentId: null });
        await createLimitedGame(roomId, 2);
        const res = await press();
        expect(res.body.status).toBe('nothing_to_start');
        expect(await startRows()).toHaveLength(0);
    });

    it('a "Global Scoreboard only" device presses nothing', async () => {
        await createLimitedGame(roomId, 2);
        const db = await getDatabase();
        await db.run(
            `UPDATE witness_devices SET target_room_id = NULL, target_tournament_id = NULL, global_only = 1 WHERE atgames_unique_id = ?`,
            DESKTOP,
        );
        const res = await press();
        expect(res.body.status).toBe('nothing_to_start');
        expect(await startRows()).toHaveLength(0);
    });

    it('two open tables: naming one presses only that one; no table presses both', async () => {
        const cats = await createLimitedGame(roomId, 2, 'Bad Cats');
        const taxi = await createLimitedGame(roomId, 2, 'Taxi');
        const named = await press(BAD_CATS);
        expect(named.body.status).toBe('started');
        expect(named.body.started.map((s: { gameId: string }) => s.gameId)).toEqual([cats.gameId]);
        expect((await startRows()).map(r => r.game_id)).toEqual([cats.gameId]);

        const all = await press();
        const byGame = Object.fromEntries(
            (all.body.started as Array<{ gameId: string; alreadyStarted: boolean }>).map(s => [s.gameId, s.alreadyStarted]),
        );
        expect(byGame).toEqual({ [cats.gameId]: true, [taxi.gameId]: false });
    });

    it('a named table that is not one of them is no_match (and presses nothing)', async () => {
        await createLimitedGame(roomId, 2, 'Bad Cats');
        await createLimitedGame(roomId, 2, 'Taxi', false); // limited, no press needed
        const notStartRequired = await press({ table: 'Taxi' });
        expect(notStartRequired.body).toMatchObject({ ok: true, status: 'no_match', started: [] });
        expect(typeof notStartRequired.body.reason).toBe('string');
        const unknown = await press({ table: 'Medieval Madness' });
        expect(unknown.body.status).toBe('no_match');
        expect(await startRows()).toHaveLength(0);
    });

    it('one table in two limited tournaments (two member rooms): one start row per games row', async () => {
        const second = await createTestRoom('w45-second', 'Second Room');
        await addMember(second, USER);
        const a = await createLimitedGame(roomId, 2);
        const b = await createLimitedGame(second, 3);
        const res = await press(BAD_CATS);
        expect(res.body.started.map((s: { gameId: string }) => s.gameId).sort()).toEqual([a.gameId, b.gameId].sort());
        expect(await startRows()).toHaveLength(2);
    });

    it('sendingTo is the heartbeat\'s own line, refreshed after the press', async () => {
        await createLimitedGame(roomId, 2);
        const beat = async () => (await request(app).get('/api/witness/heartbeat').query({ device: DESKTOP, token })).body.sendingTo as string;
        expect(await beat()).toMatch(/ · ATTEMPTS NOT STARTED$/);
        const res = await press();
        expect(res.body.sendingTo).toMatch(/ · 2 OF 2 ATTEMPTS LEFT$/);
        expect(res.body.sendingTo).toBe(await beat());
    });

    it('end to end: after the press a play started at/after it counts; one started before it is still not_started', async () => {
        const { gameId } = await createLimitedGame(roomId, 2);
        const pressed = await press();
        const startedTs = pressed.body.started[0].startedTs as number;

        // A game that began 30 s BEFORE the press: refused exactly as before W45.
        const early = await request(app).get('/api/witness/score').query({
            device: DESKTOP, token, ...BAD_CATS, score: 1_000_000,
            started: startedTs - 30, ended: startedTs + 200, dur: 230, reason: 'game_over',
        });
        expect(early.body).toMatchObject({ status: 'not_sanctioned', reasons: [ATTEMPT_REFUSAL_TEXT.not_started] });
        expect(await attemptRows(gameId)).toHaveLength(0);

        // A game that began after the press: the start counts, its score lands.
        const att = await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, ...BAD_CATS, started: startedTs + 5, key: 'w45-1' });
        expect(att.body).toMatchObject({ status: 'counted', attempt: 1, of: 2 });
        const later = await request(app).get('/api/witness/score').query({
            device: DESKTOP, token, ...BAD_CATS, score: 4_000_000,
            started: startedTs + 5, ended: startedTs + 305, dur: 300, reason: 'game_over', attempt: 'w45-1',
        });
        expect(later.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2 } });
        expect(await attemptRows(gameId)).toEqual([{ status: 'scored', attempt_no: 1 }]);
        const db = await getDatabase();
        const board = await db.all(`SELECT score FROM score_history WHERE game_id = ? AND source = 'vpx'`, gameId);
        expect(board).toEqual([{ score: 4_000_000 }]);
    });
});

describe('openLimitedGames play_device (W51, v2.191.0)', () => {
    it('lists a vr_headset-excluding tournament for a PC play and not for a VR play', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        await addMember(roomId, USER);
        const { gameId, tournamentId } = await createLimitedGame(roomId, 2);
        const db = await getDatabase();
        await db.run(
            'UPDATE tournaments SET platform_rules = ? WHERE id = ?',
            JSON.stringify({ engines: { required: [], excluded: [] }, devices: { required: [], excluded: ['vr_headset'] } }),
            tournamentId,
        );
        await pairDevice(app, DESKTOP, 'desktop');
        const { VpxScoreIngestService } = await import('../services/VpxScoreIngestService.js');
        const list = (playDevice?: 'pc' | 'vr_headset') => VpxScoreIngestService.openLimitedGames({
            canonicalUserId: USER, target: { roomId: null, tournamentId: null }, deviceType: 'desktop',
            playDevice, nowTs: Math.floor(Date.now() / 1000),
        });
        expect((await list('pc')).map(g => g.gameId)).toEqual([gameId]);
        expect((await list()).map(g => g.gameId)).toEqual([gameId]);
        expect(await list('vr_headset')).toEqual([]);
    });
});
