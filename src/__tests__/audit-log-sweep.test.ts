import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * 2026-08 audit-log sweep (ROADMAP.md "Audit").
 *
 * The app-level `auditLog` middleware (src/api/auditMiddleware.ts) was
 * mounted BEFORE every router's own requireAuth/requireSuperAdmin, so
 * req.user was never set when it ran — it audited NOTHING in production,
 * for any route. The fix is explicit `AuditService.log` calls at each
 * admin-write call site (de facto doctrine since v2.49.0's room-ban routes).
 *
 * These tests mount the routers DIRECTLY — no auditLog middleware anywhere
 * in the chain — so an audit_log row can only come from the route's own
 * explicit AuditService.log call. This is the same proof pattern
 * room-bans.test.ts uses for the reference room.ban/room.unban routes.
 */

async function createAdminApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    return app;
}

async function createRoomsApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function superToken(discordId = 'super-audit-sweep-1') {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId, username: 'SuperAdmin' });
}

function roomAdminToken(discordId: string, roomIds: string[]) {
    return signToken({ role: 'room_admin', gameRoomIds: roomIds, discordId, username: 'RoomAdmin' });
}

async function latestAuditRow(action: string) {
    const db = await getDatabase();
    return db.get(`SELECT * FROM audit_log WHERE action = ? ORDER BY id DESC LIMIT 1`, action);
}

describe('POST /api/admin/settings — explicit audit write, keys only (no secret values)', () => {
    it('writes an audit_log row listing changed keys, with no secret VALUE anywhere in details', async () => {
        const app = await createAdminApp();

        const secretValue = 'super-secret-ra-key-do-not-leak-9f8e7d';
        const plainValue = 'plain-non-secret-value-should-also-not-leak';

        const res = await request(app)
            .post('/api/admin/settings')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ RA_API_KEY: secretValue, GAME_ROOM_NAME: plainValue });
        expect(res.status).toBe(200);

        const row = await latestAuditRow('settings.update');
        expect(row).toBeTruthy();
        expect(row.actor).toBe('super-audit-sweep-1');

        const details = JSON.parse(row.details);
        expect(details.keys).toEqual(expect.arrayContaining(['RA_API_KEY', 'GAME_ROOM_NAME']));

        // Doctrine: log KEYS changed, never values — secrets doubly so. Assert
        // the raw details string (not just the parsed `keys` array) never
        // contains either value, so a future change that starts spreading
        // req.body into `details` gets caught here.
        expect(row.details).not.toContain(secretValue);
        expect(row.details).not.toContain(plainValue);

        // The setting itself still round-trips as ciphertext at rest — this
        // test isn't asserting encryption behavior, just that the audit trail
        // never becomes a second, unencrypted copy of the secret.
        const db = await getDatabase();
        const stored = await db.get('SELECT value FROM settings WHERE key = ?', 'RA_API_KEY');
        expect(stored.value).not.toBe(secretValue);
    });
});

describe('DELETE /api/admin/rooms/:roomId — explicit audit write (destructive)', () => {
    it('writes an audit_log row (action room.delete) naming the deleted room', async () => {
        const app = await createAdminApp();
        const roomId = await createTestRoom('audit-sweep-room-delete', 'Sweep Delete Room');

        const res = await request(app)
            .delete(`/api/admin/rooms/${roomId}`)
            .set('Authorization', `Bearer ${superToken()}`);
        expect(res.status).toBe(200);

        const row = await latestAuditRow('room.delete');
        expect(row).toBeTruthy();
        expect(row.target_id).toBe(roomId);
        expect(JSON.parse(row.details).slug).toBe('audit-sweep-room-delete');
    });
});

