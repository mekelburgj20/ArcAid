import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { RoomMembershipService } from '../services/RoomMembershipService.js';

// v2.39.0 — approval-rooms view gate (tmp/approval-rooms-contract.md, D1).
// `roomVisibilityGate` is mounted ONCE in rooms.ts right after portal +
// scoreboard-config, so those two stay reachable for everyone while every
// other room-scoped route (leaderboard, tournaments, lobby, admin, ...) is
// gated for 'approval'-policy rooms.

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}
function roomAdminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}
function superAdminToken() {
    return signToken({ role: 'super_admin', gameRoomIds: [] });
}

async function makeApprovalRoom(slug = 'approval-room') {
    const roomId = await createTestRoom(slug, 'Approval Room');
    await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
    return roomId;
}

describe('roomVisibilityGate — open room (byte-identical / unaffected)', () => {
    it('serves leaderboard with no auth at all', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('open-room-1');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Open Game' });
        await createTestSubmission(gameId, { username: 'P1', score: 100 });

        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
    });

    it('serves tournaments to a guest', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('open-room-2');
        const res = await request(app).get(`/api/rooms/${roomId}/tournaments`);
        expect(res.status).toBe(200);
    });
});

describe('roomVisibilityGate — portal / scoreboard-config bypass the gate structurally', () => {
    it('portal is always reachable, even for a guest, on an approval room', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-portal-1');
        const res = await request(app).get(`/api/rooms/${roomId}/portal`);
        expect(res.status).toBe(200);
        expect(res.body.join_policy).toBe('approval');
        expect(res.body.viewer_status).toBe('none');
    });

    it('scoreboard-config is always reachable, even for a guest, on an approval room', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-portal-2');
        const res = await request(app).get(`/api/rooms/${roomId}/scoreboard-config`);
        expect(res.status).toBe(200);
    });
});

describe('roomVisibilityGate — approval room, gated viewer classes', () => {
    it('403s a guest (no token) on leaderboard', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-guest');
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('APPROVAL_REQUIRED');
    });

    it('403s a logged-in non-member on tournaments', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-nonmember');
        const token = playerToken('discord-nonmember');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });

    it('403s a user with a pending join request', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-pending');
        const discordId = 'discord-pending-1';
        const { JoinRequestService } = await import('../services/JoinRequestService.js');
        await JoinRequestService.request(roomId, discordId);
        const token = playerToken(discordId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
    });
});

describe('roomVisibilityGate — approval room, admitted viewer classes', () => {
    it('allows a room member (room_members row)', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-member');
        const discordId = 'discord-member-1';
        await RoomMembershipService.addMember(discordId, roomId, 'self_join');
        const token = playerToken(discordId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
    });

    it('allows a room admin via token gameRoomIds', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-admin-token');
        const token = roomAdminToken(roomId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
    });

    it('allows a room admin via a fresh game_room_admins row even with a stale token', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-admin-db');
        const discordId = 'discord-admin-db-1';
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'admin')`,
            roomId, discordId,
        );
        // Stale token minted BEFORE the admin grant — gameRoomIds is empty,
        // proving the gate falls back to a live DB check.
        const token = playerToken(discordId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
    });

    it('allows super_admin', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('gate-super');
        const token = superAdminToken();
        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
    });
});

describe('portal viewer_status per class', () => {
    it('reports admin for a room admin', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('vs-admin');
        const token = roomAdminToken(roomId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/portal`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.body.viewer_status).toBe('admin');
    });

    it('reports member for a room member', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('vs-member');
        const discordId = 'discord-vs-member';
        await RoomMembershipService.addMember(discordId, roomId, 'self_join');
        const token = playerToken(discordId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/portal`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.body.viewer_status).toBe('member');
    });

    it('reports pending for a user with an outstanding request', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('vs-pending');
        const discordId = 'discord-vs-pending';
        const { JoinRequestService } = await import('../services/JoinRequestService.js');
        await JoinRequestService.request(roomId, discordId);
        const token = playerToken(discordId);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/portal`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.body.viewer_status).toBe('pending');
    });

    it('reports none for a guest', async () => {
        const app = await createTestApp();
        const roomId = await makeApprovalRoom('vs-none');
        const res = await request(app).get(`/api/rooms/${roomId}/portal`);
        expect(res.body.viewer_status).toBe('none');
    });
});

describe('self-join on an approval room', () => {
    it('POST /api/me/rooms/:roomId 403s with APPROVAL_REQUIRED instead of joining', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('self-join-blocked');
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);

        const token = playerToken('discord-self-join-1');
        const res = await request(app)
            .post(`/api/me/rooms/${roomId}`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('APPROVAL_REQUIRED');

        const isMember = await RoomMembershipService.isMember('discord-self-join-1', roomId);
        expect(isMember).toBe(false);
    });
});

