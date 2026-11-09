import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import axios from 'axios';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { clearAtGamesSessions } from '../services/AtGamesPrivateClient.js';

/**
 * A34 (v2.233.0): AtGames lets an account own one running-or-upcoming private
 * tournament at a time, so the create form asks first. Pinned: only an OWNED
 * tournament that has not ended counts; no account and an unreachable AtGames
 * answer without blocking.
 */

function fakeJwt(payload: Record<string, unknown>): string {
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

const HOUR = 3_600_000;

async function app() {
    const a = express();
    a.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    a.use('/api/rooms', roomsRouter);
    return a;
}

describe('GET /:roomId/admin/atgames/owned-open', () => {
    let roomId: string;
    let token: string;

    beforeEach(async () => {
        clearAtGamesSessions();
        await setupTestDb();
        roomId = await createTestRoom('atg-open', 'ATG Open');
        token = signToken({ role: 'room_admin', gameRoomIds: [roomId], username: 'admin', discordId: 'admin-1' });
        vi.spyOn(axios, 'post').mockResolvedValue({
            data: { account: { token: fakeJwt({ id: 1, exp: Math.floor(Date.now() / 1000) + 3600 }) } }, headers: {},
        } as never);
    });
    afterEach(() => vi.restoreAllMocks());

    async function withCreds() {
        const db = await getDatabase();
        for (const [k, v] of [['ATGAMES_EMAIL', 'owner@example.com'], ['ATGAMES_PASSWORD', 'pw'], ['ATGAMES_DEVICE_FP', 'fp']]) {
            await db.run('INSERT OR REPLACE INTO game_room_settings (game_room_id, key, value) VALUES (?, ?, ?)', roomId, k, v);
        }
    }

    it('is busy only for an owned tournament that has not ended', async () => {
        await withCreds();
        const now = Date.now();
        vi.spyOn(axios, 'get').mockResolvedValue({ data: [
            { id: 1, name: 'Joined Elsewhere', membershipRole: 'MEMBER', end: new Date(now + HOUR).toISOString() },
            { id: 2, name: 'Old Night', membershipRole: 'OWNER', end: new Date(now - HOUR).toISOString() },
            { id: 3, name: 'Tonight', membershipRole: 'OWNER', end: new Date(now + 2 * HOUR).toISOString() },
        ] } as never);
        const res = await request(await app()).get(`/api/rooms/${roomId}/admin/atgames/owned-open`).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('busy');
        expect(res.body.tournament.name).toBe('Tonight');
    });

    it('is free when every owned tournament has ended', async () => {
        await withCreds();
        vi.spyOn(axios, 'get').mockResolvedValue({ data: [
            { id: 2, name: 'Old Night', membershipRole: 'OWNER', end: new Date(Date.now() - HOUR).toISOString() },
        ] } as never);
        const res = await request(await app()).get(`/api/rooms/${roomId}/admin/atgames/owned-open`).set('Authorization', `Bearer ${token}`);
        expect(res.body).toEqual({ status: 'free', tournament: null });
    });

    it('answers no_account without credentials, and unknown when AtGames fails', async () => {
        const a = await app();
        const none = await request(a).get(`/api/rooms/${roomId}/admin/atgames/owned-open`).set('Authorization', `Bearer ${token}`);
        expect(none.body.status).toBe('no_account');

        await withCreds();
        vi.spyOn(axios, 'get').mockRejectedValue(Object.assign(new Error('down'), { response: { status: 503 } }));
        const down = await request(a).get(`/api/rooms/${roomId}/admin/atgames/owned-open`).set('Authorization', `Bearer ${token}`);
        expect(down.body.status).toBe('unknown');
    });
});
