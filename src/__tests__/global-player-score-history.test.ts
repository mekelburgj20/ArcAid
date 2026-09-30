import { describe, it, expect, beforeAll } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GlobalLeaderboardService } from '../services/GlobalLeaderboardService.js';

/**
 * v2.157.0 — the Global game page's per-player history drill-in.
 *
 * The board shows each player's BEST only; `GET /api/global/scoreboard/
 * :globalGameId/players/:playerKey/scores` returns every score the board's
 * best-per-player collapse folded into that row. The load-bearing property is
 * that "player" means EXACTLY what the board means by it: the endpoint accepts
 * the board row's `player_key` and matches through the same partition rule, so
 * a Discord-linked player's aliases arrive together here just as they collapse
 * together there.
 *
 * Bootstrap follows global-scoreboard-categories.test.ts: global.ts declares
 * its routes without a '/global' prefix on the router, so it mounts at '/api'.
 */
async function createTestApp() {
    await setupTestDb();
    const app = express();
    app.use(express.json());
    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);
    return app;
}

const playerToken = (discordId: string, username = 'Tester') =>
    signToken({ role: 'player', discordId, username, gameRoomIds: [] });

async function makeGame(name: string): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_games (id, name, type, status, global_leaderboard, platforms, manufacturer, year)
         VALUES (?, ?, 'pinball', 'approved', 1, '["vpx"]', 'Williams', 1997)`,
        id, name,
    );
    return id;
}

async function addScore(gameId: string, opts: {
    username: string;
    score: number;
    playerId: string;
    submittedBy?: string | null;
    submittedAt: string;
    deleted?: boolean;
    excluded?: boolean;
    roomId?: string | null;
    source?: string | null;
    engine?: string;
}): Promise<string> {
    const db = await getDatabase();
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO global_scores (
            id, global_game_id, player_id, submitted_by_user_id, iscored_username, score, submitted_at,
            origin_type, origin_game_room_id, exclude_from_global, platform, engine, device, source, deleted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'pc', ?, ?)`,
        id, gameId, opts.playerId, opts.submittedBy ?? null, opts.username, opts.score, opts.submittedAt,
        opts.roomId ? 'room' : 'global', opts.roomId ?? null, opts.excluded ? 1 : 0,
        opts.engine ?? 'vpx', opts.source ?? null, opts.deleted ? new Date().toISOString() : null,
    );
    return id;
}

