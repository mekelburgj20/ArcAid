import { describe, it, expect } from 'vitest';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from '../services/ScoreHistoryService.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { signToken } from '../api/auth.js';
import request from 'supertest';
import express from 'express';

/**
 * v2.155.3 — the history dedup key now includes `submitted_during_tournament_id`.
 *
 * Production incident, 2026-09-06 19:17 UTC: with Black Rose ACTIVE in both
 * Weekly Grind - VR and Daily Grind, the owner submitted 945,436,670 on the
 * Daily Grind card, then the SAME score on the WG-VR card 26 seconds later.
 * `ScoreHistoryService.isDuplicate` matched on (room, name, user, score) and
 * never looked at the tournament stamp, so the second submit's history row
 * was silently swallowed — WG-VR's leaderboard (which reads `score_history`
 * filtered by ITS tournament id) never saw it, even though its `submissions`
 * row (already resolver-correct since v2.155.1/v2.155.2) landed fine.
 *
 * Design ruling: one play may be submitted to EACH tournament currently
 * running the table — the SAME score in a DIFFERENT tournament is a distinct
 * score event. The SAME score into the SAME tournament is still a re-send
 * and must still be dropped.
 */

describe('ScoreHistoryService.log — tournament-scoped dedup', () => {
    it('the same score submitted to two DIFFERENT tournaments writes two rows', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('dedup-diff-tourn', 'Dedup Diff Tourn');
        const gameName = 'Black Rose';

        const id1 = await ScoreHistoryService.log({
            gameName, gameRoomId: roomId, username: 'Player1', score: 945436670,
            source: 'community', tournamentId: 'tourn-a',
        });
        const id2 = await ScoreHistoryService.log({
            gameName, gameRoomId: roomId, username: 'Player1', score: 945436670,
            source: 'community', tournamentId: 'tourn-b',
        });

        expect(id1).not.toBeNull();
        expect(id2).not.toBeNull();
        expect(id1).not.toBe(id2);

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 945436670`,
            roomId, gameName,
        );
        expect(rows.length).toBe(2);
        expect(rows.map((r: any) => r.submitted_during_tournament_id).sort()).toEqual(['tourn-a', 'tourn-b']);
    });

    it('the SAME score submitted to the SAME tournament twice writes only one row (a re-send)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('dedup-same-tourn', 'Dedup Same Tourn');
        const gameName = 'Black Rose';

        const id1 = await ScoreHistoryService.log({
            gameName, gameRoomId: roomId, username: 'Player1', score: 945436670,
            source: 'community', tournamentId: 'tourn-a',
        });
        const id2 = await ScoreHistoryService.log({
            gameName, gameRoomId: roomId, username: 'Player1', score: 945436670,
            source: 'community', tournamentId: 'tourn-a',
        });

        expect(id1).not.toBeNull();
        expect(id2).toBeNull();

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT id FROM score_history WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 945436670`,
            roomId, gameName,
        );
        expect(rows.length).toBe(1);
    });

    it('tournamentId: null submitted twice still dedupes — null is a real, constrained value, not "unconstrained"', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('dedup-null-tourn', 'Dedup Null Tourn');
        const gameName = 'Solo Pin';

        const id1 = await ScoreHistoryService.log({
            gameName, gameRoomId: roomId, username: 'Player1', score: 8000,
            source: 'community', tournamentId: null, skipTournamentLink: true,
        });
        const id2 = await ScoreHistoryService.log({
            gameName, gameRoomId: roomId, username: 'Player1', score: 8000,
            source: 'community', tournamentId: null, skipTournamentLink: true,
        });

        expect(id1).not.toBeNull();
        expect(id2).toBeNull();

        const db = await getDatabase();
        const rows = await db.all(
            `SELECT id, submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 8000`,
            roomId, gameName,
        );
        expect(rows.length).toBe(1);
        expect(rows[0].submitted_during_tournament_id).toBeNull();
    });
});

