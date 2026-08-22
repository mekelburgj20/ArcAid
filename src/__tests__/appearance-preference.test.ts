import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { signToken } from '../api/auth.js';
import { PreferencesService } from '../services/PreferencesService.js';
import { UpdatePreferencesSchema } from '../api/schemas.js';
import { getDatabase } from '../database/database.js';

/**
 * v2.130.0 — the viewer-level Dark/Light/Auto Appearance preference.
 *
 * Migration 161 adds `user_preferences.appearance` (nullable = 'auto'), and
 * `/api/me/preferences` grew a second independently-optional field so the
 * Appearance control and the admin theme select can each post only what they
 * changed without clobbering each other.
 */

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

describe('migration 161_user_preferences_appearance', () => {
    it('fresh DB has the appearance column and it is nullable', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const columns = await db.all<{ name: string; notnull: number }[]>('PRAGMA table_info(user_preferences)');
        const col = columns.find(c => c.name === 'appearance');
        expect(col).toBeTruthy();
        expect(col!.notnull).toBe(0);
    });
});

describe('UpdatePreferencesSchema', () => {
    it('accepts { appearance } alone', () => {
        const parsed = UpdatePreferencesSchema.safeParse({ appearance: 'light' });
        expect(parsed.success).toBe(true);
    });

    it('accepts { ui_theme } alone', () => {
        const parsed = UpdatePreferencesSchema.safeParse({ ui_theme: 'ocean' });
        expect(parsed.success).toBe(true);
    });

    it('accepts both together', () => {
        const parsed = UpdatePreferencesSchema.safeParse({ ui_theme: 'coffee', appearance: 'auto' });
        expect(parsed.success).toBe(true);
    });

    it('rejects an unknown appearance value', () => {
        expect(UpdatePreferencesSchema.safeParse({ appearance: 'sepia' }).success).toBe(false);
        expect(UpdatePreferencesSchema.safeParse({ appearance: true }).success).toBe(false);
    });

    it('rejects an unknown theme value', () => {
        expect(UpdatePreferencesSchema.safeParse({ ui_theme: 'neon-banana' }).success).toBe(false);
    });

    it('rejects a body carrying neither field', () => {
        expect(UpdatePreferencesSchema.safeParse({}).success).toBe(false);
    });
});

describe('PreferencesService appearance', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('getAll reports null appearance for a user who has never chosen', async () => {
        const all = await PreferencesService.getAll('discord-app-1');
        expect(all).toEqual({ ui_theme: null, appearance: null });
    });

    it('round-trips light and dark through getAll', async () => {
        await PreferencesService.setAppearance('discord-app-2', 'light');
        expect((await PreferencesService.getAll('discord-app-2')).appearance).toBe('light');

        await PreferencesService.setAppearance('discord-app-2', 'dark');
        expect((await PreferencesService.getAll('discord-app-2')).appearance).toBe('dark');
    });

    it("stores 'auto' as NULL — the absence of an override, not a third value", async () => {
        await PreferencesService.setAppearance('discord-app-3', 'light');
        await PreferencesService.setAppearance('discord-app-3', 'auto');

        expect(await PreferencesService.getAppearance('discord-app-3')).toBeNull();
        const db = await getDatabase();
        const row = await db.get('SELECT appearance FROM user_preferences WHERE discord_user_id = ?', 'discord-app-3');
        expect(row.appearance).toBeNull();
    });

    it('appearance and ui_theme are independent on the same row', async () => {
        await PreferencesService.setTheme('discord-app-4', 'ocean');
        await PreferencesService.setAppearance('discord-app-4', 'light');
        expect(await PreferencesService.getAll('discord-app-4')).toEqual({ ui_theme: 'ocean', appearance: 'light' });

        // Changing the theme must not disturb the appearance...
        await PreferencesService.setTheme('discord-app-4', 'coffee');
        expect((await PreferencesService.getAll('discord-app-4')).appearance).toBe('light');
        // ...and clearing the theme must not delete the row out from under it
        // (pre-v2.130 setTheme(null) was a DELETE of the whole row).
        await PreferencesService.setTheme('discord-app-4', null);
        expect(await PreferencesService.getAll('discord-app-4')).toEqual({ ui_theme: null, appearance: 'light' });
    });

    it('ignores a junk value stored directly in the column', async () => {
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_preferences (discord_user_id, appearance) VALUES (?, ?)',
            'discord-app-5', 'sepia',
        );
        expect(await PreferencesService.getAppearance('discord-app-5')).toBeNull();
    });
});

describe('GET/POST /api/me/preferences — appearance', () => {
    async function createApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    // Generous timeout: this is the first test in the describe to build a
    // fresh DB, and the full migration chain alone can outrun the 10s default.
    it('requires auth', async () => {
        const app = await createApp();
        expect((await request(app).get('/api/me/preferences')).status).toBe(401);
        expect((await request(app).post('/api/me/preferences').send({ appearance: 'light' })).status).toBe(401);
    }, 30000);

    it('accepts a player token and round-trips the appearance', async () => {
        const app = await createApp();
        const token = playerToken('discord-ep-app-1');

        const before = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(before.status).toBe(200);
        expect(before.body).toEqual({ ui_theme: null, appearance: null });

        const post = await request(app)
            .post('/api/me/preferences')
            .set('Authorization', `Bearer ${token}`)
            .send({ appearance: 'light' });
        expect(post.status).toBe(200);

        const after = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(after.body).toEqual({ ui_theme: null, appearance: 'light' });
    });

    it('posting only ui_theme leaves a stored appearance untouched', async () => {
        const app = await createApp();
        const token = playerToken('discord-ep-app-2');

        await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`).send({ appearance: 'dark' });
        await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`).send({ ui_theme: 'ocean' });

        const after = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(after.body).toEqual({ ui_theme: 'ocean', appearance: 'dark' });
    });

    it('rejects a bad appearance value with 400', async () => {
        const app = await createApp();
        const token = playerToken('discord-ep-app-3');
        const res = await request(app)
            .post('/api/me/preferences')
            .set('Authorization', `Bearer ${token}`)
            .send({ appearance: 'sepia' });
        expect(res.status).toBe(400);
    });
});
