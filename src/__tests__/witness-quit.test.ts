import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { parseQuitEvidence } from '../utils/quitEvidence.js';
import { AttemptService } from '../services/AttemptService.js';
import { WitnessEvidenceService } from '../services/WitnessEvidenceService.js';

/**
 * W49 (v2.189.0, castcade B16) — a game the player QUIT before game over.
 *
 * The Castcade companion sends `quit=1` (+ `quit_ball=<n>`), `quit=0`, or
 * nothing. The game still posts and counts - the same status and rank as
 * without the field - and in Limited attempts it still uses its attempt (a
 * quit must not buy a free retry). The fact is stored on the evidence row and
 * shipped as its own `quits` map on the public integrity read. Badge, never
 * gate.
 */

const USER = '123456789012345678';
const DESKTOP = 'castcade-install-uuid-quit';
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

async function pairDesktop(app: express.Express) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: DESKTOP, username: 'Owner', type: 'desktop' });
    return pairRes.body.token as string;
}

async function roomGame(roomId: string, maxAttempts: number | null = null, name = 'Bad Cats') {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
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
    const { WitnessService } = await import('../services/WitnessService.js');
    await WitnessService.setDeviceTarget(USER, DESKTOP, { roomId, tournamentId: null });
    return { tournamentId, gameId };
}

function scoreQuery(over: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Bad Cats (Williams 1989)', rom: 'bcats_l5', slug: 'vpx-badcats',
        score: 8366650,
        started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 300, reason: 'game_over', ...over,
    };
}

describe('parseQuitEvidence', () => {
    it('quit=1 with an in-range ball', () => {
        expect(parseQuitEvidence({ quit: '1', quit_ball: '2' })).toEqual({ quit: true, quitBall: 2 });
        expect(parseQuitEvidence({ quit: '1', quit_ball: '10' })).toEqual({ quit: true, quitBall: 10 });
        expect(parseQuitEvidence({ quit: 1, quit_ball: 3 })).toEqual({ quit: true, quitBall: 3 });
    });

    it('quit=1 with no ball (Stern SAM, a map with no current ball)', () => {
        expect(parseQuitEvidence({ quit: '1' })).toEqual({ quit: true, quitBall: null });
    });

    it('quit=0 means it reached game over; a stray ball is ignored', () => {
        expect(parseQuitEvidence({ quit: '0' })).toEqual({ quit: false, quitBall: null });
        expect(parseQuitEvidence({ quit: 0 })).toEqual({ quit: false, quitBall: null });
        expect(parseQuitEvidence({ quit: '0', quit_ball: '2' })).toEqual({ quit: false, quitBall: null });
    });

    it('anything else for quit is unknown (null), never an error', () => {
        for (const bad of [undefined, null, '', '2', 'true', 'yes', '01', '-1', ['1'], 2, true]) {
            expect(parseQuitEvidence({ quit: bad })).toBeNull();
        }
        expect(parseQuitEvidence({})).toBeNull();
    });

    it('an out-of-range or malformed ball is dropped, the quit is kept', () => {
        for (const bad of ['0', '11', '-1', '2.5', 'x', '', '002', ['2'], 99, 0, 2.5]) {
            expect(parseQuitEvidence({ quit: '1', quit_ball: bad })).toEqual({ quit: true, quitBall: null });
        }
    });

    it('a ball with no quit (or quit unknown) is null', () => {
        expect(parseQuitEvidence({ quit_ball: '2' })).toBeNull();
        expect(parseQuitEvidence({ quit: 'maybe', quit_ball: '2' })).toBeNull();
    });
});

