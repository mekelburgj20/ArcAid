import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { signToken } from '../api/auth.js';
import { getDatabase } from '../database/database.js';
import { GameRoomService } from '../services/GameRoomService.js';

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

describe('POST /api/rooms (public self-serve room creation)', () => {
    it('requires Discord login', async () => {
        const app = await createTestApp();

        const res = await request(app)
            .post('/api/rooms')
            .send({ name: 'My Room', slug: 'my_room' });

        expect(res.status).toBe(401);
    });

    it('creates a standalone room and grants the creator owner', async () => {
        const app = await createTestApp();
        const token = playerToken('discord-1');

        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'My Room', slug: 'my_room', description: 'A test room' });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.room.slug).toBe('my_room');

        const db = await getDatabase();
        const admin = await db.get(
            `SELECT role FROM game_room_admins WHERE game_room_id = ? AND discord_user_id = ?`,
            res.body.room.id, 'discord-1',
        );
        expect(admin?.role).toBe('owner');

        const settings = await db.all(
            `SELECT key, value FROM game_room_settings WHERE game_room_id = ? ORDER BY key`,
            res.body.room.id,
        );
        const map = Object.fromEntries(settings.map((s: any) => [s.key, s.value]));
        expect(map.DISCORD_ENABLED).toBe('false');
        expect(map.ISCORED_ENABLED).toBe('false');
        // Style-system revamp P0 (honesty fix): every new room seeds a real
        // SCOREBOARD_STYLE so it renders the modern card path instead of
        // silently falling back to the legacy GameCard path. 'banner' is the
        // interim default until Phase 1 flips it to the new Arcade style.
        expect(map.SCOREBOARD_STYLE).toBe('banner');
    });

    it('seeds ISCORED_ENABLED=false for the non-standalone (super-admin) create path too (v2.81.0)', async () => {
        // The public self-serve route above always passes mode: 'standalone',
        // which seeds both DISCORD_ENABLED and ISCORED_ENABLED off. The
        // super-admin route (POST /api/admin/rooms) calls GameRoomService.create
        // with no mode — as of v2.81.0 iScored is opt-in for ALL new rooms
        // regardless of mode, so ISCORED_ENABLED must still land false here,
        // while DISCORD_ENABLED is untouched (connected-mode rooms keep Discord
        // on by default).
        await setupTestDb();
        const room = await GameRoomService.create({ name: 'Connected Room', slug: 'connected_room_v281' });

        const db = await getDatabase();
        const settings = await db.all(
            `SELECT key, value FROM game_room_settings WHERE game_room_id = ? ORDER BY key`,
            room.id,
        );
        const map = Object.fromEntries(settings.map((s: any) => [s.key, s.value]));
        expect(map.ISCORED_ENABLED).toBe('false');
        expect(map.DISCORD_ENABLED).toBeUndefined();
        expect(map.SCOREBOARD_STYLE).toBe('banner');
    });

    it('rejects a reserved slug', async () => {
        const app = await createTestApp();
        const token = playerToken('discord-2');

        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Admin Room', slug: 'admin' });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/reserved/i);
    });

    it('rejects a duplicate slug with 409', async () => {
        const app = await createTestApp();
        await createTestRoom('taken_slug', 'Existing Room');
        const token = playerToken('discord-3');

        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'New Room', slug: 'taken_slug' });

        expect(res.status).toBe(409);
    });

    it('enforces the 3-room-per-user cap', async () => {
        // Pre-seed 3 existing owner grants directly (rather than issuing 3 create
        // requests) so this test's single POST doesn't also collide with
        // roomCreateLimiter's 3-per-hour window, which is keyed on the same
        // discordId — that's a real coincidence (both caps are 3) that would
        // otherwise make the 4th request 429 (rate limited) before it ever
        // reaches the cap check, rather than the 403 this test wants to assert.
        const app = await createTestApp();
        const db = await getDatabase();
        const discordId = 'discord-4';
        for (let i = 0; i < 3; i++) {
            const roomId = await createTestRoom(`existing_room_${i}`, `Existing Room ${i}`);
            await db.run(
                `INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'owner')`,
                roomId, discordId,
            );
        }
        const token = playerToken(discordId);

        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Room 4', slug: 'room_4' });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/room limit reached/i);
    });

    it('respects the PUBLIC_ROOM_CREATION_ENABLED kill switch', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        await db.run(
            `INSERT INTO settings (key, value) VALUES ('PUBLIC_ROOM_CREATION_ENABLED', 'false')`,
        );
        const token = playerToken('discord-5');

        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${token}`)
            .send({ name: 'Disabled Room', slug: 'disabled_room' });

        expect(res.status).toBe(403);
        expect(res.body.error).toMatch(/disabled/i);
    });
});
