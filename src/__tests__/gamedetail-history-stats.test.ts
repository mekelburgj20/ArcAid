import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission,
} from './helpers.js';
import { getDatabase } from '../database/database.js';

/**
 * Regression coverage for two GameDetail/history/stats fixes:
 *  (1) GET /:roomId/history includes ARCHIVED games alongside COMPLETED (not just COMPLETED).
 *  (2) StatsService.getGameStats / getGamePlayerRankings read from score_history (the
 *      physical union of tournament + community/freeplay + sync submissions) instead of
 *      `submissions` alone, so community-flavored scores are counted.
 *  Plus the /:roomId/score-counts?gameNames= batched-counts path.
 *
 * Bootstrap pattern copied verbatim from room-scores.test.ts: mount rooms.ts at
 * /api/rooms against a fresh setupTestDb() per test (setup.ts's global beforeEach
 * already calls _resetForTesting(), so each `it()` gets its own in-memory database).
 */
async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: roomsRouter } = await import('../api/routes/rooms.js');
    app.use('/api/rooms', roomsRouter);

    return app;
}

/**
 * Direct score_history seeding for cases the `submissions`-flavored
 * createTestSubmission() helper can't express (explicit submitted_by_user_id,
 * orphaned_at, source, created_at, game_id-less community rows). Copied
 * verbatim from room-scores.test.ts — mirrors the column set ScoreHistoryService
 * and the sync poller actually write.
 */
async function insertScoreHistoryRow(opts: {
    gameRoomId: string;
    gameName: string;
    iscoredUsername: string;
    score: number;
    discordUserId?: string | null;
    submittedByUserId?: string | null;
    source?: 'tournament' | 'community' | 'sync';
    orphanedAt?: string | null;
    createdAt?: string;
}) {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO score_history (
            game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
            submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id, orphaned_at, created_at
         ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        opts.gameName, opts.gameRoomId, opts.iscoredUsername,
        opts.discordUserId ?? 'SYSTEM', opts.score, opts.source ?? 'community',
        opts.gameRoomId, opts.submittedByUserId ?? null, opts.orphanedAt ?? null,
        opts.createdAt ?? new Date().toISOString(),
    );
}

describe('GET /api/rooms/:roomId/history — ARCHIVED inclusion', () => {
    it('(a) includes COMPLETED and ARCHIVED tournament games, excludes ACTIVE', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);

        const completedId = await createTestGame(tId, {
            name: 'Completed Game', status: 'COMPLETED', endDate: '2026-01-01T00:00:00.000Z',
        });
        const archivedId = await createTestGame(tId, {
            name: 'Archived Game', status: 'ARCHIVED', endDate: '2026-01-02T00:00:00.000Z',
        });
        const activeId = await createTestGame(tId, { name: 'Active Game', status: 'ACTIVE' });

        await createTestSubmission(completedId, { username: 'P1', score: 100 });
        await createTestSubmission(archivedId, { username: 'P2', score: 200 });
        await createTestSubmission(activeId, { username: 'P3', score: 300 });

        const res = await request(app).get(`/api/rooms/${roomId}/history`);

        expect(res.status).toBe(200);
        const names = res.body.results.map((r: any) => r.game_name);
        expect(names).toContain('Completed Game');
        expect(names).toContain('Archived Game');
        expect(names).not.toContain('Active Game');
        expect(res.body.total).toBe(2);
    });
});