// D2 (v2.41.0, tmp/player-governs-global-contract.md) — the contract's
// premise is that approval-room submit endpoints are ALREADY member-gated via
// `roomVisibilityGate` (mounted at `router.use('/:roomId', roomVisibilityGate)`
// in rooms.ts, BEFORE the submit-score/freeplay-score/community-scores route
// registrations), so removing the room-level Global Scoreboard fan-out gate
// does not open a "non-members can submit scores to a private room" hole.
// These tests lock that premise in.
async function seedPlatformForGame(gameName: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
        crypto.randomUUID(), gameName, JSON.stringify(['real']),
    );
    return db;
}

// Minimal valid PNG signature (8-byte header + padding) — passes the
// magic-byte check in uploadValidation.ts's isAllowedImage.
const VALID_PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);

describe('roomVisibilityGate — approval room, submit endpoints are member-gated (D2, v2.41.0)', () => {
    describe('POST /:roomId/submit-score/:gameName', () => {
        it('403s a guest (no token)', async () => {
            const app = await createTestApp();
            const roomId = await makeApprovalRoom('submit-gate-guest');
            const gameName = 'Submit Gate Guest Game';
            await seedPlatformForGame(gameName);

            const res = await request(app)
                .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
                .field('username', 'Guesty')
                .field('score', '1000')
                .field('engine', 'real').field('device', 'real_cabinet');
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('APPROVAL_REQUIRED');
        });

        it('403s a logged-in non-member', async () => {
            const app = await createTestApp();
            const roomId = await makeApprovalRoom('submit-gate-nonmember');
            const gameName = 'Submit Gate Nonmember Game';
            await seedPlatformForGame(gameName);
            const token = playerToken('discord-submit-nonmember-1');

            const res = await request(app)
                .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
                .set('Authorization', `Bearer ${token}`)
                .field('username', 'NonMember')
                .field('score', '1000')
                .field('engine', 'real').field('device', 'real_cabinet');
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('APPROVAL_REQUIRED');
        });

        it('allows a room member through to the handler (201)', async () => {
            const app = await createTestApp();
            const roomId = await makeApprovalRoom('submit-gate-member');
            const gameName = 'Submit Gate Member Game';
            await seedPlatformForGame(gameName);
            const discordId = 'discord-submit-member-1';
            await RoomMembershipService.addMember(discordId, roomId, 'self_join');
            const token = playerToken(discordId);

            const res = await request(app)
                .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
                .set('Authorization', `Bearer ${token}`)
                .field('username', 'Member')
                .field('score', '1000')
                .field('engine', 'real').field('device', 'real_cabinet');
            expect(res.status).toBe(201);
        });
    });

    describe('POST /:roomId/freeplay-score', () => {
        it('403s a guest (no token)', async () => {
            const app = await createTestApp();
            const roomId = await makeApprovalRoom('freeplay-gate-guest');
            const gameName = 'Freeplay Gate Guest Game';
            const db = await seedPlatformForGame(gameName);
            const gg = await db.get('SELECT id FROM global_games WHERE name = ?', gameName);

            const res = await request(app)
                .post(`/api/rooms/${roomId}/freeplay-score`)
                .field('globalGameId', gg.id)
                .field('username', 'Guesty')
                .field('score', '1000')
                .field('engine', 'real').field('device', 'real_cabinet')
                .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('APPROVAL_REQUIRED');
        });

        it('403s a logged-in non-member', async () => {
            const app = await createTestApp();
            const roomId = await makeApprovalRoom('freeplay-gate-nonmember');
            const gameName = 'Freeplay Gate Nonmember Game';
            const db = await seedPlatformForGame(gameName);
            const gg = await db.get('SELECT id FROM global_games WHERE name = ?', gameName);
            const token = playerToken('discord-freeplay-nonmember-1');

            const res = await request(app)
                .post(`/api/rooms/${roomId}/freeplay-score`)
                .set('Authorization', `Bearer ${token}`)
                .field('globalGameId', gg.id)
                .field('username', 'NonMember')
                .field('score', '1000')
                .field('engine', 'real').field('device', 'real_cabinet')
                .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });
            expect(res.status).toBe(403);
            expect(res.body.code).toBe('APPROVAL_REQUIRED');
        });

        it('allows a room member through to the handler (201)', async () => {
            const app = await createTestApp();
            const roomId = await makeApprovalRoom('freeplay-gate-member');
            const gameName = 'Freeplay Gate Member Game';
            const db = await seedPlatformForGame(gameName);
            const gg = await db.get('SELECT id FROM global_games WHERE name = ?', gameName);
            const discordId = 'discord-freeplay-member-1';
            await RoomMembershipService.addMember(discordId, roomId, 'self_join');
            const token = playerToken(discordId);

            const res = await request(app)
                .post(`/api/rooms/${roomId}/freeplay-score`)
                .set('Authorization', `Bearer ${token}`)
                .field('globalGameId', gg.id)
                .field('username', 'Member')
                .field('score', '1000')
                .field('engine', 'real').field('device', 'real_cabinet')
                .attach('photo', VALID_PNG, { filename: 'score.png', contentType: 'image/png' });
            expect(res.status).toBe(201);
        });
    });
});
