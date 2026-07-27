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
 * Coverage for the v2.46.0 mirror-link contract: the Discord-side-initiated
 * mirror of the existing Google->Discord account-link flow (covered in
 * `identity-link-flow.test.ts`). Structure follows that file's template:
 *   • POST /api/auth/link/google/start — discord-identity-only gate + nonce mint
 *   • POST /api/auth/google/callback with linkNonce — valid / invalid / expired /
 *     replay / direction-mismatch / bans / conflict / idempotent-same-canonical
 *   • IdentityLinkService.createLink's LINK_CONFLICT guard — direct unit
 *     coverage, plus the existing discord/callback link branch now mapping
 *     the same conflict to 409.
 */

async function seedBan(discordUserId: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, banned_by) VALUES (?, ?, 'test-admin')`,
        `ban-${discordUserId}`, discordUserId,
    );
}

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

describe('POST /api/auth/link/google/start', () => {
    beforeEach(async () => {
        await setupTestDb();
        LinkNonceStore._clearAll();
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('400s for a google identity — nothing to link', async () => {
        const app = await createTestApp();
        const token = signToken({ role: 'player', gameRoomIds: [], discordId: 'google:sub-abc', provider: 'google' });
        const res = await request(app)
            .post('/api/auth/link/google/start')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(400);
    });

    it('401s with no auth', async () => {
        const app = await createTestApp();
        const res = await request(app).post('/api/auth/link/google/start');
        expect(res.status).toBe(401);
    });

    it('mints a nonce for a logged-in Discord identity', async () => {
        const app = await createTestApp();
        const token = signToken({ role: 'player', gameRoomIds: [], discordId: '111122223333444455', provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/link/google/start')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(typeof res.body.nonce).toBe('string');
        expect(res.body.nonce.length).toBeGreaterThan(0);
    });

    it('403s a banned Discord identity — no nonce minted', async () => {
        const app = await createTestApp();
        const discordId = '222233334444555577';
        await seedBan(discordId);
        const token = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });

        const res = await request(app)
            .post('/api/auth/link/google/start')
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(403);

        const banCheck = await BanService.isIdentityBanned(discordId);
        expect(banCheck.banned).toBe(true); // sanity — the seed actually took
    });

    // Test additions (mirror-link-fixes.md) — the nonce must bind to the
    // VERIFIED JWT identity (`req.user!.discordId`), never anything the
    // request body claims. The route never reads the body at all, but this
    // regression test pins that down explicitly rather than relying on
    // "the code doesn't read req.body" being obvious from inspection.
    it('binds the nonce to the JWT identity even if the request body tries to supply a different id', async () => {
        const app = await createTestApp();
        const realDiscordId = '333322221111000099';
        const spoofedDiscordId = '999900001111222233';
        const token = signToken({ role: 'player', gameRoomIds: [], discordId: realDiscordId, provider: 'discord' });

        const res = await request(app)
            .post('/api/auth/link/google/start')
            .set('Authorization', `Bearer ${token}`)
            .send({ discordId: spoofedDiscordId, userId: spoofedDiscordId });

        expect(res.status).toBe(200);
        // Consuming the nonce must resolve to the REAL (JWT) identity, not
        // the spoofed body value.
        const initiator = LinkNonceStore.consume(res.body.nonce);
        expect(initiator).toBe(realDiscordId);
    });
});

describe('POST /api/auth/google/callback — link completion', () => {
    beforeEach(async () => {
        await setupTestDb();
        LinkNonceStore._clearAll();
        process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-google-client-secret';
    });
    afterEach(() => {
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        vi.unstubAllGlobals();
    });

    it('valid nonce: creates the link, rewrites attribution, and mints a canonical (Discord) token with linked:true', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const discordId = '333344445555666688';
        const googleSub = 'sub-mirror-link-1';
        const googleId = `google:${googleSub}`;

        // Seed a score under the google identity so we can assert the rewrite.
        const roomId = await createTestRoom('mirror-link-flow-room', 'Mirror Link Flow Room');
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_by_user_id)
             VALUES ('sub-mirror-link-1', ?, ?, 'ghandle2', 2000, datetime('now'), ?)`,
            gameId, googleId, googleId,
        );

        // Fix 6 regression setup — the snowflake already has its OWN avatar
        // and username before the link. The mocked google profile below has
        // a DIFFERENT name ("Google Person") and no picture; post-link the
        // snowflake's existing profile fields must survive untouched.
        await db.run(
            `INSERT INTO user_profiles (discord_user_id, avatar_url, username) VALUES (?, 'https://example.com/discord-existing.jpg', 'DiscordExistingName')`,
            discordId,
        );

        const nonce = LinkNonceStore.create(discordId);
        mockGoogleFetch({ sub: googleSub, name: 'Google Person' });

        // Fix 1b (adversarial review) — the link-callback POST must include
        // the initiator's own bearer token (their still-logged-in Discord
        // session) proving this browser started the flow.
        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/google/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(200);
        expect(res.body.linked).toBe(true);
        expect(res.body.user.discordId).toBe(discordId);

        const payload = decodeJwtPayload(res.body.token);
        expect(payload.discordId).toBe(discordId);
        expect(payload.provider).toBe('google'); // login method, not the canonicalized id

        const linkRow = await db.get('SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(linkRow.canonical_user_id).toBe(discordId);

        const submissionRow = await db.get('SELECT discord_user_id, submitted_by_user_id FROM submissions WHERE id = ?', 'sub-mirror-link-1');
        expect(submissionRow.discord_user_id).toBe(discordId);
        expect(submissionRow.submitted_by_user_id).toBe(discordId);

        // Fix 6 (adversarial review) — the post-link avatar/username upsert
        // in google/callback must be SKIPPED on the link path; pre-fix it
        // unconditionally overwrote the just-COALESCE-merged snowflake
        // profile with Google's own data.
        const profileRow = await db.get('SELECT avatar_url, username FROM user_profiles WHERE discord_user_id = ?', discordId);
        expect(profileRow.avatar_url).toBe('https://example.com/discord-existing.jpg');
        expect(profileRow.username).toBe('DiscordExistingName');
    });

    it('invalid nonce: 400, no link created, no token minted', async () => {
        const app = await createTestApp();
        mockGoogleFetch({ sub: 'sub-mirror-invalid', name: 'Nobody' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: 'not-a-real-nonce' });

        expect(res.status).toBe(400);
        expect(res.body.token).toBeUndefined();
        const db = await getDatabase();
        const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
        expect(count.c).toBe(0);
    });

    it('expired nonce: 400, no link created', async () => {
        const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - 11 * 60 * 1000);
        const discordId = '444455556666777799';
        const nonce = LinkNonceStore.create(discordId);
        nowSpy.mockRestore();

        const app = await createTestApp();
        mockGoogleFetch({ sub: 'sub-mirror-expired', name: 'Nobody' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(400);
        const db = await getDatabase();
        const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
        expect(count.c).toBe(0);
    });

    it('replay: a second use of an already-consumed nonce 400s', async () => {
        const app = await createTestApp();
        const discordId = '555566667777888800';
        const nonce = LinkNonceStore.create(discordId);
        mockGoogleFetch({ sub: 'sub-mirror-replay', name: 'Replay Person' });

        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });
        const first = await request(app)
            .post('/api/auth/google/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });
        expect(first.status).toBe(200);

        const second = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code-2', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });
        expect(second.status).toBe(400);
    });

    // Direction-mismatch: a nonce minted for the OTHER flow (initiator is a
    // google:* id, as /link/discord/start would mint) must not be replayable
    // into THIS callback, whose whole point is linking a Discord snowflake
    // onto a google canonical.
    it('direction-mismatch: a nonce minted with a google:* initiator 400s here', async () => {
        const app = await createTestApp();
        const nonce = LinkNonceStore.create('google:sub-wrong-direction');
        mockGoogleFetch({ sub: 'sub-mirror-mismatch', name: 'Mismatch Person' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(400);
        const db = await getDatabase();
        const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
        expect(count.c).toBe(0);
    });

    it('without linkNonce, behaves exactly like a normal Google login (no linked flag)', async () => {
        const app = await createTestApp();
        mockGoogleFetch({ sub: 'sub-mirror-plain', name: 'Plain Person' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });

        expect(res.status).toBe(200);
        expect(res.body.linked).toBeUndefined();
    });

    it('banned google id + valid nonce: 403 at callback, no link row, no token minted', async () => {
        const app = await createTestApp();
        const googleSub = 'sub-mirror-banned-google';
        const googleId = `google:${googleSub}`;
        const discordId = '666677778888999911';
        await seedBan(googleId);

        const nonce = LinkNonceStore.create(discordId);
        mockGoogleFetch({ sub: googleSub, name: 'Banned Google Person' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(403);
        expect(res.body.token).toBeUndefined();

        const db = await getDatabase();
        const linkRow = await db.get('SELECT * FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(linkRow).toBeUndefined();
        // Test additions (mirror-link-fixes.md) — no trace at all, not just
        // no link row: this ban check fires before the nonce is even
        // consumed (googleBanCheck runs ahead of the linkNonce block), so
        // nothing about the Discord snowflake should exist either.
        const sessionRow = await db.get('SELECT * FROM sessions WHERE discord_user_id = ?', discordId);
        expect(sessionRow).toBeUndefined();
        const profileRow = await db.get('SELECT * FROM user_profiles WHERE discord_user_id = ?', discordId);
        expect(profileRow).toBeUndefined();
    });

    it('banned Discord snowflake (initiator) + valid nonce: 403 at callback, no link row, no token minted', async () => {
        const app = await createTestApp();
        const discordId = '777788889999000022';
        await seedBan(discordId);

        const nonce = LinkNonceStore.create(discordId);
        mockGoogleFetch({ sub: 'sub-mirror-banned-discord', name: 'Someone' });

        // Fix 1b — must present the (banned) initiator's own token to reach
        // past the assert and into the ban check itself.
        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/google/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(403);
        expect(res.body.token).toBeUndefined();

        const db = await getDatabase();
        const linkRow = await db.get('SELECT * FROM user_identity_links WHERE provider_user_id = ?', 'google:sub-mirror-banned-discord');
        expect(linkRow).toBeUndefined();
        // Test additions (mirror-link-fixes.md) — no sessions/user_profiles
        // trace for the banned initiator either.
        const sessionRow = await db.get('SELECT * FROM sessions WHERE discord_user_id = ?', discordId);
        expect(sessionRow).toBeUndefined();
        const profileRow = await db.get('SELECT * FROM user_profiles WHERE discord_user_id = ?', discordId);
        expect(profileRow).toBeUndefined();
    });

    it('already-linked-to-different-canonical: 409, no rewrite, existing link row unchanged, attribution unmoved', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const googleSub = 'sub-mirror-conflict';
        const googleId = `google:${googleSub}`;
        const originalDiscordId = '888899990000111133';
        const attackerDiscordId = '999900001111222244';
        await IdentityLinkService.createLink(googleId, originalDiscordId);

        // Attribution already lives under the ORIGINAL canonical (from the
        // createLink call above). The 409 must leave it there — the
        // attacker's callback must never touch it.
        const roomId = await createTestRoom('mirror-conflict-room', 'Mirror Conflict Room');
        const tournamentId = await createTestTournament(roomId);
        const gameId = await createTestGame(tournamentId);
        await db.run(
            `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_by_user_id)
             VALUES ('sub-mirror-conflict-1', ?, ?, 'ghandle-conflict', 3000, datetime('now'), ?)`,
            gameId, originalDiscordId, originalDiscordId,
        );

        const nonce = LinkNonceStore.create(attackerDiscordId);
        mockGoogleFetch({ sub: googleSub, name: 'Conflict Person' });

        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId: attackerDiscordId, provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/google/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(409);
        expect(res.body.token).toBeUndefined();

        const linkRow = await db.get('SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(linkRow.canonical_user_id).toBe(originalDiscordId); // unchanged — attacker did not steal the link

        const submissionRow = await db.get('SELECT discord_user_id, submitted_by_user_id FROM submissions WHERE id = ?', 'sub-mirror-conflict-1');
        expect(submissionRow.discord_user_id).toBe(originalDiscordId); // untouched
        expect(submissionRow.submitted_by_user_id).toBe(originalDiscordId);

        // Test additions — no trace of the attacker's failed attempt either.
        const sessionRow = await db.get('SELECT * FROM sessions WHERE discord_user_id = ?', attackerDiscordId);
        expect(sessionRow).toBeUndefined();
        const profileRow = await db.get('SELECT * FROM user_profiles WHERE discord_user_id = ?', attackerDiscordId);
        expect(profileRow).toBeUndefined();
    });

    it('same-canonical replay: idempotent success (linked:true), no error', async () => {
        const app = await createTestApp();
        const googleSub = 'sub-mirror-idempotent';
        const googleId = `google:${googleSub}`;
        const discordId = '000011112222333355';
        await IdentityLinkService.createLink(googleId, discordId);

        const nonce = LinkNonceStore.create(discordId);
        mockGoogleFetch({ sub: googleSub, name: 'Idempotent Person' });

        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/google/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(200);
        expect(res.body.linked).toBe(true);
        expect(res.body.user.discordId).toBe(discordId);
    });

    // Test additions (mirror-link-fixes.md) — role resolution on the mirror
    // path: a snowflake with an elevated role must have that role carried
    // into the token minted at link completion, not silently downgraded to
    // 'player' because the code path is keying off the google identity.
    it('mirror path role resolution: a snowflake with room_admin linking a Google account receives a token carrying that role', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const discordId = '444433332222111100';
        const googleSub = 'sub-mirror-role-admin';
        const roomId = await createTestRoom('mirror-role-room', 'Mirror Role Room');
        await db.run(
            `INSERT INTO game_room_admins (game_room_id, discord_user_id, role) VALUES (?, ?, 'admin')`,
            roomId, discordId,
        );

        const nonce = LinkNonceStore.create(discordId);
        mockGoogleFetch({ sub: googleSub, name: 'Room Admin Person' });

        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/google/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(200);
        expect(res.body.linked).toBe(true);
        const payload = decodeJwtPayload(res.body.token);
        expect(payload.role).toBe('room_admin');
        expect(payload.discordId).toBe(discordId);
        expect((payload.gameRoomIds as string[])).toContain(roomId);
    });

    it('mirror path role resolution: a snowflake with super_admin linking a Google account receives a token carrying that role', async () => {
        const app = await createTestApp();
        const db = await getDatabase();
        const discordId = '555544443333222211';
        const googleSub = 'sub-mirror-role-super';
        await db.run(`INSERT INTO super_admins (discord_user_id) VALUES (?)`, discordId);

        const nonce = LinkNonceStore.create(discordId);
        mockGoogleFetch({ sub: googleSub, name: 'Super Admin Person' });

        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });
        const res = await request(app)
            .post('/api/auth/google/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

        expect(res.status).toBe(200);
        expect(res.body.linked).toBe(true);
        const payload = decodeJwtPayload(res.body.token);
        expect(payload.role).toBe('super_admin');
        expect(payload.discordId).toBe(discordId);
    });

    // Fix 1 (adversarial review) — server-side initiator assert, mirror
    // direction. Symmetric to the coverage added in identity-link-flow.test.ts
    // for the discord/callback side.
    describe('Fix 1 server-side initiator assert', () => {
        it('valid nonce but NO Authorization header: 401, no link created', async () => {
            const app = await createTestApp();
            const discordId = '666655554444333322';
            const nonce = LinkNonceStore.create(discordId);
            mockGoogleFetch({ sub: 'sub-fix1-mirror-no-auth', name: 'Nobody' });

            const res = await request(app)
                .post('/api/auth/google/callback')
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

            expect(res.status).toBe(401);
            expect(res.body.token).toBeUndefined();
            const db = await getDatabase();
            const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
            expect(count.c).toBe(0);
        });

        it('valid nonce but Authorization token for a DIFFERENT identity than the initiator: 401, no link created', async () => {
            const app = await createTestApp();
            const discordId = '777766665555444433';
            const nonce = LinkNonceStore.create(discordId);
            mockGoogleFetch({ sub: 'sub-fix1-mirror-wrong-user', name: 'Nobody' });

            const wrongToken = signToken({ role: 'player', gameRoomIds: [], discordId: '888877776666555544', provider: 'discord' });
            const res = await request(app)
                .post('/api/auth/google/callback')
                .set('Authorization', `Bearer ${wrongToken}`)
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

            expect(res.status).toBe(401);
            expect(res.body.token).toBeUndefined();
            const db = await getDatabase();
            const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
            expect(count.c).toBe(0);
        });

        it('valid nonce with a matching initiator token: 200, link created', async () => {
            const app = await createTestApp();
            const discordId = '999988887777666655';
            const nonce = LinkNonceStore.create(discordId);
            mockGoogleFetch({ sub: 'sub-fix1-mirror-happy', name: 'Happy Person' });

            const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId, provider: 'discord' });
            const res = await request(app)
                .post('/api/auth/google/callback')
                .set('Authorization', `Bearer ${initiatorToken}`)
                .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback', linkNonce: nonce });

            expect(res.status).toBe(200);
            expect(res.body.linked).toBe(true);
        });
    });
});

