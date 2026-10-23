import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { AttemptService, ATTEMPT_LATE_SEC, ATTEMPT_REFUSAL_TEXT } from '../services/AttemptService.js';
import { checkAttemptLimitSubmission, ATTEMPTS_WITNESS_ONLY_MESSAGE } from '../services/EventSubmissionGate.js';

/**
 * Limited attempts (v2.167.0, ADR 0029): N game starts per player per table.
 *
 *   1. `recordStart` counts starts atomically: 1..N counted, N+1 over_limit,
 *      a resend of the same key is the stored answer, a late report is
 *      flagged, a void row frees its slot.
 *   2. `bindScore` implements the ADR's table row by row.
 *   3. The witness score route refuses an unbound score the way it refuses a
 *      Sanctioned one (desktop: `not_sanctioned` + reasons; cabinet: `no_match`).
 *   4. Cabinets count at report time (owner ruling 2026-10-22): each game
 *      report is the attempt, a replay never uses a second one, an exit sample
 *      cannot be counted.
 *   5. Every manual submit path refuses a limited tournament through ONE helper.
 */

const USER = '123456789012345678';
const DESKTOP = 'castcade-install-uuid-1';
const CABINET = 'fp-device-uuid-cab';
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

async function designate(device: string, roomId: string) {
    const { WitnessService } = await import('../services/WitnessService.js');
    await WitnessService.setDeviceTarget(USER, device, { roomId, tournamentId: null });
}

