import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { BanService } from '../services/BanService.js';
import { drainBackgroundTasks } from '../utils/backgroundTasks.js';

/**
 * B27 - a player posts a score they kept private ("Don't post this score to
 * the global Arcaid scoreboard") to the Global Scoreboard afterwards, or takes
 * it off again. Ownership is the raw global_scores.player_id.
 */

async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api', globalRouter);
    app.use('/api/rooms', roomsRouter);
    return app;
}

const playerToken = (discordId: string, roomId?: string) =>
    signToken({ role: 'player', gameRoomIds: roomId ? [roomId] : [], discordId, username: discordId });

const auth = (id: string) => ({ Authorization: `Bearer ${playerToken(id)}` });

beforeEach(async () => { await setupTestDb(); });

async function seedGame(roomId: string, gameName = 'Medieval Madness') {
    const db = await getDatabase();
    const globalGameId = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', ?, 'approved')`,
        globalGameId, gameName, JSON.stringify(['real']),
    );
    const tid = crypto.randomUUID();
    await db.run(
        `INSERT INTO tournaments (id, name, type, mode, cadence, is_active, game_room_id)
         VALUES (?, 'DG', 'DG', 'pinball', '{"cron":"0 22 * * *"}', 1, ?)`, tid, roomId,
    );
    await db.run(
        `INSERT INTO games (id, tournament_id, name, status, game_room_id, start_date)
         VALUES (?, ?, ?, 'ACTIVE', ?, ?)`,
        crypto.randomUUID(), tid, gameName, roomId, new Date().toISOString(),
    );
    return globalGameId;
}

async function seedScore(opts: {
    globalGameId: string; playerId: string; roomId: string | null;
    exclude?: number; deleted?: boolean; score?: number;
}) {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type,
            origin_game_room_id, exclude_from_global, deleted_at, source, engine, device, platform)
         VALUES (?, ?, ?, ?, ?, 'game_room', ?, ?, ?, 'community', 'real', 'real_cabinet', 'real')`,
        id, opts.globalGameId, opts.playerId, `name-${opts.playerId}`, opts.score ?? 5000, opts.roomId,
        opts.exclude ?? 1, opts.deleted ? new Date().toISOString() : null,
    );
    return id;
}

const flag = async (id: string) =>
    (await (await getDatabase()).get<{ exclude_from_global: number }>(
        'SELECT exclude_from_global FROM global_scores WHERE id = ?', id))!.exclude_from_global;

const activityRows = async () => {
    await drainBackgroundTasks();
    return (await getDatabase()).all<{ game_room_id: string | null; summary: string }>(
        `SELECT * FROM activity_log WHERE event_type = 'score_global_sharing'`);
};

const patch = (app: express.Express, id: string, token: string | null, body: unknown) => {
    const r = request(app).patch(`/api/me/global-scores/${id}`);
    if (token) r.set('Authorization', `Bearer ${token}`);
    return r.send(body as object);
};

describe('GET /api/me/global-scores/private', () => {
    it('returns a real kept-private room submit to its owner only, never public or deleted rows', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('b27-a', 'B27 Room');
        const gg = await seedGame(roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/community-scores/${encodeURIComponent('Medieval Madness')}`)
            .set('Authorization', `Bearer ${playerToken('u-1', roomId)}`)
            .send({ score: 7777, platform: 'real', engine: 'real', device: 'real_cabinet', excludeGlobal: true });
        expect(res.status).toBe(201);
        await seedScore({ globalGameId: gg, playerId: 'u-1', roomId, exclude: 0, score: 1 });
        await seedScore({ globalGameId: gg, playerId: 'u-1', roomId, exclude: 1, deleted: true, score: 2 });
        await seedScore({ globalGameId: gg, playerId: 'u-2', roomId, exclude: 1, score: 3 });

        const mine = await request(app).get('/api/me/global-scores/private').set(auth('u-1'));
        expect(mine.status).toBe(200);
        expect(mine.body.scores).toHaveLength(1);
        expect(mine.body.scores[0]).toMatchObject({
            score: 7777, game_name: 'Medieval Madness', origin_room_name: 'B27 Room', origin_room_slug: 'b27-a',
        });
        const other = await request(app).get('/api/me/global-scores/private').set(auth('u-3'));
        expect(other.body.scores).toEqual([]);
        expect((await request(app).get('/api/me/global-scores/private')).status).toBe(401);
    });
});

