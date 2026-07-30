import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { isAllowedImage } from '../api/uploadValidation.js';
import { CommunityScoreSchema, ScoreSubmissionSchema, FreeplayScoreSchema } from '../api/schemas.js';

// S11 — trust & safety hardening. Covers the four in-scope changes:
//   (a) dedicated rate limiters on guest-writable routes,
//   (b) tiered authz on the room comment-delete (+ token-derived comment author),
//   (c) score-value bounds on the three guest submit schemas,
//   (d) magic-byte validation of image uploads.
//
// The test app mounts ONLY the rooms router — NOT server.ts's generalLimiter —
// so every 429 observed here comes strictly from the dedicated route limiters
// (guestContentLimiter / writeLimiter), which is exactly what we want to prove.
//
// Isolation note: setup.ts resets the in-memory DB before each test but does
// NOT reset express-rate-limit's in-memory stores, and the rooms router (with
// its limiter instances) is module-cached across tests in this file. Both the
// writeLimiter and the guestContentLimiter key on the client IP, so each test
// uses a FRESH client IP (trust-proxy + X-Forwarded-For) to get its own counter
// bucket.

async function createTestApp() {
    await setupTestDb();
    const app = express();
    // trust proxy = 1 (not `true`) so req.ip reflects our X-Forwarded-For while
    // avoiding express-rate-limit's ERR_ERL_PERMISSIVE_TRUST_PROXY warning.
    app.set('trust proxy', 1);
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

// Distinct client IP per call — isolates the IP-keyed writeLimiter (and the
// guest-content limiter's IP fallback) between tests.
let ipCounter = 1;
function freshIp(): string {
    const n = ipCounter++;
    return `10.0.${(n >> 8) & 0xff}.${n & 0xff}`;
}

// Seed a comment row directly (bypasses the limiter/handler so authz tests don't
// burn limiter budget) and returns its id.
async function seedComment(roomId: string, gameName: string, userId: string): Promise<number> {
    const db = await getDatabase();
    const r = await db.run(
        `INSERT INTO game_comments (game_name, game_room_id, user_id, display_name, type, body)
         VALUES (?, ?, ?, 'Seeded', 'comment', 'seeded body')`,
        gameName, roomId, userId,
    );
    return r.lastID as number;
}

describe('S11 (d) — image upload magic-byte validation', () => {
    it('isAllowedImage accepts PNG/APNG, JPEG, and WebP signatures', () => {
        // PNG (and APNG, same signature): 89 50 4E 47 0D 0A 1A 0A, padded past 12 bytes.
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
        // JPEG: FF D8 FF ...
        const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(12)]);
        // WebP: 'RIFF' + 4-byte size + 'WEBP' = 12 bytes exactly.
        const webp = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP', 'ascii')]);

        expect(isAllowedImage(png)).toBe(true);
        expect(isAllowedImage(jpeg)).toBe(true);
        expect(isAllowedImage(webp)).toBe(true);
    });

    it('isAllowedImage rejects a text buffer and buffers shorter than 12 bytes', () => {
        expect(isAllowedImage(Buffer.from('this is plainly not an image file'))).toBe(false);
        // 'RIFF' present but no 'WEBP' at bytes 8-11.
        expect(isAllowedImage(Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(8)]))).toBe(false);
        // Too short (< 12 bytes) even though these 3 bytes start a PNG signature.
        expect(isAllowedImage(Buffer.from([0x89, 0x50, 0x4e]))).toBe(false);
        // Full 8-byte PNG signature but still under the 12-byte floor.
        expect(isAllowedImage(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
    });

    it('submit-score rejects a spoofed non-image upload with 400', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-upload', 'S11 Upload');
        const db = await getDatabase();
        const gameName = 'Upload Game';
        // ensurePlatformAllowed must pass so the handler reaches the image check —
        // an approved catalogue row exposing the 'real' platform satisfies it.
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
            crypto.randomUUID(), gameName, JSON.stringify(['real']),
        );

        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('X-Forwarded-For', freshIp())
            .field('username', 'Tester')
            .field('score', '5000')
            .field('engine', 'real').field('device', 'real_cabinet')
            // multer's fileFilter trusts the (spoofable) mimetype, so this text
            // buffer sails past it — the magic-byte check must reject it.
            .attach('photo', Buffer.from('this is text, not a real image'), { filename: 'evil.png', contentType: 'image/png' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Invalid image file');
    });
});

