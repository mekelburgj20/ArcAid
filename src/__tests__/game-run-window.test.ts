import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { ScoreRankService } from '../services/ScoreRankService.js';
import { RankingService } from '../services/RankingService.js';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame } from './helpers.js';

/**
 * v2.172.0 — a table that comes back round in the SAME tournament must open
 * with an empty card. Reproduces rtx_pinball Daily Grind / WHO dunnit: ran
 * 2026-08-22 03:00Z → 2026-08-23 03:00Z, ran again from 2026-10-25 03:00Z, and
 * the new card showed the August scores (web rows carry no game_id, so the
 * (room, tournament, name) key alone could not tell the runs apart).
 */
describe('game run window — a re-run table does not inherit the previous run', () => {
    let roomId: string;
    let tournamentId: string;
    let oldRun: string;
    let newRun: string;

    async function logScore(name: string, userId: string, score: number, createdAt: string) {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO score_history (
                game_name, game_room_id, game_id, iscored_username, discord_user_id, score, source,
                submitted_from_room_id, submitted_during_tournament_id, submitted_by_user_id,
                engine, device, created_at
             ) VALUES ('WHO dunnit', ?, NULL, ?, ?, ?, 'community', ?, ?, ?, 'vpx', 'pc', ?)`,
            roomId, name, userId, score, roomId, tournamentId, userId, createdAt,
        );
    }

    beforeEach(async () => {
        await setupTestDb();
        roomId = await createTestRoom();
        tournamentId = await createTestTournament(roomId);
        oldRun = await createTestGame(tournamentId, {
            name: 'WHO dunnit', status: 'COMPLETED',
            startDate: '2026-08-22T03:00:09.068Z', endDate: '2026-08-23T03:00:05.193Z',
        });
        newRun = await createTestGame(tournamentId, {
            name: 'WHO dunnit', status: 'ACTIVE', startDate: '2026-10-25T03:00:00.789Z',
        });

        // Previous run.
        await logScore('mekelburgj', '698435672586846228', 10_925_984_270, '2026-08-23 02:14:26');
        await logScore('DirtySocks', '904597467973189694', 10_659_290_060, '2026-08-22 22:23:20');
        // Logged after the old run ended but before the new one began (an
        // iScored final sync, a late cabinet report) — still the old run's.
        await logScore('LateSync', '111111111111111111', 1_000, '2026-08-23 03:05:00');
        // This run. The first sits in the whole-second gap before start_date's
        // milliseconds, which the grace exists for.
        await logScore('EarlyBird', '222222222222222222', 500, '2026-10-25 03:00:00');
        await logScore('Zelnar', '164530869535637505', 6_512_345_230, '2026-10-25 18:40:08');
        await logScore('Benjamin Cohen', '975481387396243586', 2_359_270_810, '2026-10-25 16:38:00');
    });

    it('the new run\'s card holds only this run\'s scores', async () => {
        const board = await LeaderboardService.recalculate(newRun);
        expect(board.map(r => r.iscored_username)).toEqual(['Zelnar', 'Benjamin Cohen', 'EarlyBird']);
    });

    it('the old run\'s card keeps its own scores and gains none of the new run\'s', async () => {
        const board = await LeaderboardService.recalculate(oldRun);
        expect(board.map(r => r.iscored_username)).toEqual(['mekelburgj', 'DirtySocks', 'LateSync']);
    });

    it('the platform tabs read the same run', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE score_history SET engine = 'fx' WHERE iscored_username = 'mekelburgj'`);
        const tabs = await LeaderboardService.getDistinctProvenance(newRun);
        expect(tabs.engines).toEqual(['vpx']);
    });

    it('the submit-moment rank card ranks against this run only', async () => {
        const res = await ScoreRankService.computeRoomRank({
            gameRoomId: roomId,
            gameName: 'WHO dunnit',
            partitionKey: '333333333333333333',
            submittedScore: 3_000_000_000,
            tournamentId,
        });
        // Behind Zelnar only — not behind mekelburgj/DirtySocks from August.
        expect(res.rank).toBe(2);
        expect(res.totalPlayers).toBe(4);
    });

    it('ranking points score each run off its own scores', async () => {
        const groupId = crypto.randomUUID();
        await RankingService.create({
            id: groupId, name: 'DG', rank_method: 'max_10', best_n: 10, min_games: 1,
            tournament_ids: [tournamentId], game_room_id: roomId,
        });
        const rankings = await RankingService.computeRankings(groupId);
        const played = Object.fromEntries(rankings.map(r => [r.iscored_username, r.games_played]));
        // Pre-fix, every player matched BOTH runs and was credited twice.
        expect(played['mekelburgj']).toBe(1);
        expect(played['Zelnar']).toBe(1);
    });

    it('a game with no start_date keeps the unbounded window', async () => {
        const db = await getDatabase();
        await db.run(`UPDATE games SET start_date = NULL WHERE id = ?`, oldRun);
        await db.run(`UPDATE games SET start_date = NULL WHERE id = ?`, newRun);
        const board = await LeaderboardService.recalculate(newRun);
        expect(board).toHaveLength(6);
    });
});
