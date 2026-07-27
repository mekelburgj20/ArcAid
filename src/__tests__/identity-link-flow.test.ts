import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { IdentityLinkService } from '../services/IdentityLinkService.js';
import { LinkNonceStore } from '../services/LinkNonceStore.js';
import { BanService } from '../services/BanService.js';

/**
 * M2 fix (S22 Phase 2 adversarial review) — a banned `google:X` identity
 * holding a still-valid access token could use this exact link flow to link
 * a clean Discord snowflake and mint a brand-new 24h token+refresh pair,
 * repeatably: the pre-fix code ban-checked only the Discord snowflake being
 * linked TO (auth.ts's `discordBanCheck`), never the google id consumed from
 * the nonce. Two enforcement points, tested below: `POST
 * /auth/link/discord/start` (can't even mint a nonce while banned) and `POST
 * /auth/discord/callback` with a valid nonce for a banned google id (no link
 * row, no token).
 */
async function seedBan(discordUserId: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, banned_by) VALUES (?, ?, 'test-admin')`,
        `ban-${discordUserId}`, discordUserId,
    );
}

/**
 * Coverage for the v2.36.0 Google->Discord account-link HTTP flow:
 *   • POST /api/auth/link/discord/start — google-identity-only gate + nonce mint
 *   • POST /api/auth/discord/callback with linkNonce — valid / invalid / expired / replay
 *   • Login-after-link: a subsequent Google login for the now-linked google id
 *     mints a token for the canonical (Discord) identity
 *   • GET/DELETE /api/auth/link/discord — self-only list + unlink
 */

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

describe('POST /api/auth/link/discord/start', () => {
    beforeEach(async () => {
        await setupTestDb();
        LinkNonceStore._clearAll();
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('400s for a non-google (Discord) identity — nothing to link', async () => {
        const app = await createTestApp();
        const token = signToken({ role: 'player', gameRoomIds: [], discordId: '111122223333444455', provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/link/discord/start')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
    });

    it('401s with no auth', async () => {
        const app = await createTestApp();
        const res = await request(app).post('/api/auth/link/discord/start');
        expect(res.status).toBe(401);
    });

    it('mints a nonce for a logged-in google identity', async () => {
        const app = await createTestApp();
        const token = signToken({ role: 'player', gameRoomIds: [], discordId: 'google:sub-abc', provider: 'google' });
        const res = await request(app)
            .post('/api/auth/link/discord/start')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(typeof res.body.nonce).toBe('string');
        expect(res.body.nonce.length).toBeGreaterThan(0);
    });

    // M2 fix (S22 Phase 2 adversarial review).
    it('403s a banned google identity — no nonce minted', async () => {
        const app = await createTestApp();
        const googleId = 'google:sub-banned-start';
        await seedBan(googleId);
        const token = signToken({ role: 'player', gameRoomIds: [], discordId: googleId, provider: 'google' });

        const res = await request(app)
            .post('/api/auth/link/discord/start')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);

        const banCheck = await BanService.isIdentityBanned(googleId);
        expect(banCheck.banned).toBe(true); // sanity — the seed actually took
    });
});

describe('POST /api/auth/discord/callback — link completion', () => {
    beforeEach(async () => {
        await setupTestDb();
        LinkNonceStore._clearAll();
        process.env.DISCORD_CLIENT_ID = 'test-discord-client-id';
        process.env.DISCORD_CLIENT_SECRET = 'test-discord-client-secret';
    });
    afterEach(() => {
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        vi.unstubAllGlobals();
    });

    it('valid nonce: creates the link, rewrites attribution, and mints a canonical token with linked:true', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const googleId = 'google:sub-link-1';
        const discordId = '222233334444555566';

        // Seed a score under the google identity so we can assert the rewrite.
        const roomId = await createTestRoom('link-flow-room', 'Link Flow Room');
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_by_user_id)
             VALUES ('sub-link-1', ?, ?, 'ghandle', 1000, datetime('now'), ?)`,
            gameId, googleId, googleId,
        );

        const nonce = LinkNonceStore.create(googleId);
        mockDiscordFetch({ id: discordId, username: 'discorduser', global_name: 'Discord User' });

        // Fix 1b (adversarial review) — the link-callback POST must include
        // the initiator's own bearer token (their still-logged-in google:*
        // session) proving this browser started the flow.
        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId: googleId, provider: 'google' });
        const res = await request(app)
            .post('/api/auth/discord/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

        expect(res.status).toBe(200);
        expect(res.body.linked).toBe(true);
        expect(res.body.user.discordId).toBe(discordId);

        const payload = decodeJwtPayload(res.body.token);
        expect(payload.discordId).toBe(discordId);
        expect(payload.provider).toBe('discord');

        const linkRow = await db.get('SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(linkRow.canonical_user_id).toBe(discordId);

        const submissionRow = await db.get('SELECT discord_user_id, submitted_by_user_id FROM submissions WHERE id = ?', 'sub-link-1');
        expect(submissionRow.discord_user_id).toBe(discordId);
        expect(submissionRow.submitted_by_user_id).toBe(discordId);
    });

    it('invalid nonce: 400, no link created, no token minted', async () => {
        const app = await createTestApp();
        mockDiscordFetch({ id: '333344445555666677', username: 'discorduser' });

        const res = await request(app)
            .post('/api/auth/discord/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: 'not-a-real-nonce' });

        expect(res.status).toBe(400);
        expect(res.body.token).toBeUndefined();
        const db = await getDatabase();
        const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
        expect(count.c).toBe(0);
    });

    it('expired nonce: 400, no link created', async () => {
        // Mint the nonce as if it were created 11 minutes ago (past the
        // 10-minute TTL), then restore the real clock so `consume()` — called
        // later, for real, inside the route handler — sees an expiresAt that
        // is already in the past.
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 11 * 60 * 1000);
        const googleId = 'google:sub-expired';
        const nonce = LinkNonceStore.create(googleId);
        nowSpy.mockRestore();

        const app = await createTestApp();
        mockDiscordFetch({ id: '444455556666777788', username: 'discorduser' });

        const res = await request(app)
            .post('/api/auth/discord/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

        expect(res.status).toBe(400);
        const db = await getDatabase();
        const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
        expect(count.c).toBe(0);
    });

    it('replay: a second use of an already-consumed nonce 400s', async () => {
        const app = await createTestApp();
        const googleId = 'google:sub-replay';
        const discordId = '555566667777888899';
        const nonce = LinkNonceStore.create(googleId);
        mockDiscordFetch({ id: discordId, username: 'discorduser' });

        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId: googleId, provider: 'google' });
        const first = await request(app)
            .post('/api/auth/discord/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });
        expect(first.status).toBe(200);

        const second = await request(app)
            .post('/api/auth/discord/callback')
            .send({ code: 'fake-code-2', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });
        expect(second.status).toBe(400);
    });

    it('without linkNonce, behaves exactly like a normal Discord login (no linked flag)', async () => {
        const app = await createTestApp();
        mockDiscordFetch({ id: '666677778888999900', username: 'plainuser' });

        const res = await request(app)
            .post('/api/auth/discord/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback' });

        expect(res.status).toBe(200);
        expect(res.body.linked).toBeUndefined();
    });

    // M2 fix (S22 Phase 2 adversarial review) — the nonce's google id was
    // never ban-checked pre-fix, only the Discord snowflake being linked TO.
    it('banned google id + valid nonce: 403 at callback, no link row, no token minted', async () => {
        const app = await createTestApp();
        const googleId = 'google:sub-banned-callback';
        const discordId = '888899990000111122';
        await seedBan(googleId);

        const nonce = LinkNonceStore.create(googleId);
        mockDiscordFetch({ id: discordId, username: 'discorduser', global_name: 'Discord User' });

        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId: googleId, provider: 'google' });
        const res = await request(app)
            .post('/api/auth/discord/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

        expect(res.status).toBe(403);
        expect(res.body.token).toBeUndefined();

        const db = await getDatabase();
        const linkRow = await db.get('SELECT * FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(linkRow).toBeUndefined();
        // Test additions (mirror-link-fixes.md) — a banned callback attempt
        // must leave NO trace at all, not just no link row: no sessions row
        // for the newly-authenticated Discord snowflake, no user_profiles
        // row either (both would otherwise get written before the ban check
        // if ordering ever regressed).
        const sessionRow = await db.get('SELECT * FROM sessions WHERE discord_user_id = ?', discordId);
        expect(sessionRow).toBeUndefined();
        const profileRow = await db.get('SELECT * FROM user_profiles WHERE discord_user_id = ?', discordId);
        expect(profileRow).toBeUndefined();
    });

    // Fix 1 (adversarial review) — server-side initiator assert. The bearer
    // token proves the browser completing the link is the one that started
    // it; without it (or with the wrong identity's token), the callback must
    // 401 even though the nonce itself is valid.
    describe('Fix 1 server-side initiator assert', () => {
        it('valid nonce but NO Authorization header: 401, no link created', async () => {
            const app = await createTestApp();
            const googleId = 'google:sub-fix1-no-auth';
            const discordId = '111100002222333366';
            const nonce = LinkNonceStore.create(googleId);
            mockDiscordFetch({ id: discordId, username: 'discorduser' });

            const res = await request(app)
                .post('/api/auth/discord/callback')
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

            expect(res.status).toBe(401);
            expect(res.body.token).toBeUndefined();
            const db = await getDatabase();
            const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
            expect(count.c).toBe(0);
        });

        it('valid nonce but Authorization token for a DIFFERENT identity than the initiator: 401, no link created', async () => {
            const app = await createTestApp();
            const googleId = 'google:sub-fix1-wrong-user';
            const discordId = '222211110000999977';
            const nonce = LinkNonceStore.create(googleId);
            mockDiscordFetch({ id: discordId, username: 'discorduser' });

            const wrongToken = signToken({ role: 'player', gameRoomIds: [], discordId: 'google:sub-not-the-initiator', provider: 'google' });
            const res = await request(app)
                .post('/api/auth/discord/callback')
                .set('Authorization', `Bearer ${wrongToken}`)
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

            expect(res.status).toBe(401);
            expect(res.body.token).toBeUndefined();
            const db = await getDatabase();
            const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
            expect(count.c).toBe(0);
        });

        it('valid nonce with a matching initiator token: 200, link created', async () => {
            const app = await createTestApp();
            const googleId = 'google:sub-fix1-happy';
            const discordId = '333322221111000088';
            const nonce = LinkNonceStore.create(googleId);
            mockDiscordFetch({ id: discordId, username: 'discorduser', global_name: 'Discord User' });

            const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId: googleId, provider: 'google' });
            const res = await request(app)
                .post('/api/auth/discord/callback')
                .set('Authorization', `Bearer ${initiatorToken}`)
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

            expect(res.status).toBe(200);
            expect(res.body.linked).toBe(true);
        });
    });
});

