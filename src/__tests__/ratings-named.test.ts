import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { RatingService } from '../services/RatingService.js';
import { GlobalRatingService } from '../services/GlobalRatingService.js';

/**
 * C2 - ratings carry a name (owner ruling: "stamp your name on it or don't
 * rate at all"). Both rating payloads gain `raters`, resolved through
 * resolveUserLabels (display_name -> username -> earliest alias -> raw id),
 * and each player's given ratings are listable by user.
 */

async function seedProfile(id: string, displayName: string | null, username: string | null = null) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO user_profiles (discord_user_id, display_name, username) VALUES (?, ?, ?)`,
        id, displayName, username,
    );
}

async function seedAlias(id: string, alias: string) {
    const db = await getDatabase();
    await db.run(`INSERT INTO user_mappings (discord_user_id, iscored_username) VALUES (?, ?)`, id, alias);
}

async function stamp(table: string, where: string, updatedAt: string, ...params: unknown[]) {
    const db = await getDatabase();
    await db.run(`UPDATE ${table} SET updated_at = ? WHERE ${where}`, updatedAt, ...params);
}

async function seedGame(id: string, name: string) {
    const db = await getDatabase();
    await db.run(`INSERT INTO global_games (id, name, type, status) VALUES (?, ?, 'pinball', 'approved')`, id, name);
}

async function roomsApp() {
    const app = express();
    app.use(express.json());
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);
    return app;
}

async function globalApp() {
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

beforeEach(async () => {
    await setupTestDb();
});

describe('room rating raters', () => {
    it('lists every rater with a resolved name, newest first; existing fields unchanged', async () => {
        const roomId = await createTestRoom('named-room', 'Named Room');
        await seedProfile('r-display', 'Display Dan');
        await seedProfile('r-user', null, 'login_lou');
        await seedAlias('r-alias', 'AliasAl');
        await RatingService.setRating(roomId, 'Medieval Madness', 'r-display', 5);
        await RatingService.setRating(roomId, 'Medieval Madness', 'r-user', 3);
        await RatingService.setRating(roomId, 'Medieval Madness', 'r-alias', 4);
        await RatingService.setRating(roomId, 'Medieval Madness', 'r-raw', 1);
        await stamp('game_ratings', 'user_id = ?', '2026-10-01 10:00:00', 'r-display');
        await stamp('game_ratings', 'user_id = ?', '2026-10-04 10:00:00', 'r-user');
        await stamp('game_ratings', 'user_id = ?', '2026-10-03 10:00:00', 'r-alias');
        await stamp('game_ratings', 'user_id = ?', '2026-10-02 10:00:00', 'r-raw');

        const info = await RatingService.getGameRating(roomId, 'Medieval Madness', 'r-display');
        expect(info.rating_count).toBe(4);
        expect(info.avg_rating).toBe(3.3);
        expect(info.user_rating).toBe(5);
        expect(info.raters).toEqual([
            { user_id: 'r-user', display_name: 'login_lou', rating: 3, updated_at: '2026-10-04 10:00:00' },
            { user_id: 'r-alias', display_name: 'AliasAl', rating: 4, updated_at: '2026-10-03 10:00:00' },
            // Nothing resolves: never the raw id (a guest uuid or a bare snowflake).
            { user_id: 'r-raw', display_name: 'Unknown player', rating: 1, updated_at: '2026-10-02 10:00:00' },
            { user_id: 'r-display', display_name: 'Display Dan', rating: 5, updated_at: '2026-10-01 10:00:00' },
        ]);
    });

    it('an unrated game has an empty raters list', async () => {
        const roomId = await createTestRoom('empty-room', 'Empty Room');
        const info = await RatingService.getGameRating(roomId, 'Nobody Rated');
        expect(info.raters).toEqual([]);
    });
});

describe('global rating raters', () => {
    it('lists every rater with a resolved name, newest first', async () => {
        await seedGame('gg-named', 'Attack From Mars');
        await seedProfile('g1', 'Global One');
        await GlobalRatingService.setRating('gg-named', 'g1', 4);
        await GlobalRatingService.setRating('gg-named', 'g2', 2);
        await stamp('global_game_ratings', 'discord_user_id = ?', '2026-10-01 00:00:00', 'g1');
        await stamp('global_game_ratings', 'discord_user_id = ?', '2026-10-05 00:00:00', 'g2');

        const info = await GlobalRatingService.getGameRating('gg-named');
        expect(info.user_rating).toBeNull();
        expect(info.raters.map(r => [r.user_id, r.display_name, r.rating])).toEqual([
            ['g2', 'Unknown player', 2],
            ['g1', 'Global One', 4],
        ]);
    });
});

describe('ratings by user', () => {
    it('GET /api/rooms/:roomId/ratings/by-user/:userId reaches the by-user handler, not /ratings/:gameName', async () => {
        const app = await roomsApp();
        const roomId = await createTestRoom('by-user-room', 'By User Room');
        const other = await createTestRoom('by-user-other', 'Other Room');
        await RatingService.setRating(roomId, 'Game One', 'rater-x', 5);
        await RatingService.setRating(roomId, 'Game Two', 'rater-x', 2);
        await RatingService.setRating(other, 'Game Three', 'rater-x', 4);
        await RatingService.setRating(roomId, 'Game One', 'rater-y', 1);
        await stamp('game_ratings', 'user_id = ? AND game_name = ?', '2026-10-01 00:00:00', 'rater-x', 'Game One');
        await stamp('game_ratings', 'user_id = ? AND game_name = ?', '2026-10-02 00:00:00', 'rater-x', 'Game Two');

        const res = await request(app).get(`/api/rooms/${roomId}/ratings/by-user/rater-x`);
        expect(res.status).toBe(200);
        // The :gameName handler would answer { game_name: 'by-user', ... } -
        // and would never see the trailing /rater-x segment at all.
        expect(res.body.game_name).toBeUndefined();
        expect(res.body).toEqual({
            ratings: [
                { game_name: 'Game Two', rating: 2, updated_at: '2026-10-02 00:00:00' },
                { game_name: 'Game One', rating: 5, updated_at: '2026-10-01 00:00:00' },
            ],
        });

        // The game-name route still works alongside it.
        const byGame = await request(app).get(`/api/rooms/${roomId}/ratings/${encodeURIComponent('Game One')}`);
        expect(byGame.body.game_name).toBe('Game One');
        expect(byGame.body.rating_count).toBe(2);
    });

    it('GET /api/global/ratings/by-user/:userId lists global ratings with names, newest first', async () => {
        const app = await globalApp();
        await seedGame('gg-a', 'Alpha Table');
        await seedGame('gg-b', 'Beta Table');
        await GlobalRatingService.setRating('gg-a', 'gu', 3);
        await GlobalRatingService.setRating('gg-b', 'gu', 5);
        await GlobalRatingService.setRating('gg-a', 'someone-else', 1);
        await stamp('global_game_ratings', 'discord_user_id = ? AND global_game_id = ?', '2026-10-09 00:00:00', 'gu', 'gg-a');
        await stamp('global_game_ratings', 'discord_user_id = ? AND global_game_id = ?', '2026-10-01 00:00:00', 'gu', 'gg-b');

        const res = await request(app).get('/api/global/ratings/by-user/gu');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            ratings: [
                { global_game_id: 'gg-a', name: 'Alpha Table', rating: 3, updated_at: '2026-10-09 00:00:00' },
                { global_game_id: 'gg-b', name: 'Beta Table', rating: 5, updated_at: '2026-10-01 00:00:00' },
            ],
        });
    });
});
