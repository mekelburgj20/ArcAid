import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';

// v2.86.0 — game ratings now require Discord login (voter = the token's
// discordId, closing the trivial ballot-stuffing hole where a client-supplied
// `x-user-id` header was the entire identity check) AND are room-scoped
// (migration 139 added `game_room_id` to `game_ratings`, previously keyed on
// `game_name` alone across the whole install). No tests existed for the
// rating endpoints before this file.

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.set('trust proxy', 1);
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

let ipCounter = 1;
function freshIp(): string {
    const n = ipCounter++;
    return `10.1.${(n >> 8) & 0xff}.${n & 0xff}`;
}

function playerToken(discordId: string, roomIds: string[] = []) {
    return signToken({ role: 'player', gameRoomIds: roomIds, discordId, username: 'Tester' });
}

async function seedBan(discordUserId: string, gameRoomId: string | null = null): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_bans (id, discord_user_id, reason, banned_by, game_room_id)
         VALUES (?, ?, 'test ban', 'test-admin', ?)`,
        crypto.randomUUID(), discordUserId, gameRoomId,
    );
}

describe('Ratings — login gating + room scoping (v2.86.0)', () => {
    it('an anonymous POST (no Bearer token) is rejected with 401', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rating-anon-room', 'Rating Anon Room');
        const res = await request(app)
            .post(`/api/rooms/${roomId}/ratings/${encodeURIComponent('Medieval Madness')}`)
            .set('X-Forwarded-For', freshIp())
            .set('x-user-id', `guest-${crypto.randomUUID()}`)
            .send({ rating: 5 });
        expect(res.status).toBe(401);
    });

    it('an authenticated vote upserts on (room, game, user) — re-rating updates rather than duplicating', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rating-upsert-room', 'Rating Upsert Room');
        const discordId = `disc-upsert-${crypto.randomUUID()}`;
        const token = playerToken(discordId, [roomId]);
        const gameName = 'Attack From Mars';

        const first = await request(app)
            .post(`/api/rooms/${roomId}/ratings/${encodeURIComponent(gameName)}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${token}`)
            .send({ rating: 3 });
        expect(first.status).toBe(200);
        expect(first.body.user_rating).toBe(3);
        expect(first.body.rating_count).toBe(1);

        const second = await request(app)
            .post(`/api/rooms/${roomId}/ratings/${encodeURIComponent(gameName)}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${token}`)
            .send({ rating: 5 });
        expect(second.status).toBe(200);
        expect(second.body.user_rating).toBe(5);
        // Still one row for this (room, game, user) — average reflects the
        // UPDATE, not a second row averaged in.
        expect(second.body.rating_count).toBe(1);
        expect(second.body.avg_rating).toBe(5);

        const db = await getDatabase();
        const count = await db.get(
            'SELECT COUNT(*) AS n FROM game_ratings WHERE game_room_id = ? AND game_name = ? AND user_id = ?',
            roomId, gameName, discordId,
        );
        expect(count.n).toBe(1);
    });

    it('the same game name in two different rooms keeps independent rating aggregates', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('rating-room-a', 'Rating Room A');
        const roomB = await createTestRoom('rating-room-b', 'Rating Room B');
        const gameName = 'WHO Dunnit';
        const voterA = `disc-a-${crypto.randomUUID()}`;
        const voterB = `disc-b-${crypto.randomUUID()}`;

        await request(app)
            .post(`/api/rooms/${roomA}/ratings/${encodeURIComponent(gameName)}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${playerToken(voterA, [roomA])}`)
            .send({ rating: 2 });

        await request(app)
            .post(`/api/rooms/${roomB}/ratings/${encodeURIComponent(gameName)}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${playerToken(voterB, [roomB])}`)
            .send({ rating: 5 });

        const getA = await request(app).get(`/api/rooms/${roomA}/ratings/${encodeURIComponent(gameName)}`);
        const getB = await request(app).get(`/api/rooms/${roomB}/ratings/${encodeURIComponent(gameName)}`);

        expect(getA.body.rating_count).toBe(1);
        expect(getA.body.avg_rating).toBe(2);
        expect(getB.body.rating_count).toBe(1);
        expect(getB.body.avg_rating).toBe(5);
    });

    it('a banned identity gets 403 on rating POST', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('rating-banned-room', 'Rating Banned Room');
        const discordId = `disc-banned-${crypto.randomUUID()}`;
        await seedBan(discordId, roomId);

        const res = await request(app)
            .post(`/api/rooms/${roomId}/ratings/${encodeURIComponent('Twilight Zone')}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${playerToken(discordId, [roomId])}`)
            .send({ rating: 4 });

        expect(res.status).toBe(403);
        expect(res.body.error).toBe('This account is banned.');
    });

    it('GET /:roomId/ratings room-filters the bulk map (a rating in another room is not included)', async () => {
        const app = await createTestApp();
        const roomA = await createTestRoom('rating-getfilter-a', 'Rating GetFilter A');
        const roomB = await createTestRoom('rating-getfilter-b', 'Rating GetFilter B');
        const gameName = 'Godzilla';
        const voter = `disc-getfilter-${crypto.randomUUID()}`;

        await request(app)
            .post(`/api/rooms/${roomA}/ratings/${encodeURIComponent(gameName)}`)
            .set('X-Forwarded-For', freshIp())
            .set('Authorization', `Bearer ${playerToken(voter, [roomA])}`)
            .send({ rating: 4 });

        const bulkA = await request(app).get(`/api/rooms/${roomA}/ratings`);
        const bulkB = await request(app).get(`/api/rooms/${roomB}/ratings`);

        expect(bulkA.body.ratings[gameName]).toBeTruthy();
        expect(bulkB.body.ratings[gameName]).toBeUndefined();
    });
});
