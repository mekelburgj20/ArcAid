import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { PreferencesService, getRecapPrefsVersion } from '../services/PreferencesService.js';

/**
 * Run recap privacy switches (B31.1): `recap_play_stats` (default shown) and
 * `recap_time_of_day` (default off), through the service and /api/me/preferences.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

const playerToken = (discordId: string) =>
    signToken({ role: 'player', gameRoomIds: [], discordId, username: discordId });

beforeEach(async () => { await setupTestDb(); });

describe('PreferencesService recap prefs', () => {
    it('defaults: play stats shown, time of day off', async () => {
        expect(await PreferencesService.getRecapPlayStats('u-new')).toBe(true);
        expect(await PreferencesService.getRecapTimeOfDay('u-new')).toBe(false);
    });

    it('round-trips both and leaves other prefs alone', async () => {
        await PreferencesService.setAppearance('u1', 'light');
        await PreferencesService.setRecapPlayStats('u1', false);
        await PreferencesService.setRecapTimeOfDay('u1', true);
        expect(await PreferencesService.getRecapPlayStats('u1')).toBe(false);
        expect(await PreferencesService.getRecapTimeOfDay('u1')).toBe(true);
        expect(await PreferencesService.getAppearance('u1')).toBe('light');
        await PreferencesService.setRecapPlayStats('u1', true);
        expect(await PreferencesService.getRecapPlayStats('u1')).toBe(true);
    });

    it('every setter bumps the cache watermark', async () => {
        const v = getRecapPrefsVersion();
        await PreferencesService.setRecapPlayStats('u1', false);
        await PreferencesService.setRecapTimeOfDay('u1', true);
        expect(getRecapPrefsVersion()).toBe(v + 2);
    });
});

describe('getRecapPrefsFor', () => {
    it('gives defaults to unknown and iscored:* keys', async () => {
        const m = await PreferencesService.getRecapPrefsFor(['nobody', 'iscored:ann']);
        expect(m.get('nobody')).toEqual({ playStats: true, timeOfDay: false });
        expect(m.get('iscored:ann')).toEqual({ playStats: true, timeOfDay: false });
    });

    it('reads the raw id', async () => {
        await PreferencesService.setRecapPlayStats('d1', false);
        await PreferencesService.setRecapTimeOfDay('d2', true);
        const m = await PreferencesService.getRecapPrefsFor(['d1', 'd2']);
        expect(m.get('d1')).toEqual({ playStats: false, timeOfDay: false });
        expect(m.get('d2')).toEqual({ playStats: true, timeOfDay: true });
    });

    it('uses the union of raw and canonical ids: hidden if ANY hides; time of day from the canonical', async () => {
        const db = await getDatabase();
        await db.run(`INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES ('google:1', 'disc1')`);
        await db.run(`INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES ('google:2', 'disc2')`);
        // google:1 hides on the raw id only; disc1 shows.
        await PreferencesService.setRecapPlayStats('google:1', false);
        // disc2 opted in to time of day; google:2 has nothing.
        await PreferencesService.setRecapTimeOfDay('disc2', true);
        // A raw id that opts in, but whose canonical says off, stays off.
        await PreferencesService.setRecapTimeOfDay('google:1', true);
        await PreferencesService.setRecapTimeOfDay('disc1', false);
        const m = await PreferencesService.getRecapPrefsFor(['google:1', 'google:2', 'disc1']);
        expect(m.get('google:1')).toEqual({ playStats: false, timeOfDay: false });
        expect(m.get('google:2')).toEqual({ playStats: true, timeOfDay: true });
        expect(m.get('disc1')).toEqual({ playStats: true, timeOfDay: false });
    });
});

describe('GET/POST /api/me/preferences recap keys', () => {
    it('reports the defaults and persists only what was sent', async () => {
        const app = await createTestApp();
        const token = playerToken('u-1');
        const before = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(before.body).toMatchObject({ recap_play_stats: true, recap_time_of_day: false });

        const a = await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`).send({ recap_play_stats: false });
        expect(a.status).toBe(200);
        let now = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(now.body).toMatchObject({ recap_play_stats: false, recap_time_of_day: false });

        await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`).send({ recap_time_of_day: true });
        now = await request(app).get('/api/me/preferences').set('Authorization', `Bearer ${token}`);
        expect(now.body).toMatchObject({ recap_play_stats: false, recap_time_of_day: true });
    });

    it('still refuses an empty body and a non-boolean value', async () => {
        const app = await createTestApp();
        const token = playerToken('u-1');
        expect((await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`).send({})).status).toBe(400);
        expect((await request(app).post('/api/me/preferences').set('Authorization', `Bearer ${token}`).send({ recap_play_stats: 'no' })).status).toBe(400);
    });
});
