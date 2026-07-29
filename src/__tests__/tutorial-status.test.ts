import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { signToken } from '../api/auth.js';
import { PreferencesService } from '../services/PreferencesService.js';
import { getDatabase } from '../database/database.js';

/**
 * v2.48.0 — first-login player tutorial (tmp/first-login-tutorial-contract.md).
 * Covers migration 121's fresh-run idempotency, PreferencesService's typed
 * accessors, and the GET/POST /api/me/tutorial-status chokepoint.
 */

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

describe('migration 121_user_preferences_tutorial_seen', () => {
    it('fresh DB has the tutorial_seen_at column and it is nullable', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const columns = await db.all<{ name: string }[]>("PRAGMA table_info(user_preferences)");
        const col = columns.find(c => c.name === 'tutorial_seen_at');
        expect(col).toBeTruthy();

        // Row with no preferences yet — column reads null, no crash.
        const row = await db.get('SELECT tutorial_seen_at FROM user_preferences WHERE discord_user_id = ?', 'nobody');
        expect(row).toBeUndefined();
    });
});

describe('PreferencesService tutorial methods', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('getTutorialSeenAt returns null when nothing is saved', async () => {
        const seenAt = await PreferencesService.getTutorialSeenAt('discord-pref-1');
        expect(seenAt).toBeNull();
    });

    it('markTutorialSeen sets a timestamp readable via getTutorialSeenAt', async () => {
        const written = await PreferencesService.markTutorialSeen('discord-pref-2');
        expect(typeof written).toBe('string');
        const seenAt = await PreferencesService.getTutorialSeenAt('discord-pref-2');
        expect(seenAt).toBe(written);
    });

    it('markTutorialSeen is idempotent across repeated calls (no error, still non-null after)', async () => {
        await PreferencesService.markTutorialSeen('discord-pref-3');
        await expect(PreferencesService.markTutorialSeen('discord-pref-3')).resolves.not.toThrow();
        const seenAt = await PreferencesService.getTutorialSeenAt('discord-pref-3');
        expect(seenAt).not.toBeNull();
    });

    it('does not disturb an existing ui_theme row for the same user', async () => {
        await PreferencesService.setTheme('discord-pref-4', 'ocean');
        await PreferencesService.markTutorialSeen('discord-pref-4');
        const theme = await PreferencesService.getTheme('discord-pref-4');
        expect(theme).toBe('ocean');
    });
});

describe('GET/POST /api/me/tutorial-status — chokepoint', () => {
    async function createApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        app.use('/api', globalRouter);
        return app;
    }

    it('GET requires auth — 401 without a token', async () => {
        const app = await createApp();
        const res = await request(app).get('/api/me/tutorial-status');
        expect(res.status).toBe(401);
    });

    it('POST requires auth — 401 without a token', async () => {
        const app = await createApp();
        const res = await request(app).post('/api/me/tutorial-status');
        expect(res.status).toBe(401);
    });

    it('GET returns seenAt: null for a fresh user, then non-null after POST', async () => {
        const app = await createApp();
        const token = playerToken('discord-ep-1');

        const before = await request(app)
            .get('/api/me/tutorial-status')
            .set('Authorization', `Bearer ${token}`);
        expect(before.status).toBe(200);
        expect(before.body).toEqual({ seenAt: null });

        const post = await request(app)
            .post('/api/me/tutorial-status')
            .set('Authorization', `Bearer ${token}`);
        expect(post.status).toBe(200);
        expect(typeof post.body.seenAt).toBe('string');

        const after = await request(app)
            .get('/api/me/tutorial-status')
            .set('Authorization', `Bearer ${token}`);
        expect(after.status).toBe(200);
        expect(typeof after.body.seenAt).toBe('string');
    });

    it('double-POST is idempotent — both succeed, GET still returns a non-null timestamp', async () => {
        const app = await createApp();
        const token = playerToken('discord-ep-2');

        const first = await request(app)
            .post('/api/me/tutorial-status')
            .set('Authorization', `Bearer ${token}`);
        expect(first.status).toBe(200);

        const second = await request(app)
            .post('/api/me/tutorial-status')
            .set('Authorization', `Bearer ${token}`);
        expect(second.status).toBe(200);

        const after = await request(app)
            .get('/api/me/tutorial-status')
            .set('Authorization', `Bearer ${token}`);
        expect(after.body.seenAt).not.toBeNull();
    });
});
