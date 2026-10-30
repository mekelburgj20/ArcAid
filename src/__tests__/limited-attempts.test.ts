import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { AttemptService, ATTEMPT_LATE_SEC, ATTEMPT_REFUSAL_TEXT, attemptsLeftLine } from '../services/AttemptService.js';
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

    it('W68: a scored attempt can be voided (it stops counting); a void row cannot be voided again', async () => {
        await start('k1');
        const db = await getDatabase();
        const row = await db.get<{ id: number }>(`SELECT id FROM attempts WHERE attempt_key = 'k1'`);
        await AttemptService.markScored(row!.id, { scoreHistoryId: 1, score: 10, endedTs: now });
        await expect(AttemptService.void(row!.id, 'admin-1', ids.tournamentId))
            .resolves.toEqual({ previousStatus: 'scored', scoreHistoryId: 1 });
        expect((await AttemptService.usedByGame(ids.tournamentId))[ids.gameId]).toBeUndefined();
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

        it('W37: one game start in TWO limited tournaments (two member rooms) uses an attempt in EACH; the score lands on both', async () => {
            const otherRoom = await createTestRoom('w37-other', 'W37 Other');
            await addMember(otherRoom, USER);
            const { WitnessService } = await import('../services/WitnessService.js');
            await WitnessService.setDeviceTarget(USER, DESKTOP, { roomId: null, tournamentId: null }); // All my rooms
            const a = await createLimitedGame(roomId, 3);
            const b = await createLimitedGame(otherRoom, 5);
            const q = scoreQuery();

            const att = await request(app).get('/api/witness/attempt')
                .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: Math.floor(Date.now() / 1000), key: 'sess-w37' });
            expect(att.body).toMatchObject({ ok: true, status: 'counted', attempt: 1 });

            const res = await request(app).get('/api/witness/score')
                .query({ device: DESKTOP, token, ...q, attempt: 'sess-w37' });
            expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
            expect(res.body.landed).toHaveLength(2);
            expect(res.body.landed.map((l: { attempt?: { of: number } }) => l.attempt?.of).sort()).toEqual([3, 5]);
            expect(await boardRows(a.gameId)).toHaveLength(1);
            expect(await boardRows(b.gameId)).toHaveLength(1);
            expect((await AttemptService.usedByGame(a.tournamentId))[a.gameId]![USER]).toBe(1);
            expect((await AttemptService.usedByGame(b.tournamentId))[b.gameId]![USER]).toBe(1);
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

        it('the "Sending to" line counts down the attempts left, on heartbeat and check-in (2026-10-25)', async () => {
            const beat = async () => (await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token })).body.sendingTo as string;
            const checkin = async () => (await request(app).get('/api/witness/checkin').query({ device: CABINET, token })).body.sendingTo as string;

            // No limited game open: no suffix at all.
            expect(await beat()).not.toMatch(/ATTEMPT/);

            await createLimitedGame(roomId, 2);
            expect(await beat()).toMatch(/ · 2 OF 2 ATTEMPTS LEFT$/);
            await report(30, 1_000_000);
            expect(await checkin()).toMatch(/ · 1 OF 2 ATTEMPTS LEFT$/);
            await report(20, 2_000_000);
            expect(await beat()).toMatch(/ · NO ATTEMPTS LEFT$/);
        });

        it('the line names each table when several limited games are open, and only ones the device routes to', async () => {
            await createLimitedGame(roomId, 3, 'Bad Cats');
            await createLimitedGame(roomId, 5, 'Taxi');
            await createLimitedGame(roomId, null, 'Unlimited Table');
            const elsewhere = await createTestRoom('attempts-elsewhere', 'Elsewhere');
            await createLimitedGame(elsewhere, 4, 'Not Routed'); // not a member, not designated
            const res = await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token });
            expect(res.body.sendingTo).toMatch(/ · ATTEMPTS LEFT: BAD CATS 3\/3, TAXI 5\/5$/);
        });

        it('a "Global Scoreboard only" device shows no attempts (its plays land on no tournament)', async () => {
            await createLimitedGame(roomId, 2);
            const db = await getDatabase();
            await db.run(
                `UPDATE witness_devices SET target_room_id = NULL, target_tournament_id = NULL, global_only = 1 WHERE atgames_unique_id = ?`,
                CABINET,
            );
            const res = await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token });
            expect(res.body.sendingTo).not.toMatch(/ATTEMPT/);
        });

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

        it('W64: a restart-abandoned game posts as its own score — attempt note `restart`, quit evidence stored and badged; a normal game has no note', async () => {
            const { gameId, tournamentId } = await createLimitedGame(roomId, 3);
            const db = await getDatabase();
            const first = await report(30, 900_000, { reason: 'restart', quit: 1, quit_ball: 2 });
            expect(first.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 3 } });
            const normal = await report(20, 1_500_000, { reason: 'game_over' });
            expect(normal.body).toMatchObject({ status: 'ingested', attempt: { n: 2, of: 3 } });

            const notes = await db.all<Array<{ attempt_no: number; status: string; note: string | null }>>(
                `SELECT attempt_no, status, note FROM attempts WHERE game_id = ? ORDER BY attempt_no`, gameId,
            );
            expect(notes).toEqual([
                { attempt_no: 1, status: 'scored', note: 'restart' },
                { attempt_no: 2, status: 'scored', note: null },
            ]);

            // A CABINET report's quit params reach the evidence trail (nothing gates them on device type).
            const ev = await db.all<Array<{ score: number; quit: number | null; quit_ball: number | null }>>(
                `SELECT score, quit, quit_ball FROM witness_evidence WHERE game_id = ? ORDER BY score`, gameId,
            );
            expect(ev).toEqual([
                { score: 900_000, quit: 1, quit_ball: 2 },
                { score: 1_500_000, quit: null, quit_ball: null },
            ]);
            const { WitnessEvidenceService } = await import('../services/WitnessEvidenceService.js');
            const quits = await WitnessEvidenceService.quitMap(tournamentId);
            const rows = await boardRows(gameId);
            const quitRow = rows.find(r => r.score === 900_000)!;
            expect(quits).toEqual({ [String(quitRow.id)]: { ball: 2 } });
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

