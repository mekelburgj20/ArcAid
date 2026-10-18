import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { setupTestDb, createTestRoom, createTestTournament, createTestGame, createTestSubmission } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { RankingService } from '../services/RankingService.js';
import { TournamentService, SeasonConfigError } from '../services/TournamentService.js';
import { createSeason } from './seasonHelpers.js';

/**
 * Season standings (docs/season-format-plan.md §3.2, §4).
 *
 *   - best_game_linear starts at the group's `points_top` (default 100, so
 *     existing groups are unchanged), floored at 0.
 *   - `include_archived` counts ARCHIVED tables — cleanup archives completed
 *     tables, and a season's week 1 must not silently vanish.
 *   - Per-game placement is competition rank (RANK()): tied scores share the
 *     place and both get the higher points (1st, 1st, 3rd).
 *   - The season's standings group is created, kept in step and deleted with
 *     the tournament.
 */

beforeEach(async () => {
    await setupTestDb();
});

async function makeGroup(opts: { pointsTop?: number; includeArchived?: boolean } = {}) {
    const roomId = await createTestRoom(`rank-${crypto.randomUUID().slice(0, 8)}`, 'Rank Room');
    const tournamentId = await createTestTournament(roomId, { name: 'Weekly' });
    const groupId = crypto.randomUUID();
    await RankingService.create({
        id: groupId,
        name: 'Standings',
        rank_method: 'best_game_linear',
        best_n: 10,
        min_games: 1,
        tournament_ids: [tournamentId],
        game_room_id: roomId,
        points_top: opts.pointsTop,
        include_archived: opts.includeArchived,
    });
    return { roomId, tournamentId, groupId };
}

const pointsFor = (rankings: Awaited<ReturnType<typeof RankingService.computeRankings>>, name: string) =>
    rankings.find(r => r.iscored_username === name)?.total_points;

describe('best_game_linear points', () => {
    it('starts at points_top and floors at 0', () => {
        expect(RankingService.calculatePoints('best_game_linear', 1, 0, 50)).toBe(50);
        expect(RankingService.calculatePoints('best_game_linear', 2, 0, 50)).toBe(49);
        expect(RankingService.calculatePoints('best_game_linear', 3, 0, 50)).toBe(48);
        expect(RankingService.calculatePoints('best_game_linear', 51, 0, 50)).toBe(0);
        expect(RankingService.calculatePoints('best_game_linear', 70, 0, 50)).toBe(0);
    });

    it('defaults to 100 so existing groups are unchanged', async () => {
        expect(RankingService.calculatePoints('best_game_linear', 1, 0)).toBe(100);
        const { tournamentId, groupId } = await makeGroup();
        const group = await RankingService.getById(groupId);
        expect(group!.points_top).toBe(100);
        expect(group!.include_archived).toBe(false);

        const g = await createTestGame(tournamentId, { name: 'AFM', status: 'COMPLETED' });
        await createTestSubmission(g, { username: 'Alice', score: 900 });
        await createTestSubmission(g, { username: 'Bob', score: 800 });
        const rankings = await RankingService.computeRankings(groupId);
        expect(pointsFor(rankings, 'Alice')).toBe(100);
        expect(pointsFor(rankings, 'Bob')).toBe(99);
    });

    it('uses the group points_top', async () => {
        const { tournamentId, groupId } = await makeGroup({ pointsTop: 50 });
        const g = await createTestGame(tournamentId, { name: 'AFM', status: 'COMPLETED' });
        await createTestSubmission(g, { username: 'Alice', score: 900 });
        await createTestSubmission(g, { username: 'Bob', score: 800 });
        await createTestSubmission(g, { username: 'Cara', score: 700 });
        const rankings = await RankingService.computeRankings(groupId);
        expect(pointsFor(rankings, 'Alice')).toBe(50);
        expect(pointsFor(rankings, 'Bob')).toBe(49);
        expect(pointsFor(rankings, 'Cara')).toBe(48);
    });
});

describe('RANK() placement', () => {
    it('tied scores share the place and both get the higher points', async () => {
        const { tournamentId, groupId } = await makeGroup({ pointsTop: 50 });
        const g = await createTestGame(tournamentId, { name: 'MM', status: 'COMPLETED' });
        await createTestSubmission(g, { username: 'Zed', score: 1000 });
        await createTestSubmission(g, { username: 'Amy', score: 1000 });
        await createTestSubmission(g, { username: 'Cal', score: 500 });
        const rankings = await RankingService.computeRankings(groupId);
        expect(pointsFor(rankings, 'Zed')).toBe(50);
        expect(pointsFor(rankings, 'Amy')).toBe(50);
        // 1st, 1st, 3rd — not 2nd.
        expect(pointsFor(rankings, 'Cal')).toBe(48);
        expect(rankings.find(r => r.iscored_username === 'Cal')!.breakdown[0]!.game_rank).toBe(3);
    });
});

