import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { Scheduler } from '../engine/Scheduler.js';

/**
 * DELETE /api/rooms/:roomId/admin/room — the room owner deletes their own room
 * from Room Settings → Danger zone. Owner (or super admin) only, slug typed to
 * confirm, suspended rooms held by the visibility gate.
 */

async function createRoomsApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

function roomAdminToken(roomId: string, discordId?: string, extra: Record<string, unknown> = {}) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId, username: 'Admin', ...extra });
}

async function addAdmin(roomId: string, discordId: string, role: 'owner' | 'admin') {
    const db = await getDatabase();
    await db.run('INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, ?)', roomId, discordId, role);
}

async function roomExists(roomId: string) {
    const db = await getDatabase();
    return !!(await db.get('SELECT id FROM game_rooms WHERE id = ?', roomId));
}

describe('DELETE /api/rooms/:roomId/admin/room (owner deletes their room)', () => {
    let app: express.Express;
    let roomId: string;
    const slug = `owner-del-${Math.random().toString(36).slice(2, 8)}`;

    beforeEach(async () => {
        app = await createRoomsApp();
        roomId = await createTestRoom(`${slug}-${Math.random().toString(36).slice(2, 6)}`, 'Owner Delete Room');
        vi.spyOn(Scheduler.getInstance(), 'reload').mockResolvedValue();
    });

    async function slugOf(id: string) {
        const db = await getDatabase();
        return (await db.get<{ slug: string }>('SELECT slug FROM game_rooms WHERE id = ?', id))!.slug;
    }

    it('lets the owner delete the room (with its tournaments) and writes an audit row', async () => {
        await addAdmin(roomId, 'owner-1', 'owner');
        const tournamentId = await createTestTournament(roomId, { name: 'Weekly' });
        const roomSlug = await slugOf(roomId);

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/room`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId, 'owner-1')}`)
            .send({ confirm: roomSlug.toUpperCase() });

        expect(res.status).toBe(200);
        expect(await roomExists(roomId)).toBe(false);
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM tournaments WHERE id = ?', tournamentId)).toBeUndefined();
        expect(await db.get('SELECT 1 FROM game_room_admins WHERE game_room_id = ?', roomId)).toBeUndefined();
        const audit = await db.get<{ actor: string; details: string }>(
            `SELECT actor, details FROM audit_log WHERE action = 'room.delete' AND target_id = ?`, roomId,
        );
        expect(audit?.actor).toBe('owner-1');
        expect(JSON.parse(audit!.details)).toMatchObject({ slug: roomSlug, by: 'owner' });
        expect(Scheduler.getInstance().reload).toHaveBeenCalled();
    });

    it('refuses a co-admin who is not the owner', async () => {
        await addAdmin(roomId, 'owner-1', 'owner');
        await addAdmin(roomId, 'coadmin-1', 'admin');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/room`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId, 'coadmin-1')}`)
            .send({ confirm: await slugOf(roomId) });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('OWNER_REQUIRED');
        expect(await roomExists(roomId)).toBe(true);
    });

    it('refuses a password (local) admin, who has no owner row', async () => {
        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/room`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId, undefined, { localAdminId: 'local-1' })}`)
            .send({ confirm: await slugOf(roomId) });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('OWNER_REQUIRED');
        expect(await roomExists(roomId)).toBe(true);
    });

    it('refuses an owner token for a different room', async () => {
        const otherRoom = await createTestRoom(`other-${Math.random().toString(36).slice(2, 8)}`, 'Other');
        await addAdmin(otherRoom, 'owner-2', 'owner');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/room`)
            .set('Authorization', `Bearer ${roomAdminToken(otherRoom, 'owner-2')}`)
            .send({ confirm: await slugOf(roomId) });

        expect(res.status).toBe(403);
        expect(await roomExists(roomId)).toBe(true);
    });

    it('refuses when the typed confirmation is not the room slug', async () => {
        await addAdmin(roomId, 'owner-1', 'owner');

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/room`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId, 'owner-1')}`)
            .send({ confirm: 'wrong' });

        expect(res.status).toBe(400);
        expect(res.body.code).toBe('CONFIRM_MISMATCH');
        expect(await roomExists(roomId)).toBe(true);
    });

    it('holds a suspended room: the owner cannot delete it', async () => {
        await addAdmin(roomId, 'owner-1', 'owner');
        const db = await getDatabase();
        await db.run(`UPDATE game_rooms SET suspended_at = datetime('now'), suspended_by = 'sa' WHERE id = ?`, roomId);

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/room`)
            .set('Authorization', `Bearer ${roomAdminToken(roomId, 'owner-1')}`)
            .send({ confirm: await slugOf(roomId) });

        expect(res.status).toBe(403);
        expect(res.body.code).toBe('ROOM_SUSPENDED');
        expect(await roomExists(roomId)).toBe(true);
    });

    it('lets a super admin delete any room', async () => {
        const token = signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'SA' });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/admin/room`)
            .set('Authorization', `Bearer ${token}`)
            .send({ confirm: await slugOf(roomId) });

        expect(res.status).toBe(200);
        expect(await roomExists(roomId)).toBe(false);
    });
});