describe('W38 (ADR 0033 §3–4): plays that straddle the window, and "Start attempts"', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        await addMember(roomId, USER);
    });

    async function requireStart(tournamentId: string, on = true) {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET require_attempt_start = ? WHERE id = ?', on ? 1 : 0, tournamentId);
    }
    const pressStart = (tournamentId: string, gameId: string, who = USER) =>
        request(app).post(`/api/rooms/${roomId}/tournaments/${tournamentId}/games/${gameId}/attempt-start`)
            .set('Authorization', `Bearer ${playerToken(who)}`).send({});
    async function attemptRows(gameId: string) {
        const db = await getDatabase();
        return db.all<Array<{ status: string; attempt_no: number; note: string | null }>>(
            'SELECT status, attempt_no, note FROM attempts WHERE game_id = ? ORDER BY id', gameId,
        );
    }

    it('§3: a desktop play that STARTED before the window and ended inside it counts (it used to be refused as unreported)', async () => {
        const token = await pairDevice(app, DESKTOP, 'desktop');
        const { gameId } = await createLimitedGame(roomId, 3);
        const db = await getDatabase();
        // The rotation game went up 2 minutes ago; this game started 5 minutes ago.
        await db.run('UPDATE games SET start_date = ? WHERE id = ?', new Date(Date.now() - 2 * MINUTE).toISOString(), gameId);
        const q = scoreQuery();

        const att = await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: q.started, key: 'early-1' });
        expect(att.body.status).toBe('no_match'); // no open game at the start: nothing counted yet
        expect(await attemptRows(gameId)).toHaveLength(0);

        const res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...q, attempt: 'early-1' });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested', attempt: { n: 1, of: 3, remaining: 2 } });
        expect(await boardRows(gameId)).toHaveLength(1);
        expect(await attemptRows(gameId)).toEqual([{ status: 'scored', attempt_no: 1, note: 'started before the window' }]);
    });

    describe('Start attempts required', () => {
        it('desktop: before the press a start counts nothing and its score goes to Global as not_started; after it, plays count', async () => {
            const token = await pairDevice(app, DESKTOP, 'desktop');
            const { tournamentId, gameId } = await createLimitedGame(roomId, 2);
            await requireStart(tournamentId);
            const q = scoreQuery();
            const nowSec = Math.floor(Date.now() / 1000);

            const att = await request(app).get('/api/witness/attempt')
                .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: nowSec, key: 'pre-1' });
            expect(att.body).toMatchObject({ status: 'no_match', reason: ATTEMPT_REFUSAL_TEXT.not_started });
            const before = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...q, attempt: 'pre-1' });
            expect(before.body).toMatchObject({ status: 'not_sanctioned', reasons: [ATTEMPT_REFUSAL_TEXT.not_started] });
            expect(await attemptRows(gameId)).toHaveLength(0); // used no attempt
            expect(await boardRows(gameId)).toHaveLength(0);

            const pressed = await pressStart(tournamentId, gameId);
            expect(pressed.status).toBe(200);
            const startedTs = pressed.body.startedTs as number;

            const att2 = await request(app).get('/api/witness/attempt')
                .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: startedTs + 5, key: 'post-1' });
            expect(att2.body).toMatchObject({ status: 'counted', attempt: 1, of: 2 });
            const after = await request(app).get('/api/witness/score')
                .query({ device: DESKTOP, token, ...q, score: 4_000_000, started: startedTs + 5, ended: startedTs + 305, attempt: 'post-1' });
            expect(after.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2 } });
            expect(await boardRows(gameId)).toHaveLength(1);
        });

        it('a game that began BEFORE the press does not count even if it ends after it', async () => {
            const token = await pairDevice(app, DESKTOP, 'desktop');
            const { tournamentId, gameId } = await createLimitedGame(roomId, 2);
            await requireStart(tournamentId);
            const startedTs = (await pressStart(tournamentId, gameId)).body.startedTs as number;
            const res = await request(app).get('/api/witness/score')
                .query({ device: DESKTOP, token, ...scoreQuery({ started: startedTs - 30, ended: startedTs + 200 }) });
            expect(res.body).toMatchObject({ status: 'not_sanctioned', reasons: [ATTEMPT_REFUSAL_TEXT.not_started] });
            expect(await attemptRows(gameId)).toHaveLength(0);
        });

        it('cabinet: a report before the press uses nothing (no_match); after it, it counts; the line reads NOT STARTED until then', async () => {
            const token = await pairDevice(app, CABINET);
            const { tournamentId, gameId } = await createLimitedGame(roomId, 2);
            await requireStart(tournamentId);
            const beat = async () => (await request(app).get('/api/witness/heartbeat').query({ device: CABINET, token })).body.sendingTo as string;
            expect(await beat()).toMatch(/ · ATTEMPTS NOT STARTED$/);

            const nowSec = Math.floor(Date.now() / 1000);
            const early = await request(app).get('/api/witness/score')
                .query({ device: CABINET, token, ...scoreQuery({ started: nowSec - 300, ended: nowSec - 10 }) });
            expect(early.body).toMatchObject({ ok: true, status: 'no_match' });
            expect(await attemptRows(gameId)).toHaveLength(0);

            const startedTs = (await pressStart(tournamentId, gameId)).body.startedTs as number;
            expect(await beat()).toMatch(/ · 2 OF 2 ATTEMPTS LEFT$/);
            const later = await request(app).get('/api/witness/score')
                .query({ device: CABINET, token, ...scoreQuery({ score: 5_000_000, started: startedTs, ended: startedTs + 200 }) });
            expect(later.body).toMatchObject({ status: 'ingested', attempt: { n: 1, of: 2 } });
        });

        it('the press is idempotent (keeps the first time) and the viewer can read it back', async () => {
            const { tournamentId, gameId } = await createLimitedGame(roomId, 2);
            await requireStart(tournamentId);
            const { AttemptService } = await import('../services/AttemptService.js');
            const first = await AttemptService.startAttempts({ tournamentId, gameId, canonicalUserId: USER, source: 'web', nowSec: 1000 });
            const second = await AttemptService.startAttempts({ tournamentId, gameId, canonicalUserId: USER, source: 'web', nowSec: 2000 });
            expect([first, second]).toEqual([1000, 1000]);
            const me = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/attempt-starts/me`)
                .set('Authorization', `Bearer ${playerToken(USER)}`);
            expect(me.body).toEqual({ starts: { [gameId]: 1000 } });
        });

        it('refuses a press from a non-member (403), on a tournament without the setting (409) and on a closed table (409)', async () => {
            const { tournamentId, gameId } = await createLimitedGame(roomId, 2);
            const notRequired = await pressStart(tournamentId, gameId);
            expect(notRequired.status).toBe(409);
            expect(notRequired.body.code).toBe('NOT_REQUIRED');

            await requireStart(tournamentId);
            const stranger = await pressStart(tournamentId, gameId, '999999999999999999');
            expect(stranger.status).toBe(403);
            expect(stranger.body.code).toBe('NOT_ENTERED');

            const db = await getDatabase();
            await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id = ?`, gameId);
            const closed = await pressStart(tournamentId, gameId);
            expect(closed.status).toBe(409);
            expect(closed.body.code).toBe('NOT_OPEN');
        });

        it('the public integrity read says the tournament requires it; the setting survives an edit that omits it', async () => {
            const { tournamentId } = await createLimitedGame(roomId, 2);
            const { TournamentService } = await import('../services/TournamentService.js');
            const db = await getDatabase();
            const stored = await db.get<Record<string, unknown>>('SELECT * FROM tournaments WHERE id = ?', tournamentId);
            const base = {
                name: stored!.name as string, type: stored!.type as string, cadence: {}, game_room_id: roomId, is_active: true,
            };
            await TournamentService.update(tournamentId, { ...base, require_attempt_start: true });
            await TournamentService.update(tournamentId, base); // omits it
            const read = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
            expect(read.body).toMatchObject({ maxAttempts: 2, requireAttemptStart: true });
            await TournamentService.update(tournamentId, { ...base, require_attempt_start: false });
            const off = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
            expect(off.body.requireAttemptStart).toBe(false);
        });
    });
});

