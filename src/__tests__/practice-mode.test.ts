import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { AttemptService, ATTEMPT_REFUSAL_TEXT, attemptsLeftLine, playIsPractice } from '../services/AttemptService.js';
import { normalizePracticeGames } from '../utils/practiceGames.js';

/**
 * W126 (ADR 0043) — Practice mode: a player pauses their own attempts on one
 * table of a limited-attempts tournament.
 *
 *   1. The rule: a play is practice when its START falls inside a pause. A
 *      pause only looks forward — a game already running stays an attempt, a
 *      practice game stays practice after a resume.
 *   2. The allowance (`tournaments.practice_games`): null = no pausing, 0 =
 *      unlimited, N = N per player per table for the table's whole run. The
 *      pause ends itself when the last practice game starts; the next game is
 *      an attempt.
 *   3. A practice game uses no attempt and never reaches the tournament board.
 *   4. Desktop (live start call) and cabinet (report after the fact) agree.
 */

const USER = '123456789012345678';
const DESKTOP = 'castcade-install-uuid-practice';
const CABINET = 'fp-device-uuid-practice';
const MINUTE = 60_000;

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    const { default: integrityRouter } = await import('../api/routes/integrity.js');
    app.use('/api', integrityRouter);
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

/** A limited-attempts rotation game; `practiceGames` null = practice not offered. */
async function createGame(roomId: string, maxAttempts: number, practiceGames: number | null, name = 'Bad Cats') {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, max_attempts, practice_games)
         VALUES (?, 'Five Shots', 'WG', 'pinball', '{}', 1, ?, 'rotation', ?, ?)`,
        tournamentId, roomId, maxAttempts, practiceGames,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

function scoreQuery(overrides: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Bad Cats (Williams 1989)',
        rom: 'bcats_l5',
        slug: 'vpx-badcats',
        score: 8366650,
        started: Math.floor((endedMs - 5 * MINUTE) / 1000),
        ended: Math.floor(endedMs / 1000),
        dur: 300,
        reason: 'game_over',
        ...overrides,
    };
}

async function boardRows(gameId: string) {
    const db = await getDatabase();
    return db.all<Array<{ id: number; score: number }>>(
        `SELECT id, score FROM score_history WHERE game_id = ? AND source = 'vpx' ORDER BY id`, gameId,
    );
}

async function attemptRows(gameId: string) {
    const db = await getDatabase();
    return db.all<Array<{ attempt_key: string; status: string; attempt_no: number; score: number | null }>>(
        'SELECT attempt_key, status, attempt_no, score FROM attempts WHERE game_id = ? ORDER BY id', gameId,
    );
}

async function pauseRows(gameId: string) {
    const db = await getDatabase();
    return db.all<Array<{ paused_ts: number; resumed_ts: number | null; ended_by: string | null }>>(
        'SELECT paused_ts, resumed_ts, ended_by FROM attempt_pauses WHERE game_id = ? ORDER BY id', gameId,
    );
}

describe('playIsPractice / normalizePracticeGames (pure)', () => {
    it('a play is practice when its start is inside [paused, resumed); an open pause has no end', () => {
        const closed = [{ pausedTs: 100, resumedTs: 200 }];
        expect(playIsPractice(closed, 99)).toBe(false);   // started before the press: an attempt
        expect(playIsPractice(closed, 100)).toBe(true);
        expect(playIsPractice(closed, 199)).toBe(true);
        expect(playIsPractice(closed, 200)).toBe(false);  // started at the resume: an attempt
        expect(playIsPractice([{ pausedTs: 100, resumedTs: null }], 1_000_000)).toBe(true);
        expect(playIsPractice([], 150)).toBe(false);
        expect(playIsPractice([{ pausedTs: 10, resumedTs: 20 }, { pausedTs: 100, resumedTs: null }], 50)).toBe(false);
    });

    it('the allowance: null = no pausing, 0 = unlimited, 1..999; anything else is null, never "unlimited"', () => {
        expect(normalizePracticeGames(null)).toBeNull();
        expect(normalizePracticeGames(undefined)).toBeNull();
        expect(normalizePracticeGames('')).toBeNull();
        expect(normalizePracticeGames(0)).toBe(0);
        expect(normalizePracticeGames(3)).toBe(3);
        expect(normalizePracticeGames('5')).toBe(5);
        expect(normalizePracticeGames(-1)).toBeNull();
        expect(normalizePracticeGames(1.5)).toBeNull();
        expect(normalizePracticeGames(1000)).toBeNull();
        expect(normalizePracticeGames('lots')).toBeNull();
    });
});

describe('the pause and the allowance (AttemptService)', () => {
    let roomId: string;
    const now = Math.floor(Date.now() / 1000);

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        await addMember(roomId, USER);
    });

    const press = (ids: { tournamentId: string; gameId: string }, nowSec: number, userId = USER) =>
        AttemptService.pauseForPlayer({ roomId, ...ids, userId, nowSec });
    const resume = (ids: { tournamentId: string; gameId: string }, nowSec: number) =>
        AttemptService.resumeForPlayer({ roomId, ...ids, userId: USER, nowSec });
    /** A LIVE desktop start at `at` (device and server clocks agree). */
    const start = (ids: { tournamentId: string; gameId: string }, key: string, at: number, limit = 3) =>
        AttemptService.recordStart({
            ...ids, gameRoomId: roomId, canonicalUserId: USER, deviceId: DESKTOP, key, limit, startedTs: at, nowSec: at,
        });

    it('is not offered unless the host set an allowance; an open pause row then changes nothing', async () => {
        const ids = await createGame(roomId, 3, null);
        expect(await press(ids, now - 100)).toMatchObject({ ok: false, httpStatus: 409, code: 'NOT_OFFERED' });
        // Even a pause row written some other way produces no practice game.
        const db = await getDatabase();
        await db.run(
            `INSERT INTO attempt_pauses (game_id, canonical_user_id, tournament_id, paused_ts) VALUES (?, ?, ?, ?)`,
            ids.gameId, USER, ids.tournamentId, now - 100,
        );
        expect(await start(ids, 'k1', now)).toMatchObject({ status: 'counted', attempt: 1 });
    });

    it('unlimited (0): starts inside the pause are practice and use no attempt; after the resume they count', async () => {
        const ids = await createGame(roomId, 3, 0);
        const paused = await press(ids, now - 100);
        expect(paused).toMatchObject({ ok: true, practice: { offered: true, limit: 0, used: 0, left: null, paused: true, pausedTs: now - 100 } });

        expect(await start(ids, 'p1', now - 90)).toEqual({
            status: 'practice', practice: { n: 1, of: 0, remaining: null }, late: false, resent: false,
        });
        expect(await start(ids, 'p2', now - 80)).toMatchObject({ status: 'practice', practice: { n: 2 } });
        // A resend of a practice start is the stored answer.
        expect(await start(ids, 'p2', now - 80)).toMatchObject({ status: 'practice', practice: { n: 2 }, resent: true });
        expect((await AttemptService.usedByPlayer(USER, [ids.gameId]))[ids.gameId]).toBeUndefined();
        expect((await AttemptService.usedByGame(ids.tournamentId))[ids.gameId]).toBeUndefined();

        expect(await resume(ids, now - 50)).toMatchObject({ ok: true, resumed: true, practice: { paused: false, used: 2 } });
        expect(await start(ids, 'a1', now - 40)).toMatchObject({ status: 'counted', attempt: 1, of: 3, remaining: 2 });
        expect(await pauseRows(ids.gameId)).toEqual([{ paused_ts: now - 100, resumed_ts: now - 50, ended_by: 'player' }]);
        // A second resume with nothing open changes nothing.
        expect(await resume(ids, now - 30)).toMatchObject({ ok: true, resumed: false });
    });

    it('a pause only looks forward: a game that started BEFORE the press stays an attempt and its score binds', async () => {
        const ids = await createGame(roomId, 3, 0);
        expect(await start(ids, 'a1', now - 300)).toMatchObject({ status: 'counted', attempt: 1 });
        await press(ids, now - 200); // pressed while the game is running (it is going badly)
        const bound = await AttemptService.bindScore({
            ...ids, gameRoomId: roomId, canonicalUserId: USER, deviceId: DESKTOP, attemptKey: 'a1', limit: 3,
            score: 1000, startedTs: now - 300, endedTs: now - 100,
        });
        expect(bound).toMatchObject({ ok: true, attempt: { n: 1, of: 3 } });
    });

    it('a start call that ARRIVES after the press, for a game that began before it, is still an attempt (no held-back-call loophole)', async () => {
        const ids = await createGame(roomId, 3, 0);
        // The game began at now-60 with the network unplugged; the player saw it
        // going badly, pressed Pause at now-30, then let the start call through.
        await press(ids, now - 30);
        const held = await AttemptService.recordStart({
            ...ids, gameRoomId: roomId, canonicalUserId: USER, deviceId: DESKTOP, key: 'held',
            limit: 3, startedTs: now - 60, nowSec: now,
        });
        expect(held).toMatchObject({ status: 'counted', attempt: 1, late: false });
        // And the mirror: a practice game whose call arrives after Resume stays practice.
        await resume(ids, now - 10);
        const practiceHeld = await AttemptService.recordStart({
            ...ids, gameRoomId: roomId, canonicalUserId: USER, deviceId: DESKTOP, key: 'held-2',
            limit: 3, startedTs: now - 20, nowSec: now,
        });
        expect(practiceHeld).toMatchObject({ status: 'practice', practice: { n: 1 } });
    });

    it('a practice game stays practice after a resume: its score is refused as `practice` and kept on the row', async () => {
        const ids = await createGame(roomId, 3, 0);
        await press(ids, now - 300);
        await start(ids, 'p1', now - 250);
        await resume(ids, now - 200); // resumed while the practice game is still running
        const bound = await AttemptService.bindScore({
            ...ids, gameRoomId: roomId, canonicalUserId: USER, deviceId: DESKTOP, attemptKey: 'p1', limit: 3,
            score: 4321, startedTs: now - 250, endedTs: now - 100,
        });
        expect(bound).toEqual({ ok: false, reason: 'practice', text: ATTEMPT_REFUSAL_TEXT.practice });
        expect(await attemptRows(ids.gameId)).toEqual([{ attempt_key: 'p1', status: 'practice', attempt_no: 1, score: 4321 }]);
    });

    it('a score with no reported start inside a pause is practice, not a used `unreported` attempt', async () => {
        const ids = await createGame(roomId, 3, 0);
        await press(ids, now - 400);
        const bound = await AttemptService.bindScore({
            ...ids, gameRoomId: roomId, canonicalUserId: USER, deviceId: DESKTOP, attemptKey: null, limit: 3,
            score: 999, startedTs: now - 300, endedTs: now - 100,
        });
        expect(bound).toMatchObject({ ok: false, reason: 'practice' });
        expect((await attemptRows(ids.gameId)).map(r => r.status)).toEqual(['practice']);
        expect((await AttemptService.usedByPlayer(USER, [ids.gameId]))[ids.gameId]).toBeUndefined();
    });

    it('an allowance of 2: two practice games, the pause ends itself, the next game is an attempt', async () => {
        const ids = await createGame(roomId, 3, 2);
        expect(await press(ids, now - 100)).toMatchObject({ ok: true, practice: { limit: 2, left: 2, paused: true } });
        expect(await start(ids, 'p1', now - 90)).toMatchObject({ status: 'practice', practice: { n: 1, of: 2, remaining: 1 } });
        expect((await pauseRows(ids.gameId))[0]!.resumed_ts).toBeNull();
        expect(await start(ids, 'p2', now - 80)).toMatchObject({ status: 'practice', practice: { n: 2, of: 2, remaining: 0 } });

        // The last practice game closed the pause (after its own start, so it stays practice).
        const [pause] = await pauseRows(ids.gameId);
        expect(pause!.ended_by).toBe('cap');
        expect(pause!.resumed_ts).toBeGreaterThan(now - 80);
        const state = (await AttemptService.practiceStateFor(USER, [{ gameId: ids.gameId, practiceGames: 2 }]))[ids.gameId]!;
        expect(state).toMatchObject({ used: 2, left: 0, paused: false, pausedTs: null });

        // The next start is an attempt, even one whose time falls inside the old pause.
        expect(await start(ids, 'a1', now - 70)).toMatchObject({ status: 'counted', attempt: 1, remaining: 2 });
        expect(await press(ids, now)).toMatchObject({ ok: false, httpStatus: 409, code: 'NO_PRACTICE_LEFT' });
    });

    it('a host void gives a practice game back', async () => {
        const ids = await createGame(roomId, 3, 1);
        await press(ids, now - 100);
        await start(ids, 'p1', now - 90);
        expect(await press(ids, now - 50)).toMatchObject({ ok: false, code: 'NO_PRACTICE_LEFT' });
        const db = await getDatabase();
        const row = await db.get<{ id: number }>(`SELECT id FROM attempts WHERE attempt_key = 'p1'`);
        await expect(AttemptService.void(row!.id, 'admin-1', ids.tournamentId))
            .resolves.toEqual({ previousStatus: 'practice', scoreHistoryId: null });
        expect(await press(ids, now - 40)).toMatchObject({ ok: true, practice: { used: 0, left: 1, paused: true } });
    });

    it('the press is idempotent: a second press keeps the open pause and its time', async () => {
        const ids = await createGame(roomId, 3, 0);
        await press(ids, 1000);
        expect(await press(ids, 2000)).toMatchObject({ ok: true, practice: { paused: true, pausedTs: 1000 } });
        expect(await pauseRows(ids.gameId)).toHaveLength(1);
    });

    it('refuses a non-member, a closed table, a table whose Start attempts is not pressed, and a player with no attempts left', async () => {
        const ids = await createGame(roomId, 1, 0);
        expect(await press(ids, now, '999999999999999999')).toMatchObject({ ok: false, httpStatus: 403, code: 'NOT_ENTERED' });

        const db = await getDatabase();
        await db.run('UPDATE tournaments SET require_attempt_start = 1 WHERE id = ?', ids.tournamentId);
        expect(await press(ids, now)).toMatchObject({ ok: false, httpStatus: 409, code: 'NOT_STARTED' });
        await AttemptService.startAttempts({ ...ids, canonicalUserId: USER, source: 'web', nowSec: now - 500 });

        await start(ids, 'a1', now - 400, 1); // the one attempt
        expect(await press(ids, now)).toMatchObject({ ok: false, httpStatus: 409, code: 'NO_ATTEMPTS_LEFT' });

        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id = ?`, ids.gameId);
        expect(await press(ids, now)).toMatchObject({ ok: false, httpStatus: 409, code: 'NOT_OPEN' });
        expect(await AttemptService.pauseForPlayer({ roomId, tournamentId: ids.tournamentId, gameId: 'nope', userId: USER }))
            .toMatchObject({ ok: false, httpStatus: 404, code: 'NOT_FOUND' });
    });

    it('a pause is per table: the same player keeps counting on another table', async () => {
        const a = await createGame(roomId, 3, 0, 'Bad Cats');
        const b = await createGame(roomId, 3, 0, 'Taxi');
        await press(a, now - 100);
        expect(await start(a, 'k', now - 50)).toMatchObject({ status: 'practice' });
        expect(await start(b, 'k', now - 50)).toMatchObject({ status: 'counted', attempt: 1 });
    });

    it('the runner sees who is in practice mode now, by name, and not a pause whose allowance is used up', async () => {
        const ids = await createGame(roomId, 3, 1);
        await press(ids, now - 100);
        const listed = await AttemptService.pausedNow(ids.tournamentId);
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({ gameId: ids.gameId, gameName: 'Bad Cats', pausedTs: now - 100, practiceUsed: 0, practiceLeft: 1 });
        expect(listed[0]!.playerLabel).toBeTruthy();
        await start(ids, 'p1', now - 90);
        expect(await AttemptService.pausedNow(ids.tournamentId)).toEqual([]);
        const admin = await AttemptService.listForAdmin(ids.tournamentId);
        expect(admin[0]).toMatchObject({ status: 'practice', attemptNo: 1, voidable: true, reinstatable: false });
    });
});

