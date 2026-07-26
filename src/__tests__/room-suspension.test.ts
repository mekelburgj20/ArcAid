import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { GameRoomService } from '../services/GameRoomService.js';
import { RoomAccessService } from '../services/RoomAccessService.js';
import { discordExcludedRoomIds } from '../utils/discordRoomFilter.js';
import { auditLog } from '../api/auditMiddleware.js';

/**
 * S22 Phase 2 (v2.44.0) — room suspension (contract §1/§4). Mirrors
 * room-visibility-gate.test.ts's `makeApprovalRoom` pattern with a
 * `makeSuspendedRoom` helper (direct UPDATE of the new columns).
 *
 * `canJoinRoomChannel` (websocket.ts) is not exported and has no existing
 * test file/pattern (unlike the HTTP gate) — per contract's "unit-level is
 * fine" allowance, the WS seam is covered by unit-testing
 * `RoomAccessService.isSuspended`, the exact function `canJoinRoomChannel`
 * delegates to (same single-source-of-truth relationship as
 * `getJoinPolicy`/`canViewRoom` for the approval-room gate).
 */

async function createRoomsApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

async function createGlobalApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

async function createAdminApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    // Wire the real audit middleware (mirrors server.ts:132) so the
    // "audit row created" assertions below exercise the actual chain, not a
    // hand-simulated one.
    app.use((req, _res, next) => { (req as any).correlationId = 'test-corr'; next(); });
    const { requireAuth, requireSuperAdmin } = await import('../api/middleware.js');
    app.use('/api/admin', (req, res, next) => {
        requireAuth(req, res, () => requireSuperAdmin(req, res, () => auditLog(req, res, next)));
    });
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    return app;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}
function roomAdminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}
function superAdminToken(discordId = 'super-1') {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId, username: 'SuperAdmin' });
}

async function makeSuspendedRoom(slug = 'suspended-room'): Promise<string> {
    const roomId = await createTestRoom(slug, 'Suspended Room');
    await GameRoomService.suspend(roomId, 'super-admin-1', 'testing');
    return roomId;
}

