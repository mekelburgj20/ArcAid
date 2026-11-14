import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { signToken } from '../api/auth.js';
import { normalizeInstallVideoUrl } from '../utils/witnessInstallVideo.js';

/** The super-admin-set install video link: validator + public/admin routes. */

const playerToken = signToken({ role: 'player', gameRoomIds: [], discordId: '123456789012345678', username: 'p' });
const superToken = signToken({ role: 'super_admin', gameRoomIds: [], discordId: 'super-1', username: 'admin' });
const VIDEO = 'https://www.youtube.com/watch?v=abc123';

describe('normalizeInstallVideoUrl', () => {
    it('accepts an absolute https address, trimmed', () => {
        expect(normalizeInstallVideoUrl(VIDEO)).toBe(VIDEO);
        expect(normalizeInstallVideoUrl(`  ${VIDEO}  `)).toBe(VIDEO);
    });
    it('clears on empty or whitespace', () => {
        expect(normalizeInstallVideoUrl('')).toBeNull();
        expect(normalizeInstallVideoUrl('   ')).toBeNull();
        expect(normalizeInstallVideoUrl(null)).toBeNull();
    });
    it('refuses http, javascript:, relative and non-strings', () => {
        expect(normalizeInstallVideoUrl('http://example.com/v')).toBeUndefined();
        expect(normalizeInstallVideoUrl('javascript:alert(1)')).toBeUndefined();
        expect(normalizeInstallVideoUrl('//example.com/v')).toBeUndefined();
        expect(normalizeInstallVideoUrl(42)).toBeUndefined();
    });
    it('refuses quotes, angle brackets, whitespace and control characters', () => {
        for (const bad of ['https://a.com/"x', 'https://a.com/<x', 'https://a.com/x>', 'https://a.com/a b', 'https://a.com/a\tb', 'https://a.com/a\u0007b']) {
            expect(normalizeInstallVideoUrl(bad)).toBeUndefined();
        }
    });
    it('refuses more than 500 characters', () => {
        const long = 'https://a.com/' + 'x'.repeat(500);
        expect(normalizeInstallVideoUrl(long)).toBeUndefined();
        expect(normalizeInstallVideoUrl('https://a.com/' + 'x'.repeat(486))).toBeDefined();
    });
});

describe('install video routes', () => {
    let app: express.Express;
    beforeEach(async () => {
        await setupTestDb();
        app = express();
        app.use(express.json());
        const { default: globalRouter } = await import('../api/routes/global.js');
        const { default: adminRouter } = await import('../api/routes/admin.js');
        app.use('/api/admin', adminRouter);
        app.use('/api', globalRouter);
    });
    const put = (body: unknown) =>
        request(app).put('/api/admin/witness/guide').set('Authorization', `Bearer ${superToken}`).send(body as object);

    it('public read null -> set -> read -> clear -> null', async () => {
        const first = await request(app).get('/api/witness/guide');
        expect(first.status).toBe(200);
        expect(first.body).toEqual({ videoUrl: null });
        expect(first.headers['cache-control']).toBe('public, max-age=60');

        const set = await put({ videoUrl: VIDEO });
        expect(set.status).toBe(200);
        expect(set.body).toEqual({ videoUrl: VIDEO });
        expect((await request(app).get('/api/witness/guide')).body).toEqual({ videoUrl: VIDEO });
        const admin = await request(app).get('/api/admin/witness/guide').set('Authorization', `Bearer ${superToken}`);
        expect(admin.body).toEqual({ videoUrl: VIDEO });

        const cleared = await put({ videoUrl: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body).toEqual({ videoUrl: null });
        expect((await request(app).get('/api/witness/guide')).body).toEqual({ videoUrl: null });
    });

    it('an invalid address is a 400 and changes nothing', async () => {
        await put({ videoUrl: VIDEO });
        const bad = await put({ videoUrl: 'http://example.com/v' });
        expect(bad.status).toBe(400);
        expect(bad.body).toEqual({ error: 'VIDEO_URL_INVALID' });
        expect((await request(app).get('/api/witness/guide')).body).toEqual({ videoUrl: VIDEO });
    });

    it('an invalid stored value reads as null', async () => {
        const { SettingsService } = await import('../services/SettingsService.js');
        await SettingsService.saveMany({ WITNESS_INSTALL_VIDEO_URL: 'javascript:alert(1)' });
        expect((await request(app).get('/api/witness/guide')).body).toEqual({ videoUrl: null });
    });

    it('the admin routes are super-admin only', async () => {
        const get = await request(app).get('/api/admin/witness/guide').set('Authorization', `Bearer ${playerToken}`);
        expect(get.status).toBe(403);
        const res = await request(app).put('/api/admin/witness/guide')
            .set('Authorization', `Bearer ${playerToken}`).send({ videoUrl: VIDEO });
        expect(res.status).toBe(403);
    });
});