describe('practice mode over the wire', () => {
    let app: express.Express;
    let roomId: string;
    const auth = { Authorization: `Bearer ${playerToken(USER)}` };
    const pressPause = (ids: { tournamentId: string; gameId: string }) =>
        request(app).post(`/api/rooms/${roomId}/tournaments/${ids.tournamentId}/games/${ids.gameId}/attempt-pause`).set(auth).send({});
    const pressResume = (ids: { tournamentId: string; gameId: string }) =>
        request(app).post(`/api/rooms/${roomId}/tournaments/${ids.tournamentId}/games/${ids.gameId}/attempt-resume`).set(auth).send({});

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        await addMember(roomId, USER);
    });

    it('needs a login', async () => {
        const ids = await createGame(roomId, 3, 0);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/tournaments/${ids.tournamentId}/games/${ids.gameId}/attempt-pause`).send({});
        expect(res.status).toBe(401);
    });

    it('desktop: a start inside the pause is answered as practice (no new wire status), its score stays off the board; after Resume plays count', async () => {
        const token = await pairDevice(app, DESKTOP, 'desktop');
        const ids = await createGame(roomId, 2, 3);
        const q = scoreQuery();

        const paused = await pressPause(ids);
        expect(paused.status).toBe(200);
        expect(paused.body.practice).toMatchObject({ offered: true, limit: 3, used: 0, left: 3, paused: true });

        const att = await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: Math.floor(Date.now() / 1000), key: 'prac-1' });
        expect(att.body).toMatchObject({
            ok: true, status: 'no_match', game: 'Bad Cats', attempt: null,
            reason: ATTEMPT_REFUSAL_TEXT.practice, practice: { n: 1, of: 3, remaining: 2 },
        });
        const score = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...q, attempt: 'prac-1' });
        expect(score.body).toMatchObject({ ok: true, status: 'not_sanctioned', reasons: [ATTEMPT_REFUSAL_TEXT.practice] });
        expect(await boardRows(ids.gameId)).toHaveLength(0);
        expect(await attemptRows(ids.gameId)).toEqual([{ attempt_key: 'prac-1', status: 'practice', attempt_no: 1, score: q.score }]);

        // The public read: no attempt used; the allowance is published.
        const integrity = await request(app).get(`/api/rooms/${roomId}/tournaments/${ids.tournamentId}/integrity`);
        expect(integrity.body).toMatchObject({ maxAttempts: 2, practiceGames: 3, attempts: {} });

        const resumed = await pressResume(ids);
        expect(resumed.body).toMatchObject({ resumed: true, practice: { paused: false, used: 1, left: 2 } });
        const nowSec = Math.floor(Date.now() / 1000);
        const att2 = await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: nowSec, key: 'real-1' });
        expect(att2.body).toMatchObject({ status: 'counted', attempt: 1, of: 2, remaining: 1 });
        expect(att2.body.practice).toBeUndefined();
        const landed = await request(app).get('/api/witness/score')
            .query({ device: DESKTOP, token, ...q, score: 4_000_000, started: nowSec, ended: nowSec + 200, attempt: 'real-1' });
        expect(landed.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2 } });
        expect(await boardRows(ids.gameId)).toHaveLength(1);
    });

    it('desktop: a game already running when Pause is pressed still counts and lands', async () => {
        const token = await pairDevice(app, DESKTOP, 'desktop');
        const ids = await createGame(roomId, 2, 0);
        const q = scoreQuery();
        const nowSec = Math.floor(Date.now() / 1000);
        await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: nowSec, key: 'real-1' });
        expect((await pressPause(ids)).status).toBe(200);
        const res = await request(app).get('/api/witness/score')
            .query({ device: DESKTOP, token, ...q, started: nowSec, ended: nowSec + 200, attempt: 'real-1' });
        expect(res.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2 } });
        expect(await boardRows(ids.gameId)).toHaveLength(1);
    });

    it('cabinet: a game that started inside the pause is practice (restarts too), the line says PRACTICE MODE, and the allowance ends the pause', async () => {
        const token = await pairDevice(app, CABINET);
        const ids = await createGame(roomId, 2, 3);
        const beat = async () => (await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token })).body.sendingTo as string;
        expect(await beat()).toMatch(/ · 2 OF 2 ATTEMPTS LEFT$/);

        const pausedTs = (await pressPause(ids)).body.practice.pausedTs as number;
        expect(await beat()).toMatch(/ · PRACTICE MODE, 3 LEFT$/);

        // A game that began BEFORE the press, reported after it: an attempt.
        const before = await request(app).get('/api/witness/score')
            .query({ device: CABINET, token, ...scoreQuery({ score: 1_000_000, started: pausedTs - 300, ended: pausedTs - 20 }) });
        expect(before.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2 } });

        // One restart + the game, both started inside the pause: two practice games.
        const inside = await request(app).get('/api/witness/score')
            .query({ device: CABINET, token, ...scoreQuery({ score: 2_000_000, started: pausedTs + 5, ended: pausedTs + 200, restarts: 1 }) });
        expect(inside.body).toMatchObject({ ok: true, status: 'no_match' });
        expect((await attemptRows(ids.gameId)).map(r => [r.status, r.attempt_no])).toEqual([
            ['scored', 1], ['practice', 1], ['practice', 2],
        ]);
        expect(await boardRows(ids.gameId)).toHaveLength(1);
        expect(await beat()).toMatch(/ · PRACTICE MODE, 1 LEFT$/);

        // A replay of the practice report changes nothing.
        await request(app).get('/api/witness/score')
            .query({ device: CABINET, token, ...scoreQuery({ score: 2_000_000, started: pausedTs + 5, ended: pausedTs + 200, restarts: 1 }) });
        expect(await attemptRows(ids.gameId)).toHaveLength(3);

        // The third practice game uses the allowance up; the pause ends; the next game counts.
        await request(app).get('/api/witness/score')
            .query({ device: CABINET, token, ...scoreQuery({ score: 2_500_000, started: pausedTs + 210, ended: pausedTs + 400 }) });
        expect(await beat()).toMatch(/ · 1 OF 2 ATTEMPTS LEFT$/);
        const counted = await request(app).get('/api/witness/score')
            .query({ device: CABINET, token, ...scoreQuery({ score: 3_000_000, started: pausedTs + 410, ended: pausedTs + 600 }) });
        expect(counted.body).toMatchObject({ status: 'ingested', attempt: { n: 2, of: 2 } });
        expect(await boardRows(ids.gameId)).toHaveLength(2);
    });

    it('the room read and the per-tournament read carry my practice state', async () => {
        const ids = await createGame(roomId, 2, 0);
        const off = await createGame(roomId, 2, null, 'Taxi');
        await pressPause(ids);
        const room = await request(app).get(`/api/rooms/${roomId}/attempt-starts/me`).set(auth);
        const byId = Object.fromEntries((room.body.games as Array<{ gameId: string; practice: unknown }>).map(g => [g.gameId, g.practice]));
        expect(byId[ids.gameId]).toMatchObject({ offered: true, limit: 0, left: null, paused: true });
        expect(byId[off.gameId]).toEqual({ offered: false, limit: null, used: 0, left: null, paused: false, pausedTs: null });

        const me = await request(app).get(`/api/rooms/${roomId}/tournaments/${ids.tournamentId}/attempt-starts/me`).set(auth);
        expect(me.body.practice[ids.gameId]).toMatchObject({ offered: true, paused: true });
    });

    it('the setting is off by default, survives an edit that omits it, and null turns it off', async () => {
        const ids = await createGame(roomId, 2, null);
        const { TournamentService } = await import('../services/TournamentService.js');
        const db = await getDatabase();
        const stored = await db.get<Record<string, unknown>>('SELECT * FROM tournaments WHERE id = ?', ids.tournamentId);
        const base = { name: stored!.name as string, type: stored!.type as string, cadence: {}, game_room_id: roomId, is_active: true };
        const read = async () => (await request(app).get(`/api/rooms/${roomId}/tournaments/${ids.tournamentId}/integrity`)).body.practiceGames;

        expect(await read()).toBeNull();
        await TournamentService.update(ids.tournamentId, { ...base, practice_games: 0 });
        expect(await read()).toBe(0);
        await TournamentService.update(ids.tournamentId, base); // omits it
        expect(await read()).toBe(0);
        await TournamentService.update(ids.tournamentId, { ...base, practice_games: 4 });
        expect(await read()).toBe(4);
        await TournamentService.update(ids.tournamentId, { ...base, practice_games: null });
        expect(await read()).toBeNull();

        const createdId = crypto.randomUUID();
        await TournamentService.create({ ...base, id: createdId, max_attempts: 3, practice_games: 2 });
        const created = await db.get<{ practice_games: number | null }>('SELECT practice_games FROM tournaments WHERE id = ?', createdId);
        expect(created!.practice_games).toBe(2);
        const plainId = crypto.randomUUID();
        await TournamentService.create({ ...base, id: plainId, max_attempts: 3 });
        const plain = await db.get<{ practice_games: number | null }>('SELECT practice_games FROM tournaments WHERE id = ?', plainId);
        expect(plain!.practice_games).toBeNull();
    });
});

describe('attemptsLeftLine with a paused table', () => {
    it('one table: PRACTICE MODE with what is left; unlimited has no count; not-started wins', () => {
        expect(attemptsLeftLine([{ gameName: 'Taxi', left: 4, limit: 5, practice: true, practiceLeft: 2 }])).toBe(' · PRACTICE MODE, 2 LEFT');
        expect(attemptsLeftLine([{ gameName: 'Taxi', left: 4, limit: 5, practice: true, practiceLeft: null }])).toBe(' · PRACTICE MODE');
        expect(attemptsLeftLine([{ gameName: 'Taxi', left: 4, limit: 5, notStarted: true, practice: true }])).toBe(' · ATTEMPTS NOT STARTED');
    });

    it('several tables: the paused one reads PRACTICE beside the others\' counts', () => {
        expect(attemptsLeftLine([
            { gameName: 'Taxi', left: 4, limit: 5 },
            { gameName: 'Bad Cats', left: 1, limit: 3, practice: true, practiceLeft: 2 },
        ])).toBe(' · ATTEMPTS LEFT: BAD CATS PRACTICE, TAXI 4/5');
    });
});