describe('roomVisibilityGate — suspended room blocks everyone except super_admin', () => {
    it('403s ROOM_SUSPENDED for a guest (no token)', async () => {
        const app = await createRoomsApp();
        const roomId = await makeSuspendedRoom('suspend-guest');
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ROOM_SUSPENDED');
    });

    it('403s ROOM_SUSPENDED for a logged-in player', async () => {
        const app = await createRoomsApp();
        const roomId = await makeSuspendedRoom('suspend-player');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/tournaments`)
            .set('Authorization', `Bearer ${playerToken('discord-suspend-player-1')}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ROOM_SUSPENDED');
    });

    it('403s ROOM_SUSPENDED for the room\'s OWN room_admin — suspension blocks admins too', async () => {
        const app = await createRoomsApp();
        const roomId = await makeSuspendedRoom('suspend-room-admin');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`);
        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ROOM_SUSPENDED');
    });

    it('allows super_admin through unaffected', async () => {
        const app = await createRoomsApp();
        const roomId = await makeSuspendedRoom('suspend-super');
        const res = await request(app)
            .get(`/api/rooms/${roomId}/leaderboard`)
            .set('Authorization', `Bearer ${superAdminToken()}`);
        expect(res.status).toBe(200);
    });

    it('an open (non-suspended) room is completely unaffected', async () => {
        const app = await createRoomsApp();
        const roomId = await createTestRoom('suspend-control-open');
        const res = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        expect(res.status).toBe(200);
    });
});

describe('GET /api/rooms — suspended rooms excluded from the public listing', () => {
    it('omits a suspended room but includes an open one', async () => {
        const app = await createGlobalApp();
        const openRoomId = await createTestRoom('list-open-room', 'Open Room');
        const suspendedRoomId = await makeSuspendedRoom('list-suspended-room');

        const res = await request(app).get('/api/rooms');
        expect(res.status).toBe(200);
        const ids = res.body.map((r: any) => r.id);
        expect(ids).toContain(openRoomId);
        expect(ids).not.toContain(suspendedRoomId);
    });
});

describe('GET /api/portal — suspended room returns the minimal shape', () => {
    it('returns { suspended: true, name, slug } only — no settings/config/scores fields', async () => {
        const app = await createGlobalApp();
        await makeSuspendedRoom('portal-suspended-1');

        const res = await request(app).get('/api/portal?slug=portal-suspended-1');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ suspended: true, name: 'Suspended Room', slug: 'portal-suspended-1' });
        expect(res.body.join_policy).toBeUndefined();
        expect(res.body.ui_theme).toBeUndefined();
        expect(res.body.viewer_status).toBeUndefined();
    });

    it('an open room still returns the full shape (control)', async () => {
        const app = await createGlobalApp();
        await createTestRoom('portal-open-1', 'Open Portal Room');

        const res = await request(app).get('/api/portal?slug=portal-open-1');
        expect(res.status).toBe(200);
        expect(res.body.suspended).toBeUndefined();
        expect(res.body.join_policy).toBe('open');
        expect(res.body).toHaveProperty('ui_theme');
    });
});

describe('RoomAccessService.isSuspended — WS gate seam (canJoinRoomChannel delegates here)', () => {
    it('true for a suspended room', async () => {
        await setupTestDb();
        const roomId = await makeSuspendedRoom('ws-suspended-1');
        expect(await RoomAccessService.isSuspended(roomId)).toBe(true);
    });

    it('false for an open room', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('ws-open-1');
        expect(await RoomAccessService.isSuspended(roomId)).toBe(false);
    });

    it('false again after unsuspend', async () => {
        await setupTestDb();
        const roomId = await makeSuspendedRoom('ws-unsuspend-1');
        expect(await RoomAccessService.isSuspended(roomId)).toBe(true);
        await GameRoomService.unsuspend(roomId);
        expect(await RoomAccessService.isSuspended(roomId)).toBe(false);
    });
});

describe('discordExcludedRoomIds — suspended rooms included in the exclusion union', () => {
    it('includes a suspended room alongside DISCORD_ENABLED=false / approval rooms', async () => {
        await setupTestDb();
        const suspendedRoomId = await makeSuspendedRoom('discord-excl-suspended');
        const openRoomId = await createTestRoom('discord-excl-open');

        const excluded = await discordExcludedRoomIds();
        expect(excluded).toContain(suspendedRoomId);
        expect(excluded).not.toContain(openRoomId);
    });
});

describe('POST /api/admin/rooms/:roomId/suspend + /unsuspend', () => {
    it('super-admin can suspend a room; audit row created', async () => {
        const app = await createAdminApp();
        const roomId = await createTestRoom('admin-suspend-1', 'Admin Suspend Target');

        const res = await request(app)
            .post(`/api/admin/rooms/${roomId}/suspend`)
            .set('Authorization', `Bearer ${superAdminToken('super-audit-1')}`)
            .send({ reason: 'reported for abuse' });
        expect(res.status).toBe(200);

        const room = await GameRoomService.getById(roomId);
        expect(room?.suspended_at).toBeTruthy();
        expect(room?.suspended_by).toBe('super-audit-1');
        expect(room?.suspended_reason).toBe('reported for abuse');

        // Fire-and-forget audit write (AuditService.log in auditMiddleware) —
        // flush a tick before asserting. Actor is the token's `username`
        // (auditMiddleware prefers username over discordId), not the discordId
        // param — see superAdminToken()'s hardcoded 'SuperAdmin' username.
        await new Promise((r) => setTimeout(r, 20));
        const db = await getDatabase();
        const auditRow = await db.get(
            `SELECT * FROM audit_log WHERE actor = ? AND action LIKE '%suspend%'`,
            'SuperAdmin',
        );
        expect(auditRow).toBeTruthy();
    });

    it('room_admin (non-super) is 403d', async () => {
        const app = await createAdminApp();
        const roomId = await createTestRoom('admin-suspend-2');
        const res = await request(app)
            .post(`/api/admin/rooms/${roomId}/suspend`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`)
            .send({});
        expect(res.status).toBe(403);
    });

    it('404s an unknown room', async () => {
        const app = await createAdminApp();
        const res = await request(app)
            .post('/api/admin/rooms/does-not-exist/suspend')
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({});
        expect(res.status).toBe(404);
    });

    it('is idempotent — suspending an already-suspended room returns 200 and updates the reason', async () => {
        const app = await createAdminApp();
        const roomId = await makeSuspendedRoom('admin-suspend-idempotent');

        const res = await request(app)
            .post(`/api/admin/rooms/${roomId}/suspend`)
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({ reason: 'updated reason' });
        expect(res.status).toBe(200);

        const room = await GameRoomService.getById(roomId);
        expect(room?.suspended_reason).toBe('updated reason');
    });

    it('unsuspend restores full access (fail-on-revert)', async () => {
        const roomsApp = await createRoomsApp();
        const roomId = await GameRoomService.create({ name: 'Revert Room', slug: 'admin-unsuspend-1' }).then((r) => r.id);
        await GameRoomService.suspend(roomId, 'super-1', 'temp');

        const gatedRes = await request(roomsApp).get(`/api/rooms/${roomId}/leaderboard`);
        expect(gatedRes.status).toBe(403);

        const adminApp = await createAdminApp();
        const unsuspendRes = await request(adminApp)
            .post(`/api/admin/rooms/${roomId}/unsuspend`)
            .set('Authorization', `Bearer ${superAdminToken()}`)
            .send({});
        expect(unsuspendRes.status).toBe(200);

        const room = await GameRoomService.getById(roomId);
        expect(room?.suspended_at).toBeNull();

        const restoredRes = await request(roomsApp).get(`/api/rooms/${roomId}/leaderboard`);
        expect(restoredRes.status).toBe(200);
    });

    it('room_admin (non-super) is 403d on unsuspend too', async () => {
        const app = await createAdminApp();
        const roomId = await makeSuspendedRoom('admin-unsuspend-authz');
        const res = await request(app)
            .post(`/api/admin/rooms/${roomId}/unsuspend`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId)}`)
            .send({});
        expect(res.status).toBe(403);
    });
});

// Sanity check that the suspension gate doesn't interfere with a normal,
// data-bearing room-scoped read (leaderboard results still flow through once
// unsuspended) — guards against an overly-broad suspension check.
describe('suspension gate does not corrupt normal room data flow', () => {
    it('leaderboard data is intact before suspension and after unsuspend', async () => {
        const app = await createRoomsApp();
        const roomId = await createTestRoom('data-flow-room');
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Flow Game' });
        await createTestSubmission(gameId, { username: 'P1', score: 500 });

        const before = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        expect(before.status).toBe(200);
        expect(before.body).toHaveLength(1);

        await GameRoomService.suspend(roomId, 'super-1', null);
        const during = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        expect(during.status).toBe(403);

        await GameRoomService.unsuspend(roomId);
        const after = await request(app).get(`/api/rooms/${roomId}/leaderboard`);
        expect(after.status).toBe(200);
        expect(after.body).toHaveLength(1);
    });
});