describe('GET /api/global/scoreboard/:globalGameId/players/:playerKey/scores', () => {
    // The router's first import is slow (it pulls most of the service layer);
    // pay it once here rather than inside the first test's 10s budget.
    beforeAll(async () => { await import('../api/routes/global.js'); }, 60_000);

    it('returns every visible score of the board row\'s player, newest first, and none of anyone else\'s', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('hist-room', 'History Room');
        const gameId = await makeGame('Attack from Mars');

        // Alice: one Discord user, TWO aliases — the board collapses them.
        await addScore(gameId, { username: 'Alice', score: 500, playerId: 'u-alice', submittedBy: 'u-alice', submittedAt: '2026-09-01T00:00:00.000Z', roomId });
        await addScore(gameId, { username: 'AliceAlt', score: 900, playerId: 'u-alice', submittedBy: 'u-alice', submittedAt: '2026-09-03T00:00:00.000Z', source: 'vpx' });
        await addScore(gameId, { username: 'Alice', score: 700, playerId: 'u-alice', submittedBy: 'u-alice', submittedAt: '2026-09-02T00:00:00.000Z' });
        // Invisible to the board, so invisible here.
        await addScore(gameId, { username: 'Alice', score: 999, playerId: 'u-alice', submittedBy: 'u-alice', submittedAt: '2026-09-04T00:00:00.000Z', deleted: true });
        await addScore(gameId, { username: 'Alice', score: 998, playerId: 'u-alice', submittedBy: 'u-alice', submittedAt: '2026-09-05T00:00:00.000Z', excluded: true });
        // Someone else.
        await addScore(gameId, { username: 'Bob', score: 800, playerId: 'u-bob', submittedBy: 'u-bob', submittedAt: '2026-09-02T12:00:00.000Z' });

        const board = await GlobalLeaderboardService.getForCard(gameId, 'simulation');
        expect(board).toHaveLength(2); // one row per player — the aliases folded
        const aliceRow = board.find(r => r.discord_user_id === 'u-alice')!;
        expect(aliceRow.score).toBe(900);

        const res = await request(app)
            .get(`/api/global/scoreboard/${gameId}/players/${encodeURIComponent(aliceRow.player_key)}/scores`);
        expect(res.status).toBe(200);
        expect(res.body.scores.map((s: any) => s.score)).toEqual([900, 700, 500]);
        expect(res.body.player.discord_user_id).toBe('u-alice');

        const roomRow = res.body.scores.find((s: any) => s.score === 500);
        expect(roomRow.origin_room_name).toBe('History Room');
        expect(roomRow.origin_room_slug).toBe('hist-room');
        const cabinetRow = res.body.scores.find((s: any) => s.score === 900);
        expect(cabinetRow.source).toBe('vpx');
        expect(cabinetRow.engine).toBe('vpx');
        expect(cabinetRow.device).toBe('pc');
    });

    it('collapses an anonymous player per lowercased name, exactly as the board does', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Medieval Madness');
        await addScore(gameId, { username: 'Zed', score: 100, playerId: 'iscored:Zed', submittedAt: '2026-09-01T00:00:00.000Z' });
        await addScore(gameId, { username: 'zed', score: 200, playerId: 'iscored:zed', submittedAt: '2026-09-02T00:00:00.000Z' });
        await addScore(gameId, { username: 'Other', score: 300, playerId: 'iscored:Other', submittedAt: '2026-09-02T00:00:00.000Z' });

        const board = await GlobalLeaderboardService.getForCard(gameId, 'simulation');
        const zedRow = board.find(r => r.iscored_username.toLowerCase() === 'zed')!;
        expect(board).toHaveLength(2);

        const res = await request(app)
            .get(`/api/global/scoreboard/${gameId}/players/${encodeURIComponent(zedRow.player_key)}/scores`);
        expect(res.status).toBe(200);
        expect(res.body.scores.map((s: any) => s.score)).toEqual([200, 100]);
    });

    it('marks is_own only on the viewer\'s rows (the self-delete ownership rule)', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Twilight Zone');
        await addScore(gameId, { username: 'Carol', score: 10, playerId: 'u-carol', submittedBy: 'u-carol', submittedAt: '2026-09-01T00:00:00.000Z' });
        await addScore(gameId, { username: 'Carol', score: 20, playerId: 'u-carol', submittedBy: 'u-carol', submittedAt: '2026-09-02T00:00:00.000Z' });
        const [row] = await GlobalLeaderboardService.getForCard(gameId, 'simulation');
        const url = `/api/global/scoreboard/${gameId}/players/${encodeURIComponent(row!.player_key)}/scores`;

        const own = await request(app).get(url).set('Authorization', `Bearer ${playerToken('u-carol')}`);
        expect(own.body.scores.every((s: any) => s.is_own === true)).toBe(true);

        const other = await request(app).get(url).set('Authorization', `Bearer ${playerToken('u-dave')}`);
        expect(other.body.scores.every((s: any) => s.is_own === false)).toBe(true);

        const guest = await request(app).get(url);
        expect(guest.status).toBe(200);
        expect(guest.body.scores.every((s: any) => s.is_own === false)).toBe(true);
    });

    it('404s on an unknown game', async () => {
        const app = await createTestApp();
        const res = await request(app).get('/api/global/scoreboard/no-such-game/players/u-x/scores');
        expect(res.status).toBe(404);
    });

    it('returns an empty list for a key with no visible scores', async () => {
        const app = await createTestApp();
        const gameId = await makeGame('Scared Stiff');
        const res = await request(app).get(`/api/global/scoreboard/${gameId}/players/nobody/scores`);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ player: null, scores: [] });
    });
});