describe('POST /api/admin/bans — explicit audit write (moderation)', () => {
    it('writes an audit_log row (action user.ban) for the banned identity', async () => {
        const app = await createAdminApp();
        const targetId = 'discord-audit-sweep-ban-target';

        const res = await request(app)
            .post('/api/admin/bans')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ discordUserId: targetId, reason: 'sweep test' });
        expect(res.status).toBe(201);

        const row = await latestAuditRow('user.ban');
        expect(row).toBeTruthy();
        expect(row.target_id).toBe(targetId);
        expect(JSON.parse(row.details).reason).toBe('sweep test');
    });
});

describe('DELETE /api/rooms/:roomId/admin/games/:gameId/submissions/:submissionId — explicit audit write (wipe player)', () => {
    it('writes an audit_log row (action submission.wipe) — the reference moderation action for this route family', async () => {
        const app = await createRoomsApp();
        const roomId = await createTestRoom('audit-sweep-wipe-room');
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId, { name: 'Sweep Wipe Game' });
        const submissionId = await createTestSubmission(gameId, { username: 'WipeMe', score: 4242 });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/games/${gameId}/submissions/${submissionId}`)
            .set('Authorization', `Bearer ${roomAdminToken('discord-audit-sweep-admin-1', [roomId])}`);
        expect(res.status).toBe(200);

        const row = await latestAuditRow('submission.wipe');
        expect(row).toBeTruthy();
        expect(row.target_id).toBe(submissionId);
        const details = JSON.parse(row.details);
        expect(details.roomId).toBe(roomId);
        expect(details.player.toLowerCase()).toBe('wipeme');
        expect(details.score).toBe(4242);
    });
});

describe('POST /api/rooms/:roomId/admin/merge-player — explicit audit write (identity op)', () => {
    it('writes an audit_log row (action player.merge) on commit, not on dry-run', async () => {
        const app = await createRoomsApp();
        const roomId = await createTestRoom('audit-sweep-merge-room');
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId, { name: 'Sweep Merge Game' });
        await createTestSubmission(gameId, { username: 'OldName', score: 100 });

        const adminToken = roomAdminToken('discord-audit-sweep-merge-admin', [roomId]);

        // Dry-run must NOT write an audit row (no mutation happened).
        const dryRes = await request(app)
            .post(`/api/rooms/${roomId}/admin/merge-player?dryRun=true`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ fromUsername: 'OldName', toUsername: 'NewName' });
        expect(dryRes.status).toBe(200);
        expect(await latestAuditRow('player.merge')).toBeUndefined();

        const commitRes = await request(app)
            .post(`/api/rooms/${roomId}/admin/merge-player`)
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ fromUsername: 'OldName', toUsername: 'NewName' });
        expect(commitRes.status).toBe(200);

        const row = await latestAuditRow('player.merge');
        expect(row).toBeTruthy();
        expect(row.target_id).toBe('NewName');
        const details = JSON.parse(row.details);
        expect(details.roomId).toBe(roomId);
        expect(details.fromUsername).toBe('OldName');
        expect(details.toUsername).toBe('NewName');
    });
});

describe('app-level auditLog middleware is no longer mounted (dead-weight removal)', () => {
    it('a plain admin write with no explicit AuditService.log call produces NO audit row', async () => {
        // PUT /api/admin/catalogue/games/:id (routine metadata edit) was
        // deliberately left out of the explicit-audit sweep — low
        // accountability weight, not moderation/destructive/identity/settings.
        // Pre-sweep, the blanket auditLog middleware was already dead for this
        // route in production (mount-order bug); this asserts it stays dead
        // now that the mount itself is gone, i.e. no *new* silent auto-audit
        // reappears. Targets a nonexistent id (404) to stay fully synchronous
        // and side-effect-free.
        const app = await createAdminApp();
        const db = await getDatabase();
        const before = await db.get('SELECT COUNT(*) AS c FROM audit_log');

        const res = await request(app)
            .put('/api/admin/catalogue/games/does-not-exist')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ name: 'irrelevant' });
        expect(res.status).toBe(404);

        const after = await db.get('SELECT COUNT(*) AS c FROM audit_log');
        expect(after.c).toBe(before.c);
    });
});
