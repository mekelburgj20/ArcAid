import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalLeaderboardService } from '../services/GlobalLeaderboardService.js';

/**
 * scores-page-redesign (WP4) — B3 `hasScores` bound on the global catalogue
 * lens. Bootstrap pattern copied from api-auth.test.ts, which is the existing
 * suite that mounts global.ts (note: global.ts's own routes are declared
 * WITHOUT a '/global' prefix on the router itself — the route is
 * `router.get('/global/scoreboard', ...)` — so it's mounted at bare '/api',
 * not '/api/global'; setup.ts's global beforeEach resets the DB before each
 * `it()`).
 */
async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);

    return app;
}

async function seedZeroAndScoredGame() {
    const db = await getDatabase();
    const zeroId = crypto.randomUUID();
    const scoredId = crypto.randomUUID();

    await db.run(
        `INSERT INTO global_games (id, name, type, status) VALUES (?, 'Zero Score Game', 'pinball', 'approved')`,
        zeroId,
    );
    await db.run(
        `INSERT INTO global_games (id, name, type, status) VALUES (?, 'Scored Game', 'pinball', 'approved')`,
        scoredId,
    );
    await db.run(
        `INSERT INTO global_scores (id, global_game_id, player_id, iscored_username, score, origin_type)
         VALUES (?, ?, 'PLAYER1', 'Player1', 1000, 'global')`,
        crypto.randomUUID(), scoredId,
    );

    return { zeroId, scoredId };
}

describe('GlobalLeaderboardService.getTopGames hasScores', () => {
    it('(a) includes zero-score catalogue games by default; excludes them + adjusts total when hasScores=true', async () => {
        await setupTestDb();
        const { zeroId, scoredId } = await seedZeroAndScoredGame();

        const withoutFlag = await GlobalLeaderboardService.getTopGames({ scope: 'global' });
        expect(withoutFlag.data.some(g => g.global_game_id === zeroId)).toBe(true);
        expect(withoutFlag.data.some(g => g.global_game_id === scoredId)).toBe(true);
        expect(withoutFlag.total).toBe(2);

        const withFlag = await GlobalLeaderboardService.getTopGames({ scope: 'global', hasScores: true });
        expect(withFlag.data.some(g => g.global_game_id === zeroId)).toBe(false);
        expect(withFlag.data.some(g => g.global_game_id === scoredId)).toBe(true);
        expect(withFlag.data.every(g => g.score_count > 0)).toBe(true);
        expect(withFlag.total).toBe(1);
    });
});

describe('GET /api/global/scoreboard hasScores', () => {
    it('(b) hasScores=1 returns only scored games; standalone /scoreboard (no flag) is unchanged', async () => {
        const app = await createTestApp();
        await seedZeroAndScoredGame();

        const withFlag = await request(app).get('/api/global/scoreboard?scope=global&hasScores=1');
        expect(withFlag.status).toBe(200);
        expect(withFlag.body.data.length).toBeGreaterThan(0);
        expect(withFlag.body.data.every((g: any) => g.score_count > 0)).toBe(true);
        expect(withFlag.body.data.some((g: any) => g.name === 'Zero Score Game')).toBe(false);

        // Regression guard: standalone /scoreboard never sends hasScores —
        // behavior must stay byte-identical (zero-score games still appear).
        const withoutFlag = await request(app).get('/api/global/scoreboard?scope=global');
        expect(withoutFlag.status).toBe(200);
        expect(withoutFlag.body.data.some((g: any) => g.name === 'Zero Score Game')).toBe(true);
        expect(withoutFlag.body.data.some((g: any) => g.name === 'Scored Game')).toBe(true);
    });
});