describe('include_archived', () => {
    async function seedTwoWeeks(tournamentId: string) {
        const week1 = await createTestGame(tournamentId, { name: 'Week One', status: 'ARCHIVED' });
        await createTestSubmission(week1, { username: 'Alice', score: 900 });
        const week2 = await createTestGame(tournamentId, { name: 'Week Two', status: 'COMPLETED' });
        await createTestSubmission(week2, { username: 'Alice', score: 900 });
    }

    it('off: ARCHIVED tables do not count (existing behaviour)', async () => {
        const { tournamentId, groupId } = await makeGroup({ pointsTop: 50 });
        await seedTwoWeeks(tournamentId);
        const rankings = await RankingService.computeRankings(groupId);
        expect(pointsFor(rankings, 'Alice')).toBe(50);
    });

    it('on: ARCHIVED tables count', async () => {
        const { tournamentId, groupId } = await makeGroup({ pointsTop: 50, includeArchived: true });
        await seedTwoWeeks(tournamentId);
        const rankings = await RankingService.computeRankings(groupId);
        expect(pointsFor(rankings, 'Alice')).toBe(100);
    });

    it('update() keeps points_top / include_archived when omitted', async () => {
        const { tournamentId, groupId } = await makeGroup({ pointsTop: 50, includeArchived: true });
        await RankingService.update(groupId, {
            name: 'Renamed', rank_method: 'best_game_linear', best_n: 10, min_games: 1, tournament_ids: [tournamentId],
        });
        const group = await RankingService.getById(groupId);
        expect(group!.points_top).toBe(50);
        expect(group!.include_archived).toBe(true);
    });
});

