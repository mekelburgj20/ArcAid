import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * W27.3 (ADR 0033 §5) — `GET /api/me/witness/routing?roomId=`: does each of my
 * paired devices send to this room? Decided by `deviceRoutesTo` (the ingest's
 * own rule) on the device's effective target, so the room page's line cannot
 * disagree with where a score goes.
 */

const USER = '123456789012345678';
const CABINET = 'fp-device-uuid-route';

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
    await request(app).get('/api/witness/pair').query({ code: codeRes.body.code, device: CABINET, username: 'Owner' });
}

async function join(roomId: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
}

async function tournament(roomId: string, name: string, finished = false) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, event_finished_at)
         VALUES (?, ?, 'WG', 'pinball', '{}', 1, ?, ?, ?)`,
        id, name, roomId, finished ? 'event' : 'rotation', finished ? new Date().toISOString() : null,
    );
    return id;
}

describe('GET /api/me/witness/routing', () => {
    let app: express.Express;
    let here: string;
    let other: string;
    const routing = async () => (await request(app).get('/api/me/witness/routing').query({ roomId: here })
        .set('Authorization', `Bearer ${playerToken(USER)}`)).body;
    const point = (body: Record<string, unknown>) => request(app).patch(`/api/me/witness/devices/${CABINET}`)
        .set('Authorization', `Bearer ${playerToken(USER)}`).send(body);

    beforeEach(async () => {
        app = await createTestApp();
        here = await createTestRoom('wizard', 'The Wizard Room');
        other = await createTestRoom('rtx', 'RTX Pinball');
        await pairCabinet(app);
    }, 30_000); // the first run imports the whole API router cold

    it('All my rooms + a member: yes', async () => {
        await join(here);
        expect(await routing()).toEqual([expect.objectContaining({ deviceId: CABINET, deviceType: 'atgames', sendsHere: 'yes', why: null })]);
    });

    it('All my rooms but not a member: no, not_member — unless entered directly into a tournament here', async () => {
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'no', why: 'not_member' })]);
        const t = await tournament(here, 'Friday Night');
        const db = await getDatabase();
        await db.run(`INSERT INTO tournament_participants (tournament_id, user_id, source, checked_in_at) VALUES (?, ?, 'admin', datetime('now'))`, t, USER);
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'entered_only', why: null })]);
    });

    it('Global Scoreboard only: no, global_only', async () => {
        await join(here);
        await point({ globalOnly: true });
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'no', why: 'global_only' })]);
    });

    it('narrowed to another room: no, other_room, naming it; to this room: yes', async () => {
        await join(here); await join(other);
        await point({ roomId: other });
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'no', why: 'other_room', targetRoomName: 'RTX Pinball' })]);
        await point({ roomId: here });
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'yes' })]);
    });

    it('pinned to a tournament here: one_tournament; elsewhere: other_tournament; finished: reads as the room', async () => {
        await join(here); await join(other);
        const t = await tournament(here, 'Spooky Season');
        await point({ roomId: here, tournamentId: t });
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'one_tournament', targetTournamentName: 'Spooky Season' })]);

        const elsewhere = await tournament(other, 'Halloween Week');
        await point({ roomId: other, tournamentId: elsewhere });
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'no', why: 'other_tournament' })]);

        // A finished pinned tournament reads as absent: the device sends to its room (here).
        const done = await tournament(here, 'Last Week', true);
        await point({ roomId: here, tournamentId: done });
        expect(await routing()).toEqual([expect.objectContaining({ sendsHere: 'yes', targetTournamentName: null })]);
    });

    it('needs a roomId and a login', async () => {
        const noRoom = await request(app).get('/api/me/witness/routing').set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(noRoom.status).toBe(400);
        const anon = await request(app).get('/api/me/witness/routing').query({ roomId: here });
        expect(anon.status).toBe(401);
    });
});
