import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { RankingService, assignCompetitionRanks } from '../services/RankingService.js';

/**
 * B30 (v2.254.0) — overall standings place tied totals TOGETHER.
 *
 * GamerDad89 (Mox, 2026-11-20): two players on 92 season points were shown
 * 3rd and 4th. Overall places are now competition ranks (1, 2, 3, 3, 5), the
 * same rule the per-game placement has used since migration 181, and a cache
 * written before the change is re-ranked on read (a finished season's data
 * never changes, so its cache would otherwise keep the old places forever).
 */

beforeEach(async () => {
    await setupTestDb();
});

async function seasonLikeGroup() {
    const roomId = await createTestRoom(`ties-${crypto.randomUUID().slice(0, 8)}`, 'Ties Room');
    const tournamentId = await createTestTournament(roomId, { name: 'Season' });
    const groupId = crypto.randomUUID();
    await RankingService.create({
        id: groupId,
        name: 'Season — Season',
        rank_method: 'best_game_linear',
        best_n: 10,
        min_games: 1,
        tournament_ids: [tournamentId],
        game_room_id: roomId,
        points_top: 50,
        include_archived: true,
    });
    // Week 1: Alice 50, Bob 49, Cara 48, Dan 47, Eve 46.
    const week1 = await createTestGame(tournamentId, { name: 'Week One', status: 'ARCHIVED' });
    await createTestSubmission(week1, { username: 'Alice', score: 900 });
    await createTestSubmission(week1, { username: 'Bob', score: 800 });
    await createTestSubmission(week1, { username: 'Cara', score: 700 });
    await createTestSubmission(week1, { username: 'Dan', score: 600 });
    await createTestSubmission(week1, { username: 'Eve', score: 500 });
    // Week 2: Bob 50, Alice 49, Dan 48, Cara 47 (Eve did not play).
    const week2 = await createTestGame(tournamentId, { name: 'Week Two', status: 'ACTIVE' });
    await createTestSubmission(week2, { username: 'Bob', score: 990 });
    await createTestSubmission(week2, { username: 'Alice', score: 980 });
    await createTestSubmission(week2, { username: 'Dan', score: 970 });
    await createTestSubmission(week2, { username: 'Cara', score: 960 });
    return { groupId };
}

const placesOf = (rows: Array<{ iscored_username: string; rank: number; total_points: number }>) =>
    rows.map(r => [r.iscored_username, r.total_points, r.rank]);

describe('overall standings ties (B30)', () => {
    it('tied totals share the place and the next total skips past them (1, 1, 3, 3, 5)', async () => {
        const { groupId } = await seasonLikeGroup();
        const rows = await RankingService.computeRankings(groupId);
        // Totals: Alice 99, Bob 99, Cara 95, Dan 95, Eve 46.
        expect(rows.map(r => r.rank)).toEqual([1, 1, 3, 3, 5]);
        expect(rows.find(r => r.iscored_username === 'Eve')).toMatchObject({ total_points: 46, rank: 5 });
        expect(new Set(rows.slice(0, 2).map(r => r.iscored_username))).toEqual(new Set(['Alice', 'Bob']));
    });

    it('a cache written with row-position places is re-ranked on read', async () => {
        const { groupId } = await seasonLikeGroup();
        const first = await RankingService.getRankings(groupId);
        expect(first.map(r => r.rank)).toEqual([1, 1, 3, 3, 5]);

        // What a pre-2.254.0 cache holds: the same rows, numbered 1..N.
        const db = await getDatabase();
        const stale = first.map((r, i) => ({ ...r, rank: i + 1 }));
        await db.run('UPDATE ranking_groups_cache SET rankings = ? WHERE ranking_group_id = ?', JSON.stringify(stale), groupId);

        const reread = await RankingService.getRankings(groupId);
        expect(placesOf(reread)).toEqual(placesOf(first));
    });

    it('works for a lower-is-better list too (average rank)', () => {
        const rows = [
            { rank: 0, total_points: 1.5 },
            { rank: 0, total_points: 1.5 },
            { rank: 0, total_points: 2 },
            { rank: 0, total_points: 3.25 },
            { rank: 0, total_points: 3.25 },
            { rank: 0, total_points: 3.25 },
            { rank: 0, total_points: 4 },
        ];
        expect(assignCompetitionRanks(rows).map(r => r.rank)).toEqual([1, 1, 3, 4, 4, 4, 7]);
    });

    it('no ties is plain 1..N', () => {
        const rows = [{ rank: 0, total_points: 9 }, { rank: 0, total_points: 8 }, { rank: 0, total_points: 7 }];
        expect(assignCompetitionRanks(rows).map(r => r.rank)).toEqual([1, 2, 3]);
    });
});
