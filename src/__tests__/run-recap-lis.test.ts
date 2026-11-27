import { describe, it, expect } from 'vitest';
import fixture from './fixtures/run-recap-lis.json';
import { computeRunRecap, type RecapScoreRow, type RecapStanding } from '../utils/runRecapCompute.js';

/**
 * The reference run (Lost in Space, one season run, 335 Witness games from 11
 * players plus 18 typed scores) reproduced from an ANONYMIZED fixture: names are
 * Player A.., ids are fake snowflakes, scores and times are real. The expected
 * figures are the owner's hand-built recap (Witness-only view).
 */

const rows: RecapScoreRow[] = fixture.score_history.map(r => ({
    history_id: r.id, key: r.submitted_by_user_id, iscored_username: r.iscored_username, discord_user_id: r.submitted_by_user_id,
    submitted_by_user_id: r.submitted_by_user_id, score: r.score, source: r.source, created_at: r.created_at,
}));

/** The board: each player's best (highest, then earliest), ranked. */
function board(): RecapStanding[] {
    const best = new Map<string, RecapScoreRow>();
    for (const r of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.history_id - b.history_id)) {
        const cur = best.get(r.key);
        if (!cur || r.score > cur.score) best.set(r.key, r);
    }
    return [...best.values()].sort((a, b) => b.score - a.score)
        .map((r, i) => ({ key: r.key, rank: i + 1, history_id: r.history_id, score: r.score, created_at: r.created_at }));
}

function run(prefs = new Map()) {
    return computeRunRecap({
        rows, standings: board(), prefs, timezone: fixture.timezone, state: 'completed',
        start_date: fixture.game.start_date, end_date: fixture.game.end_date, close_at: fixture.game.end_date,
        attemptsUsed: null, now: new Date('2026-11-27T12:00:00Z'),
    });
}

const witnessCount = (key: string) => rows.filter(r => r.key === key && r.source === 'vpx').length;

