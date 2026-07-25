import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { createSession, refreshAccessToken } from '../api/auth.js';

// ---------------------------------------------------------------------------
// Google OAuth route coverage (v2.35.0 Google-login contract).
//
// Covers: GET /api/auth/google config gate, POST /api/auth/google/callback
// (mocked token+userinfo fetch -> provider:'google' token + user_profiles
// upsert with avatar_url), and refreshAccessToken re-stamping `provider`
// correctly for both discord and google sessions from user_profiles (not
// user_mappings).
// ---------------------------------------------------------------------------

function decodeJwtPayload(token: string): Record<string, unknown> {
    const parts = token.split('.');
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
}

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: authRouter } = await import('../api/routes/auth.js');
    app.use('/api/auth', authRouter);
    return app;
}

describe('Google OAuth — GET /api/auth/google', () => {
    afterEach(() => {
        delete process.env.GOOGLE_CLIENT_ID;
    });

    it('returns 400 when GOOGLE_CLIENT_ID is unset', async () => {
        const app = await createTestApp();
        const res = await request(app).get('/api/auth/google');
        expect(res.status).toBe(400);
    });

    it('returns clientId when configured', async () => {
        process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
        const app = await createTestApp();
        const res = await request(app).get('/api/auth/google');
        expect(res.status).toBe(200);
        expect(res.body.clientId).toBe('test-google-client-id');
    });
});

describe('Google OAuth — POST /api/auth/google/callback', () => {
    beforeEach(() => {
        process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
    });

    afterEach(() => {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        vi.unstubAllGlobals();
    });

    function mockGoogleFetch(profile: { sub: string; name?: string; email?: string; picture?: string }) {
        vi.stubGlobal('fetch', vi.fn(async (url: string) => {
            if (url === 'https://oauth2.googleapis.com/token') {
                return {
                    ok: true,
                    json: async () => ({ access_token: 'fake-access-token', token_type: 'Bearer' }),
                } as any;
            }
            if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
                return { ok: true, json: async () => profile } as any;
            }
            throw new Error(`Unexpected fetch URL in test: ${url}`);
        }));
    }

    it('mints a player token with provider:google and upserts user_profiles.avatar_url', async () => {
        mockGoogleFetch({ sub: 'sub-12345', name: 'Ada Lovelace', email: 'ada@example.com', picture: 'https://lh3.googleusercontent.com/pic.jpg' });
        const app = await createTestApp();

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });

        expect(res.status).toBe(200);
        expect(res.body.token).toBeTruthy();
        expect(res.body.user.discordId).toBe('google:sub-12345');
        expect(res.body.user.username).toBe('Ada Lovelace');
        expect(res.body.user.avatar).toBe('https://lh3.googleusercontent.com/pic.jpg');

        const payload = decodeJwtPayload(res.body.token);
        expect(payload.provider).toBe('google');
        expect(payload.role).toBe('player');
        expect(payload.discordId).toBe('google:sub-12345');

        const db = await getDatabase();
        const profile = await db.get(
            'SELECT avatar_url, avatar_hash FROM user_profiles WHERE discord_user_id = ?',
            'google:sub-12345',
        );
        expect(profile.avatar_url).toBe('https://lh3.googleusercontent.com/pic.jpg');
        expect(profile.avatar_hash).toBeNull();
    });

    it('falls back to email-local-part when Google reports no name', async () => {
        mockGoogleFetch({ sub: 'sub-noname', email: 'noname@example.com' });
        const app = await createTestApp();

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });

        expect(res.status).toBe(200);
        expect(res.body.user.username).toBe('noname');
    });

    it('mints a super_admin token when the google id is a super admin', async () => {
        mockGoogleFetch({ sub: 'sub-admin', name: 'Admin Ada' });
        const app = await createTestApp();
        const db = await getDatabase();
        await db.run(
            'INSERT INTO super_admins (discord_user_id, username) VALUES (?, ?)',
            'google:sub-admin', 'Admin Ada',
        );

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });

        expect(res.status).toBe(200);
        const payload = decodeJwtPayload(res.body.token);
        expect(payload.role).toBe('super_admin');
        expect(payload.provider).toBe('google');
    });

    it('returns 400 when GOOGLE_CLIENT_SECRET is unset', async () => {
        delete process.env.GOOGLE_CLIENT_SECRET;
        const app = await createTestApp();
        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });
        expect(res.status).toBe(400);
    });

    it('returns 401 when Google rejects the code', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, text: async () => 'invalid_grant' } as any)));
        const app = await createTestApp();
        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'bad-code', redirectUri: 'https://arcaid.app/auth/google/callback' });
        expect(res.status).toBe(401);
    });
});

describe('refreshAccessToken — provider re-stamping (v2.35.0)', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('re-stamps provider:discord for a legacy discord session and reads username from user_profiles', async () => {
        const db = await getDatabase();
        const discordId = '123456789012345678';
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name, avatar_hash) VALUES (?, ?, ?)`,
            discordId, 'ChosenName', 'abc123hash',
        );
        const refreshToken = 'refresh-token-discord';
        await createSession(discordId, refreshToken, 'irrelevant-access-token');

        const result = await refreshAccessToken(refreshToken);
        expect(result).not.toBeNull();
        const payload = decodeJwtPayload(result!.token);
        expect(payload.provider).toBe('discord');
        expect(payload.username).toBe('ChosenName');
        expect(payload.avatar).toBe('https://cdn.discordapp.com/avatars/123456789012345678/abc123hash.png');
    });

    it('re-stamps provider:google for a google session and reads avatar_url', async () => {
        const db = await getDatabase();
        const googleId = 'google:sub-999';
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, display_name, avatar_url) VALUES (?, ?, ?)`,
            googleId, 'GoogleChosenName', 'https://example.com/pic.jpg',
        );
        const refreshToken = 'refresh-token-google';
        await createSession(googleId, refreshToken, 'irrelevant-access-token');

        const result = await refreshAccessToken(refreshToken);
        expect(result).not.toBeNull();
        const payload = decodeJwtPayload(result!.token);
        expect(payload.provider).toBe('google');
        expect(payload.username).toBe('GoogleChosenName');
        expect(payload.avatar).toBe('https://example.com/pic.jpg');
        expect(payload.discordId).toBe('google:sub-999');
    });

    it('degrades to the raw id as username when no display_name is set (documented tradeoff)', async () => {
        const db = await getDatabase();
        const googleId = 'google:sub-nodisplay';
        await db.run(`INSERT INTO user_profiles (discord_user_id) VALUES (?)`, googleId);
        const refreshToken = 'refresh-token-nodisplay';
        await createSession(googleId, refreshToken, 'irrelevant-access-token');

        const result = await refreshAccessToken(refreshToken);
        const payload = decodeJwtPayload(result!.token);
        expect(payload.username).toBe(googleId);
    });
});