describe('W56: the room top-level "Start attempts" list (GET /rooms/:roomId/attempt-starts/me)', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        await addMember(roomId, USER);
    });

    async function requireStart(tournamentId: string, on = true) {
        const db = await getDatabase();
        await db.run('UPDATE tournaments SET require_attempt_start = ? WHERE id = ?', on ? 1 : 0, tournamentId);
    }
    const roomList = (who = USER, room = roomId) =>
        request(app).get(`/api/rooms/${room}/attempt-starts/me`).set('Authorization', `Bearer ${playerToken(who)}`);

    it('lists every open start-required limited game with whether the viewer pressed it', async () => {
        const congo = await createLimitedGame(roomId, 3, 'Congo');
        const cactus = await createLimitedGame(roomId, 3, 'Cactus Canyon');
        await requireStart(congo.tournamentId);
        await requireStart(cactus.tournamentId);
        await AttemptService.startAttempts({ tournamentId: cactus.tournamentId, gameId: cactus.gameId, canonicalUserId: USER, source: 'web', nowSec: 1234 });

        const res = await roomList();
        expect(res.status).toBe(200);
        const byName = Object.fromEntries((res.body.games as Array<{ gameName: string }>).map(g => [g.gameName, g]));
        expect(Object.keys(byName).sort()).toEqual(['Cactus Canyon', 'Congo']);
        expect(byName['Congo']).toEqual({
            gameId: congo.gameId, gameName: 'Congo', tournamentId: congo.tournamentId, tournamentName: 'Five Shots',
            roundNo: null, started: false, startedTs: null,
        });
        expect(byName['Cactus Canyon']).toMatchObject({ gameId: cactus.gameId, started: true, startedTs: 1234 });
    });

    it('leaves out a tournament without the setting, an unlimited one and a closed table', async () => {
        const notRequired = await createLimitedGame(roomId, 3, 'No Press');
        const unlimited = await createLimitedGame(roomId, null, 'Unlimited');
        await requireStart(unlimited.tournamentId);
        const closed = await createLimitedGame(roomId, 3, 'Closed');
        await requireStart(closed.tournamentId);
        const db = await getDatabase();
        await db.run(`UPDATE games SET status = 'COMPLETED' WHERE id = ?`, closed.gameId);
        const finished = await createLimitedGame(roomId, 3, 'Finished Event');
        await requireStart(finished.tournamentId);
        await db.run(`UPDATE tournaments SET event_finished_at = CURRENT_TIMESTAMP WHERE id = ?`, finished.tournamentId);
        expect(notRequired.gameId).toBeTruthy();

        const res = await roomList();
        expect(res.status).toBe(200);
        expect(res.body.games).toEqual([]);
    });

    it('leaves out a game the viewer is not allowed in (not a member; invite-only and off the roster)', async () => {
        const { tournamentId } = await createLimitedGame(roomId, 3, 'Congo');
        await requireStart(tournamentId);
        const stranger = await roomList('999999999999999999');
        expect(stranger.status).toBe(200);
        expect(stranger.body.games).toEqual([]);

        const db = await getDatabase();
        await db.run(`UPDATE tournaments SET entry_mode = 'invited' WHERE id = ?`, tournamentId);
        expect((await roomList()).body.games).toEqual([]);
        await db.run("INSERT INTO tournament_roster (tournament_id, user_id, source) VALUES (?, ?, 'host')", tournamentId, USER);
        expect((await roomList()).body.games).toHaveLength(1);
    });

    it('only lists this room\'s games; a press through the existing POST flips started', async () => {
        const other = await createTestRoom('other-room', 'Other Room');
        await addMember(other, USER);
        const elsewhere = await createLimitedGame(other, 3, 'Elsewhere');
        await requireStart(elsewhere.tournamentId);
        const here = await createLimitedGame(roomId, 3, 'Congo');
        await requireStart(here.tournamentId);

        const before = await roomList();
        expect(before.body.games.map((g: { gameName: string }) => g.gameName)).toEqual(['Congo']);
        expect(before.body.games[0].started).toBe(false);
        const pressed = await request(app)
            .post(`/api/rooms/${roomId}/tournaments/${here.tournamentId}/games/${here.gameId}/attempt-start`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        expect(pressed.status).toBe(200);
        const after = await roomList();
        expect(after.body.games[0]).toMatchObject({ started: true, startedTs: pressed.body.startedTs });
    });

    it('needs a logged-in player, and 404s an unknown room', async () => {
        expect((await request(app).get(`/api/rooms/${roomId}/attempt-starts/me`)).status).toBe(401);
        expect((await roomList(USER, 'no-such-room')).status).toBe(404);
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

/**
 * W68 (owner 2026-10-30) — the host can give back a SCORED attempt (optionally
 * deleting its score through the ordinary per-row delete), and REINSTATE an
 * over-the-limit play once room exists. Born from the Test #4 SAM fragments:
 * per-ball records ate a player's attempts, so their real game went over_limit.
 */
describe('W68: void a scored attempt, reinstate an over-the-limit play', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;
    const adminToken = () => signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'admin' });
    const playedAtOf = (ended: number) => new Date(ended * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        await addMember(roomId, USER);
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Bad Cats', 'pinball', 'Williams', 1989, 'approved')`,
            crypto.randomUUID(),
        );
        token = await pairDevice(app, CABINET);
        await designate(CABINET, roomId);
    });

    /** One cabinet report: started `minAgo` minutes ago, four minutes long. */
    const play = (minAgo: number, score: number) => {
        const started = Math.floor((Date.now() - minAgo * MINUTE) / 1000);
        const ended = started + 240;
        return {
            started, ended, score,
            send: () => request(app).get('/api/witness/score').query({ device: CABINET, token, ...scoreQuery({ started, ended, score }) }),
        };
    };
    const attemptRow = async (started: number) => {
        const db = await getDatabase();
        return db.get<{ id: number; status: string; attempt_no: number; score_history_id: number | null; score: number | null }>(
            `SELECT id, status, attempt_no, score_history_id, score FROM attempts WHERE attempt_key = ?`, `cab:${started}`,
        );
    };
    const voidIt = (tournamentId: string, id: number, body: Record<string, unknown> = {}) =>
        request(app).post(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/attempts/${id}/void`)
            .set('Authorization', `Bearer ${adminToken()}`).send(body);
    const reinstate = (tournamentId: string, id: number) =>
        request(app).post(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/attempts/${id}/reinstate`)
            .set('Authorization', `Bearer ${adminToken()}`).send({});

    /** Two attempts: a real game, a per-ball fragment, then the real game that went over the limit. */
    async function fragmentScenario() {
        const ids = await createLimitedGame(roomId, 2);
        const first = play(40, 1_000_000);
        const fragment = play(30, 4_644_100);
        const real = play(20, 167_719_210);
        expect((await first.send()).body.status).toBe('ingested');
        expect((await fragment.send()).body.status).toBe('ingested');
        expect((await real.send()).body).toMatchObject({ status: 'no_match' });
        return { ...ids, first, fragment, real };
    }

    it('voiding a scored attempt with deleteScore removes the score, tombstones it, and frees the attempt; a replay stays refused', async () => {
        const { tournamentId, gameId, fragment } = await fragmentScenario();
        const row = (await attemptRow(fragment.started))!;
        expect(row).toMatchObject({ status: 'scored', score: 4_644_100 });
        expect(row.score_history_id).not.toBeNull();

        const res = await voidIt(tournamentId, row.id, { deleteScore: true });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, scoreDeleted: true });
        expect((await attemptRow(fragment.started))!.status).toBe('void');
        expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000]);

        const db = await getDatabase();
        const tomb = await db.get(
            `SELECT 1 FROM auto_score_suppressions WHERE source = 'vpx' AND owner_key = ? AND score = 4644100`, USER,
        );
        expect(tomb).toBeTruthy();
        // first + the over-limit row; the voided fragment no longer counts.
        expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(2);

        // The cabinet replays the fragment: the void is final and the score stays gone.
        await fragment.send();
        expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000]);
        expect((await attemptRow(fragment.started))!.status).toBe('void');

        const audit = await db.get<{ details: string }>(`SELECT details FROM audit_log WHERE action = 'attempt.void' ORDER BY id DESC LIMIT 1`);
        expect(JSON.parse(audit!.details)).toMatchObject({ attemptId: row.id, previousStatus: 'scored', deleteScore: true, scoreDeleted: true });
    });

    it('voiding a scored attempt WITHOUT deleteScore keeps the score on the board; the attempt stops counting', async () => {
        const { tournamentId, gameId, fragment } = await fragmentScenario();
        const row = (await attemptRow(fragment.started))!;
        const res = await voidIt(tournamentId, row.id);
        expect(res.body).toEqual({ success: true });
        expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000, 4_644_100]);
        expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(2);
    });

    it('reinstate: refused with no room; after the fragment is voided the play lands as the next attempt, once, with its own time', async () => {
        const { tournamentId, gameId, fragment, real } = await fragmentScenario();
        const over = (await attemptRow(real.started))!;
        expect(over).toMatchObject({ status: 'over_limit', attempt_no: 3, score: 167_719_210 });

        // The list says why not yet.
        let list = await request(app).get(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/attempts`)
            .set('Authorization', `Bearer ${adminToken()}`);
        let listed = list.body.attempts.find((a: { id: number }) => a.id === over.id);
        expect(listed).toMatchObject({ reinstatable: false, used: 3, voidable: true });
        expect(listed.reinstateBlockedReason).toMatch(/^No room: 2 of 2 attempts/);

        const refused = await reinstate(tournamentId, over.id);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'NO_ROOM' });
        expect(refused.body.error).toMatch(/2 of 2/);

        const db = await getDatabase();
        const globalBefore = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores WHERE score = 167719210`);
        expect(globalBefore!.n).toBe(1);

        await voidIt(tournamentId, (await attemptRow(fragment.started))!.id, { deleteScore: true });
        list = await request(app).get(`/api/rooms/${roomId}/admin/tournaments/${tournamentId}/attempts`)
            .set('Authorization', `Bearer ${adminToken()}`);
        listed = list.body.attempts.find((a: { id: number }) => a.id === over.id);
        expect(listed).toMatchObject({ reinstatable: true, reinstateBlockedReason: null });

        const res = await reinstate(tournamentId, over.id);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ success: true, attemptNo: 2, of: 2 });

        const after = (await attemptRow(real.started))!;
        expect(after).toMatchObject({ status: 'scored', attempt_no: 2, score: 167_719_210, score_history_id: res.body.scoreHistoryId });

        const landed = await db.get<{ created_at: string; submitted_during_tournament_id: string; source: string; device: string; engine: string }>(
            `SELECT created_at, submitted_during_tournament_id, source, device, engine FROM score_history WHERE id = ?`,
            res.body.scoreHistoryId,
        );
        expect(landed).toEqual({
            created_at: playedAtOf(real.ended), submitted_during_tournament_id: tournamentId,
            source: 'vpx', device: 'atgames', engine: 'vpx',
        });
        expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000, 167_719_210]);

        // The board reads it, and no second Global row was written.
        const { LeaderboardService } = await import('../services/LeaderboardService.js');
        const board = await LeaderboardService.getForGame(gameId);
        expect(board[0]).toMatchObject({ score: 167_719_210 });
        const globalAfter = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_scores WHERE score = 167719210`);
        expect(globalAfter!.n).toBe(1);

        // The trail reads it as counted, so "Where your plays went" does too.
        const trail = await db.get<{ outcome: string; score_history_id: number; global_score_id: string | null }>(
            `SELECT outcome, score_history_id, global_score_id FROM witness_evidence WHERE score = 167719210 AND game_id = ?`, gameId,
        );
        expect(trail).toMatchObject({ outcome: 'ingested', score_history_id: res.body.scoreHistoryId });
        expect(trail!.global_score_id).not.toBeNull();
        const { WitnessEvidenceService } = await import('../services/WitnessEvidenceService.js');
        const plays = await WitnessEvidenceService.recentPlaysForUser(USER);
        const thePlay = plays.find(p => p.score === 167_719_210)!;
        expect(thePlay.destinations.map(d => d.status)).toEqual(['counted']);

        // A replay of the reinstated report adds nothing; a second reinstate is refused.
        await real.send();
        expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000, 167_719_210]);
        const again = await reinstate(tournamentId, over.id);
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('NOT_REINSTATABLE');

        const audit = await db.get<{ details: string }>(`SELECT details FROM audit_log WHERE action = 'attempt.reinstate' ORDER BY id DESC LIMIT 1`);
        expect(JSON.parse(audit!.details)).toMatchObject({ attemptId: over.id, attemptNo: 2, of: 2 });
    });

    it('reinstate refuses a row that is not over the limit', async () => {
        const { tournamentId, first } = await fragmentScenario();
        const res = await reinstate(tournamentId, (await attemptRow(first.started))!.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('NOT_REINSTATABLE');
    });

    it('reinstate refuses a play somebody deleted (SUPPRESSED) and changes nothing', async () => {
        const { tournamentId, gameId, fragment, real } = await fragmentScenario();
        await voidIt(tournamentId, (await attemptRow(fragment.started))!.id);
        const { AutoScoreSuppressionService } = await import('../services/AutoScoreSuppressionService.js');
        await AutoScoreSuppressionService.record({
            source: 'vpx', ownerKey: USER, gameName: 'Bad Cats', score: real.score, playedAt: playedAtOf(real.ended), gameRoomId: roomId,
        });
        const over = (await attemptRow(real.started))!;
        const res = await reinstate(tournamentId, over.id);
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('SUPPRESSED');
        expect((await attemptRow(real.started))).toMatchObject({ status: 'over_limit', attempt_no: over.attempt_no });
        // The fragment was voided without deleting its score; the deleted play did not land.
        expect((await boardRows(gameId)).map(r => r.score)).toEqual([1_000_000, 4_644_100]);
    });

    it('reinstate refuses an over-limit start that never stored a score (a desktop start) — MISSING_PLAY', async () => {
        const { tournamentId, gameId } = await createLimitedGame(roomId, 1);
        const now = Math.floor(Date.now() / 1000);
        const base = { tournamentId, gameId, gameRoomId: roomId, canonicalUserId: USER, deviceId: DESKTOP, limit: 1, startedTs: now, nowSec: now };
        await AttemptService.recordStart({ ...base, key: 'd1' });
        await AttemptService.recordStart({ ...base, key: 'd2' });
        const db = await getDatabase();
        const [r1, r2] = await db.all<Array<{ id: number }>>(`SELECT id FROM attempts WHERE game_id = ? ORDER BY id`, gameId);
        await AttemptService.void(r1!.id, 'admin-1', tournamentId);
        await expect(AttemptService.reinstateAttempt(r2!.id, tournamentId, 'admin-1'))
            .rejects.toMatchObject({ code: 'MISSING_PLAY', httpStatus: 409 });
    });
});

describe('attemptsLeftLine (the cabinet suffix)', () => {
    it('one game: "N OF M ATTEMPTS LEFT", zero reads "NO ATTEMPTS LEFT", none is empty', () => {
        expect(attemptsLeftLine([])).toBe('');
        expect(attemptsLeftLine([{ gameName: 'Taxi', left: 7, limit: 10 }])).toBe(' · 7 OF 10 ATTEMPTS LEFT');
        expect(attemptsLeftLine([{ gameName: 'Taxi', left: 0, limit: 10 }])).toBe(' · NO ATTEMPTS LEFT');
    });

    it('several games: each table named, alphabetical, upper case', () => {
        expect(attemptsLeftLine([
            { gameName: 'Taxi', left: 0, limit: 5 },
            { gameName: 'Bad Cats', left: 2, limit: 3 },
        ])).toBe(' · ATTEMPTS LEFT: BAD CATS 2/3, TAXI 0/5');
    });
});
