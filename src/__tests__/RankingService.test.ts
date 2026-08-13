import { describe, it, expect, beforeEach } from 'vitest';
import { RankingService } from '../services/RankingService.js';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import crypto from 'crypto';

describe('RankingService', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    describe('CRUD', () => {
        it('creates, retrieves, and deletes a ranking group', async () => {
            const roomId = await createTestRoom();
            const tournamentId = await createTestTournament(roomId);
            const groupId = crypto.randomUUID();

            await RankingService.create({
                id: groupId,
                name: 'Season 1',
                rank_method: 'max_10',
                best_n: 25,
                min_games: 1,
                tournament_ids: [tournamentId],
                game_room_id: roomId,
            });

            const group = await RankingService.getById(groupId);
            expect(group).toBeTruthy();
            expect(group!.name).toBe('Season 1');
            expect(group!.rank_method).toBe('max_10');
            expect(group!.tournament_ids).toEqual([tournamentId]);

            await RankingService.delete(groupId);
            const deleted = await RankingService.getById(groupId);
            expect(deleted).toBeNull();
        });

        it('updates a ranking group and replaces tournament associations', async () => {
            const roomId = await createTestRoom();
            const t1 = await createTestTournament(roomId, { name: 'T1' });
            const t2 = await createTestTournament(roomId, { name: 'T2' });
            const groupId = crypto.randomUUID();

            await RankingService.create({
                id: groupId,
                name: 'Original',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [t1],
                game_room_id: roomId,
            });

            await RankingService.update(groupId, {
                name: 'Updated',
                rank_method: 'best_game_papa',
                best_n: 5,
                min_games: 2,
                tournament_ids: [t1, t2],
            });

            const group = await RankingService.getById(groupId);
            expect(group!.name).toBe('Updated');
            expect(group!.rank_method).toBe('best_game_papa');
            expect(group!.tournament_ids).toHaveLength(2);
        });

        it('getAll filters by room', async () => {
            const room1 = await createTestRoom('r1', 'Room 1');
            const room2 = await createTestRoom('r2', 'Room 2');

            await RankingService.create({
                id: crypto.randomUUID(),
                name: 'Group A',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [],
                game_room_id: room1,
            });
            await RankingService.create({
                id: crypto.randomUUID(),
                name: 'Group B',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [],
                game_room_id: room2,
            });

            const room1Groups = await RankingService.getAll(room1);
            expect(room1Groups).toHaveLength(1);
            expect(room1Groups[0]!.name).toBe('Group A');
        });
    });

    describe('computeRankings', () => {
        // v2.104.2 regression — the UAT ticker-empty incident. Web submissions
        // write score_history with game_id NULL (CommunityScoreService passes
        // no gameId; rotations NULL it later anyway) but full name+tournament
        // attribution. The old `sh.game_id = g.id` join silently dropped every
        // such row — masked for months because iScored-synced rows DO carry
        // game_id. The join is now name+attribution (LeaderboardService
        // doctrine); this seeds the exact web shape and must produce standings.
        it('counts web-submitted scores (NULL game_id, name+tournament attributed)', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            await createTestGame(tId, { name: 'Web Game', status: 'ACTIVE' });

            const db = await (await import('../database/database.js')).getDatabase();
            await db.run(
                `INSERT INTO score_history (
                    game_name, game_room_id, game_id, iscored_username, discord_user_id,
                    score, source, submitted_from_room_id, submitted_during_tournament_id,
                    submitted_by_user_id, engine, device
                 ) VALUES (?, ?, NULL, ?, ?, ?, 'community', ?, ?, ?, 'vpx', 'pc')`,
                'Web Game', roomId, 'WebPlayer', '111222333444555666',
                7777, roomId, tId, '111222333444555666',
            );

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Web Shape Test',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            const rankings = await RankingService.computeRankings(groupId);
            expect(rankings).toHaveLength(1);
            expect(rankings[0]!.iscored_username).toBe('WebPlayer');
            expect(rankings[0]!.games_played).toBe(1);
        });

        it('returns empty for group with no tournaments', async () => {
            const roomId = await createTestRoom();
            const groupId = crypto.randomUUID();

            await RankingService.create({
                id: groupId,
                name: 'Empty',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [],
                game_room_id: roomId,
            });

            const rankings = await RankingService.computeRankings(groupId);
            expect(rankings).toEqual([]);
        });

        it('computes max_10 rankings correctly', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const game1 = await createTestGame(tId, { name: 'Game 1', status: 'COMPLETED' });
            const game2 = await createTestGame(tId, { name: 'Game 2', status: 'COMPLETED' });

            // Game 1: Alice 1st, Bob 2nd
            await createTestSubmission(game1, { username: 'Alice', score: 9000 });
            await createTestSubmission(game1, { username: 'Bob', score: 5000 });

            // Game 2: Bob 1st, Alice 2nd
            await createTestSubmission(game2, { username: 'Bob', score: 8000 });
            await createTestSubmission(game2, { username: 'Alice', score: 4000 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Max 10 Test',
                rank_method: 'max_10',
                best_n: 25,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            const rankings = await RankingService.computeRankings(groupId);

            expect(rankings).toHaveLength(2);
            // Both have 1st (100) + 2nd (80) = 180 points
            // Order may vary since totals are equal — both should be 180
            const alice = rankings.find(r => r.iscored_username === 'Alice');
            const bob = rankings.find(r => r.iscored_username === 'Bob');
            expect(alice!.total_points).toBe(180);
            expect(bob!.total_points).toBe(180);
            expect(alice!.games_played).toBe(2);
        });

        it('computes best_game_linear rankings correctly', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const game1 = await createTestGame(tId, { name: 'Game 1', status: 'COMPLETED' });

            await createTestSubmission(game1, { username: 'First', score: 9000 });
            await createTestSubmission(game1, { username: 'Second', score: 7000 });
            await createTestSubmission(game1, { username: 'Third', score: 5000 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Linear Test',
                rank_method: 'best_game_linear',
                best_n: 25,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            const rankings = await RankingService.computeRankings(groupId);

            expect(rankings).toHaveLength(3);
            expect(rankings[0]!.iscored_username).toBe('First');
            expect(rankings[0]!.total_points).toBe(100); // 101 - 1
            expect(rankings[1]!.total_points).toBe(99);  // 101 - 2
            expect(rankings[2]!.total_points).toBe(98);  // 101 - 3
        });

        it('average_rank excludes players below min_games', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const game1 = await createTestGame(tId, { name: 'Game 1', status: 'COMPLETED' });
            const game2 = await createTestGame(tId, { name: 'Game 2', status: 'COMPLETED' });

            // Alice plays both games
            await createTestSubmission(game1, { username: 'Alice', score: 9000 });
            await createTestSubmission(game2, { username: 'Alice', score: 8000 });

            // Bob plays only one
            await createTestSubmission(game1, { username: 'Bob', score: 5000 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Avg Rank Test',
                rank_method: 'average_rank',
                best_n: 25,
                min_games: 2, // Bob won't qualify
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            const rankings = await RankingService.computeRankings(groupId);

            expect(rankings).toHaveLength(1);
            expect(rankings[0]!.iscored_username).toBe('Alice');
        });

        it('caches computed rankings', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED' });
            await createTestSubmission(gameId, { username: 'Player1', score: 1000 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Cache Test',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            await RankingService.computeRankings(groupId);

            // getRankings should use cache
            const cached = await RankingService.getRankings(groupId);
            expect(cached).toHaveLength(1);

            // Invalidate and verify cache is gone
            await RankingService.invalidate(groupId);
            const { getDatabase } = await import('../database/database.js');
            const db = await getDatabase();
            const row = await db.get('SELECT * FROM ranking_groups_cache WHERE ranking_group_id = ?', groupId);
            expect(row).toBeUndefined();
        });
    });

    // v2.31.0 (ranking-card restyle, D1) — additive `tournaments` field on
    // the group object returned by getActiveWithRankings, sourced from
    // ranking_group_tournaments + tournaments(id, name, type).
    describe('getActiveWithRankings tournaments attachment', () => {
        it('attaches id/name/type for each tournament in the group', async () => {
            const roomId = await createTestRoom();
            const t1 = await createTestTournament(roomId, { name: 'Daily Grind', type: 'DG' });
            const t2 = await createTestTournament(roomId, { name: 'Weekly VPXS', type: 'WG-VPXS' });
            const groupId = crypto.randomUUID();

            await RankingService.create({
                id: groupId,
                name: 'Season 1',
                rank_method: 'max_10',
                best_n: 25,
                min_games: 1,
                tournament_ids: [t1, t2],
                game_room_id: roomId,
            });

            const results = await RankingService.getActiveWithRankings(roomId);
            expect(results).toHaveLength(1);
            const { group } = results[0]!;
            expect(group.tournaments).toHaveLength(2);
            const names = group.tournaments.map(t => t.name).sort();
            expect(names).toEqual(['Daily Grind', 'Weekly VPXS']);
            const dg = group.tournaments.find(t => t.id === t1);
            expect(dg).toEqual({ id: t1, name: 'Daily Grind', type: 'DG' });
        });

        it('returns an empty tournaments array for a group with no tournaments', async () => {
            const roomId = await createTestRoom();
            const groupId = crypto.randomUUID();

            await RankingService.create({
                id: groupId,
                name: 'Empty Group',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [],
                game_room_id: roomId,
            });

            const results = await RankingService.getActiveWithRankings(roomId);
            expect(results).toHaveLength(1);
            expect(results[0]!.group.tournaments).toEqual([]);
        });

        it('excludes inactive groups (unchanged pre-existing filter)', async () => {
            const roomId = await createTestRoom();
            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Inactive Group',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [],
                game_room_id: roomId,
            });
            const db = (await import('../database/database.js')).getDatabase;
            const conn = await db();
            await conn.run('UPDATE ranking_groups SET is_active = 0 WHERE id = ?', groupId);

            const results = await RankingService.getActiveWithRankings(roomId);
            expect(results).toHaveLength(0);
        });
    });

    describe('cache watermark auto-invalidation', () => {
        // These tests prove the cache self-invalidates on data changes —
        // no caller needs to remember to invoke invalidate(). Each scenario
        // mutates the underlying data and verifies the next getRankings()
        // call reflects the change.

        it('reflects newly inserted scores without an explicit invalidate', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED' });
            await createTestSubmission(gameId, { username: 'Alice', score: 1000 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Watermark Insert',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            // First read populates the cache.
            const initial = await RankingService.getRankings(groupId);
            expect(initial).toHaveLength(1);
            expect(initial[0]!.iscored_username).toBe('Alice');

            // Add a new score directly — no invalidate() call.
            await createTestSubmission(gameId, { username: 'Bob', score: 2000 });

            // Next read should auto-detect the change via watermark and recompute.
            const after = await RankingService.getRankings(groupId);
            expect(after).toHaveLength(2);
            // Bob's higher score wins #1.
            expect(after[0]!.iscored_username).toBe('Bob');
            expect(after[1]!.iscored_username).toBe('Alice');
        });

        it('drops games when status flips to ARCHIVED (post-maintenance scenario)', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const game1 = await createTestGame(tId, { name: 'G1', status: 'COMPLETED' });
            const game2 = await createTestGame(tId, { name: 'G2', status: 'COMPLETED' });
            await createTestSubmission(game1, { username: 'Alice', score: 1000 });
            await createTestSubmission(game2, { username: 'Alice', score: 500 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Watermark Hide',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            const initial = await RankingService.getRankings(groupId);
            expect(initial).toHaveLength(1);
            expect(initial[0]!.breakdown).toHaveLength(2); // Both games count.

            // Simulate post-maintenance cleanup archiving game2 — no invalidate().
            const { getDatabase } = await import('../database/database.js');
            const db = await getDatabase();
            await db.run(`UPDATE games SET status = 'ARCHIVED' WHERE id = ?`, game2);

            // Watermark detects eligible_games count drop, recomputes.
            const after = await RankingService.getRankings(groupId);
            expect(after).toHaveLength(1);
            expect(after[0]!.breakdown).toHaveLength(1); // Only G1 remains.
            expect(after[0]!.breakdown[0]!.game_name).toBe('G1');
        });

        it('reflects score deletions without an explicit invalidate', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED' });
            await createTestSubmission(gameId, { username: 'Alice', score: 1000 });
            await createTestSubmission(gameId, { username: 'Bob', score: 2000 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Watermark Delete',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            const initial = await RankingService.getRankings(groupId);
            expect(initial).toHaveLength(2);

            // v2.13.12: rankings + watermark source from score_history (not
            // submissions). Per-row delete in production removes the
            // score_history row; submissions is reconciled separately. Mirror
            // that here so the watermark detects the change.
            const { getDatabase } = await import('../database/database.js');
            const db = await getDatabase();
            await db.run(
                `DELETE FROM score_history WHERE game_id = ? AND LOWER(iscored_username) = ?`,
                gameId, 'bob',
            );

            const after = await RankingService.getRankings(groupId);
            expect(after).toHaveLength(1);
            expect(after[0]!.iscored_username).toBe('Alice');
        });

        it('returns the same cached object when nothing has changed (no recompute)', async () => {
            const roomId = await createTestRoom();
            const tId = await createTestTournament(roomId);
            const gameId = await createTestGame(tId, { status: 'COMPLETED' });
            await createTestSubmission(gameId, { username: 'Alice', score: 1000 });

            const groupId = crypto.randomUUID();
            await RankingService.create({
                id: groupId,
                name: 'Watermark Stable',
                rank_method: 'max_10',
                best_n: 10,
                min_games: 1,
                tournament_ids: [tId],
                game_room_id: roomId,
            });

            await RankingService.getRankings(groupId);

            // Capture cache.generated_at — if a recompute happens, it bumps.
            const { getDatabase } = await import('../database/database.js');
            const db = await getDatabase();
            const before = await db.get<{ generated_at: string }>(
                'SELECT generated_at FROM ranking_groups_cache WHERE ranking_group_id = ?',
                groupId,
            );

            // Wait briefly so a real recompute would land a different timestamp.
            await new Promise(resolve => setTimeout(resolve, 30));

            await RankingService.getRankings(groupId);

            const after = await db.get<{ generated_at: string }>(
                'SELECT generated_at FROM ranking_groups_cache WHERE ranking_group_id = ?',
                groupId,
            );

            // No data changes → watermark matches → cache untouched.
            expect(after?.generated_at).toBe(before?.generated_at);
        });
    });
});
