import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { runRatingsUnified } from '../database/migrations/ratingsUnified.js';
import { RatingService } from '../services/RatingService.js';
import { GlobalRatingService } from '../services/GlobalRatingService.js';
import { GlobalLeaderboardService } from '../services/GlobalLeaderboardService.js';
import { catalogueIdForName, normalizeRatingPlatform } from '../utils/ratingTarget.js';

/**
 * C3 (ratings half) + C2.2 - one rating store for any catalogue table, with a
 * platform axis. Room-only names keep the legacy room-scoped store.
 */

let ipCounter = 1;
function freshIp(): string {
    const n = ipCounter++;
    return `10.7.${(n >> 8) & 0xff}.${n & 0xff}`;
}

function playerToken(discordId: string) {
    return signToken({ role: 'player', gameRoomIds: [], discordId, username: 'Tester' });
}

async function seedGame(id: string, name: string, manufacturer: string | null = null, year: number | null = null) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, status, manufacturer, year) VALUES (?, ?, 'pinball', 'approved', ?, ?)`,
        id, name, manufacturer, year,
    );
}

async function seedRoomRating(roomId: string, gameName: string, userId: string, rating: number, updatedAt: string) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO game_ratings (game_room_id, game_name, user_id, rating, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
        roomId, gameName, userId, rating, updatedAt, updatedAt,
    );
}

async function app() {
    const a = express();
    a.set('trust proxy', 1);
    a.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    const { default: globalRouter } = await import('../api/routes/global.js');
    a.use('/api/rooms', roomsRouter);
    a.use('/api', globalRouter);
    return a;
}

beforeEach(async () => {
    await setupTestDb();
});

describe('ratingTarget', () => {
    it('resolves exactly one approved row; ambiguous or missing names resolve to null', async () => {
        const db = await getDatabase();
        await seedGame('gg-mm', 'Medieval Madness');
        await seedGame('gg-amb-1', 'Ambiguous', 'Williams', 1990);
        await seedGame('gg-amb-2', 'Ambiguous', 'Stern', 2010);
        expect(await catalogueIdForName(db, 'medieval madness')).toBe('gg-mm');
        expect(await catalogueIdForName(db, 'Ambiguous')).toBeNull();
        expect(await catalogueIdForName(db, 'Room Only')).toBeNull();
    });

    it('normalizes platforms', () => {
        expect(normalizeRatingPlatform(undefined)).toBe('');
        expect(normalizeRatingPlatform(null)).toBe('');
        expect(normalizeRatingPlatform('')).toBe('');
        expect(normalizeRatingPlatform(' VPX ')).toBe('vpx');
        expect(normalizeRatingPlatform('nonsense')).toBeNull();
        expect(normalizeRatingPlatform('unknown')).toBeNull();
        expect(normalizeRatingPlatform(5)).toBeNull();
    });
});

describe('migration 205 fold', () => {
    it('moves catalogue-table room ratings into the one store (newest wins) and keeps room-only ones', async () => {
        const db = await getDatabase();
        const room1 = await createTestRoom('fold-1', 'Fold One');
        const room2 = await createTestRoom('fold-2', 'Fold Two');
        await seedGame('gg-mm', 'Medieval Madness');
        await seedGame('gg-amb-1', 'Ambiguous', 'Williams', 1990);
        await seedGame('gg-amb-2', 'Ambiguous', 'Stern', 2010);

        await seedRoomRating(room1, 'Medieval Madness', 'user-a', 2, '2026-10-01 00:00:00');
        await seedRoomRating(room2, 'medieval madness', 'user-a', 5, '2026-10-03 00:00:00');
        await seedRoomRating(room1, 'Medieval Madness', 'user-b', 4, '2026-10-01 00:00:00');
        await seedRoomRating(room1, 'Ambiguous', 'user-c', 3, '2026-10-01 00:00:00');
        await seedRoomRating(room1, 'Room Only', 'user-d', 1, '2026-10-01 00:00:00');
        await db.run(
            `INSERT INTO global_game_ratings (global_game_id, discord_user_id, platform, rating, created_at, updated_at)
             VALUES ('gg-mm', 'user-a', '', 3, '2026-10-02 00:00:00', '2026-10-02 00:00:00')`,
        );

        // Step 1 sees the platform column already there and skips the rebuild.
        await runRatingsUnified(db);

        const mm = await db.all(
            `SELECT discord_user_id, platform, rating FROM global_game_ratings WHERE global_game_id = 'gg-mm' ORDER BY discord_user_id`,
        );
        expect(mm).toEqual([
            { discord_user_id: 'user-a', platform: '', rating: 5 },
            { discord_user_id: 'user-b', platform: '', rating: 4 },
        ]);
        const kept = await db.all(`SELECT game_name, user_id FROM game_ratings ORDER BY game_name`);
        expect(kept).toEqual([
            { game_name: 'Ambiguous', user_id: 'user-c' },
            { game_name: 'Room Only', user_id: 'user-d' },
        ]);

        // Re-running is a no-op.
        await runRatingsUnified(db);
        const again = await db.get(`SELECT COUNT(*) AS n FROM global_game_ratings`);
        expect(again.n).toBe(2);
    });

    it('rebuilds a pre-205 table with the platform column, keeping rows', async () => {
        const db = await getDatabase();
        await seedGame('gg-old', 'Old Table');
        await db.exec(`
            DROP TABLE global_game_ratings;
            CREATE TABLE global_game_ratings (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                global_game_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(global_game_id, discord_user_id),
                FOREIGN KEY (global_game_id) REFERENCES global_games (id) ON DELETE CASCADE
            );
            INSERT INTO global_game_ratings (global_game_id, discord_user_id, rating) VALUES ('gg-old', 'u1', 4);
        `);
        await runRatingsUnified(db);
        const cols = await db.all(`PRAGMA table_info(global_game_ratings)`);
        expect(cols.some((c: { name: string }) => c.name === 'platform')).toBe(true);
        const rows = await db.all(`SELECT discord_user_id, platform, rating FROM global_game_ratings`);
        expect(rows).toEqual([{ discord_user_id: 'u1', platform: '', rating: 4 }]);
        // The new unique key allows a second platform row for the same player.
        await GlobalRatingService.setRating('gg-old', 'u1', 2, 'vpx');
        const n = await db.get(`SELECT COUNT(*) AS n FROM global_game_ratings`);
        expect(n.n).toBe(2);
    });
});

describe('unified writes', () => {
    it('a catalogue table rated in two rooms and globally shares one aggregate', async () => {
        const a = await app();
        const room1 = await createTestRoom('uni-1', 'Uni One');
        const room2 = await createTestRoom('uni-2', 'Uni Two');
        await seedGame('gg-mm', 'Medieval Madness');
        const name = encodeURIComponent('Medieval Madness');

        const p1 = await request(a).post(`/api/rooms/${room1}/ratings/${name}`)
            .set('X-Forwarded-For', freshIp()).set('Authorization', `Bearer ${playerToken('voter-1')}`)
            .send({ rating: 2 });
        expect(p1.status).toBe(200);
        expect(p1.body.unified).toBe(true);
        expect(p1.body.global_game_id).toBe('gg-mm');
        const p2 = await request(a).post(`/api/rooms/${room2}/ratings/${name}`)
            .set('X-Forwarded-For', freshIp()).set('Authorization', `Bearer ${playerToken('voter-2')}`)
            .send({ rating: 4 });
        expect(p2.status).toBe(200);

        const g1 = await request(a).get(`/api/rooms/${room1}/ratings/${name}`);
        const g2 = await request(a).get(`/api/rooms/${room2}/ratings/${name}`);
        const gg = await request(a).get(`/api/global/games/gg-mm/rating`);
        for (const body of [g1.body, g2.body, gg.body]) {
            expect(body.rating_count).toBe(2);
            expect(body.avg_rating).toBe(3);
        }
        expect(g1.body.unified).toBe(true);
        expect(g2.body.global_game_id).toBe('gg-mm');

        const db = await getDatabase();
        const legacy = await db.get(`SELECT COUNT(*) AS n FROM game_ratings`);
        expect(legacy.n).toBe(0);
    });

    it('a room-only name keeps the legacy store', async () => {
        const roomId = await createTestRoom('legacy-room', 'Legacy Room');
        await RatingService.setRating(roomId, 'Room Only', 'voter-x', 3);
        const info = await RatingService.getGameRating(roomId, 'Room Only', 'voter-x');
        expect(info.unified).toBe(false);
        expect(info.global_game_id).toBeNull();
        expect(info.user_ratings).toEqual({ '': 3 });
        expect(info.by_platform).toEqual([]);
        expect(info.raters.map(r => r.platform)).toEqual(['']);
    });
});

describe('platform axis', () => {
    it('general + per-platform rows; the headline counts a rater once', async () => {
        const a = await app();
        await seedGame('gg-mm', 'Medieval Madness');
        const auth = `Bearer ${playerToken('plat-user')}`;

        const r1 = await request(a).post('/api/global/games/gg-mm/rating')
            .set('X-Forwarded-For', freshIp()).set('Authorization', auth).send({ rating: 3 });
        expect(r1.status).toBe(200);
        const r2 = await request(a).post('/api/global/games/gg-mm/rating')
            .set('X-Forwarded-For', freshIp()).set('Authorization', auth).send({ rating: 5, platform: 'vpx' });
        expect(r2.status).toBe(200);
        expect(r2.body.rating_count).toBe(1);
        expect(r2.body.avg_rating).toBe(4);
        expect(r2.body.user_rating).toBe(3);
        expect(r2.body.user_ratings).toEqual({ '': 3, vpx: 5 });
        expect(r2.body.by_platform).toEqual([{ platform: 'vpx', avg_rating: 5, rating_count: 1, user_rating: 5 }]);
        expect(r2.body.raters).toHaveLength(2);
        expect(r2.body.raters.map((r: { platform: string }) => r.platform).sort()).toEqual(['', 'vpx']);

        const bad = await request(a).post('/api/global/games/gg-mm/rating')
            .set('X-Forwarded-For', freshIp()).set('Authorization', auth).send({ rating: 4, platform: 'nonsense' });
        expect(bad.status).toBe(400);
        expect(bad.body.error).toBe('PLATFORM_INVALID');
    });

    it('room route: platform on a room-only name is unsupported; invalid platform is invalid', async () => {
        const a = await app();
        const roomId = await createTestRoom('plat-room', 'Plat Room');
        const auth = `Bearer ${playerToken('plat-room-user')}`;
        const roomOnly = encodeURIComponent('Room Only');

        const unsupported = await request(a).post(`/api/rooms/${roomId}/ratings/${roomOnly}`)
            .set('X-Forwarded-For', freshIp()).set('Authorization', auth).send({ rating: 4, platform: 'vpx' });
        expect(unsupported.status).toBe(400);
        expect(unsupported.body.error).toBe('PLATFORM_UNSUPPORTED');

        const invalid = await request(a).post(`/api/rooms/${roomId}/ratings/${roomOnly}`)
            .set('X-Forwarded-For', freshIp()).set('Authorization', auth).send({ rating: 4, platform: 'nonsense' });
        expect(invalid.status).toBe(400);
        expect(invalid.body.error).toBe('PLATFORM_INVALID');

        const db = await getDatabase();
        const n = await db.get(`SELECT COUNT(*) AS n FROM game_ratings`);
        expect(n.n).toBe(0);
    });
});

describe('aggregates count a two-platform rater once', () => {
    it('getBulkRatings, RatingService.getAllRatings and the scoreboard card query', async () => {
        const db = await getDatabase();
        const roomId = await createTestRoom('agg-room', 'Agg Room');
        await seedGame('gg-mm', 'Medieval Madness');
        await db.run(
            `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type)
             VALUES (?, 'gg-mm', 'P1', 'P1', 1000, 'global')`,
            crypto.randomUUID(),
        );
        // u1: general 2 + vpx 4 -> own average 3; u2: general 5. Headline = (3 + 5) / 2 = 4, two raters.
        await GlobalRatingService.setRating('gg-mm', 'u1', 2);
        await GlobalRatingService.setRating('gg-mm', 'u1', 4, 'vpx');
        await GlobalRatingService.setRating('gg-mm', 'u2', 5);

        const bulk = await GlobalRatingService.getBulkRatings('u1');
        expect(bulk.ratings['gg-mm']).toEqual({ avg_rating: 4, rating_count: 2 });
        expect(bulk.userRatings).toEqual({ 'gg-mm': 2 });

        const all = await RatingService.getAllRatings(roomId);
        expect(all['Medieval Madness']).toEqual({ avg_rating: 4, rating_count: 2 });
        const mine = await RatingService.getUserRatings(roomId, 'u1');
        expect(mine).toEqual({ 'Medieval Madness': 2 });

        const top = await GlobalLeaderboardService.getTopGames({ scope: 'global' });
        const card = top.data.find((g: { global_game_id: string }) => g.global_game_id === 'gg-mm') as
            { avg_rating: number; rating_count: number } | undefined;
        expect(card).toBeDefined();
        expect(card!.rating_count).toBe(2);
        expect(card!.avg_rating).toBe(4);
    });
});

describe('by-user rows', () => {
    it('global by-user rows carry platform; the room by-user route returns residue only', async () => {
        const a = await app();
        const roomId = await createTestRoom('by-user-uni', 'By User Uni');
        await seedGame('gg-mm', 'Medieval Madness');
        await RatingService.setRating(roomId, 'Medieval Madness', 'bu', 4);
        await RatingService.setRating(roomId, 'Medieval Madness', 'bu', 5, 'vpx');
        await RatingService.setRating(roomId, 'Room Only', 'bu', 2);

        const g = await request(a).get('/api/global/ratings/by-user/bu');
        expect(g.status).toBe(200);
        expect(g.body.ratings.map((r: { global_game_id: string; platform: string; rating: number }) =>
            [r.global_game_id, r.platform, r.rating]).sort()).toEqual([['gg-mm', '', 4], ['gg-mm', 'vpx', 5]]);

        const r = await request(a).get(`/api/rooms/${roomId}/ratings/by-user/bu`);
        expect(r.status).toBe(200);
        expect(r.body.ratings).toHaveLength(1);
        expect(r.body.ratings[0]).toMatchObject({ game_name: 'Room Only', platform: '', rating: 2 });
    });
});
