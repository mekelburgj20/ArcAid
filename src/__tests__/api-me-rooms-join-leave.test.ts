import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';

// v2.38.0 — explicit room join/leave contract (docs/contracts/join-leave-contract.md).
// POST/DELETE /api/me/rooms/:roomId, RoomMembershipService source='self_join'.

async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);

    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

describe('POST /api/me/rooms/:roomId (join)', () => {
    it('requires Discord login', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('join_room_1', 'Join Room 1');

        const res = await request(app).post(`/api/me/rooms/${roomId}`);

        expect(res.status).toBe(401);
    });

    it('404s for a non-existent room', async () => {
        const app = await createTestApp();
        const token = playerToken('discord-join-1');

        const res = await request(app)
            .post('/api/me/rooms/does-not-exist')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
    });

    it('joins a room, appearing in /api/me/rooms with source self_join', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('join_room_2', 'Join Room 2');
        const token = playerToken('discord-join-2');

        const joinRes = await request(app)
            .post(`/api/me/rooms/${roomId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(joinRes.status).toBe(200);
        expect(joinRes.body.success).toBe(true);

        const listRes = await request(app)
            .get('/api/me/rooms')
            .set('Authorization', `Bearer ${token}`);
        expect(listRes.status).toBe(200);
        expect(listRes.body).toHaveLength(1);
        expect(listRes.body[0].roomId).toBe(roomId);
        expect(listRes.body[0].source).toBe('self_join');
    });

    it('joining twice is idempotent (no duplicate row, source stays self_join)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('join_room_3', 'Join Room 3');
        const token = playerToken('discord-join-3');

        await request(app).post(`/api/me/rooms/${roomId}`).set('Authorization', `Bearer ${token}`);
        const second = await request(app).post(`/api/me/rooms/${roomId}`).set('Authorization', `Bearer ${token}`);
        expect(second.status).toBe(200);

        const listRes = await request(app).get('/api/me/rooms').set('Authorization', `Bearer ${token}`);
        expect(listRes.body).toHaveLength(1);
        expect(listRes.body[0].source).toBe('self_join');
    });

    it('does NOT report success when the insert silently fails to land (regression for the swallowed-CHECK-constraint bug)', async () => {
        // RoomMembershipService.addMember intentionally swallows its own DB
        // errors for its fire-and-forget callers (ScoreHistoryService etc.) —
        // that behavior must stay. This route can't inherit that trade-off, so
        // it re-queries membership after the call and 500s if it didn't land.
        // Simulate the exact failure mode that was caught during implementation
        // (a CHECK constraint silently rejecting the row) by stubbing addMember
        // to resolve without actually persisting anything.
        const app = await createTestApp();
        const roomId = await createTestRoom('join_room_4', 'Join Room 4');
        const token = playerToken('discord-join-4');

        const spy = vi.spyOn(RoomMembershipService, 'addMember').mockResolvedValue(undefined);
        try {
            const res = await request(app)
                .post(`/api/me/rooms/${roomId}`)
                .set('Authorization', `Bearer ${token}`);
            expect(res.status).toBe(500);
            expect(res.body.success).toBeUndefined();
        } finally {
            spy.mockRestore();
        }
    });
});

describe('DELETE /api/me/rooms/:roomId (leave)', () => {
    it('requires Discord login', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('leave_room_1', 'Leave Room 1');

        const res = await request(app).delete(`/api/me/rooms/${roomId}`);

        expect(res.status).toBe(401);
    });

    it('leaves a room, removing it from /api/me/rooms', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('leave_room_2', 'Leave Room 2');
        const token = playerToken('discord-leave-2');

        await request(app).post(`/api/me/rooms/${roomId}`).set('Authorization', `Bearer ${token}`);
        const leaveRes = await request(app)
            .delete(`/api/me/rooms/${roomId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(leaveRes.status).toBe(200);
        expect(leaveRes.body.success).toBe(true);

        const listRes = await request(app).get('/api/me/rooms').set('Authorization', `Bearer ${token}`);
        expect(listRes.body).toHaveLength(0);
    });

    it('leaving a room the user never joined is a 200 no-op', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('leave_room_3', 'Leave Room 3');
        const token = playerToken('discord-leave-3');

        const res = await request(app)
            .delete(`/api/me/rooms/${roomId}`)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
    });

    it('does NOT remove a game_room_admins row when the owner leaves', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('leave_room_4', 'Leave Room 4');
        const discordId = 'discord-leave-owner';
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'owner')`,
            roomId, discordId,
        );
        const token = playerToken(discordId);

        // Owner also has a room_members row (e.g. from admin_invite on room creation).
        await request(app).post(`/api/me/rooms/${roomId}`).set('Authorization', `Bearer ${token}`);
        const leaveRes = await request(app)
            .delete(`/api/me/rooms/${roomId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(leaveRes.status).toBe(200);

        const admin = await db.get(
            `SELECT role FROM game_room_admins WHERE game_room_id = ? AND discord_user_id = ?`,
            roomId, discordId,
        );
        expect(admin?.role).toBe('owner');
    });
});