describe('run recap, reference run', () => {
    const recap = run();
    const byGames = (n: number) => recap.players.find(p => p.games === n)!;

    it('has 335 games from 11 Witness players', () => {
        expect(recap.totals.witness_games).toBe(335);
        expect(recap.totals.witness_players).toBe(11);
        expect(recap.totals.players).toBe(21);
        expect(recap.totals.other_only_players).toBe(10);
        expect(recap.totals.hidden_players).toBe(0);
    });

    it('winner: 22 games, average 116,170,221, median 84,578,100, best 492,315,750 on the last game', () => {
        const winner = recap.players[0]!;
        expect(winner.rank).toBe(1);
        expect(winner.games).toBe(22);
        expect(winner.average).toBe(116170221);
        expect(winner.median).toBe(84578100);
        expect(winner.best).toBe(492315750);
        expect(winner.best_game_no).toBe(22);
        expect(recap.hero.winning_game_no).toBe(22);
        expect(recap.hero.winner_key).toBe(winner.key);
        expect(recap.hero.winner_days!.map(d => d.games)).toEqual([16, 2, 4]);
        expect(recap.hero.game_of_day).toBe(4);
        expect(recap.hero.ms_before_close).toBeGreaterThan(6 * 3_600_000);
        expect(recap.hero.ms_before_close).toBeLessThan(8 * 3_600_000);
    });

    it('with the typed scores in, the early lead is typed: 4 lead changes', () => {
        // Typed / synced scores count for who led (plan 0.2): three typed scores take the lead on day one.
        expect(recap.facts.lead_changes).toBe(4);
        expect(recap.lead_changes.map(c => c.kind)).toEqual(['first', 'takes_first', 'takes_first', 'takes_first', 'takes_first']);
        expect(recap.lead_changes[recap.lead_changes.length - 1]!.wins_it).toBe(true);
    });

    it('Witness-only view: 7 lead changes (plus the first score) in the reference order and annotations', () => {
        const witnessRows = rows.filter(x => x.source === 'vpx');
        const standings = board().filter(s => witnessCount(s.key) > 0)
            .map((s, i) => ({ ...s, rank: i + 1 }));
        const r = computeRunRecap({
            rows: witnessRows, standings, prefs: new Map(), timezone: fixture.timezone, state: 'completed',
            start_date: fixture.game.start_date, end_date: fixture.game.end_date, close_at: fixture.game.end_date,
            attemptsUsed: null, now: new Date('2026-11-27T12:00:00Z'),
        });
        expect(r.facts.lead_changes).toBe(7);
        const names = r.lead_changes.map(c => c.player_key);
        expect(r.lead_changes.map(c => c.kind)).toEqual([
            'first', 'takes_first', 'takes_first', 'takes_first', 'takes_first', 'takes_back', 'takes_back', 'takes_back',
        ]);
        expect(r.lead_changes.map(c => c.wins_it)).toEqual([false, false, false, false, false, false, false, true]);
        // The leader order is A, B, C, D, E, D, E, D: five leaders, the winner (D) retaking twice.
        expect(names[3]).toBe(names[5]);
        expect(names[3]).toBe(names[7]);
        expect(names[4]).toBe(names[6]);
        expect(new Set(names).size).toBe(5);
        expect(names[7]).toBe(r.hero.winner_key);
        expect(r.lead_changes.map(c => Math.round(c.score / 1e5) / 10)).toEqual([31.4, 92.6, 166.1, 196.5, 205.3, 358.6, 400.7, 492.3]);
    });

    it('counts games per day in America/Chicago: 79, 43, 43, 80, 9, 42, 39', () => {
        expect(recap.per_day!.map(b => b.games)).toEqual([79, 43, 43, 80, 9, 42, 39]);
        expect(recap.per_day!.map(b => b.label)).toEqual([
            'Fri 11/20', 'Sat 11/21', 'Sun 11/22', 'Mon 11/23', 'Tue 11/24', 'Wed 11/25', 'Thu 11/26',
        ]);
    });

    it('streak 19 games in 47 minutes (the 85-game player) and a 98 minute session (the 28-game player)', () => {
        const streakPlayer = byGames(85);
        expect(recap.facts.longest_streak).toEqual({ player_key: streakPlayer.key, games: 19, minutes: 47 });
        const streak = recap.awards.find(a => a.id === 'longest_streak')!;
        expect(streak.player_keys).toEqual([streakPlayer.key]);
        expect(streak.detail).toBe('19 games in 47 minutes');
        const longest = recap.awards.find(a => a.id === 'longest_session')!;
        expect(longest.player_keys).toEqual([byGames(28).key]);
        expect(longest.detail).toBe('15 games over 98 minutes');
        const busiest = recap.awards.find(a => a.id === 'busiest_day')!;
        expect(busiest.player_keys).toEqual([streakPlayer.key]);
        expect(busiest.detail).toBe('32 games on Mon 11/23');
    });

    it('most games: the 122-game player, all 7 days, 8.58 billion points', () => {
        const award = recap.awards.find(a => a.id === 'most_games')!;
        expect(award.player_keys).toEqual([byGames(122).key]);
        expect(award.detail).toBe('122 games, all 7 days, 8.58 billion points in total');
        expect(recap.facts.most_games).toEqual({ player_key: byGames(122).key, games: 122 });
    });

    it('personal bests: the 85-game and 28-game players share the award with 8 each; best first game is 166.1M', () => {
        const pb = recap.awards.find(a => a.id === 'most_personal_bests')!;
        expect(new Set(pb.player_keys)).toEqual(new Set([byGames(85).key, byGames(28).key]));
        expect(pb.detail).toBe('8 each');
        // The plan's rule has no per-player minimum, so the 5-game player's 171.9M first game beats the
        // 2-game player's 166.1M that the hand-built recap named (and it was not a lead change).
        const first = recap.awards.find(a => a.id === 'best_first_game')!;
        expect(first.player_keys).toHaveLength(1);
        expect(first.detail).toBe('171.9M on game #1');
    });

    it('time of day needs the opt-in; the fixed night window counts the 24 midnight games and 10 more', () => {
        const owl = byGames(122).key;
        expect(recap.awards.find(a => a.id === 'night_owl')).toBeUndefined();
        const opted = run(new Map([[owl, { playStats: true, timeOfDay: true }]]));
        const hours = opted.detail.get(owl)!.hours!;
        expect(hours[0]).toBe(24);
        expect(hours.slice(0, 5).reduce((s, n) => s + n, 0)).toBe(34);
        // Seven awards already qualify; the opt-in Night owl is never squeezed out (every award id fits).
        expect(opted.awards).toHaveLength(8);
        const owlAward = opted.awards.find(a => a.id === 'night_owl');
        expect(owlAward?.player_keys).toEqual([owl]);
        expect(owlAward?.value).toBe(34);
        // Only opted-in players carry clock times.
        expect(opted.detail.get(owl)!.games.every(g => g.time !== null)).toBe(true);
        expect(opted.detail.get(byGames(85).key)!.games.every(g => g.time === null)).toBe(true);
        expect(opted.detail.get(byGames(85).key)!.hours).toBeNull();
    });

    it('a hidden player leaves every aggregate', () => {
        const hidden = byGames(122).key;
        const r = run(new Map([[hidden, { playStats: false, timeOfDay: false }]]));
        expect(r.totals.witness_games).toBe(335 - 122);
        expect(r.totals.hidden_players).toBe(1);
        expect(r.per_day!.reduce((s, b) => s + b.games, 0)).toBe(335 - 122);
        const row = r.players.find(p => p.key === hidden)!;
        expect(row.play_stats).toBe('hidden');
        expect(row.games).toBeNull();
        expect(row.best).toBeGreaterThan(0);
        expect(r.awards.find(a => a.id === 'most_games')?.player_keys).not.toContain(hidden);
        // Standings facts still include them.
        expect(r.lead_changes.length).toBe(recap.lead_changes.length);
    });

    it('sanity: fixture Witness counts', () => {
        expect(witnessCount(byGames(22).key)).toBe(22);
    });
});