describe('PATCH /api/me/global-scores/:scoreId', () => {
    it('posts a private score, busts the cache, writes one activity row, and hides it again', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('b27-b', 'B27 Room');
        const gg = await seedGame(roomId);
        const id = await seedScore({ globalGameId: gg, playerId: 'u-1', roomId, score: 4242 });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at) VALUES (?, 'global', '[]', ?)`,
            gg, new Date().toISOString());

        const before = await request(app).get(`/api/global/scoreboard/${gg}`);
        expect(before.body.total).toBe(0);

        const res = await patch(app, id, playerToken('u-1'), { share_to_global: true });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ success: true, share_to_global: true, changed: true });
        expect(await flag(id)).toBe(0);
        expect(await db.get('SELECT 1 AS x FROM global_leaderboard_cache WHERE global_game_id = ?', gg)).toBeUndefined();

        const after = await request(app).get(`/api/global/scoreboard/${gg}`);
        expect(after.body.total).toBe(1);
        const list = await request(app).get('/api/me/global-scores/private').set(auth('u-1'));
        expect(list.body.scores).toEqual([]);

        const rows = await activityRows();
        expect(rows).toHaveLength(1);
        expect(rows[0].game_room_id).toBe(roomId);
        expect(rows[0].summary).toContain('posted to the Global Scoreboard');
        expect(rows[0].summary).not.toContain('name-u-1');

        // idempotent repeat: no second row
        const again = await patch(app, id, playerToken('u-1'), { share_to_global: true });
        expect(again.status).toBe(200);
        expect(again.body.changed).toBe(false);
        expect(await activityRows()).toHaveLength(1);

        // hide again
        const hide = await patch(app, id, playerToken('u-1'), { share_to_global: false });
        expect(hide.body).toEqual({ success: true, share_to_global: false, changed: true });
        expect(await flag(id)).toBe(1);
        expect((await request(app).get(`/api/global/scoreboard/${gg}`)).body.total).toBe(0);
        expect(await activityRows()).toHaveLength(2);
    });

    it('refuses with the right status codes', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('b27-c', 'B27 Room');
        const gg = await seedGame(roomId);
        const id = await seedScore({ globalGameId: gg, playerId: 'u-1', roomId });
        const gone = await seedScore({ globalGameId: gg, playerId: 'u-1', roomId, deleted: true });

        expect((await patch(app, id, playerToken('u-2'), { share_to_global: true })).status).toBe(403);
        expect((await patch(app, crypto.randomUUID(), playerToken('u-1'), { share_to_global: true })).status).toBe(404);
        expect((await patch(app, gone, playerToken('u-1'), { share_to_global: true })).status).toBe(404);
        expect((await patch(app, id, playerToken('u-1'), {})).status).toBe(400);
        expect((await patch(app, id, playerToken('u-1'), { share_to_global: 'yes' })).status).toBe(400);
        expect((await patch(app, id, null, { share_to_global: true })).status).toBe(401);
        expect(await flag(id)).toBe(1);
    });

    it('409 ROOM_GLOBAL_OFF when the origin room keeps scores off Global; row unchanged', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('b27-d', 'B27 Room');
        const gg = await seedGame(roomId);
        const id = await seedScore({ globalGameId: gg, playerId: 'u-1', roomId });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO game_room_settings (game_room_id, key, value) VALUES (?, 'GLOBAL_SCOREBOARD_ENABLED', 'false')`, roomId);
        const res = await patch(app, id, playerToken('u-1'), { share_to_global: true });
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('ROOM_GLOBAL_OFF');
        expect(await flag(id)).toBe(1);
    });

    it('a banned player cannot share but can still hide', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('b27-e', 'B27 Room');
        const gg = await seedGame(roomId);
        const hidden = await seedScore({ globalGameId: gg, playerId: 'u-1', roomId, exclude: 1 });
        const shown = await seedScore({ globalGameId: gg, playerId: 'u-1', roomId, exclude: 0 });
        const db = await getDatabase();
        await db.run(
            `INSERT INTO user_bans (id, discord_user_id, reason, banned_by) VALUES (?, 'u-1', 'test', 'admin')`,
            crypto.randomUUID());
        BanService.clearCache();

        const share = await patch(app, hidden, playerToken('u-1'), { share_to_global: true });
        expect(share.status).toBe(403);
        expect(share.body.error).toBe('This account is banned.');
        expect(await flag(hidden)).toBe(1);

        const hide = await patch(app, shown, playerToken('u-1'), { share_to_global: false });
        expect(hide.status).toBe(200);
        expect(await flag(shown)).toBe(1);
    });
});