async function createLimitedGame(roomId: string, maxAttempts: number | null, name = 'Bad Cats') {
    const db = await getDatabase();
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, max_attempts)
         VALUES (?, 'Five Shots', 'WG', 'pinball', '{}', 1, ?, 'rotation', ?)`,
        tournamentId, roomId, maxAttempts,
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

describe('AttemptService.recordStart', () => {
    let roomId: string;
    let ids: { tournamentId: string; gameId: string };
    const now = Math.floor(Date.now() / 1000);
    const start = (key: string, startedTs = now) => AttemptService.recordStart({
        tournamentId: ids.tournamentId, gameId: ids.gameId, gameRoomId: roomId,
        canonicalUserId: USER, deviceId: DESKTOP, key, limit: 3, startedTs, nowSec: now,
    });

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        ids = await createLimitedGame(roomId, 3);
    });

    it('counts 1..N, then over_limit (still recorded, numbered past the limit)', async () => {
        expect(await start('k1')).toMatchObject({ status: 'counted', attempt: 1, of: 3, remaining: 2, late: false });
        expect(await start('k2')).toMatchObject({ status: 'counted', attempt: 2, remaining: 1 });
        expect(await start('k3')).toMatchObject({ status: 'counted', attempt: 3, remaining: 0 });
        expect(await start('k4')).toMatchObject({ status: 'over_limit', attempt: 4, remaining: 0 });
        const db = await getDatabase();
        const n = await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts WHERE game_id = ?', ids.gameId);
        expect(n!.n).toBe(4);
    });

    it('a resend of the same key returns the stored answer and uses no slot', async () => {
        await start('k1');
        const again = await start('k1');
        expect(again).toMatchObject({ status: 'counted', attempt: 1, resent: true });
        expect(await start('k2')).toMatchObject({ attempt: 2 });
    });

    it(`flags a start reported more than ${ATTEMPT_LATE_SEC}s after it happened — and still counts it`, async () => {
        const late = await start('k1', now - ATTEMPT_LATE_SEC - 5);
        expect(late).toMatchObject({ status: 'counted', attempt: 1, late: true });
        const onTime = await start('k2', now - ATTEMPT_LATE_SEC + 5);
        expect(onTime).toMatchObject({ late: false, attempt: 2 });
    });

    it('a voided attempt is excluded from the count and the public read', async () => {
        await start('k1'); await start('k2'); await start('k3');
        const db = await getDatabase();
        const row = await db.get<{ id: number }>(`SELECT id FROM attempts WHERE attempt_key = 'k2'`);
        await AttemptService.void(row!.id, 'admin-1', ids.tournamentId);
        expect(await start('k4')).toMatchObject({ status: 'counted', attempt: 3 });
        expect((await AttemptService.usedByGame(ids.tournamentId))[ids.gameId]![USER]).toBe(3);
    });

    it('cannot void a scored attempt', async () => {
        await start('k1');
        const db = await getDatabase();
        const row = await db.get<{ id: number }>(`SELECT id FROM attempts WHERE attempt_key = 'k1'`);
        await AttemptService.markScored(row!.id, { scoreHistoryId: 1, score: 10, endedTs: now });
        await expect(AttemptService.void(row!.id, 'admin-1', ids.tournamentId)).rejects.toMatchObject({ code: 'NOT_VOIDABLE', httpStatus: 409 });
    });
});

describe('AttemptService.bindScore — the ADR table', () => {
    let roomId: string;
    let ids: { tournamentId: string; gameId: string };
    const now = Math.floor(Date.now() / 1000);
    const base = () => ({
        tournamentId: ids.tournamentId, gameId: ids.gameId, gameRoomId: roomId,
        canonicalUserId: USER, deviceId: DESKTOP, limit: 1,
    });
    const bind = (attemptKey: string | null, score = 1000) =>
        AttemptService.bindScore({ ...base(), attemptKey, score, startedTs: now - 300, endedTs: now });

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        ids = await createLimitedGame(roomId, 1);
    });

    it('counted, on time → accepted', async () => {
        await AttemptService.recordStart({ ...base(), key: 'k1', startedTs: now, nowSec: now });
        expect(await bind('k1')).toMatchObject({ ok: true, attempt: { n: 1, of: 1, remaining: 0 } });
    });

    it('counted, late → refused (late)', async () => {
        await AttemptService.recordStart({ ...base(), key: 'k1', startedTs: now - 600, nowSec: now });
        expect(await bind('k1')).toMatchObject({ ok: false, reason: 'late' });
    });

    it('over_limit → refused (over_limit)', async () => {
        await AttemptService.recordStart({ ...base(), key: 'k1', startedTs: now, nowSec: now });
        await AttemptService.recordStart({ ...base(), key: 'k2', startedTs: now, nowSec: now });
        expect(await bind('k2')).toMatchObject({ ok: false, reason: 'over_limit' });
    });

    it('void → refused (void)', async () => {
        await AttemptService.recordStart({ ...base(), key: 'k1', startedTs: now, nowSec: now });
        const db = await getDatabase();
        const row = await db.get<{ id: number }>(`SELECT id FROM attempts WHERE attempt_key = 'k1'`);
        await AttemptService.void(row!.id, 'admin-1');
        expect(await bind('k1')).toMatchObject({ ok: false, reason: 'void' });
    });

    it('scored already → same score passes to the duplicate path, a different score is reused', async () => {
        await AttemptService.recordStart({ ...base(), key: 'k1', startedTs: now, nowSec: now });
        const first = await bind('k1', 1000);
        expect(first.ok).toBe(true);
        await AttemptService.markScored((first as { attemptId: number }).attemptId, { scoreHistoryId: 7, score: 1000, endedTs: now });
        expect(await bind('k1', 1000)).toMatchObject({ ok: true });
        expect(await bind('k1', 2000)).toMatchObject({ ok: false, reason: 'reused' });
    });

    it('no row → an unreported row is created (counts, late = 1) and the score is refused', async () => {
        const res = await bind('never-reported');
        expect(res).toMatchObject({ ok: false, reason: 'unreported', text: ATTEMPT_REFUSAL_TEXT.unreported });
        expect(ATTEMPT_REFUSAL_TEXT.unreported).toBe(
            'no game start was reported for this score — import this table in Castcade so live mode can count attempts',
        );
        const db = await getDatabase();
        const row = await db.get<{ status: string; late: number; attempt_no: number }>(
            `SELECT status, late, attempt_no FROM attempts WHERE attempt_key = 'never-reported'`,
        );
        expect(row).toMatchObject({ status: 'unreported', late: 1, attempt_no: 1 });
        // A key-less score also leaves a row, and its resend does not count twice.
        await bind(null, 555);
        await bind(null, 555);
        expect((await AttemptService.usedByGame(ids.tournamentId))[ids.gameId]![USER]).toBe(2);
    });
});

describe('witness routes on a limited tournament', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        await addMember(roomId, USER);
    });

    describe('desktop (Castcade)', () => {
        let token: string;
        beforeEach(async () => {
            token = await pairDevice(app, DESKTOP, 'desktop');
            await designate(DESKTOP, roomId);
        });

        it('/witness/attempt counts a start; the score bound to it lands with `attempt`', async () => {
            const { gameId } = await createLimitedGame(roomId, 2);
            const q = scoreQuery();
            const att = await request(app).get('/api/witness/attempt')
                .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: Math.floor(Date.now() / 1000), key: 'sess-1' });
            expect(att.status).toBe(200);
            expect(att.body).toMatchObject({ ok: true, status: 'counted', attempt: 1, of: 2, remaining: 1, late: false, game: 'Bad Cats' });

            const res = await request(app).get('/api/witness/score')
                .query({ device: DESKTOP, token, ...q, attempt: 'sess-1' });
            expect(res.body).toMatchObject({ ok: true, status: 'ingested', attempt: { n: 1, of: 2, remaining: 1 } });
            expect(await boardRows(gameId)).toHaveLength(1);
            const db = await getDatabase();
            const row = await db.get<{ status: string; score_history_id: number | null }>(
                `SELECT status, score_history_id FROM attempts WHERE attempt_key = 'sess-1'`,
            );
            expect(row!.status).toBe('scored');
            expect(row!.score_history_id).not.toBeNull();
        });

        it('a repeat of a live score with the same key is told it landed and uses no second attempt (v2.167.1)', async () => {
            const { gameId, tournamentId } = await createLimitedGame(roomId, 2);
            const q = scoreQuery();
            await request(app).get('/api/witness/attempt')
                .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: Math.floor(Date.now() / 1000), key: 'sess-1' });
            const first = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...q, attempt: 'sess-1' });
            const again = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...q, attempt: 'sess-1' });
            expect(first.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2, remaining: 1 } });
            // Pre-v2.167.1 the repeat hit the attempt binding first and was
            // refused as `reused` — "not sanctioned" for a score on the board.
            expect(again.body).toMatchObject({ ok: true, status: 'ingested' });
            expect(again.body.reasons).toBeUndefined();
            expect(await boardRows(gameId)).toHaveLength(1);
            expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(1);
        });

        it('/witness/attempt answers unlimited (and records nothing) when the tournament has no limit', async () => {
            await createLimitedGame(roomId, null);
            const att = await request(app).get('/api/witness/attempt')
                .query({ device: DESKTOP, token, table: 'Bad Cats', started: Math.floor(Date.now() / 1000), key: 'x' });
            expect(att.body).toMatchObject({ ok: true, status: 'unlimited' });
            const db = await getDatabase();
            expect((await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM attempts'))!.n).toBe(0);
        });

        it('/witness/attempt keeps the bare 401 on a bad token', async () => {
            await createLimitedGame(roomId, 2);
            const att = await request(app).get('/api/witness/attempt')
                .query({ device: DESKTOP, token: 'wrong', table: 'Bad Cats', started: 1, key: 'x' });
            expect(att.status).toBe(401);
            expect(att.body).toEqual({ ok: false });
        });

        it('an over_limit key is refused: not_sanctioned + reasons, nothing on the board', async () => {
            const { gameId } = await createLimitedGame(roomId, 1);
            const started = Math.floor(Date.now() / 1000);
            for (const key of ['a', 'b']) {
                await request(app).get('/api/witness/attempt')
                    .query({ device: DESKTOP, token, table: 'Bad Cats', started, key });
            }
            const res = await request(app).get('/api/witness/score')
                .query({ device: DESKTOP, token, ...scoreQuery(), attempt: 'b' });
            expect(res.body).toMatchObject({
                ok: true, status: 'not_sanctioned', reasons: [ATTEMPT_REFUSAL_TEXT.over_limit],
            });
            expect(await boardRows(gameId)).toHaveLength(0);
            const db = await getDatabase();
            const trail = await db.get<{ outcome: string; reasons: string }>(
                `SELECT outcome, reasons FROM witness_evidence WHERE game_id = ?`, gameId,
            );
            expect(trail).toMatchObject({ outcome: 'attempt_refused' });
            expect(JSON.parse(trail!.reasons)).toEqual(['over_limit']);
        });

        it('the runner\'s evidence list names the player (resolved label), never the raw id', async () => {
            const { tournamentId } = await createLimitedGame(roomId, 3);
            const db = await getDatabase();
            await db.run(
                `INSERT OR REPLACE INTO user_profiles (discord_user_id, display_name) VALUES (?, 'Mox')`, USER,
            );
            await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery() });
            const { WitnessEvidenceService } = await import('../services/WitnessEvidenceService.js');
            const rows = await WitnessEvidenceService.listForTournament(tournamentId);
            expect(rows.length).toBeGreaterThan(0);
            expect(rows[0]!.playerLabel).toBe('Mox');
        });

        it('a score with no reported start is refused as unreported', async () => {
            const { gameId } = await createLimitedGame(roomId, 3);
            const res = await request(app).get('/api/witness/score')
                .query({ device: DESKTOP, token, ...scoreQuery() });
            expect(res.body).toMatchObject({ status: 'not_sanctioned', reasons: [ATTEMPT_REFUSAL_TEXT.unreported] });
            expect(await boardRows(gameId)).toHaveLength(0);
        });
    });

    describe('cabinet (counted at report time)', () => {
        let token: string;
        beforeEach(async () => {
            token = await pairDevice(app, CABINET);
            await designate(CABINET, roomId);
        });

        const report = (startedOffsetMin: number, score: number, extra: Record<string, unknown> = {}) => {
            const endedMs = Date.now() - startedOffsetMin * MINUTE + 4 * MINUTE;
            return request(app).get('/api/witness/score').query({
                device: CABINET, token,
                ...scoreQuery({
                    score,
                    started: Math.floor((Date.now() - startedOffsetMin * MINUTE) / 1000),
                    ended: Math.floor(Math.min(endedMs, Date.now()) / 1000),
                    ...extra,
                }),
            });
        };

        it('three reports on a 2-attempt game: two land, the third is refused (no_match on the wire)', async () => {
            const { gameId } = await createLimitedGame(roomId, 2);
            const r1 = await report(30, 1_000_000);
            const r2 = await report(20, 2_000_000);
            const r3 = await report(10, 3_000_000);
            expect(r1.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2, remaining: 1 } });
            expect(r2.body).toMatchObject({ status: 'ingested', attempt: { n: 2, of: 2, remaining: 0 } });
            expect(r3.body).toMatchObject({ ok: true, status: 'no_match' });
            expect(r3.body.reasons).toBeUndefined();
            expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000, 2_000_000]);
        });

        it('a replayed cabinet report does not consume a second attempt', async () => {
            const { gameId, tournamentId } = await createLimitedGame(roomId, 2);
            const started = Math.floor((Date.now() - 30 * MINUTE) / 1000);
            const q = { started, ended: started + 240, score: 1_234_567 };
            const a = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...scoreQuery(q) });
            const b = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...scoreQuery(q) });
            expect(a.body.status).toBe('ingested');
            expect(b.body.status).toBe('duplicate');
            expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(1);
            const next = await report(10, 2_000_000);
            expect(next.body).toMatchObject({ status: 'ingested', attempt: { n: 2 } });
        });

        it('restarts=2 on a 3-attempt game: the restarts use attempts 1–2, the game lands as 3; a second such report is over_limit', async () => {
            const { gameId, tournamentId } = await createLimitedGame(roomId, 3);
            const first = await report(30, 1_000_000, { restarts: 2 });
            expect(first.body).toMatchObject({ status: 'ingested', attempt: { n: 3, of: 3, remaining: 0 } });
            const db = await getDatabase();
            const restartRows = await db.all<Array<{ attempt_no: number; status: string; note: string }>>(
                `SELECT attempt_no, status, note FROM attempts WHERE attempt_key LIKE 'cab:%:r%' ORDER BY attempt_no`,
            );
            expect(restartRows).toEqual([
                { attempt_no: 1, status: 'counted', note: 'restart' },
                { attempt_no: 2, status: 'counted', note: 'restart' },
            ]);
            // Replaying the same report adds nothing.
            await report(30, 1_000_000, { restarts: 2 });
            expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(3);

            const second = await report(10, 2_000_000, { restarts: 2 });
            expect(second.body).toMatchObject({ ok: true, status: 'no_match' });
            expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000]);
        });

        it('a cabinet attempt call (no_score) is never late and keeps its reason; a later score report for the same start binds to that row', async () => {
            const { gameId, tournamentId } = await createLimitedGame(roomId, 2);
            const started = Math.floor((Date.now() - 30 * MINUTE) / 1000);
            const att = await request(app).get('/api/witness/attempt').query({
                device: CABINET, token, table: 'Bad Cats (Williams 1989)', rom: 'bcats_l5', slug: 'vpx-badcats',
                started, ended: started + 10, key: `cab:${started}`, reason: 'no_score',
            });
            expect(att.body).toMatchObject({ ok: true, status: 'counted', attempt: 1, of: 2, late: false });
            const db = await getDatabase();
            const row = await db.get<{ note: string; ended_ts: number; late: number }>(
                `SELECT note, ended_ts, late FROM attempts WHERE attempt_key = ?`, `cab:${started}`,
            );
            expect(row).toEqual({ note: 'no_score', ended_ts: started + 10, late: 0 });

            const res = await request(app).get('/api/witness/score').query({
                device: CABINET, token, ...scoreQuery({ started, ended: started + 240, score: 777_000 }),
            });
            expect(res.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2 } });
            expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(1);
        });

        it('a cabinet score report first, then an attempt call for the same start: one row, the stored answer', async () => {
            const { gameId, tournamentId } = await createLimitedGame(roomId, 2);
            const started = Math.floor((Date.now() - 30 * MINUTE) / 1000);
            await request(app).get('/api/witness/score').query({
                device: CABINET, token, ...scoreQuery({ started, ended: started + 240, score: 888_000 }),
            });
            const att = await request(app).get('/api/witness/attempt').query({
                device: CABINET, token, table: 'Bad Cats (Williams 1989)', started, key: `cab:${started}`,
            });
            expect(att.body).toMatchObject({ status: 'counted', attempt: 1 });
            expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(1);
        });

        it('an exit sample cannot be counted and is refused', async () => {
            const { gameId } = await createLimitedGame(roomId, 2);
            const res = await report(30, 1_000_000, { reason: 'exit_sample' });
            expect(res.body).toMatchObject({ ok: true, status: 'no_match' });
            expect(await boardRows(gameId)).toHaveLength(0);
            const db = await getDatabase();
            const trail = await db.get<{ outcome: string; reasons: string }>(
                `SELECT outcome, reasons FROM witness_evidence WHERE game_id = ?`, gameId,
            );
            expect(trail!.outcome).toBe('attempt_refused');
            expect(JSON.parse(trail!.reasons)).toEqual(['exit_sample']);
        });
    });

    it('the public integrity read carries maxAttempts and per-game usage', async () => {
        const token = await pairDevice(app, DESKTOP, 'desktop');
        await designate(DESKTOP, roomId);
        const { tournamentId, gameId } = await createLimitedGame(roomId, 5);
        await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, table: 'Bad Cats', started: Math.floor(Date.now() / 1000), key: 'one' });
        const res = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
        expect(res.status).toBe(200);
        expect(res.body.maxAttempts).toBe(5);
        expect(res.body.attempts).toEqual({ [gameId]: { [USER]: 1 } });
    });
});

describe('manual submits refuse a limited tournament', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('checkAttemptLimitSubmission → ATTEMPTS_WITNESS_ONLY for a limited tournament, ok otherwise', async () => {
        const roomId = await createTestRoom();
        const limited = await createLimitedGame(roomId, 3);
        const open = await createLimitedGame(roomId, null, 'Other');
        expect(await checkAttemptLimitSubmission(limited.tournamentId)).toEqual({
            ok: false, code: 'ATTEMPTS_WITNESS_ONLY', message: ATTEMPTS_WITNESS_ONLY_MESSAGE,
        });
        expect(await checkAttemptLimitSubmission(open.tournamentId)).toEqual({ ok: true });
        expect(await checkAttemptLimitSubmission(null)).toEqual({ ok: true });
    });

    it('the web submit route answers 409 { code: ATTEMPTS_WITNESS_ONLY }', async () => {
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        const roomId = await createTestRoom();
        await addMember(roomId, USER);
        await createLimitedGame(roomId, 3);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent('Bad Cats')}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`)
            .send({ score: 1000, engine: 'vpx', device: 'pc' });
        expect(res.status).toBe(409);
        expect(res.body).toEqual({ error: ATTEMPTS_WITNESS_ONLY_MESSAGE, code: 'ATTEMPTS_WITNESS_ONLY' });
    });
});
