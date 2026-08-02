import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
    setupTestDb, createTestRoom, createTestTournament, createTestGame,
} from './helpers.js';
import { getDatabase } from '../database/database.js';
import { AchievementService } from '../services/AchievementService.js';

/**
 * S13 trophy case (WP2) — AchievementService + StatsService.getEnhancedPlayerStats*
 * personalBests/achievements extension.
 *
 * Bootstrap pattern copied verbatim from room-scores.test.ts: mount rooms.ts at
 * /api/rooms against a fresh setupTestDb() per test (setup.ts's global
 * beforeEach already calls _resetForTesting(), so each `it()` gets its own
 * in-memory database).
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
 * Migration 108 (`108_player_achievements`, see database.ts) already runs
 * against an empty `submissions`/`games` table as part of every
 * setupTestDb() call, so it backfills 0 rows at that point. There's no
 * exported migration runner and the module-level `db` singleton can't be
 * closed/reopened without losing the `:memory:` data (see database.ts's
 * `_resetForTesting`), so this test exercises the exact backfill SQL (copied
 * verbatim from database.ts) directly against a seeded DB — the only way to
 * observe it acting on pre-existing rows.
 */
const TOP_WINNERS_CTE = `
    WITH ranked AS (
        SELECT
            s.game_id AS game_id,
            s.iscored_username AS iscored_username,
            s.discord_user_id AS discord_user_id,
            s.score AS score,
            g.name AS game_name,
            g.tournament_id AS tournament_id,
            g.end_date AS end_date,
            t.game_room_id AS game_room_id,
            ROW_NUMBER() OVER (PARTITION BY s.game_id ORDER BY s.score DESC) AS rn
        FROM submissions s
        JOIN games g ON g.id = s.game_id
        JOIN tournaments t ON t.id = g.tournament_id
        WHERE s.orphaned_at IS NULL
          AND g.status = 'COMPLETED'
          AND g.tournament_id IS NOT NULL
    )
    SELECT * FROM ranked WHERE rn = 1
`;

const BACKFILL_108_SQL = `
    INSERT OR IGNORE INTO player_achievements
        (game_room_id, discord_user_id, iscored_username, type, game_name, game_id, tournament_id, earned_at, metadata)
    SELECT
        game_room_id, discord_user_id, iscored_username, 'tournament_win', game_name, game_id, tournament_id,
        COALESCE(end_date, datetime('now')), json_object('score', score)
    FROM (${TOP_WINNERS_CTE})
`;

async function insertSubmission(opts: {
    gameId: string;
    discordUserId: string;
    username: string;
    score: number;
    submittedByUserId?: string | null;
}) {
    const db = await getDatabase();
    const id = `${opts.gameId}-${opts.username.toLowerCase()}`;
    await db.run(
        `INSERT INTO submissions (id, game_id, discord_user_id, iscored_username, score, timestamp, submitted_by_user_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, opts.gameId, opts.discordUserId, opts.username, opts.score, new Date().toISOString(),
        opts.submittedByUserId ?? null,
    );
    // v2.74.0 (S24.5): dual-write to score_history, which every production
    // submit path does (CommunityScoreService / the tournament submit handlers
    // / the poller all write BOTH tables). This fixture wrote `submissions`
    // only, so it stopped resembling production the moment a reader moved to
    // the event log — which `StatsService.getPersonalBests` now has, per the
    // S24.5 doctrine fix. Mirrors `helpers.ts createTestSubmission`.
    const game = await db.get<{ name: string; tournament_id: string | null }>(
        'SELECT name, tournament_id FROM games WHERE id = ?', opts.gameId,
    );
    if (game) {
        const tournament = game.tournament_id
            ? await db.get<{ game_room_id: string | null }>(
                'SELECT game_room_id FROM tournaments WHERE id = ?', game.tournament_id)
            : null;
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id,
                submitted_by_user_id, score, source, submitted_from_room_id,
                submitted_during_tournament_id
             ) VALUES (?, ?, ?, ?, ?, ?, ?, 'tournament', ?, ?)`,
            game.name, tournament?.game_room_id ?? null, opts.gameId,
            opts.username, opts.discordUserId, opts.submittedByUserId ?? null, opts.score,
            tournament?.game_room_id ?? null, game.tournament_id,
        );
    }
    return id;
}

describe('migration 108 backfill (tournament_win from COMPLETED games)', () => {
    it('backfills exactly one tournament_win row for the top scorer, idempotent on re-run', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Backfill Game', status: 'COMPLETED' });

        await insertSubmission({ gameId, discordUserId: 'DWINNER', username: 'Winner', score: 900 });
        await insertSubmission({ gameId, discordUserId: 'DLOSER', username: 'Loser', score: 500 });

        await db.run(BACKFILL_108_SQL);

        const rows = await db.all(
            `SELECT * FROM player_achievements WHERE game_id = ? AND type = 'tournament_win'`, gameId,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].discord_user_id).toBe('DWINNER');
        expect(rows[0].iscored_username).toBe('Winner');

        await db.run(BACKFILL_108_SQL); // Re-run: must insert 0 additional rows.

        const rowsAfter = await db.all(
            `SELECT * FROM player_achievements WHERE game_id = ? AND type = 'tournament_win'`, gameId,
        );
        expect(rowsAfter).toHaveLength(1);
    });
});

