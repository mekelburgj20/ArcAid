import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

/**
 * S22 Phase 2 (v2.44.0) — PATCH /api/admin/users/:userId/display-name
 * (contract §2/§4). Reuses UserProfileService.setDisplayName's validation
 * directly (length/blocklist/uniqueness) rather than duplicating it — these
 * tests confirm the admin route surfaces the SAME coded errors the
 * self-service PATCH /api/users/me/profile route does.
 */

async function createApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: adminRouter } = await import('../api/routes/admin.js');
    app.use('/api/admin', adminRouter);
    return app;
}

function superToken() {
    return signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'admin' });
}
function roomAdminToken() {
    return signToken({ role: 'room_admin', gameRoomIds: ['some-room'] });
}
function playerTokenFor(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

async function seedProfile(discordUserId: string, displayName: string | null = null): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, display_name) VALUES (?, ?)`,
        discordUserId, displayName,
    );
}

describe('PATCH /api/admin/users/:userId/display-name', () => {
    it('sets a valid display name', async () => {
        const app = await createApp();
        await seedProfile('discord-target-1');

        const res = await request(app)
            .patch('/api/admin/users/discord-target-1/display-name')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ displayName: 'CleanName' });
        expect(res.status).toBe(200);
        expect(res.body.display_name).toBe('CleanName');

        const db = await getDatabase();
        const row = await db.get('SELECT display_name FROM user_profiles WHERE discord_user_id = ?', 'discord-target-1');
        expect(row.display_name).toBe('CleanName');
    });

    it('400s a blocked-term display name', async () => {
        const app = await createApp();
        await seedProfile('discord-target-2');

        const res = await request(app)
            .patch('/api/admin/users/discord-target-2/display-name')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ displayName: 'nigger' });
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('NAME_NOT_ALLOWED');

        const db = await getDatabase();
        const row = await db.get('SELECT display_name FROM user_profiles WHERE discord_user_id = ?', 'discord-target-2');
        expect(row.display_name).toBeNull();
    });

    it('409s a display name already taken by another user', async () => {
        const app = await createApp();
        await seedProfile('discord-taken-owner', 'AlreadyTaken');
        await seedProfile('discord-target-3');

        const res = await request(app)
            .patch('/api/admin/users/discord-target-3/display-name')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ displayName: 'AlreadyTaken' });
        expect(res.status).toBe(409);
        expect(res.body.reason).toBe('taken_display');
    });

    it('clears an existing display name with displayName: null', async () => {
        const app = await createApp();
        await seedProfile('discord-target-4', 'SomeName');

        const res = await request(app)
            .patch('/api/admin/users/discord-target-4/display-name')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ displayName: null });
        expect(res.status).toBe(200);
        expect(res.body.display_name).toBeNull();

        const db = await getDatabase();
        const row = await db.get('SELECT display_name FROM user_profiles WHERE discord_user_id = ?', 'discord-target-4');
        expect(row.display_name).toBeNull();
    });

    it('404s when the target has no user_profiles row at all', async () => {
        const app = await createApp();
        const res = await request(app)
            .patch('/api/admin/users/discord-never-logged-in/display-name')
            .set('Authorization', `Bearer ${superToken()}`)
            .send({ displayName: 'Whatever' });
        expect(res.status).toBe(404);
    });

    it('403s a room_admin token (not super-admin)', async () => {
        const app = await createApp();
        await seedProfile('discord-target-5');
        const res = await request(app)
            .patch('/api/admin/users/discord-target-5/display-name')
            .set('Authorization', `Bearer ${roomAdminToken()}`)
            .send({ displayName: 'Whatever' });
        expect(res.status).toBe(403);
    });

    it('403s a plain player token', async () => {
        const app = await createApp();
        await seedProfile('discord-target-6');
        const res = await request(app)
            .patch('/api/admin/users/discord-target-6/display-name')
            .set('Authorization', `Bearer ${playerTokenFor('discord-someone-else')}`)
            .send({ displayName: 'Whatever' });
        expect(res.status).toBe(403);
    });

    it('401s with no token at all', async () => {
        const app = await createApp();
        const res = await request(app)
            .patch('/api/admin/users/discord-target-7/display-name')
            .send({ displayName: 'Whatever' });
        expect(res.status).toBe(401);
    });
});