describe('Login-after-link', () => {
    beforeEach(async () => {
        await setupTestDb();
        process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
    });
    afterEach(() => {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        vi.unstubAllGlobals();
    });

    it('a google callback for a linked google id mints the snowflake-id token', async () => {
        const googleId = 'google:sub-already-linked';
        const discordId = '777788889999000011';
        await IdentityLinkService.createLink(googleId, discordId);

        const app = await createTestApp();
        mockGoogleFetch({ sub: 'sub-already-linked', name: 'Linked Person' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });

        expect(res.status).toBe(200);
        expect(res.body.user.discordId).toBe(discordId);
        const payload = decodeJwtPayload(res.body.token);
        expect(payload.discordId).toBe(discordId);
        expect(payload.provider).toBe('google'); // login method, not the canonicalized id
    });
});

describe('GET/DELETE /api/auth/link/discord', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('lists linked google identities for the caller\'s canonical id (self-only)', async () => {
        const app = await createTestApp();
        const discordId = '888899990000111122';
        await IdentityLinkService.createLink('google:sub-x', discordId);
        await IdentityLinkService.createLink('google:sub-y', discordId);
        const token = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });

        const res = await request(app)
            .get('/api/auth/link/discord')
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        expect(res.body.links.map((l: any) => l.provider_user_id).sort()).toEqual(['google:sub-x', 'google:sub-y']);
    });

    it('unlinks a google identity (row delete only)', async () => {
        const app = await createTestApp();
        const discordId = '999900001111222233';
        await IdentityLinkService.createLink('google:sub-z', discordId);
        const token = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });

        const res = await request(app)
            .delete(`/api/auth/link/discord/${encodeURIComponent('google:sub-z')}`)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        const resolved = await IdentityLinkService.resolveCanonical('google:sub-z');
        expect(resolved).toBe('google:sub-z');
    });

    it('404s unlinking a link that does not belong to the caller', async () => {
        const app = await createTestApp();
        await IdentityLinkService.createLink('google:sub-owned-by-someone-else', '111100002222333344');
        const token = signToken({ role: 'player', gameRoomIds: [], discordId: '555566667777888899', provider: 'discord' });

        const res = await request(app)
            .delete(`/api/auth/link/discord/${encodeURIComponent('google:sub-owned-by-someone-else')}`)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(404);
    });
});
