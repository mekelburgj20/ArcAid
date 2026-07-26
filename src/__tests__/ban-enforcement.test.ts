import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { createSession, refreshAccessToken, signToken } from '../api/auth.js';
import { BanService } from '../services/BanService.js';
import { ScoreReportService } from '../services/ScoreReportService.js';

/**
 * S22 Phase 2 (v2.44.0) — ban enforcement at token issuance (contract §3/§4).
 *
 * Enforcement points covered: refreshAccessToken (unit + route), POST
 * /api/rooms (room creation), and the two OAuth callbacks (using the
 * PRE-EXISTING mockDiscordFetch/mockGoogleFetch pattern from
 * identity-link-flow.test.ts / google-oauth.test.ts — no new mock
 * infrastructure needed, per the contract's fallback guidance).
 *
 * `BanService.isIdentityBanned` itself is unit-tested directly against the
 * `user_bans` + `user_identity_links` tables.
 */

function decodeJwtPayload(token: string): Record<string, unknown> {
    const parts = token.split('.');
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
}

function mockDiscordFetch(discordUser: { id: string; username: string; global_name?: string; avatar?: string }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === 'https://discord.com/api/oauth2/token') {
            return { ok: true, json: async () => ({ access_token: 'fake-access-token', token_type: 'Bearer' }) } as any;
        }
        if (url === 'https://discord.com/api/users/@me') {
            return { ok: true, json: async () => discordUser } as any;
        }
        throw new Error(`Unexpected fetch URL in test: ${url}`);
    }));
}

function mockGoogleFetch(profile: { sub: string; name?: string; email?: string; picture?: string }) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === 'https://oauth2.googleapis.com/token') {
            return { ok: true, json: async () => ({ access_token: 'fake-access-token', token_type: 'Bearer' }) } as any;
        }
        if (url === 'https://openidconnect.googleapis.com/v1/userinfo') {
            return { ok: true, json: async () => profile } as any;
        }
        throw new Error(`Unexpected fetch URL in test: ${url}`);
    }));
}