describe('GET /api/rooms/:roomId/stats/game/:name — community scores included', () => {
    it('(b) allTimeHigh/allTimeHighPlayer pick up a higher community score_history row; ' +
        'uniquePlayers collapses two aliases of one submitted_by_user_id', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, {
            name: 'Community Boost', status: 'COMPLETED', endDate: new Date().toISOString(),
        });

        // Tournament submission (submissions row + mirrored score_history row, source='tournament').
        await createTestSubmission(gameId, { username: 'Alice', discordUserId: 'DALICE', score: 600 });
        const db = await getDatabase();
        // createTestSubmission's score_history mirror doesn't populate submitted_by_user_id
        // (only discord_user_id) — set it explicitly so this row and the community row below
        // share one canonical partition key, per LeaderboardService.recalculate's
        // COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) rule.
        await db.run(
            `UPDATE score_history SET submitted_by_user_id = ? WHERE game_id = ? AND iscored_username = ?`,
            'DALICE', gameId, 'Alice',
        );

        // Community-flavored score_history row: different alias, same underlying player
        // (same submitted_by_user_id), higher score, no game_id (freeplay/community path).
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Community Boost', iscoredUsername: 'AliceCommunity',
            submittedByUserId: 'DALICE', score: 50000, source: 'community',
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/game/${encodeURIComponent('Community Boost')}`);

        expect(res.status).toBe(200);
        expect(res.body.allTimeHigh).toBe(50000);
        expect(res.body.allTimeHighPlayer).toBe('AliceCommunity');
        // Two aliases (Alice / AliceCommunity), one submitted_by_user_id (DALICE) -> 1 unique player.
        expect(res.body.uniquePlayers).toBe(1);
    });
});

describe('GET /api/rooms/:roomId/stats/game/:name/players — same-source ranking', () => {
    it('(c) the community-flavored high scorer appears with best_score matching the raw score', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, {
            name: 'Ranking Boost', status: 'COMPLETED', endDate: new Date().toISOString(),
        });

        await createTestSubmission(gameId, { username: 'Bob', discordUserId: 'DBOB', score: 700 });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Ranking Boost', iscoredUsername: 'BobCommunity',
            submittedByUserId: 'DBOB2', score: 50000, source: 'community',
        });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/stats/game/${encodeURIComponent('Ranking Boost')}/players`);

        expect(res.status).toBe(200);
        const top = res.body[0];
        expect(top.iscored_username).toBe('BobCommunity');
        expect(top.best_score).toBe(50000);
    });

    it('(c2) multi-alias user: the BEST-score alias is reported, not the most-recent one ' +
       '(SQLite bare-column trap regression)', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        // Same canonical player (submitted_by_user_id) under two aliases: the
        // higher score is on the OLDER row under alias 'AceAlias'; the most
        // recent play is a lower score under 'LaterAlias'. The ranking row must
        // carry 'AceAlias' (best-score row), best 9000, times_played 2.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Alias Trap', iscoredUsername: 'AceAlias',
            submittedByUserId: 'DMULTI', score: 9000, source: 'community',
            createdAt: '2026-01-01 00:00:00',
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Alias Trap', iscoredUsername: 'LaterAlias',
            submittedByUserId: 'DMULTI', score: 100, source: 'community',
            createdAt: '2026-06-01 00:00:00',
        });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/stats/game/${encodeURIComponent('Alias Trap')}/players`);

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(1);
        expect(res.body[0].iscored_username).toBe('AceAlias');
        expect(res.body[0].best_score).toBe(9000);
        expect(res.body[0].times_played).toBe(2);
        expect(res.body[0].last_played).toBe('2026-06-01 00:00:00');
    });
});

describe('GET /api/rooms/:roomId/score-counts — gameNames param', () => {
    it('(d) gameNames returns counts keyed by name (HAVING > 1); gameIds still works in the same request', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Arcade Game' });

        // gameIds path: two score_history rows (game_id NULL, matched via game_name fallback
        // in the score-counts SQL) for one player -> count 2; one row for another -> absent.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Arcade Game', iscoredUsername: 'Frank', score: 10,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Arcade Game', iscoredUsername: 'Frank', score: 20,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Arcade Game', iscoredUsername: 'Gina', score: 30,
        });

        // gameNames path: a pure freeplay game with no `games` row backing it at all.
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Freeplay Game', iscoredUsername: 'Hank', score: 1,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Freeplay Game', iscoredUsername: 'Hank', score: 2,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Freeplay Game', iscoredUsername: 'Ivy', score: 3,
        });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/score-counts?gameIds=${gameId}&gameNames=${encodeURIComponent('Freeplay Game')}`);

        expect(res.status).toBe(200);
        expect(res.body.counts[gameId]['frank']).toBe(2);
        expect(res.body.counts[gameId]['gina']).toBeUndefined();
        expect(res.body.counts['Freeplay Game']['hank']).toBe(2);
        expect(res.body.counts['Freeplay Game']['ivy']).toBeUndefined();
    });

    it('(d2) gameNames alone (no gameIds) still returns counts', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();

        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Solo Freeplay', iscoredUsername: 'Jack', score: 5,
        });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Solo Freeplay', iscoredUsername: 'Jack', score: 6,
        });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/score-counts?gameNames=${encodeURIComponent('Solo Freeplay')}`);

        expect(res.status).toBe(200);
        expect(res.body.counts['Solo Freeplay']['jack']).toBe(2);
    });
});

describe('Orphaned score_history rows excluded from stats', () => {
    it('(e) an orphaned high score is excluded from allTimeHigh/allTimeHighPlayer', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, {
            name: 'Orphan Stats Game', status: 'COMPLETED', endDate: new Date().toISOString(),
        });

        await createTestSubmission(gameId, { username: 'Live', discordUserId: 'DLIVE', score: 100 });
        await insertScoreHistoryRow({
            gameRoomId: roomId, gameName: 'Orphan Stats Game', iscoredUsername: 'Ghost',
            submittedByUserId: 'DGHOST', score: 99999, source: 'community',
            orphanedAt: new Date().toISOString(),
        });

        const res = await request(app)
            .get(`/api/rooms/${roomId}/stats/game/${encodeURIComponent('Orphan Stats Game')}`);

        expect(res.status).toBe(200);
        expect(res.body.allTimeHigh).toBe(100);
        expect(res.body.allTimeHighPlayer).toBe('Live');
        expect(res.body.uniquePlayers).toBe(1);
    });
});
