import { describe, it, expect, beforeEach } from 'vitest';
import { LeaderboardService } from '../services/LeaderboardService.js';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';

describe('LeaderboardService', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    describe('recalculate', () => {
        it('returns empty rankings for a game with no submissions', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId);

            const rankings = await LeaderboardService.recalculate(gameId);
            expect(rankings).toEqual([]);
        });

        it('ranks players by highest score descending', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId);

            await createTestSubmission(gameId, { username: 'Alice', score: 5000 });
            await createTestSubmission(gameId, { username: 'Bob', score: 8000 });
            await createTestSubmission(gameId, { username: 'Charlie', score: 3000 });

            const rankings = await LeaderboardService.recalculate(gameId);

            expect(rankings).toHaveLength(3);
            expect(rankings[0]!.iscored_username).toBe('Bob');
            expect(rankings[0]!.score).toBe(8000);
            expect(rankings[0]!.rank).toBe(1);
            expect(rankings[1]!.iscored_username).toBe('Alice');
            expect(rankings[1]!.rank).toBe(2);
            expect(rankings[2]!.iscored_username).toBe('Charlie');
            expect(rankings[2]!.rank).toBe(3);
        });

        it('groups by case-insensitive username and takes best score', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId);

            // Same player, different case — v2.1.0 leaderboard reads score_history,
            // so both submissions go through the helper (which dual-writes).
            await createTestSubmission(gameId, { username: 'Alice', score: 5000, discordUserId: '123' });
            await createTestSubmission(gameId, { username: 'ALICE', score: 9000, discordUserId: '123' });

            const rankings = await LeaderboardService.recalculate(gameId);

            expect(rankings).toHaveLength(1);
            expect(rankings[0]!.score).toBe(9000); // Takes highest
        });

        it('caches the result in leaderboard_cache', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId);
            await createTestSubmission(gameId, { username: 'Player1', score: 1000 });

            await LeaderboardService.recalculate(gameId);

            const { getDatabase } = await import('../database/database.js');
            const db = await getDatabase();
            const cached = await db.get('SELECT * FROM leaderboard_cache WHERE game_id = ?', gameId);
            expect(cached).toBeTruthy();
            // v2.74.0 (S24.1): the blob is a `{v, rows}` envelope, not a bare
            // array. The rows are identity-stable — names and avatars are
            // joined on at read time — so the cache survives a profile edit.
            // See src/__tests__/s24-efficiency.test.ts for that contract.
            // v2.108.0 bumped the envelope to v3 (history_id + source);
            // v2.109.0 bumped it again to v4 (photo_url).
            const parsed = JSON.parse(cached.rankings);
            expect(parsed.v).toBe(4);
            expect(parsed.rows).toHaveLength(1);
        });
    });

    describe('getForGame', () => {
        it('returns cached rankings without recalculating', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId);
            await createTestSubmission(gameId, { username: 'Player1', score: 1000 });

            // Recalculate to populate cache
            await LeaderboardService.recalculate(gameId);

            // Get from cache
            const rankings = await LeaderboardService.getForGame(gameId);
            expect(rankings).toHaveLength(1);
            expect(rankings[0]!.iscored_username).toBe('Player1');
        });

        it('recalculates if no cache exists', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId);
            await createTestSubmission(gameId, { username: 'Player1', score: 1000 });

            const rankings = await LeaderboardService.getForGame(gameId);
            expect(rankings).toHaveLength(1);
        });
    });

    describe('invalidate', () => {
        it('removes cache for a specific game', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId);
            await createTestSubmission(gameId, { username: 'Player1', score: 1000 });
            await LeaderboardService.recalculate(gameId);

            await LeaderboardService.invalidate(gameId);

            const { getDatabase } = await import('../database/database.js');
            const db = await getDatabase();
            const cached = await db.get('SELECT * FROM leaderboard_cache WHERE game_id = ?', gameId);
            expect(cached).toBeUndefined();
        });
    });

    describe('getActiveLeaderboards', () => {
        it('returns leaderboards for active games in a room', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const gameId = await createTestGame(tournamentId, { name: 'Medieval Madness' });
            await createTestSubmission(gameId, { username: 'Player1', score: 5000 });

            const leaderboards = await LeaderboardService.getActiveLeaderboards(roomId);

            expect(leaderboards).toHaveLength(1);
            expect(leaderboards[0]!.gameName).toBe('Medieval Madness');
            expect(leaderboards[0]!.rankings).toHaveLength(1);
        });

        it('returns empty array when no active games', async () => {
            const roomId = await createTestRoom();
            const leaderboards = await LeaderboardService.getActiveLeaderboards(roomId);
            expect(leaderboards).toEqual([]);
        });
    });
});
