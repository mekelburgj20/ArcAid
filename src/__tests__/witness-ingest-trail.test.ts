import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * W29 (v2.181.0) — diagnosability.
 *
 *   1. EVERY witness score leaves exactly one `witness_evidence` row per board
 *      decision, whatever happened to it, with the server's reason — so "why
 *      didn't my score land?" is answered from the database, not the device log.
 *   2. A device target change is audited (who, from, to); a save of the same
 *      choice is not.
 */

const USER = '123456789012345678';
const CABINET = 'fp-device-uuid-trail';
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
         VALUES (?, 'Weekly', 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
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

function play(over: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Bad Cats (Williams 1989)', rom: 'bcats_l5', slug: 'vpx-badcats',
        score: 18446900, started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 300, reason: 'game_over', ...over,
    };
}

type TrailRow = { outcome: string; reasons: string; game_id: string | null; score: number };
async function trail(): Promise<TrailRow[]> {
    const db = await getDatabase();
    return db.all<TrailRow[]>(`SELECT outcome, reasons, game_id, score FROM witness_evidence WHERE device_id = ? ORDER BY id`, CABINET);
}

describe('W29 — every witness score leaves a trail row with its reason', () => {
    let app: express.Express;
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        token = await pairCabinet(app);
    }, 30_000); // the first run imports the whole API router cold

    it('an invalid score (0) is recorded as invalid, with why', async () => {
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play({ score: 0 }) });
        expect(res.body).toMatchObject({ ok: true, status: 'invalid' });
        const rows = await trail();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ outcome: 'invalid', score: 0 });
        expect(JSON.parse(rows[0]!.reasons)).toEqual(['score is not a positive number']);
    });

    it('a score with no end time is recorded as invalid (played_at falls back to now)', async () => {
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play({ ended: 0 }) });
        expect(res.body).toMatchObject({ ok: true, status: 'invalid' });
        expect(JSON.parse((await trail())[0]!.reasons)).toEqual(['game end timestamp missing']);
    });

    it('a play the player deleted is recorded as suppressed', async () => {
        const { AutoScoreSuppressionService } = await import('../services/AutoScoreSuppressionService.js');
        await AutoScoreSuppressionService.record({
            source: 'vpx', ownerKey: USER, gameName: 'Bad Cats', score: 18446900, playedAt: null,
        });
        await roomGame(roomId, 'Bad Cats');
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body).toMatchObject({ ok: true, status: 'duplicate' }); // `suppressed` on the wire
        const rows = await trail();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ outcome: 'suppressed' });
        expect(JSON.parse(rows[0]!.reasons)).toEqual(['the player deleted this score']);
    });

    it('a play with nowhere to go says why: no open game, then not in the catalogue', async () => {
        // Undesignated cabinet, table not in the catalogue: the Global path's own reason.
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body).toMatchObject({ ok: true, status: 'no_match' });
        const rows = await trail();
        expect(rows).toHaveLength(1);
        expect(rows[0]!.outcome).toBe('no_match');
        expect(JSON.parse(rows[0]!.reasons)).toEqual(['"Bad Cats (Williams 1989)" is not in the Arcaid catalogue']);
    });

    it('a play that lands writes ONE row (the backstop never doubles a board path)', async () => {
        const { gameId } = await roomGame(roomId, 'Bad Cats');
        const res = await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        expect(res.body).toMatchObject({ ok: true, status: 'ingested' });
        const rows = await trail();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ outcome: 'ingested', game_id: gameId });
    });
});

describe('W29 — device target changes are audited', () => {
    let app: express.Express;
    let roomId: string;

    beforeEach(async () => {
        app = await createTestApp();
        roomId = await createTestRoom();
        await pairCabinet(app);
        const db = await getDatabase();
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
    }, 30_000);

    async function audits() {
        const db = await getDatabase();
        return db.all<Array<{ actor: string; action: string; target_type: string; target_id: string; details: string }>>(
            `SELECT actor, action, target_type, target_id, details FROM audit_log WHERE action = 'witness_target_change' ORDER BY id`,
        );
    }

    it('records who changed it, from what, to what', async () => {
        const res = await request(app).patch(`/api/me/witness/devices/${CABINET}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({ roomId });
        expect(res.status).toBe(200);

        const rows = await audits();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ actor: USER, target_type: 'witness_device', target_id: CABINET });
        const details = JSON.parse(rows[0]!.details);
        expect(details.from).toMatchObject({ roomId: null, tournamentId: null, globalOnly: false, label: 'All my rooms' });
        expect(details.to).toMatchObject({ roomId, tournamentId: null, globalOnly: false, label: `room ${roomId}` });

        await request(app).patch(`/api/me/witness/devices/${CABINET}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({ globalOnly: true });
        const after = await audits();
        expect(after).toHaveLength(2);
        expect(JSON.parse(after[1]!.details).to).toMatchObject({ roomId: null, globalOnly: true, label: 'Global Scoreboard only' });
    });

    it('a save of the same choice writes nothing', async () => {
        await request(app).patch(`/api/me/witness/devices/${CABINET}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({});
        expect(await audits()).toHaveLength(0);
    });

    it('a refused change (not a member) writes nothing', async () => {
        const other = await createTestRoom('other-room', 'Other Room');
        const res = await request(app).patch(`/api/me/witness/devices/${CABINET}`)
            .set('Authorization', `Bearer ${playerToken(USER)}`).send({ roomId: other });
        expect(res.status).toBe(400);
        expect(await audits()).toHaveLength(0);
    });
});
