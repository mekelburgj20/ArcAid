import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GameRoomSettingsService } from '../services/GameRoomSettingsService.js';
import { GlobalScoreService } from '../services/GlobalScoreService.js';

// v2.40.0 — tmp/joinreq-names-global-optin-contract.md
//   D1: join-request name resolution (username fallback)
//   D2: private-room opt-in to the Global Scoreboard (SHARE_TO_GLOBAL)

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

async function seedScoreHistory(roomId: string, opts: { gameName: string; username: string; discordUserId: string; score: number }) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (game_name, game_room_id, iscored_username, discord_user_id, score, source)
         VALUES (?, ?, ?, ?, ?, 'community')`,
        opts.gameName, roomId, opts.username, opts.discordUserId, opts.score,
    );
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
});

describe('D2 — SHARE_TO_GLOBAL fan-out gate', () => {
    it('approval room with SHARE_TO_GLOBAL unset still skips fan-out (v2.39.x behavior preserved)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('s2g-off');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await seedGlobalGame('S2G Off Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'S2G Off Game',
            playerId: 'discord-s2g-1', iscoredUsername: 'S2GPlayer', score: 1000,
        });
        expect(result).toBeNull();
    });

    it('approval room with SHARE_TO_GLOBAL=true fans out', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('s2g-on');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');
        await seedGlobalGame('S2G On Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'S2G On Game',
            playerId: 'discord-s2g-2', iscoredUsername: 'S2GPlayer2', score: 1000,
        });
        expect(result).not.toBeNull();
    });

    it('open room ignores SHARE_TO_GLOBAL entirely (setting present but irrelevant)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('s2g-open-control');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'false');
        await seedGlobalGame('S2G Open Control Game');

        const result = await GlobalScoreService.fanOutFromRoomSubmission({
            gameRoomId: roomId, gameName: 'S2G Open Control Game',
            playerId: 'discord-s2g-3', iscoredUsername: 'S2GPlayer3', score: 1000,
        });
        expect(result).not.toBeNull();
    });
});

describe('D2 — flip-to-approval respects SHARE_TO_GLOBAL opt-in', () => {
    it('keeps the room\'s global rows on open->approval flip when SHARE_TO_GLOBAL=true', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('flip-keep');
        const globalGameId = await seedGlobalGame('Flip Keep Game');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id)
             VALUES (?, ?, 'discord-flip-keep-1', 'FlipKeepPlayer', 8000, 'game_room', ?)`,
            crypto.randomUUID(), globalGameId, roomId,
        );

        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');
        await GameRoomSettingsService.set(roomId, 'JOIN_POLICY', 'approval');

        const row = await db.get('SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ?', roomId);
        expect(row.deleted_at).toBeNull();
    });
});

describe('D2 — SHARE_TO_GLOBAL toggle on an already-approval room', () => {
    it('ON->OFF scrubs the room\'s global_scores rows', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('s2g-toggle-off');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');
        const globalGameId = await seedGlobalGame('Toggle Off Game');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id)
             VALUES (?, ?, 'discord-toggle-off-1', 'ToggleOffPlayer', 5000, 'game_room', ?)`,
            crypto.randomUUID(), globalGameId, roomId,
        );

        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'false');

        const row = await db.get('SELECT deleted_at, deleted_by FROM global_scores WHERE origin_game_room_id = ?', roomId);
        expect(row.deleted_at).not.toBeNull();
        expect(row.deleted_by).toBe('system:share_to_global_off');
    });

    it('OFF->ON back-fills score_history into global_scores + restores previously-scrubbed rows', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('s2g-toggle-backfill');
        await seedGlobalGame('Backfill Game');
        await seedScoreHistory(roomId, { gameName: 'Backfill Game', username: 'BackfillPlayer', discordUserId: 'discord-backfill-1', score: 4200 });

        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');

        const db = await getDatabase();
        const row = await db.get(
            `SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ? AND LOWER(iscored_username) = LOWER(?) AND score = ?`,
            roomId, 'BackfillPlayer', 4200,
        );
        expect(row).toBeDefined();
        expect(row.deleted_at).toBeNull();
    });

    it('double-toggle (OFF->ON->OFF->ON) never creates duplicate global_scores rows', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('s2g-idempotent');
        await seedGlobalGame('Idempotent Game');
        await seedScoreHistory(roomId, { gameName: 'Idempotent Game', username: 'IdemPlayer', discordUserId: 'discord-idem-1', score: 3300 });

        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'false');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'false');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT id FROM global_scores WHERE origin_game_room_id = ? AND LOWER(iscored_username) = LOWER(?) AND score = ?`,
            roomId, 'IdemPlayer', 3300,
        );
        expect(rows).toHaveLength(1);
    });

    it('OFF->ON back-fill does NOT resurrect a moderated/self-deleted global_scores row (regression)', async () => {
        await setupTestDb();
        const roomId = await makeApprovalRoom('s2g-no-resurrect');
        const globalGameId = await seedGlobalGame('No Resurrect Game');
        const db = await getDatabase();

        // Simulate a super-admin (or player self-delete) removing a cheat/
        // unwanted score from the Global Scoreboard BEFORE the room ever
        // toggles SHARE_TO_GLOBAL — deleted_by is a real id, not one of the
        // 'system:*' privacy-scrub sentinels.
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id, deleted_at, deleted_by)
             VALUES (?, ?, 'discord-cheater-1', 'CheaterPlayer', 999999, 'game_room', ?, datetime('now'), 'discord-moderator-1')`,
            crypto.randomUUID(), globalGameId, roomId,
        );

        // A genuinely new, never-fanned-out score for the same room/game —
        // this must still fan out normally so the fix doesn't over-correct.
        await seedScoreHistory(roomId, { gameName: 'No Resurrect Game', username: 'HonestPlayer', discordUserId: 'discord-honest-1', score: 4000 });

        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');

        const moderatedRow = await db.get(
            `SELECT deleted_at, deleted_by FROM global_scores WHERE origin_game_room_id = ? AND LOWER(iscored_username) = LOWER(?)`,
            roomId, 'CheaterPlayer',
        );
        expect(moderatedRow.deleted_at).not.toBeNull();
        expect(moderatedRow.deleted_by).toBe('discord-moderator-1');

        const honestRow = await db.get(
            `SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ? AND LOWER(iscored_username) = LOWER(?) AND score = ?`,
            roomId, 'HonestPlayer', 4000,
        );
        expect(honestRow).toBeDefined();
        expect(honestRow.deleted_at).toBeNull();
    });

    it('is a no-op for an open room even if SHARE_TO_GLOBAL is toggled', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('s2g-open-noop');
        const globalGameId = await seedGlobalGame('Open Noop Game');
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type, origin_game_room_id)
             VALUES (?, ?, 'discord-open-noop-1', 'OpenNoopPlayer', 6000, 'game_room', ?)`,
            crypto.randomUUID(), globalGameId, roomId,
        );

        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'true');
        await GameRoomSettingsService.set(roomId, 'SHARE_TO_GLOBAL', 'false');

        // Room is open, so the SHARE_TO_GLOBAL flip must never touch global_scores.
        const row = await db.get('SELECT deleted_at FROM global_scores WHERE origin_game_room_id = ?', roomId);
        expect(row.deleted_at).toBeNull();
    });
});
