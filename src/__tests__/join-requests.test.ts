import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';

// v2.39.0 — approval-rooms join-request queue (tmp/approval-rooms-contract.md, D2).

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    app.use('/api', globalRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}
function roomAdminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}

async function makeApprovalRoom(slug: string) {
    const roomId = await createTestRoom(slug, 'Approval Room');
    await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
    return roomId;
}

describe('POST /api/me/rooms/:roomId/join-request', () => {
    it('400s for an open-policy room', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('jr-open-1');
        const token = playerToken('discord-jr-1');
        const res = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
    });

    it('requires Discord login', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-noauth');
        const res = await request(app).post(`/api/me/rooms/${roomId}/join-request`);
        expect(res.status).toBe(401);
    });

    it('creates a pending request', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-create');
        const token = playerToken('discord-jr-2');
        const res = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('pending');
    });

    it('is idempotent on re-request (still pending, no duplicate row)', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-idempotent');
        const token = playerToken('discord-jr-3');
        await request(app).post(`/api/me/rooms/${roomId}/join-request`).set('Authorization', `Bearer ${token}`);
        const second = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${token}`);
        expect(second.status).toBe(200);
        expect(second.body.status).toBe('pending');

        const adminToken = roomAdminToken(roomId);
        const list = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(list.body).toHaveLength(1);
    });

    it('returns member (no-op) when the user is already a member', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-already-member');
        const discordId = 'discord-jr-4';
        await RoomMembershipService.addMember(discordId, roomId, 'self_join');
        const token = playerToken(discordId);
        const res = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe('member');
    });
});

describe('room-admin join-request queue authz', () => {
    it('blocks an unauthenticated request (403 from the visibility gate — it runs before requireAuth for every route below the seam, admin routes included)', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-queue-noauth');
        const res = await request(app).get(`/api/rooms/${roomId}/admin/join-requests`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('APPROVAL_REQUIRED');
    });

    it('403s a player token (not this room\'s admin)', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-queue-forbidden');
        const token = playerToken('discord-not-admin');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });

    it('403s an admin of a DIFFERENT room', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-queue-other-room');
        const otherRoomId = await createTestRoom('jr-other-room');
        const token = roomAdminToken(otherRoomId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });
});

describe('approve / deny', () => {
    it('approve grants membership and marks resolved', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-approve');
        const discordId = 'discord-jr-approve-1';
        await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`);

        const adminToken = roomAdminToken(roomId);
        const pending = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(pending.body).toHaveLength(1);
        const id = pending.body[0].id;

        const approveRes = await request(app)
            .post(`/api/rooms/${roomId}/admin/join-requests/${id}/approve`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(approveRes.status).toBe(200);

        expect(await RoomMembershipService.isMember(discordId, roomId)).toBe(true);

        const resolved = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests?status=resolved`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(resolved.body).toHaveLength(1);
        expect(resolved.body[0].status).toBe('approved');
    });

    it('deny marks resolved without granting membership, and a re-request is allowed', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-deny');
        const discordId = 'discord-jr-deny-1';
        await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`);

        const adminToken = roomAdminToken(roomId);
        const pending = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests`)
            .set('Authorization', `Bearer ${adminToken}`);
        const id = pending.body[0].id;

        const denyRes = await request(app)
            .post(`/api/rooms/${roomId}/admin/join-requests/${id}/deny`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(denyRes.status).toBe(200);
        expect(await RoomMembershipService.isMember(discordId, roomId)).toBe(false);

        // Re-request after denial is allowed (partial unique index only blocks pending dupes).
        const again = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`);
        expect(again.status).toBe(200);
        expect(again.body.status).toBe('pending');
    });

    it('approving/denying an already-resolved request 404s', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-double-resolve');
        const discordId = 'discord-jr-double';
        await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken(discordId)}`);
        const adminToken = roomAdminToken(roomId);
        const pending = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests`)
            .set('Authorization', `Bearer ${adminToken}`);
        const id = pending.body[0].id;
        await request(app)
            .post(`/api/rooms/${roomId}/admin/join-requests/${id}/approve`)
            .set('Authorization', `Bearer ${adminToken}`);

        const second = await request(app)
            .post(`/api/rooms/${roomId}/admin/join-requests/${id}/deny`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(second.status).toBe(404);
    });
});

describe('GET /api/rooms/:roomId/admin/join-requests/count', () => {
    it('counts pending requests only', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('jr-count');
        await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken('discord-jr-count-1')}`);
        await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${playerToken('discord-jr-count-2')}`);

        const adminToken = roomAdminToken(roomId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests/count`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body.pending).toBe(2);
    });
});

describe('GET /api/rooms/:roomId/admin/members (member picker)', () => {
    it('lists room members for the admin-add picker', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('members-picker');
        await RoomMembershipService.addMember('discord-picker-1', roomId, 'self_join');
        await RoomMembershipService.addMember('discord-picker-2', roomId, 'submission');

        const adminToken = roomAdminToken(roomId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/admin/members`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        expect(res.body.map((m: any) => m.userId).sort()).toEqual(['discord-picker-1', 'discord-picker-2']);
    });
});