async function seedBan(discordUserId: string, opts: { expiresAt?: string | null; liftedAt?: string | null } = {}): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, reason, banned_by, expires_at, lifted_at)
         VALUES (?, ?, 'test ban', 'test-admin', ?, ?)`,
        id, discordUserId, opts.expiresAt ?? null, opts.liftedAt ?? null,
    );
    return id;
}

describe('BanService.isIdentityBanned — unit', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('not banned when no user_bans row exists', async () => {
        const result = await BanService.isIdentityBanned('discord-clean-1');
        expect(result.banned).toBe(false);
    });

    it('banned when an active ban row exists on the raw id', async () => {
        await seedBan('discord-banned-1');
        const result = await BanService.isIdentityBanned('discord-banned-1');
        expect(result.banned).toBe(true);
        expect(result.reason).toBe('test ban');
    });

    it('not banned once the ban is lifted', async () => {
        await seedBan('discord-lifted-1', { liftedAt: new Date().toISOString() });
        const result = await BanService.isIdentityBanned('discord-lifted-1');
        expect(result.banned).toBe(false);
    });

    it('not banned once the ban has expired', async () => {
        // n3 (accepted nit, S22 Phase 2 adversarial review) — `past` is
        // "60s ago", which is virtually always still TODAY (UTC). In the
        // extremely rare case this test runs within 60s of UTC midnight,
        // `past` would land on the PREVIOUS calendar day instead — still a
        // valid "expired" case either way (datetime() comparison handles
        // both), so this is a non-issue in practice; noted per review.
        const past = new Date(Date.now() - 60_000).toISOString();
        await seedBan('discord-expired-1', { expiresAt: past });
        const result = await BanService.isIdentityBanned('discord-expired-1');
        expect(result.banned).toBe(false);
    });

    it('still banned while expires_at is in the future', async () => {
        const future = new Date(Date.now() + 60_000 * 60).toISOString();
        await seedBan('discord-future-1', { expiresAt: future });
        const result = await BanService.isIdentityBanned('discord-future-1');
        expect(result.banned).toBe(true);
        expect(result.expiresAt).toBe(future);
    });

    it('banned via canonical resolution — ban on the canonical snowflake catches a login presenting the linked google id', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            'google:link-a', 'discord-canonical-a',
        );
        await seedBan('discord-canonical-a');

        const result = await BanService.isIdentityBanned('google:link-a');
        expect(result.banned).toBe(true);
    });

    it('banned via sibling-alias lookup — ban on a linked google id catches a login presenting the canonical snowflake', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            'google:link-b', 'discord-canonical-b',
        );
        await seedBan('google:link-b');

        const result = await BanService.isIdentityBanned('discord-canonical-b');
        expect(result.banned).toBe(true);
    });
});

describe('refreshAccessToken — ban enforcement (unit)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('throws ACCOUNT_BANNED for an actively banned identity', async () => {
        const discordId = 'discord-refresh-banned-1';
        await seedBan(discordId);
        const refreshToken = 'refresh-ban-1';
        await createSession(discordId, refreshToken, 'irrelevant-access-token');

        await expect(refreshAccessToken(refreshToken)).rejects.toMatchObject({ code: 'ACCOUNT_BANNED' });
    });

    it('allows refresh once the ban expires', async () => {
        const discordId = 'discord-refresh-expired-1';
        const past = new Date(Date.now() - 60_000).toISOString();
        await seedBan(discordId, { expiresAt: past });
        const refreshToken = 'refresh-expired-1';
        await createSession(discordId, refreshToken, 'irrelevant-access-token');

        const result = await refreshAccessToken(refreshToken);
        expect(result).not.toBeNull();
    });

    it('allows refresh once the ban is lifted', async () => {
        const discordId = 'discord-refresh-lifted-1';
        await seedBan(discordId, { liftedAt: new Date().toISOString() });
        const refreshToken = 'refresh-lifted-1';
        await createSession(discordId, refreshToken, 'irrelevant-access-token');

        const result = await refreshAccessToken(refreshToken);
        expect(result).not.toBeNull();
    });

    it('refuses refresh when the ban is on the OTHER side of an identity link (ban on canonical, session on linked google id)', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            'google:refresh-link-a', 'discord-refresh-canonical-a',
        );
        await seedBan('discord-refresh-canonical-a');
        const refreshToken = 'refresh-link-a';
        // Session predates the link rewrite (or some path left it un-rewritten) — still on the google id.
        await createSession('google:refresh-link-a', refreshToken, 'irrelevant-access-token');

        await expect(refreshAccessToken(refreshToken)).rejects.toMatchObject({ code: 'ACCOUNT_BANNED' });
    });

    it('refuses refresh when the ban is on the OTHER side of an identity link (ban on linked google id, session on canonical)', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_identity_links (provider_user_id, canonical_user_id) VALUES (?, ?)`,
            'google:refresh-link-b', 'discord-refresh-canonical-b',
        );
        await seedBan('google:refresh-link-b');
        const refreshToken = 'refresh-link-b';
        await createSession('discord-refresh-canonical-b', refreshToken, 'irrelevant-access-token');

        await expect(refreshAccessToken(refreshToken)).rejects.toMatchObject({ code: 'ACCOUNT_BANNED' });
    });
});

describe('POST /api/auth/refresh — route-level ban 401', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: authRouter } = await import('../api/routes/auth.js');
        app.use('/api/auth', authRouter);
        return app;
    }

    it('401s with code ACCOUNT_BANNED for a banned identity, distinct from the generic invalid-token 401', async () => {
        const app = await createTestApp();
        const discordId = 'discord-route-refresh-banned';
        await seedBan(discordId);
        const refreshToken = 'route-refresh-ban-1';
        await createSession(discordId, refreshToken, 'irrelevant-access-token');

        const res = await request(app).post('/api/auth/refresh').send({ refreshToken });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('ACCOUNT_BANNED');
    });

    it('401s generically (no code) for an unknown refresh token', async () => {
        const app = await createTestApp();
        const res = await request(app).post('/api/auth/refresh').send({ refreshToken: 'no-such-token' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBeUndefined();
    });
});