describe('season standings group lifecycle', () => {
    it('create() makes the group (seeded Countdown, 50 for 1st) and normalises the pick flags', async () => {
        const { tournamentId } = await createSeason({ tableCount: 12 });
        const db = await getDatabase();
        const t = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        expect(t.winner_picks).toBe(0);
        expect(t.auto_pick).toBe(0);
        expect(t.max_active_games).toBe(1);
        // A community vote overrides cooldown (owner ruling 2026-10-17).
        expect(t.eligibility_days).toBe(0);
        expect(t.season_ranking_group_id).toBeTruthy();

        const group = await RankingService.getById(t.season_ranking_group_id);
        expect(group).toMatchObject({
            name: `${t.name} — Season`,
            rank_method: 'best_game_linear',
            points_top: 50,
            best_n: 12,
            min_games: 1,
            include_archived: true,
            tournament_ids: [tournamentId],
            managed_by_season: { id: tournamentId, name: t.name },
        });
    });

    it('a Season WITHOUT Pick by poll forces nothing but still gets its standings group (ADR 0026)', async () => {
        const { tournamentId, roomId } = await createSeason({ tableCount: 8, pollPicks: false });
        const db = await getDatabase();
        // The helper's create sends no pick flags, so the service defaults apply untouched.
        let t = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        expect(t).toMatchObject({ poll_picks: 0, winner_picks: 1, auto_pick: 1, max_active_games: 1, eligibility_days: 120, season_table_count: 8 });
        expect(t.season_ranking_group_id).toBeTruthy();
        expect((await RankingService.getById(t.season_ranking_group_id))!.best_n).toBe(8);

        await TournamentService.update(tournamentId, {
            name: t.name, type: t.type, cadence: JSON.parse(t.cadence), game_room_id: roomId, is_active: true,
            winner_picks: true, auto_pick: false, max_active_games: 2, eligibility_days: 30,
        });
        t = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        expect(t).toMatchObject({ poll_picks: 0, winner_picks: 1, auto_pick: 0, max_active_games: 2, eligibility_days: 30, season_table_count: 8 });
    });

    it('Pick by poll WITHOUT a Season forces the four fields and creates no group (ADR 0026)', async () => {
        const { tournamentId, roomId } = await createSeason({ tableCount: null, pollPicks: true, tieRule: 'random' });
        const db = await getDatabase();
        const t = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        expect(t).toMatchObject({
            poll_picks: 1, season_table_count: null, season_ranking_group_id: null,
            winner_picks: 0, auto_pick: 0, max_active_games: 1, eligibility_days: 0,
            poll_opens_before_h: 96, poll_closes_before_h: 3, poll_tie_rule: 'random',
        });
        // Switching the poll off hands the four fields back to the admin.
        await TournamentService.update(tournamentId, {
            name: t.name, type: t.type, cadence: JSON.parse(t.cadence), game_room_id: roomId, is_active: true,
            poll_picks: false, winner_picks: true, auto_pick: true, max_active_games: 2, eligibility_days: 60,
        });
        expect(await db.get('SELECT poll_picks, winner_picks, max_active_games, eligibility_days FROM tournaments WHERE id = ?', tournamentId))
            .toEqual({ poll_picks: 0, winner_picks: 1, max_active_games: 2, eligibility_days: 60 });
    });

    it('update() propagates the table count only and invalidates the cache', async () => {
        const { tournamentId, roomId } = await createSeason({ tableCount: 12 });
        const db = await getDatabase();
        const t = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        // The group's scoring is edited on the Rankings page; a season save
        // must never overwrite it.
        await db.run('UPDATE ranking_groups SET points_top = 75 WHERE id = ?', t.season_ranking_group_id);
        await db.run(
            `INSERT INTO ranking_groups_cache (ranking_group_id, rankings, generated_at, data_watermark) VALUES (?, '[]', ?, 'x')`,
            t.season_ranking_group_id, new Date().toISOString(),
        );

        await TournamentService.update(tournamentId, {
            name: t.name, type: t.type, cadence: JSON.parse(t.cadence), game_room_id: roomId, is_active: true,
            season_table_count: 10,
            // A client that sends the pick flags on can't turn them back on for a season.
            winner_picks: true, auto_pick: true, max_active_games: 3, eligibility_days: 120,
        });
        const group = await RankingService.getById(t.season_ranking_group_id);
        expect(group!.points_top).toBe(75);
        expect(group!.rank_method).toBe('best_game_linear');
        expect(group!.best_n).toBe(10);
        const cache = await db.get('SELECT 1 FROM ranking_groups_cache WHERE ranking_group_id = ?', t.season_ranking_group_id);
        expect(cache).toBeUndefined();
        const after = await db.get('SELECT winner_picks, auto_pick, max_active_games, eligibility_days, season_ranking_group_id FROM tournaments WHERE id = ?', tournamentId);
        expect(after).toMatchObject({ winner_picks: 0, auto_pick: 0, max_active_games: 1, eligibility_days: 0, season_ranking_group_id: t.season_ranking_group_id });
    });

    it('update() without season fields leaves the season untouched', async () => {
        const { tournamentId, roomId } = await createSeason({ tableCount: 12 });
        const db = await getDatabase();
        const t = await db.get('SELECT * FROM tournaments WHERE id = ?', tournamentId);
        await TournamentService.update(tournamentId, {
            name: 'Renamed Season', type: t.type, cadence: JSON.parse(t.cadence), game_room_id: roomId, is_active: true,
        });
        const after = await db.get('SELECT season_table_count, winner_picks FROM tournaments WHERE id = ?', tournamentId);
        expect(after).toMatchObject({ season_table_count: 12, winner_picks: 0 });
    });

    it('a season-managed group keeps best_n locked to the season; points_top is editable', async () => {
        const { tournamentId } = await createSeason({ tableCount: 12 });
        const db = await getDatabase();
        const t = await db.get('SELECT season_ranking_group_id FROM tournaments WHERE id = ?', tournamentId);
        await RankingService.update(t.season_ranking_group_id, {
            name: 'Edited', rank_method: 'best_game_linear', best_n: 3, min_games: 1, tournament_ids: [tournamentId], points_top: 999,
        });
        const group = await RankingService.getById(t.season_ranking_group_id);
        expect(group!.best_n).toBe(12);
        expect(group!.points_top).toBe(999);
    });

    it('delete() removes the group', async () => {
        const { tournamentId } = await createSeason();
        const db = await getDatabase();
        const t = await db.get('SELECT season_ranking_group_id FROM tournaments WHERE id = ?', tournamentId);
        await TournamentService.delete(tournamentId);
        expect(await db.get('SELECT 1 FROM ranking_groups WHERE id = ?', t.season_ranking_group_id)).toBeUndefined();
    });

    it('refuses an invalid season block', async () => {
        const roomId = await createTestRoom(`bad-${crypto.randomUUID().slice(0, 6)}`, 'Bad');
        const base = { id: crypto.randomUUID(), name: 'Bad', type: 'WG', is_active: true, game_room_id: roomId };
        await expect(TournamentService.create({ ...base, cadence: { timezone: 'UTC' }, season_table_count: 12 }))
            .rejects.toBeInstanceOf(SeasonConfigError);
        await expect(TournamentService.create({
            ...base, id: crypto.randomUUID(), cadence: { cron: '0 0 * * 5' }, season_table_count: 12,
            poll_picks: true, poll_opens_before_h: 3, poll_closes_before_h: 3,
        })).rejects.toMatchObject({ code: 'POLL_OPEN' });
        // Pick by poll rides the rotation clock too — no cron, no poll.
        await expect(TournamentService.create({
            ...base, id: crypto.randomUUID(), cadence: { timezone: 'UTC' }, poll_picks: true,
        })).rejects.toMatchObject({ code: 'POLL_CADENCE' });
        await expect(TournamentService.create({
            ...base, id: crypto.randomUUID(), cadence: { cron: '0 0 * * 5' }, season_table_count: 201,
        })).rejects.toMatchObject({ code: 'SEASON_TABLE_COUNT' });
    });
});