describe('AchievementService.award', () => {
    it('dedups tournament_win by game_id (partial unique index); milestone/room_record are not deduped', async () => {
        await setupTestDb();
        const db = await getDatabase();
        const roomId = await createTestRoom();

        await AchievementService.award({
            gameRoomId: roomId, discordUserId: 'DALICE', iscoredUsername: 'Alice',
            type: 'tournament_win', gameName: 'Some Game', gameId: 'game-1', tournamentId: 'tourney-1',
            metadata: { score: 100 },
        });
        await AchievementService.award({
            gameRoomId: roomId, discordUserId: 'DALICE', iscoredUsername: 'Alice',
            type: 'tournament_win', gameName: 'Some Game', gameId: 'game-1', tournamentId: 'tourney-1',
            metadata: { score: 100 },
        });

        const winRows = await db.all(`SELECT * FROM player_achievements WHERE type = 'tournament_win' AND game_id = 'game-1'`);
        expect(winRows).toHaveLength(1);

        await AchievementService.award({
            gameRoomId: roomId, discordUserId: 'DALICE', iscoredUsername: 'Alice',
            type: 'milestone', metadata: { scope: 'games_played', threshold: 10 },
        });
        await AchievementService.award({
            gameRoomId: roomId, discordUserId: 'DALICE', iscoredUsername: 'Alice',
            type: 'milestone', metadata: { scope: 'games_played', threshold: 10 },
        });

        const milestoneRows = await db.all(`SELECT * FROM player_achievements WHERE type = 'milestone' AND discord_user_id = 'DALICE'`);
        expect(milestoneRows).toHaveLength(2);

        await AchievementService.award({
            gameRoomId: roomId, discordUserId: 'DALICE', iscoredUsername: 'Alice',
            type: 'room_record', gameName: 'Some Game', metadata: { score: 999 },
        });
        await AchievementService.award({
            gameRoomId: roomId, discordUserId: 'DALICE', iscoredUsername: 'Alice',
            type: 'room_record', gameName: 'Some Game', metadata: { score: 999 },
        });

        const recordRows = await db.all(`SELECT * FROM player_achievements WHERE type = 'room_record' AND discord_user_id = 'DALICE'`);
        expect(recordRows).toHaveLength(2);
    });
});

describe('AchievementService.getForPlayer', () => {
    it('matches by discord id OR username case-insensitively, counts per type, parses metadata', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();

        for (let i = 0; i < 3; i++) {
            await AchievementService.award({
                gameRoomId: roomId, discordUserId: 'DBOB', iscoredUsername: 'Bobby',
                type: 'tournament_win', gameName: `Game ${i}`, gameId: `game-${i}`, metadata: { score: 100 + i },
            });
        }
        for (let i = 0; i < 2; i++) {
            await AchievementService.award({
                gameRoomId: roomId, discordUserId: 'DBOB', iscoredUsername: 'Bobby',
                type: 'milestone', metadata: { scope: 'games_played', threshold: 5 + i },
            });
        }
        await AchievementService.award({
            gameRoomId: roomId, discordUserId: 'DBOB', iscoredUsername: 'Bobby',
            type: 'room_record', gameName: 'Record Game', metadata: { score: 5000 },
        });

        // Match via discordUserId.
        const byId = await AchievementService.getForPlayer(roomId, { discordUserId: 'DBOB', username: 'nonexistent' });
        expect(byId.tournamentWins).toBe(3);
        expect(byId.milestones).toBe(2);
        expect(byId.roomRecords).toBe(1);
        expect(byId.recent.length).toBe(6);
        const roomRecordEntry = byId.recent.find((r) => r.type === 'room_record');
        expect(roomRecordEntry?.metadata).toEqual({ score: 5000 });

        // Match via username only, case-insensitive, no discordUserId supplied.
        const byUsername = await AchievementService.getForPlayer(roomId, { username: 'BOBBY' });
        expect(byUsername.tournamentWins).toBe(3);
        expect(byUsername.milestones).toBe(2);
        expect(byUsername.roomRecords).toBe(1);
    });

    it('caps recent at 10 when more than 10 achievements exist', async () => {
        await setupTestDb();
        const roomId = await createTestRoom();
        for (let i = 0; i < 12; i++) {
            await AchievementService.award({
                gameRoomId: roomId, discordUserId: 'DCAROL', iscoredUsername: 'Carol',
                type: 'tournament_win', gameName: `Game ${i}`, gameId: `game-c-${i}`, metadata: { score: i },
            });
        }
        const summary = await AchievementService.getForPlayer(roomId, { discordUserId: 'DCAROL', username: 'Carol' });
        expect(summary.tournamentWins).toBe(12);
        expect(summary.recent.length).toBe(10);
    });
});

describe('GET /api/rooms/:roomId/stats/enhanced/player/:identifier — achievements + personalBests', () => {
    it('response includes achievements and personalBests with correct room_rank/total_players for a 2-player game', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom();
        const tId = await createTestTournament(roomId);
        const gameId = await createTestGame(tId, { name: 'Two Player Game' });

        const discordId1 = '111111111111111111'; // 18 digits — matches the route's discord-id regex.
        const discordId2 = '222222222222222222';

        await insertSubmission({
            gameId, discordUserId: discordId1, username: 'PlayerOne', score: 5000, submittedByUserId: discordId1,
        });
        await insertSubmission({
            gameId, discordUserId: discordId2, username: 'PlayerTwo', score: 3000, submittedByUserId: discordId2,
        });

        const res = await request(app).get(`/api/rooms/${roomId}/stats/enhanced/player/${discordId1}`);

        expect(res.status).toBe(200);
        expect(res.body.achievements).toEqual({ tournamentWins: 0, milestones: 0, roomRecords: 0, recent: [] });

        expect(res.body.personalBests).toHaveLength(1);
        const best = res.body.personalBests[0];
        expect(best.game_name).toBe('Two Player Game');
        expect(best.best_score).toBe(5000);
        expect(best.room_rank).toBe(1);
        expect(best.total_players).toBe(2);
        expect(best.achieved_at).toBeTruthy();
    });
});
