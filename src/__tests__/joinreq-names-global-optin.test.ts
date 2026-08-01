import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GlobalScoreService } from '../services/GlobalScoreService.js';

// D1 (v2.40.0) — tmp/joinreq-names-global-optin-contract.md: join-request
// name resolution (username fallback).
//
// D2 was originally v2.40.0's per-room "opt into the Global Scoreboard"
// toggle for approval-policy rooms. v2.41.0 (tmp/player-governs-global-
// contract.md) removed that room-level gate entirely: whether a room-
// originated score reaches the Global Scoreboard is now governed ONLY by the
// pre-existing per-submission `excludeFromGlobal` flag, identically for open
// and approval-policy rooms. The D2 describe blocks below assert THAT model.

function decodeJwtPayload(token: string): Record<string, unknown> {
    const parts = token.split('.');
    return JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
}

async function createAuthApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: authRouter } = await import('../api/routes/auth.js');
    app.use('/api/auth', authRouter);
    return app;
}

async function createFullApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: authRouter } = await import('../api/routes/auth.js');
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/auth', authRouter);
    app.use('/api/rooms', roomsRouter);
    app.use('/api', globalRouter);
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

function playerToken(discordId: string, username?: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username });
}
function roomAdminToken(roomId: string) {
    return signToken({ role: 'room_admin', gameRoomIds: [roomId] });
}

async function makeApprovalRoom(slug: string) {
    const roomId = await createTestRoom(slug, 'Approval Room');
    await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
    return roomId;
}

async function seedGlobalGame(name: string) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
        id, name, JSON.stringify(['real']),
    );
    return id;
}

describe('D1 — login persists user_profiles.username', () => {
    afterEach(() => {
        delete process.env.DISCORD_CLIENT_ID;
        delete process.env.DISCORD_CLIENT_SECRET;
        delete process.env.GOOGLE_CLIENT_ID;
        delete process.env.GOOGLE_CLIENT_SECRET;
        vi.unstubAllGlobals();
    });

    it('Discord login (avatar present) persists username = global_name||username', async () => {
        process.env.DISCORD_CLIENT_ID = 'test-id';
        process.env.DISCORD_CLIENT_SECRET = 'test-secret';
        const app = await createAuthApp();
        mockDiscordFetch({ id: '900011112222333344', username: 'rawhandle', global_name: 'Pretty Name', avatar: 'abc123' });

        const res = await request(app)
            .post('/api/auth/discord/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback' });
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const profile = await db.get('SELECT username, display_name FROM user_profiles WHERE discord_user_id = ?', '900011112222333344');
        expect(profile.username).toBe('Pretty Name');
        expect(profile.display_name).toBeNull();
    });

    it('Discord login (no avatar) still persists username', async () => {
        process.env.DISCORD_CLIENT_ID = 'test-id';
        process.env.DISCORD_CLIENT_SECRET = 'test-secret';
        const app = await createAuthApp();
        mockDiscordFetch({ id: '900011112222333355', username: 'noavatarhandle' });

        const res = await request(app)
            .post('/api/auth/discord/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/discord/callback' });
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const profile = await db.get('SELECT username FROM user_profiles WHERE discord_user_id = ?', '900011112222333355');
        expect(profile.username).toBe('noavatarhandle');
    });

    it('re-login updates username (last-write-wins)', async () => {
        process.env.DISCORD_CLIENT_ID = 'test-id';
        process.env.DISCORD_CLIENT_SECRET = 'test-secret';
        const app = await createAuthApp();
        mockDiscordFetch({ id: '900011112222333366', username: 'handle', global_name: 'Old Name', avatar: 'abc123' });
        await request(app).post('/api/auth/discord/callback').send({ code: 'c', redirectUri: 'https://arcaid.app/auth/discord/callback' });

        mockDiscordFetch({ id: '900011112222333366', username: 'handle', global_name: 'New Name', avatar: 'abc123' });
        await request(app).post('/api/auth/discord/callback').send({ code: 'c', redirectUri: 'https://arcaid.app/auth/discord/callback' });

        const db = await getDatabase();
        const profile = await db.get('SELECT username FROM user_profiles WHERE discord_user_id = ?', '900011112222333366');
        expect(profile.username).toBe('New Name');
    });

    it('Google login persists username = name||email-prefix', async () => {
        process.env.GOOGLE_CLIENT_ID = 'test-google-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
        const app = await createAuthApp();
        mockGoogleFetch({ sub: 'sub-username-1', name: 'Ada Lovelace', email: 'ada@example.com', picture: 'https://lh3.googleusercontent.com/pic.jpg' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const profile = await db.get('SELECT username FROM user_profiles WHERE discord_user_id = ?', 'google:sub-username-1');
        expect(profile.username).toBe('Ada Lovelace');
    });

    it('Google login (no picture) still persists username', async () => {
        process.env.GOOGLE_CLIENT_ID = 'test-google-id';
        process.env.GOOGLE_CLIENT_SECRET = 'test-google-secret';
        const app = await createAuthApp();
        mockGoogleFetch({ sub: 'sub-username-2', email: 'noname@example.com' });

        const res = await request(app)
            .post('/api/auth/google/callback')
            .send({ code: 'fake-code', redirectUri: 'https://arcaid.app/auth/google/callback' });
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const profile = await db.get('SELECT username FROM user_profiles WHERE discord_user_id = ?', 'google:sub-username-2');
        expect(profile.username).toBe('noname');
    });
});

