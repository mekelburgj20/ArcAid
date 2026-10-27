import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * W27.2 (ADR 0033 §5) — "Where your plays went": `GET /api/me/witness/plays`.
 * One entry per PLAY (a play counted in two tournaments is one entry with two
 * destinations), newest first, with why it did not count where it did not —
 * and only the asking player's plays.
 */

const USER = '123456789012345678';
const OTHER = '876543210987654321';
const CABINET = 'fp-device-uuid-plays';
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

async function rotation(roomId: string, tournamentName: string, gameName: string) {
    const db = await getDatabase();
    await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, roomId);
    const tournamentId = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format)
         VALUES (?, ?, 'WG', 'pinball', '{}', 1, ?, 'rotation')`,
        tournamentId, tournamentName, roomId,
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date) VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        crypto.randomUUID(), tournamentId, gameName, roomId, new Date(Date.now() - 60 * MINUTE).toISOString(),
    );
}

function play(over: Record<string, unknown> = {}) {
    const endedMs = Date.now();
    return {
        table: 'Medieval Madness (Williams 1997)', rom: 'mm_109c', slug: 'vpx-medievalmadness',
        score: 41234560, started: Math.floor((endedMs - 5 * MINUTE) / 1000), ended: Math.floor(endedMs / 1000),
        dur: 300, reason: 'game_over', ...over,
    };
}

describe('GET /api/me/witness/plays', () => {
    let app: express.Express;
    let token: string;

    beforeEach(async () => {
        app = await createTestApp();
        token = await pairCabinet(app);
    }, 30_000); // the first run imports the whole API router cold

    it('one play counted in two tournaments is ONE entry with two destinations', async () => {
        const a = await createTestRoom('room-a', 'Room A');
        const b = await createTestRoom('room-b', 'Room B');
        await rotation(a, 'Weekly A', 'Medieval Madness');
        await rotation(b, 'Weekly B', 'Medieval Madness');
        await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });

        const res = await request(app).get('/api/me/witness/plays').set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0]).toMatchObject({ tableName: 'Medieval Madness (Williams 1997)', score: 41234560, deviceId: CABINET });
        const dests = res.body[0].destinations.map((d: { status: string; tournamentName: string; roomSlug: string }) =>
            `${d.status}:${d.tournamentName}:${d.roomSlug}`).sort();
        expect(dests).toEqual(['counted:Weekly A:room-a', 'counted:Weekly B:room-b']);
    });

    it('a play that only reached Global carries why no tournament took it; one that went nowhere says why', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status) VALUES (?, 'Medieval Madness', 'pinball', 'Williams', 1997, 'approved')`,
            'gg-mm',
        );
        const room = await createTestRoom('wizard', 'The Wizard Room');
        await db.run(`INSERT OR IGNORE INTO room_members (user_id, room_id, source) VALUES (?, ?, 'submission')`, USER, room);
        const eventId = crypto.randomUUID();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id, format, checkin_required)
             VALUES (?, 'Friday Night', 'DG', 'pinball', '{"timezone":"UTC"}', 1, ?, 'event', 1)`,
            eventId, room,
        );
        await db.run(
            `INSERT INTO games (id, tournament_id, name, status, game_room_id, round_no, scheduled_start_at, scheduled_end_at)
             VALUES (?, ?, 'Medieval Madness', 'ACTIVE', ?, 1, ?, ?)`,
            crypto.randomUUID(), eventId, room,
            new Date(Date.now() - 30 * MINUTE).toISOString(), new Date(Date.now() + 30 * MINUTE).toISOString(),
        );
        await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        // A later play nothing can place: not in the catalogue, nothing open.
        await request(app).get('/api/witness/score').query({
            device: CABINET, token, ...play({ table: 'Some Homebrew (Original 2026)', rom: 'x', slug: 'vpx-homebrew', score: 5 }),
        });

        const res = await request(app).get('/api/me/witness/plays').set('Authorization', `Bearer ${playerToken(USER)}`);
        expect(res.body).toHaveLength(2);
        // Newest first.
        expect(res.body[0].tableName).toBe('Some Homebrew (Original 2026)');
        expect(res.body[0].destinations).toEqual([expect.objectContaining({
            status: 'not_recorded', reason: '"Some Homebrew (Original 2026)" is not in the Arcaid catalogue',
        })]);
        expect(res.body[1].destinations).toEqual([expect.objectContaining({
            status: 'global', globalGameId: 'gg-mm',
            reason: 'you are not checked in to "Friday Night" round 1 in The Wizard Room',
        })]);
    });

    it('only the asking player\'s plays, and nothing without a login', async () => {
        await request(app).get('/api/witness/score').query({ device: CABINET, token, ...play() });
        const other = await request(app).get('/api/me/witness/plays').set('Authorization', `Bearer ${playerToken(OTHER)}`);
        expect(other.body).toEqual([]);
        const anon = await request(app).get('/api/me/witness/plays');
        expect(anon.status).toBe(401);
    });
});
