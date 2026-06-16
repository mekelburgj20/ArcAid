import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { signToken } from '../api/auth.js';

// S0 (Phase 0) — critical stopgaps. These lock the two corruption/security
// bugs the audit flagged. Engine-level regression tests for the game_room_id
// INSERT changes land with S2's harness (no engine singleton is imported here,
// per the "no engine test before S2" rule).

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

const adminToken = (roomId: string) => signToken({ role: 'room_admin', gameRoomIds: [roomId] });
const superAdminToken = () => signToken({ role: 'super_admin', gameRoomIds: [] });

describe('S0 — critical stopgaps', () => {
    // SECURITY: merge-player was the S0 stopgap's super_admin-only gate (it ran
    // UNSCOPED cross-tenant writes at the time). S7 SUPERSEDED that: the writes
    // are now room-scoped to :roomId, so the gate is requireAuth + requireRoomAccess
    // and a room_admin of the room is permitted. Cross-room rejection (403),
    // room-scoping isolation, and super_admin-only global-identity writes are
    // covered by s7-admin-safety.test.ts. Here we only keep the two guards that
    // remain unchanged from S0: unauthenticated → 401, and super_admin → not rejected.
    describe('POST /api/rooms/:roomId/admin/merge-player authz', () => {
        it('rejects unauthenticated callers with 401', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom('s0-merge-anon', 'S0 Merge Anon');
            const res = await request(app)
                .post(`/api/rooms/${roomId}/admin/merge-player`)
                .send({ fromUsername: 'GhostA', toUsername: 'GhostB' });
            expect(res.status).toBe(401);
        });

        it('lets a room_admin of the room past the authz gate (S7: now room-scoped)', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom('s0-merge-roomadmin', 'S0 Merge RoomAdmin');
            const res = await request(app)
                .post(`/api/rooms/${roomId}/admin/merge-player`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`)
                .send({ fromUsername: 'GhostA', toUsername: 'GhostB' });
            // Authz gate only — the room-scoped merge internals (and the
            // global-identity gating) are exercised in s7-admin-safety.test.ts.
            expect(res.status).not.toBe(401);
            expect(res.status).not.toBe(403);
        });

        it('lets a super_admin past the authz gate', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom('s0-merge-super', 'S0 Merge Super');
            const res = await request(app)
                .post(`/api/rooms/${roomId}/admin/merge-player`)
                .set('Authorization', `Bearer ${superAdminToken()}`)
                .send({ fromUsername: 'GhostA', toUsername: 'GhostB' });
            // Only the authz change is under test here — the merge internals are
            // covered elsewhere — so we just assert the gate did not reject.
            expect(res.status).not.toBe(401);
            expect(res.status).not.toBe(403);
        });
    });

    // Deleting a tournament with live games left them with a dangling
    // tournament_id: gone from every room-scoped admin query AND no longer
    // importing scores (the poller INNER JOINs tournaments). Guard => 409.
    describe('DELETE /api/rooms/:roomId/tournaments/:id delete-guard', () => {
        it('blocks deletion with 409 when an ACTIVE game exists', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom('s0-del-active', 'S0 Del Active');
            const tId = await createTestTournament(roomId);
            await createTestGame(tId, { name: 'Live Table', status: 'ACTIVE' });

            const res = await request(app)
                .delete(`/api/rooms/${roomId}/tournaments/${tId}`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`);

            expect(res.status).toBe(409);
            expect(Array.isArray(res.body.games)).toBe(true);
            expect(res.body.games).toHaveLength(1);
            expect(res.body.games[0].name).toBe('Live Table');
            expect(res.body.games[0].status).toBe('ACTIVE');
        });

        it('blocks deletion with 409 when a QUEUED game exists', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom('s0-del-queued', 'S0 Del Queued');
            const tId = await createTestTournament(roomId);
            await createTestGame(tId, { name: 'Queued Table', status: 'QUEUED' });

            const res = await request(app)
                .delete(`/api/rooms/${roomId}/tournaments/${tId}`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`);

            expect(res.status).toBe(409);
            expect(res.body.games[0].status).toBe('QUEUED');
        });

        it('allows deletion (200) when only COMPLETED games exist', async () => {
            const app = await createTestApp();
            const roomId = await createTestRoom('s0-del-ok', 'S0 Del OK');
            const tId = await createTestTournament(roomId);
            await createTestGame(tId, { name: 'Old Table', status: 'COMPLETED', endDate: new Date().toISOString() });

            const res = await request(app)
                .delete(`/api/rooms/${roomId}/tournaments/${tId}`)
                .set('Authorization', `Bearer ${adminToken(roomId)}`);

            expect(res.status).toBe(200);
            expect(res.body.success).toBe(true);
        });
    });

    // Migration 102 backfills games.game_room_id; assert it applies cleanly on a
    // fresh DB (catches SQL errors that would otherwise halt startup).
    describe('migration 102 — games.game_room_id backfill', () => {
        it('is registered and applied on a fresh database', async () => {
            await setupTestDb();
            const { getDatabase } = await import('../database/database.js');
            const db = await getDatabase();
            const row = await db.get(
                `SELECT name FROM schema_migrations WHERE name = '102_backfill_games_game_room_id'`,
            );
            expect(row).toBeTruthy();
        });
    });
});
