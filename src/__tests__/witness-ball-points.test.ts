import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { parseBallPoints, MAX_BALL_ENTRIES } from '../utils/ballPoints.js';

/**
 * W48 (v2.180.0) — per-ball points on a witness score.
 *
 * Cabinet 1.0.6 sends `balls=` (the launcher's own per-ball points for the
 * game, raw). They are stored on the score's evidence row for a later per-ball
 * format, and are never allowed to cost the score: a malformed value is
 * dropped, never a 400.
 */

const USER = '123456789012345678';
const CABINET = 'fp-device-uuid-amh';
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

async function pairCabinet(app: express.Express) {
    const codeRes = await request(app)
        .post('/api/me/witness/pairing-code')
        .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
    const pairRes = await request(app)
        .get('/api/witness/pair')
        .query({ code: codeRes.body.code, device: CABINET, username: 'Owner' });
    return pairRes.body.token as string;
}

async function roomGame(roomId: string, name: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, 'Spooky Season', 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
        tournamentId, roomId,
    );
    const gameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        gameId, tournamentId, name, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
    return { tournamentId, gameId };
}

/** ChalataLove's 2026-10-26 00:43Z game: balls 1+2 recorded, ball 3 never written, the table's own final 6,346,370. */
function amhScore(over: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: "America's Most Haunted (Spooky Pinball 2014)", rom: "America's Most Haunted",
        slug: 'vpx-americasmosthaunted', score: 6346370,
        started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 243, reason: 'shutdown', balls: '2149140,2778720', ...over,
    };
}

describe('parseBallPoints', () => {
    it('reads the cabinet wire value, raw, in ball order (0 kept: it is what the launcher wrote)', () => {
        expect(parseBallPoints('2149140,2778720')).toEqual([2149140, 2778720]);
        expect(parseBallPoints('485110,6898420,0')).toEqual([485110, 6898420, 0]);
        expect(parseBallPoints('5')).toEqual([5]);
    });

    it('drops anything malformed whole, never guesses at part of it', () => {
        for (const bad of [undefined, null, '', ',', '1,,2', '1,-2', '1.5,2', '1, 2', 'abc', '1,2,', ['1', '2'], 12345,
            '99999999999999999']) {
            expect(parseBallPoints(bad)).toBeNull();
        }
        expect(parseBallPoints(Array(MAX_BALL_ENTRIES + 1).fill('1').join(','))).toBeNull();
        expect(parseBallPoints(Array(MAX_BALL_ENTRIES).fill('1').join(','))).toHaveLength(MAX_BALL_ENTRIES);
    });
});

describe('W48 — per-ball points on the evidence row', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairCabinet(app);
    }, 30_000); // the first run imports the whole API router cold

    it('a cabinet score that lands on a room board stores the balls beside the score it produced', async () => {
        const { gameId } = await roomGame(roomId, "America's Most Haunted");
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...amhScore() });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });

        const db = await getDatabase();
        const sh = await db.get<{ id: number; score: number }>(
            `SELECT id, score FROM score_history WHERE game_room_id = ? AND source = 'vpx'`, roomId,
        );
        expect(sh!.score).toBe(6346370);
        const ev = await db.get<{ ball_points: string | null; score_history_id: number; verdict: string | null }>(
            `SELECT ball_points, score_history_id, verdict FROM witness_evidence WHERE game_id = ?`, gameId,
        );
        expect(ev).toEqual({ ball_points: '[2149140,2778720]', score_history_id: sh!.id, verdict: null });
        // The unrecorded final ball is derivable, not stored separately: 6,346,370 − (2,149,140 + 2,778,720).
        const balls = JSON.parse(ev!.ball_points!) as number[];
        expect(sh!.score - balls.reduce((a, b) => a + b, 0)).toBe(1418510);
    });

    it('a play that only reaches Global keeps its balls too (the trail is written for every outcome)', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status) VALUES (?, ?, 'pinball', 'Spooky Pinball', 2014, 'approved')`,
            crypto.randomUUID(), "America's Most Haunted",
        );
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...amhScore() });
        expect(res.body).toMatchObject({ ok: true, status: 'global' });
        const ev = await db.get<{ outcome: string; ball_points: string | null }>(
            `SELECT outcome, ball_points FROM witness_evidence WHERE canonical_user_id = ?`, USER,
        );
        expect(ev).toEqual({ outcome: 'global', ball_points: '[2149140,2778720]' });
    });

    it('a malformed balls value never costs the score; a device that sends none stores NULL', async () => {
        const { gameId } = await roomGame(roomId, "America's Most Haunted");
        const bad = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...amhScore({ balls: '1,x' }) });
        expect(bad.body).toMatchObject({ ok: true, status: 'ingested' });

        const none = await request(app).get('/api/witness/score').query({
            device: CABINET, token, ...amhScore({ score: 1530330, balls: undefined, ended: Math.floor(Date.now() / 1000) - 600 }),
        });
        expect(none.body).toMatchObject({ ok: true, status: 'ingested' });

        const db = await getDatabase();
        const rows = await db.all<{ score: number; ball_points: string | null }[]>(
            `SELECT score, ball_points FROM witness_evidence WHERE game_id = ? ORDER BY id`, gameId,
        );
        expect(rows).toEqual([{ score: 6346370, ball_points: null }, { score: 1530330, ball_points: null }]);
    });

    it('the runner-facing row carries ballPoints and does NOT count them as evidence (no badge for a cabinet)', async () => {
        await roomGame(roomId, "America's Most Haunted");
        await request(app).get('/api/witness/score').query({ device: CABINET, token, ...amhScore() });
        const { WitnessEvidenceService } = await import('../services/WitnessEvidenceService.js');
        const latest = await WitnessEvidenceService.latestForUser(USER);
        expect(latest).toMatchObject({ ballPoints: [2149140, 2778720], evidence: null, verdict: null });
    });
});