describe('W49 - quit on the evidence row', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairDesktop(app);
    }, 30_000);

    const send = (over: Record<string, unknown> = {}) =>
        request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...scoreQuery(), ...over });

    it('a quit game lands exactly as it would have without the field, and the fact is stored and shipped', async () => {
        const { gameId, tournamentId } = await roomGame(roomId);
        const plain = await send({ score: 5_000_000, ended: Math.floor(Date.now() / 1000) - 900, started: Math.floor(Date.now() / 1000) - 1200 });
        const quit = await send({ score: 6_000_000, quit: '1', quit_ball: '2' });
        expect(plain.body).toMatchObject({ ok: true, status: 'ingested' });
        expect(quit.body).toMatchObject({ ok: true, status: plain.body.status, game: plain.body.game });

        const db = await getDatabase();
        const rows = await db.all<Array<{ id: number; score: number }>>(
            `SELECT id, score FROM score_history WHERE game_id = ? AND source = 'vpx' ORDER BY score`, gameId,
        );
        expect(rows.map(r => r.score)).toEqual([5_000_000, 6_000_000]);

        const ev = await db.all<Array<{ score: number; quit: number | null; quit_ball: number | null; score_history_id: number }>>(
            `SELECT score, quit, quit_ball, score_history_id FROM witness_evidence WHERE game_id = ? ORDER BY score`, gameId,
        );
        expect(ev).toEqual([
            { score: 5_000_000, quit: null, quit_ball: null, score_history_id: rows[0].id },
            { score: 6_000_000, quit: 1, quit_ball: 2, score_history_id: rows[1].id },
        ]);

        expect(await WitnessEvidenceService.quitMap(tournamentId)).toEqual({ [String(rows[1].id)]: { ball: 2 } });

        // The public integrity read ships it as its own map, beside (not inside) the verdicts.
        const pub = await request(app).get(`/api/rooms/${roomId}/tournaments/${tournamentId}/integrity`);
        expect(pub.status).toBe(200);
        expect(pub.body.quits).toEqual({ [String(rows[1].id)]: { ball: 2 } });
        expect(pub.body.verdicts).toEqual(await WitnessEvidenceService.verdictMap(tournamentId));

        // The runner's evidence rows carry it.
        const list = await WitnessEvidenceService.listForTournament(tournamentId);
        expect(list.find(r => r.score === 6_000_000)).toMatchObject({ quit: true, quitBall: 2 });
        expect(list.find(r => r.score === 5_000_000)).toMatchObject({ quit: null, quitBall: null });
    });

    it('quit=0 stores 0 and is NOT in the quit map; a quit with no ball stores a NULL ball', async () => {
        const { gameId, tournamentId } = await roomGame(roomId);
        await send({ score: 1_000_000, quit: '0', ended: Math.floor(Date.now() / 1000) - 900, started: Math.floor(Date.now() / 1000) - 1200 });
        await send({ score: 2_000_000, quit: '1' });
        const db = await getDatabase();
        const ev = await db.all<Array<{ score: number; quit: number | null; quit_ball: number | null }>>(
            `SELECT score, quit, quit_ball FROM witness_evidence WHERE game_id = ? ORDER BY score`, gameId,
        );
        expect(ev).toEqual([
            { score: 1_000_000, quit: 0, quit_ball: null },
            { score: 2_000_000, quit: 1, quit_ball: null },
        ]);
        const map = await WitnessEvidenceService.quitMap(tournamentId);
        expect(Object.values(map)).toEqual([{ ball: null }]);
    });

    it('a malformed quit never costs the score or makes a 400', async () => {
        const { gameId } = await roomGame(roomId);
        const res = await send({ quit: 'banana', quit_ball: '99' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const db = await getDatabase();
        const ev = await db.get<{ quit: number | null; quit_ball: number | null }>(
            'SELECT quit, quit_ball FROM witness_evidence WHERE game_id = ?', gameId,
        );
        expect(ev).toEqual({ quit: null, quit_ball: null });
    });

    it('a play that only reaches Global keeps the quit fact on its trail row', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status) VALUES (?, 'Bad Cats', 'pinball', 'Williams', 1989, 'approved')`,
            crypto.randomUUID(),
        );
        const res = await send({ quit: '1', quit_ball: '1' });
        expect(res.body).toMatchObject({ ok: true, status: 'global' });
        const ev = await db.get<{ outcome: string; quit: number | null; quit_ball: number | null }>(
            'SELECT outcome, quit, quit_ball FROM witness_evidence WHERE canonical_user_id = ?', USER,
        );
        expect(ev).toEqual({ outcome: 'global', quit: 1, quit_ball: 1 });
    });

    it('a quit play in Limited attempts still uses its attempt - a quit buys no free retry', async () => {
        const { gameId, tournamentId } = await roomGame(roomId, 2);
        const q = scoreQuery({ quit: '1', quit_ball: '2' });
        const att = await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: Math.floor(Date.now() / 1000), key: 'quit-1' });
        expect(att.body).toMatchObject({ status: 'counted', attempt: 1, of: 2 });

        const res = await request(app).get('/api/witness/score').query({ device: DESKTOP, token, ...q, attempt: 'quit-1' });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested', attempt: { n: 1, of: 2, remaining: 1 } });
        expect((await AttemptService.usedByGame(tournamentId))[gameId]![USER]).toBe(1);

        // The next start is attempt 2, not a fresh attempt 1.
        const att2 = await request(app).get('/api/witness/attempt')
            .query({ device: DESKTOP, token, table: q.table, rom: q.rom, slug: q.slug, started: Math.floor(Date.now() / 1000), key: 'quit-2' });
        expect(att2.body).toMatchObject({ status: 'counted', attempt: 2, of: 2, remaining: 0 });

        const ev = await (await getDatabase()).get<{ quit: number; quit_ball: number }>(
            'SELECT quit, quit_ball FROM witness_evidence WHERE game_id = ? AND score = ?', gameId, q.score,
        );
        expect(ev).toEqual({ quit: 1, quit_ball: 2 });
    });
});