describe('POST /api/rooms — ban enforcement on room creation', () => {
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

    it('403s room creation for a banned identity', async () => {
        const app = await createTestApp();
        const discordId = 'discord-room-create-banned';
        await seedBan(discordId);
        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ name: 'Banned Room Attempt', slug: 'banned_room_attempt' });
        expect(res.status).toBe(403);

        const db = await getDatabase();
        const room = await db.get('SELECT id FROM game_rooms WHERE slug = ?', 'banned_room_attempt');
        expect(room).toBeUndefined();
    });

    it('allows room creation for a non-banned identity (control)', async () => {
        const app = await createTestApp();
        const discordId = 'discord-room-create-clean';
        const res = await request(app)
            .post('/api/rooms')
            .set('Authorization', `Bearer ${playerToken(discordId)}`)
            .send({ name: 'Clean Room', slug: 'clean_room_ban_control' });
        expect(res.status).toBe(200);
    });
});

describe('OAuth callbacks — ban enforcement (Discord + Google)', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: authRouter } = await import('../api/routes/auth.js');
        app.use('/api/auth', authRouter);
        return app;
    }

    describe('POST /api/auth/discord/callback', () => {
        beforeEach(() => {
            process.env.DISCORD_CLIENT_ID = 'test-discord-client-id';
            process.env.DISCORD_CLIENT_SECRET = 'test-discord-client-secret';
        });
        afterEach(() => {
            delete process.env.DISCORD_CLIENT_ID;
            delete process.env.DISCORD_CLIENT_SECRET;
            vi.unstubAllGlobals();
        });

        it('403s a banned Discord identity and writes no user_profiles row', async () => {
            const discordId = '777788889999000011';
            const app = await createTestApp();
            await seedBan(discordId);
            mockDiscordFetch({ id: discordId, username: 'banneduser', global_name: 'Banned User' });

            const res = await request(app)
                .post('/api/auth/discord/callback')
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback' });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/banned/i);

            const db = await getDatabase();
            const profile = await db.get('SELECT * FROM user_profiles WHERE discord_user_id = ?', discordId);
            expect(profile).toBeUndefined();
        });

        it('allows a non-banned Discord identity through (control)', async () => {
            const discordId = '111100009999888877';
            const app = await createTestApp();
            mockDiscordFetch({ id: discordId, username: 'cleanuser', global_name: 'Clean User' });

            const res = await request(app)
                .post('/api/auth/discord/callback')
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback' });

            expect(res.status).toBe(200);
            expect(res.body.token).toBeTruthy();
        });
    });

    describe('POST /api/auth/google/callback', () => {
        beforeEach(() => {
            process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
            process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
        });
        afterEach(() => {
            delete process.env.GOOGLE_CLIENT_ID;
            delete process.env.GOOGLE_CLIENT_SECRET;
            vi.unstubAllGlobals();
        });

        it('403s a banned Google identity and writes no user_profiles row', async () => {
            const app = await createTestApp();
            await seedBan('google:banned-sub-1');
            mockGoogleFetch({ sub: 'banned-sub-1', name: 'Banned Googler' });

            const res = await request(app)
                .post('/api/auth/google/callback')
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });

            expect(res.status).toBe(403);
            expect(res.body.error).toMatch(/banned/i);

            const db = await getDatabase();
            const profile = await db.get('SELECT * FROM user_profiles WHERE discord_user_id = ?', 'google:banned-sub-1');
            expect(profile).toBeUndefined();
        });

        it('allows a non-banned Google identity through (control)', async () => {
            const app = await createTestApp();
            mockGoogleFetch({ sub: 'clean-sub-1', name: 'Clean Googler' });

            const res = await request(app)
                .post('/api/auth/google/callback')
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });

            expect(res.status).toBe(200);
            expect(res.body.token).toBeTruthy();
        });
    });
});

// Sanity check for m6/m7-style safety: verify ScoreReportService.ban is the
// same underlying writer POST /admin/bans and the score-report ban route use
// (no drift between the two ban-creation call sites' semantics).
describe('ban write-side sanity (regression guard, not new behavior)', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('ScoreReportService.ban + BanService.isIdentityBanned agree on an active ban', async () => {
        await ScoreReportService.ban('discord-writer-sanity-1', 'admin-x', null, 'sanity');
        const result = await BanService.isIdentityBanned('discord-writer-sanity-1');
        expect(result.banned).toBe(true);
    });
});
