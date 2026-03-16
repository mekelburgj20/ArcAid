import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { signToken } from '../api/auth.js';
import crypto from 'crypto';

async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);

    return app;
}

function adminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}

function superAdminToken() {
    return signToken({ role: 'super_admin', gameRoomIds: [] });
}

describe('Rooms API', () => {
    describe('GET /api/rooms/:roomId/leaderboard', () => {
        it('returns leaderboards for active games', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { name: 'Test Table' });
            await createTestSubmission(gameId, { username: 'Player1', score: 5000 });

            const res = await request(app).get(`/api/rooms/${roomId}/leaderboard`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(1);
            expect(res.body[0].gameName).toBe('Test Table');
            expect(res.body[0].rankings).toHaveLength(1);
            expect(res.body[0].rankings[0].score).toBe(5000);
        });

        it('returns empty array for room with no games', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();

            const res = await request(app).get(`/api/rooms/${roomId}/leaderboard`);

            expect(res.status).toBe(200);
            expect(res.body).toEqual([]);
        });
    });

    describe('GET /api/rooms/:roomId/tournaments', () => {
        it('returns tournaments for a room (public, no auth needed)', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            await createTestTournament(roomId, { name: 'Daily Grind' });
            await createTestTournament(roomId, { name: 'Weekly Wars' });

            const res = await request(app).get(`/api/rooms/${roomId}/tournaments`);

            expect(res.status).toBe(200);
            expect(res.body).toHaveLength(2);
        });
    });

    describe('POST /api/rooms/:roomId/tournaments', () => {
        it('requires authentication', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();

            const res = await request(app)
                .post(`/api/rooms/${roomId}/tournaments`)
                .send({ id: 'test', name: 'T', type: 'DG', cadence: {} });

            expect(res.status).toBe(401);
        });

        it('requires room access', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const otherRoom = await createTestRoom('other', 'Other');
            const token = adminToken(otherRoom); // admin of different room

            const res = await request(app)
                .post(`/api/rooms/${roomId}/tournaments`)
                .set('Authorization', `Bearer ${token}`)
                .send({ id: 'test', name: 'T', type: 'DG', cadence: {} });

            expect(res.status).toBe(403);
        });

        it('creates tournament with valid auth and data', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const token = superAdminToken();

            const res = await request(app)
                .post(`/api/rooms/${roomId}/tournaments`)
                .set('Authorization', `Bearer ${token}`)
                .send({
                    id: crypto.randomUUID(),
                    name: 'New Tournament',
                    type: 'DG',
                    mode: 'pinball',
                    cadence: { cron: '0 0 * * *', autoRotate: true, autoLock: false },
                    is_active: true,
                });

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify it was created
            const listRes = await request(app).get(`/api/rooms/${roomId}/tournaments`);
            expect(listRes.body).toHaveLength(1);
            expect(listRes.body[0].name).toBe('New Tournament');
        });
    });

    describe('GET /api/rooms/:roomId/stats/players', () => {
        it('returns player stats for a room', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED', endDate: new Date().toISOString() });
            await createTestSubmission(gameId, { username: 'Alice', score: 5000 });
            await createTestSubmission(gameId, { username: 'Bob', score: 3000 });

            const res = await request(app).get(`/api/rooms/${roomId}/stats/players`);

            expect(res.status).toBe(200);
            expect(Array.isArray(res.body)).toBe(true);
        });
    });

    describe('GET /api/rooms/:roomId/dashboard', () => {
        it('returns dashboard data', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();

            const res = await request(app).get(`/api/rooms/${roomId}/dashboard`);

            expect(res.status).toBe(200);
            expect(res.body).toBeTruthy();
        });
    });

    describe('GET /api/rooms/:roomId/settings', () => {
        it('requires authentication', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();

            const res = await request(app).get(`/api/rooms/${roomId}/settings`);

            expect(res.status).toBe(401);
        });

        it('returns settings with valid auth', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom();
            const token = adminToken(roomId);

            const res = await request(app)
                .get(`/api/rooms/${roomId}/settings`)
                .set('Authorization', `Bearer ${token}`);

            expect(res.status).toBe(200);
            expect(typeof res.body).toBe('object');
        });
    });
});