describe('ScoreHistoryService.isDuplicate — the undefined/null distinction', () => {
    it('undefined tournamentId does not constrain (matches the pre-v2.155.3 shape for callers that omit it)', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('dedup-undefined', 'Dedup Undefined');
        await ScoreHistoryService.log({
            gameName: 'Black Rose', gameRoomId: roomId, username: 'Player1', score: 5000,
            source: 'community', tournamentId: 'tourn-a',
        });

        // No tournamentId key at all -> undefined -> "don't constrain" -> the
        // tourn-a row already satisfies (room, name, user, score) regardless
        // of its tournament stamp.
        const dup = await ScoreHistoryService.isDuplicate({
            gameName: 'Black Rose', gameRoomId: roomId, username: 'Player1', score: 5000,
        });
        expect(dup).toBe(true);
    });

    it('an explicit different tournamentId does NOT match an existing row stamped with another tournament', async () => {
        await setupTestDb();
        const roomId = await createTestRoom('dedup-explicit-diff', 'Dedup Explicit Diff');
        await ScoreHistoryService.log({
            gameName: 'Black Rose', gameRoomId: roomId, username: 'Player1', score: 5000,
            source: 'community', tournamentId: 'tourn-a',
        });

        const dup = await ScoreHistoryService.isDuplicate({
            gameName: 'Black Rose', gameRoomId: roomId, username: 'Player1', score: 5000,
            tournamentId: 'tourn-b',
        });
        expect(dup).toBe(false);
    });
});

describe('end-to-end through submit-score — the same score on two ACTIVE games with the same name', () => {
    async function createTestApp() {
        await setupTestDb();
        const app = express();
        app.use(express.json());
        const { default: roomsRouter } = await import('../api/routes/rooms.js');
        app.use('/api/rooms', roomsRouter);
        return app;
    }

    function playerToken(discordId: string, username: string, roomId: string) {
        return signToken({ role: 'player', gameRoomIds: [roomId], discordId, username });
    }

    it('lands on BOTH boards — the second submit is a distinct score event, not a duplicate', async () => {
        const app = await createTestApp();
        const roomId = await createTestRoom('dedup-e2e', 'Dedup E2E');
        const gameName = 'Black Rose';

        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, status) VALUES (?, ?, 'pinball', '["real"]', 'approved')`,
            'gg-dedup-e2e', gameName,
        );

        const tournamentA = await createTestTournament(roomId, { name: 'Weekly Grind - VR' });
        const tournamentB = await createTestTournament(roomId, { name: 'Daily Grind' });
        const gameA = await createTestGame(tournamentA, { name: gameName, status: 'ACTIVE', startDate: '2026-09-03T00:00:00.000Z' });
        const gameB = await createTestGame(tournamentB, { name: gameName, status: 'ACTIVE', startDate: '2026-09-06T19:17:00.000Z' });

        const token = playerToken('dedup-owner', 'DedupOwner', roomId);

        const resB = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '945436670')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .field('gameId', gameB);
        expect(resB.status).toBe(201);

        const resA = await request(app)
            .post(`/api/rooms/${roomId}/submit-score/${encodeURIComponent(gameName)}`)
            .set('Authorization', `Bearer ${token}`)
            .field('score', '945436670')
            .field('engine', 'real')
            .field('device', 'real_cabinet')
            .field('gameId', gameA);
        expect(resA.status).toBe(201);

        const history = await db.all(
            `SELECT submitted_during_tournament_id FROM score_history
             WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND score = 945436670`,
            roomId, gameName,
        );
        expect(history.length).toBe(2);
        expect(history.map((r: any) => r.submitted_during_tournament_id).sort()).toEqual([tournamentA, tournamentB].sort());

        const rankingsA = await LeaderboardService.getForGame(gameA);
        const rankingsB = await LeaderboardService.getForGame(gameB);
        expect(rankingsA.some(r => r.score === 945436670)).toBe(true);
        expect(rankingsB.some(r => r.score === 945436670)).toBe(true);
    });
});
