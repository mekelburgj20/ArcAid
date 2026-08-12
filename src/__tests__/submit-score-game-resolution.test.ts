import { describe, it, expect } from 'vitest';
import express from 'express';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { signToken } from '../api/auth.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

/**
 * v2.100.3 — submit-score's `submissions`-upsert game resolution must prefer
 * the ACTIVE row when one name matches multiple games rows.
 *
 * Games RERUN after cooldown (Daily Grind's 120d window is the design), so a
 * room accumulates COMPLETED rows sharing a name with a later ACTIVE run.
 * Pre-fix, the resolution query was `status IN ('ACTIVE','COMPLETED') LIMIT 1`
 * with NO ORDER BY — which row wins is then UNDEFINED by SQLite's contract
 * and owned by the query planner. Landing the submissions upsert (which
 * winner resolution reads at rotation) on a long-finished game would be
 * invisible on every leaderboard (they read score_history, whose tournament
 * auto-resolve is ACTIVE-only) and only surface as a wrong winner. Same bug
 * class as the WHO-dunnit duplicate-DM incident; same fix shape as
 * ScoreSyncPoller's status-preference ORDER BY.
 *
 * Honesty note: in THIS fixture the pre-fix query happened to visit the
 * ACTIVE row first (plan-dependent), so this test did not fail pre-fix. It
 * pins the now-EXPLICIT ordering contract — ACTIVE first, newest COMPLETED
 * as fallback — so the semantic survives planner/schema changes rather than
 * riding on accidental visit order.
 */

async function playerToken(discordId: string, username: string, roomId: string) {
    return signToken({ role: 'player', gameRoomIds: [roomId], discordId, username });
}

async function seedCatalogueGame(name: string) {
    await GlobalGameService.upsert({
        name,
        type: 'pinball',
        platforms: ['real'],
        source: 'manual',
        status: 'approved',
    } as Parameters<typeof GlobalGameService.upsert>[0]);
}

describe('submit-score game resolution — ACTIVE row wins over same-name COMPLETED rows', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    it('lands the submissions row on the ACTIVE game, not the older COMPLETED one', async () => {
        const request = (await import('supertest')).default;
        const app = await createTestApp();
        const roomId = await createTestRoom('rerun-room', 'Rerun Room');
        const tournamentId = await createTestTournament(roomId, { name: 'Rerun DG' });
        const gameName = 'Rerun Game';
        await seedCatalogueGame(gameName);

        // COMPLETED row FIRST (lower rowid — the row the pre-fix scan-order
        // query returned), then the current ACTIVE run of the same name.
        const completedId = await createTestGame(tournamentId, { name: gameName, status: 'COMPLETED' });
        const activeId = await createTestGame(tournamentId, { name: gameName, status: 'ACTIVE' });

        const token = await playerToken('rerun-player-1', 'RerunPlayer', roomId);
        const res = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '5000')
            .field('engine', 'real')
            .field('device', 'real_cabinet');

        expect(res.status).toBe(201);

        const db = await getDatabase();
        const onActive = await db.get(
            `SELECT id, score FROM submissions WHERE game_id = ?`, activeId,
        );
        const onCompleted = await db.get(
            `SELECT id FROM submissions WHERE game_id = ?`, completedId,
        );
        expect(onActive).toBeTruthy();
        expect(onActive.score).toBe(5000);
        expect(onCompleted).toBeUndefined();

        // The history row (tournament-leaderboard source of truth) carries the
        // tournament attribution via its own ACTIVE-only auto-resolve.
        const history = await db.get(
            `SELECT submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?)`,
            roomId, gameName,
        );
        expect(history.submitted_during_tournament_id).toBe(tournamentId);
    });
});