describe('IdentityLinkService.createLink — LINK_CONFLICT guard', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('same canonical: idempotent no-op, does not throw', async () => {
        const googleId = 'google:sub-unit-same';
        const discordId = '111122223333444400';
        await IdentityLinkService.createLink(googleId, discordId);
        await expect(IdentityLinkService.createLink(googleId, discordId)).resolves.toBeUndefined();

        const db = await getDatabase();
        const rows = await db.all('SELECT * FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(rows.length).toBe(1);
    });

    it('different canonical: throws a LINK_CONFLICT-coded error, existing row untouched', async () => {
        const googleId = 'google:sub-unit-diff';
        const discordIdA = '222233334444555511';
        const discordIdB = '333344445555666622';
        await IdentityLinkService.createLink(googleId, discordIdA);

        await expect(IdentityLinkService.createLink(googleId, discordIdB)).rejects.toMatchObject({
            code: 'LINK_CONFLICT',
        });

        const db = await getDatabase();
        const row = await db.get('SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(row.canonical_user_id).toBe(discordIdA);
    });
});

// Existing Discord-side callback (identity-link-flow.test.ts covers the
// happy/invalid/expired/replay/ban paths) now also maps LINK_CONFLICT to 409
// — added here per the mirror-link contract rather than editing that file's
// existing 35 tests.
describe('POST /api/auth/discord/callback — link completion now 409s on conflict', () => {
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

    it('already-linked-to-different-canonical: 409, no rewrite, existing link row unchanged', async () => {
        const app = await createTestApp();
        const googleId = 'google:sub-discord-side-conflict';
        const originalDiscordId = '444455556666777733';
        const attackerDiscordId = '555566667777888844';
        await IdentityLinkService.createLink(googleId, originalDiscordId);

        const nonce = LinkNonceStore.create(googleId);
        mockDiscordFetch({ id: attackerDiscordId, username: 'attacker', global_name: 'Attacker' });

        // Fix 1b — the initiator here is the google identity (this callback
        // links google -> discord); present its own token to reach the
        // createLink call and get the real 409, not a 401.
        const initiatorToken = signToken({ role: 'player', gameRoomIds: [], discordId: googleId, provider: 'google' });
        const res = await request(app)
            .post('/api/auth/discord/callback')
            .set('Authorization', `Bearer ${initiatorToken}`)
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

        expect(res.status).toBe(409);
        expect(res.body.token).toBeUndefined();

        const db = await getDatabase();
        const linkRow = await db.get('SELECT canonical_user_id FROM user_identity_links WHERE provider_user_id = ?', googleId);
        expect(linkRow.canonical_user_id).toBe(originalDiscordId); // unchanged
        // Test additions — no trace of the attacker's failed attempt.
        const sessionRow = await db.get('SELECT * FROM sessions WHERE discord_user_id = ?', attackerDiscordId);
        expect(sessionRow).toBeUndefined();
        const profileRow = await db.get('SELECT * FROM user_profiles WHERE discord_user_id = ?', attackerDiscordId);
        expect(profileRow).toBeUndefined();
    });

    // Direction-mismatch mirror: a nonce minted for the mirror flow (initiator
    // is a Discord snowflake, as /link/google/start would mint) must not be
    // replayable into the ORIGINAL discord/callback, whose whole point is
    // linking a google id onto a Discord canonical.
    it('direction-mismatch: a nonce minted with a non-google initiator 400s here', async () => {
        const app = await createTestApp();
        const nonce = LinkNonceStore.create('666677778888999955'); // bare Discord snowflake, not google:*
        mockDiscordFetch({ id: '777788889999000066', username: 'someone' });

        const res = await request(app)
            .post('/api/auth/discord/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback', linkNonce: nonce });

        expect(res.status).toBe(400);
        const db = await getDatabase();
        const count = await db.get('SELECT COUNT(*) AS c FROM user_identity_links');
        expect(count.c).toBe(0);
    });
});