describe('S11 (c) — score value bounds (MAX_SCORE = 1e15)', () => {
    const MAX = 1_000_000_000_000_000; // 1e15 — mirrors schemas.ts MAX_SCORE

    it('CommunityScoreSchema caps score at MAX_SCORE but allows normal large scores', () => {
        const base = { username: 'Player', platform: 'real', engine: 'real', device: 'real_cabinet' };
        expect(CommunityScoreSchema.safeParse({ ...base, score: 5_000_000_000 }).success).toBe(true);
        expect(CommunityScoreSchema.safeParse({ ...base, score: MAX }).success).toBe(true); // boundary: inclusive
        expect(CommunityScoreSchema.safeParse({ ...base, score: MAX + 1 }).success).toBe(false);
        expect(CommunityScoreSchema.safeParse({ ...base, score: 9_000_000_000_000_000 }).success).toBe(false);
        // min(0) still enforced.
        expect(CommunityScoreSchema.safeParse({ ...base, score: -1 }).success).toBe(false);
    });

    it('ScoreSubmissionSchema caps score with preprocess intact (string input)', () => {
        const base = { username: 'Player', platform: 'real', engine: 'real', device: 'real_cabinet' };
        expect(ScoreSubmissionSchema.safeParse({ ...base, score: '5000000000' }).success).toBe(true);
        expect(ScoreSubmissionSchema.safeParse({ ...base, score: String(MAX) }).success).toBe(true);
        expect(ScoreSubmissionSchema.safeParse({ ...base, score: String(MAX + 1) }).success).toBe(false);
        expect(ScoreSubmissionSchema.safeParse({ ...base, score: 9_000_000_000_000_000 }).success).toBe(false);
    });

    it('FreeplayScoreSchema caps score with preprocess intact (string input)', () => {
        const base = { globalGameId: 'gg-1', username: 'Player', platform: 'real', engine: 'real', device: 'real_cabinet' };
        expect(FreeplayScoreSchema.safeParse({ ...base, score: '5000000000' }).success).toBe(true);
        expect(FreeplayScoreSchema.safeParse({ ...base, score: String(MAX) }).success).toBe(true);
        expect(FreeplayScoreSchema.safeParse({ ...base, score: String(MAX + 1) }).success).toBe(false);
    });

    it('community-scores route rejects an over-cap score with 400', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-score-cap', 'S11 Score Cap');

        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/game`)
            .set('X-Forwarded-For', freshIp())
            .send({ username: 'Cheater', score: 9_000_000_000_000_000, platform: 'real', engine: 'real', device: 'real_cabinet' });

        expect(res.status).toBe(400);
        expect(res.body.error).toBeTruthy();
    });
});

describe('S11 (a) — rate limiting on guest-writable routes', () => {
    it('guestContentLimiter blocks the 11th comment POST from one client (10/min)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-rl-comments', 'S11 RL Comments');
        // guestContentLimiter keys on IP, so a single fresh IP held constant
        // across all requests gives this test one bucket, isolated from others.
        const userId = `guest-${crypto.randomUUID()}`;
        const ip = freshIp();
        const post = () => request(app)
            .post(`/api/rooms/${roomId}/games/game/comments`)
            .set('X-Forwarded-For', ip)
            .set('x-user-id', userId)
            .send({ display_name: 'Spammer', type: 'comment', body: 'spam' });

        const statuses: number[] = [];
        for (let i = 0; i < 11; i++) statuses.push((await post()).status);

        expect(statuses.slice(0, 10).every(s => s !== 429)).toBe(true); // first 10 allowed
        expect(statuses[10]).toBe(429); // 11th blocked
    });

    it('writeLimiter blocks the 31st community-score POST from one IP (30/min)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-rl-scores', 'S11 RL Scores');
        // Single fresh IP -> one writeLimiter bucket for this test only.
        const ip = freshIp();
        // Empty body -> the handler 400s, but the request still passes THROUGH the
        // limiter first, so it counts toward the 30/min cap.
        const post = () => request(app)
            .post(`/api/rooms/${roomId}/community-scores/game`)
            .set('X-Forwarded-For', ip)
            .send({});

        const statuses: number[] = [];
        for (let i = 0; i < 31; i++) statuses.push((await post()).status);

        expect(statuses.slice(0, 30).every(s => s !== 429)).toBe(true); // first 30 pass the limiter
        expect(statuses[30]).toBe(429); // 31st blocked
    });
});

describe('S11 (b) — comment-delete authorization tiers', () => {
    const gameName = 'game';

    it('author can delete their own comment (x-user-id matches)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-cd-author', 'S11 CD Author');
        const authorId = `author-${crypto.randomUUID()}`;
        const commentId = await seedComment(roomId, gameName, authorId);

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${gameName}/comments/${commentId}`)
            .set('X-Forwarded-For', freshIp())
            .set('x-user-id', authorId);

        expect(res.status).toBe(200);
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM game_comments WHERE id = ?', commentId)).toBeUndefined();
    });

    it('a stranger x-user-id cannot delete (403) and the row survives', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-cd-stranger', 'S11 CD Stranger');
        const commentId = await seedComment(roomId, gameName, `author-${crypto.randomUUID()}`);

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${gameName}/comments/${commentId}`)
            .set('X-Forwarded-For', freshIp())
            .set('x-user-id', `stranger-${crypto.randomUUID()}`);

        expect(res.status).toBe(403);
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM game_comments WHERE id = ?', commentId)).toBeTruthy();
    });

    it('room_admin (Discord-authed token) can delete any comment in their room', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-cd-roomadmin', 'S11 CD RoomAdmin');
        const commentId = await seedComment(roomId, gameName, `someone-${crypto.randomUUID()}`);
        // conditionalRequireDiscordUser only attaches req.user when the token
        // carries a discordId, so an admin moderating comments must be Discord-authed.
        const token = signToken({ role: 'room_admin', gameRoomIds: [roomId], discordId: `ra-${crypto.randomUUID()}` });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${gameName}/comments/${commentId}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM game_comments WHERE id = ?', commentId)).toBeUndefined();
    });

    it('super_admin (Discord-authed token) can delete any comment', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-cd-super', 'S11 CD Super');
        const commentId = await seedComment(roomId, gameName, `someone-${crypto.randomUUID()}`);
        const token = signToken({ role: 'super_admin', gameRoomIds: [], discordId: `sa-${crypto.randomUUID()}` });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${gameName}/comments/${commentId}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM game_comments WHERE id = ?', commentId)).toBeUndefined();
    });

    it('a logged-in user can delete a comment they posted via the API (token identity)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-cd-loggedin', 'S11 CD LoggedIn');
        const discordId = `disc-${crypto.randomUUID()}`;
        const token = signToken({ role: 'player', gameRoomIds: [], discordId });
        const ip = freshIp();

        // POST attributes authorship to the token's discordId (item 7), not x-user-id.
        const posted = await request(app)
            .post(`/api/rooms/${roomId}/games/${gameName}/comments`)
            .set('X-Forwarded-For', ip)
            .set('Authorization', `Bearer ${token}`)
            .send({ display_name: 'LoggedIn', type: 'comment', body: 'mine' });
        expect(posted.status).toBe(201);
        const commentId = posted.body.id;

        // Same user deletes with their token; the author tier matches on discordId.
        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${gameName}/comments/${commentId}`)
            .set('X-Forwarded-For', ip)
            .set('Authorization', `Bearer ${token}`);

        expect(res.status).toBe(200);
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM game_comments WHERE id = ?', commentId)).toBeUndefined();
    });

    // v2.47.0 (S22 follow-ups M4) — pre-existing comments were stored under
    // the anon x-user-id BEFORE the poster ever logged in. Once they log in,
    // a request carries BOTH their Discord token AND the same anon
    // x-user-id header (the FE now sends both). The server must match the
    // comment as "own" via EITHER id, not just prefer req.user.discordId —
    // otherwise a logged-in user loses the delete control (and the GET route
    // starts showing a Flag button) on comments they posted anonymously
    // before logging in.
    it('a logged-in user can still delete a comment stored under their OLD anon x-user-id when both identities are present', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-cd-historical', 'S11 CD Historical');
        const anonId = `anon-${crypto.randomUUID()}`;
        // Comment stored under the anon id — as it would be pre-login.
        const commentId = await seedComment(roomId, gameName, anonId);

        const discordId = `disc-historical-${crypto.randomUUID()}`;
        const token = signToken({ role: 'player', gameRoomIds: [], discordId });

        const res = await request(app)
            .delete(`/api/rooms/${roomId}/games/${gameName}/comments/${commentId}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${token}`)
            .set('x-user-id', anonId);

        expect(res.status).toBe(200);
        const db = await getDatabase();
        expect(await db.get('SELECT id FROM game_comments WHERE id = ?', commentId)).toBeUndefined();
    });

    it('GET comments masks user_id to the caller\'s OLD anon x-user-id even when a Discord token is also present', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('s11-cd-historical-get', 'S11 CD Historical GET');
        const anonId = `anon-get-${crypto.randomUUID()}`;
        await seedComment(roomId, gameName, anonId);

        const discordId = `disc-historical-get-${crypto.randomUUID()}`;
        const token = signToken({ role: 'player', gameRoomIds: [], discordId });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/games/${gameName}/comments`)
            .set('Authorization', `Bearer ${token}`)
            .set('x-user-id', anonId);

        expect(res.status).toBe(200);
        expect(res.body.length).toBeGreaterThan(0);
        expect(res.body[0].user_id).toBe(anonId); // survives the mask — caller owns this row via x-user-id
    });
});

describe('S11 regression — comments stay open to guests in login-required rooms', () => {
    // S11 briefly gated the comment routes on conditionalRequireDiscordUser, which
    // enforces REQUIRE_DISCORD_LOGIN — but the comment form sends no Bearer token,
    // so in a login-required room the routes 401'd for everyone. optionalDiscordUser
    // decodes a token if present but never blocks; comments must stay guest-open.
    async function loginRequiredRoom(slug: string, name: string): Promise<string> {
        const roomId = await createTestRoom(slug, name);
        const { GameRoomSettingsService } = await import('../services/GameRoomSettingsService.js');
        await GameRoomSettingsService.set(roomId, 'REQUIRE_DISCORD_LOGIN', 'true');
        return roomId;
    }

    it('a guest can POST a comment even when the room requires Discord login', async () => {
        const app = await createTestApp();
        const roomId = await loginRequiredRoom('s11-cmt-guest', 'S11 Comment Guest');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/games/game/comments`)
            .set('X-Forwarded-For', freshIp())
            .set('x-user-id', `guest-${crypto.randomUUID()}`)
            .send({ display_name: 'Guest', type: 'comment', body: 'hi' });
        expect(res.status).toBe(201);
    });

    it('a guest can GET comments in a login-required room (viewing not blocked)', async () => {
        const app = await createTestApp();
        const roomId = await loginRequiredRoom('s11-cmt-view', 'S11 Comment View');
        await seedComment(roomId, 'game', `someone-${crypto.randomUUID()}`);
        const res = await request(app)
            .get(`/api/rooms/${roomId}/games/game/comments`)
            .set('X-Forwarded-For', freshIp());
        expect(res.status).toBe(200);
        expect(Array.isArray(res.body)).toBe(true);
        expect(res.body.length).toBe(1);
    });

    it('community-scores STILL requires login in a login-required room (score gate intact)', async () => {
        const app = await createTestApp();
        const roomId = await loginRequiredRoom('s11-score-gate', 'S11 Score Gate');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/game`)
            .set('X-Forwarded-For', freshIp())
            .set('x-user-id', `guest-${crypto.randomUUID()}`)
            .send({ username: 'Guest', score: 1000, platform: 'real', engine: 'real', device: 'real_cabinet' });
        expect(res.status).toBe(401);
    });
});