describe('D1 — join-request time username backfill + endpoint', () => {
    it('upserts username from the JWT claim at join-request time', async () => {
        const app = await createFullApp();
        const roomId = await makeApprovalRoom('jr-username-backfill');
        const discordId = 'discord-username-backfill-1';
        const token = playerToken(discordId, 'Fallback Name');

        const res = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200);

        const db = await getDatabase();
        const profile = await db.get('SELECT username FROM user_profiles WHERE discord_user_id = ?', discordId);
        expect(profile.username).toBe('Fallback Name');
    });

    it('GET /admin/join-requests returns username alongside displayName', async () => {
        const app = await createFullApp();
        const roomId = await makeApprovalRoom('jr-username-endpoint');
        const discordId = 'discord-username-endpoint-1';
        const token = playerToken(discordId, 'Endpoint Fallback');

        await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${token}`);

        const adminToken = roomAdminToken(roomId);
        const list = await request(app)
            .get(`/api/rooms/${roomId}/admin/join-requests`)
            .set('Authorization', `Bearer ${adminToken}`);
        expect(list.status).toBe(200);
        expect(list.body).toHaveLength(1);
        expect(list.body[0].displayName).toBeNull();
        expect(list.body[0].username).toBe('Endpoint Fallback');
        expect(list.body[0].userId).toBe(discordId);
    });

    // v2.40.1 regression: a refreshed token degrades its username claim to the
    // raw id for a user with no display_name; the join-request upsert must NOT
    // clobber a previously-good stored username with that id.
    it('does NOT overwrite a good stored username when the JWT claim is the raw id', async () => {
        const app = await createFullApp();
        const roomId = await makeApprovalRoom('jr-username-noclobber');
        const discordId = 'discord-noclobber-1';

        // Seed a good username (as a prior fresh login would have).
        const db = await getDatabase();
        await db.run(
            'INSERT INTO user_profiles (discord_user_id, username) VALUES (?, ?)',
            discordId, 'Krobs',
        );

        // Request with a degraded token whose username claim == the id.
        const degraded = playerToken(discordId, discordId);
        const res = await request(app)
            .post(`/api/me/rooms/${roomId}/join-request`)
            .set('Authorization', `Bearer ${degraded}`);
        expect(res.status).toBe(200);

        const profile = await db.get('SELECT username FROM user_profiles WHERE discord_user_id = ?', discordId);
        expect(profile.username).toBe('Krobs'); // unchanged, not clobbered to the id
    });
});

describe('D2 (v2.41.0) — per-submission opt-out governs fan-out uniformly, no room-level gate', () => {
    it('approval-room member submission fans out by default (no room-level gate)', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('pgg-approval-default');
        await seedGlobalGame('PGG Approval Default Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'PGG Approval Default Game',
            playerId: 'discord-pgg-1', iscoredUsername: 'PggPlayer1', score: 1000,
            source: 'community',
        });
        expect(result).not.toBeNull();

        const db = await getDatabase();
        const row = await db.get(
            `SELECT exclude_from_global, deleted_at FROM global_scores WHERE origin_game_room_id = ? AND LOWER(iscored_username) = LOWER(?)`,
            roomId, 'PggPlayer1',
        );
        expect(row).toBeDefined();
        expect(row.deleted_at).toBeNull();
        expect(row.exclude_from_global).toBe(0);
    });

    it('approval-room member submission with excludeFromGlobal=true records the row but does not publicly fan (flag set)', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('pgg-approval-excluded');
        await seedGlobalGame('PGG Approval Excluded Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'PGG Approval Excluded Game',
            playerId: 'discord-pgg-2', iscoredUsername: 'PggPlayer2', score: 1000,
            excludeFromGlobal: true, source: 'community',
        });
        // fanOutFromRoomSubmission still returns a result (the row is recorded
        // with the flag set) — callers gate the PUBLIC leaderboard read on
        // exclude_from_global, not on this return value. See
        // CommunityScoreService.submitScore's `!options?.excludeFromGlobal`
        // check for where the "does it actually show up" decision lives.
        expect(result).not.toBeNull();

        const db = await getDatabase();
        const row = await db.get(
            `SELECT exclude_from_global FROM global_scores WHERE origin_game_room_id = ? AND LOWER(iscored_username) = LOWER(?)`,
            roomId, 'PggPlayer2',
        );
        expect(row).toBeDefined();
        expect(row.exclude_from_global).toBe(1);
    });

    it('guest submission in an approval room never fans out (COMMUNITY/ANON sentinel)', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('pgg-approval-guest');
        await seedGlobalGame('PGG Approval Guest Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'PGG Approval Guest Game',
            playerId: 'COMMUNITY', iscoredUsername: 'GuestPlayer', score: 1000,
            source: 'community',
        });
        expect(result).toBeNull();

        const db = await getDatabase();
        const row = await db.get(
            `SELECT id FROM global_scores WHERE origin_game_room_id = ? AND LOWER(iscored_username) = LOWER(?)`,
            roomId, 'GuestPlayer',
        );
        expect(row).toBeUndefined();
    });

    it('open room is unaffected (unchanged behavior): member submission fans out by default', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('pgg-open-control');
        await seedGlobalGame('PGG Open Control Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'PGG Open Control Game',
            playerId: 'discord-pgg-open-1', iscoredUsername: 'PggOpenPlayer', score: 1000,
            source: 'community',
        });
        expect(result).not.toBeNull();
    });
});
