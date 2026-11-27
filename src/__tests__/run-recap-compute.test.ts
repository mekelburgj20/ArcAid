import { describe, it, expect } from 'vitest';
import {
    computeRunRecap, dbTimeMs, dayLabel, leadTimeline, localDayKey, localHour, medianOf, sessionsOf,
    type ComputeInput, type RecapPrefs, type RecapScoreRow,
} from '../utils/runRecapCompute.js';
import { abbrevScore, wordsScore } from '../utils/runRecapText.js';

const TZ = 'America/Chicago';
let hid = 0;

/** A row `min` minutes after 2026-11-20 12:00 UTC. */
function row(key: string, score: number, min: number, source = 'vpx'): RecapScoreRow {
    const ms = Date.UTC(2026, 10, 20, 12, 0, 0) + min * 60_000;
    return {
        history_id: ++hid, key, iscored_username: key, discord_user_id: key, submitted_by_user_id: key,
        score, source, created_at: new Date(ms).toISOString().replace('T', ' ').slice(0, 19),
    };
}

function standingsOf(rows: RecapScoreRow[]) {
    const best = new Map<string, RecapScoreRow>();
    for (const r of rows) {
        const cur = best.get(r.key);
        if (!cur || r.score > cur.score) best.set(r.key, r);
    }
    return [...best.values()].sort((a, b) => b.score - a.score)
        .map((r, i) => ({ key: r.key, rank: i + 1, history_id: r.history_id, score: r.score, created_at: r.created_at }));
}

function compute(rows: RecapScoreRow[], over: Partial<ComputeInput> = {}) {
    return computeRunRecap({
        rows, standings: standingsOf(rows), prefs: new Map(), timezone: TZ, state: 'completed',
        start_date: null, end_date: null, close_at: null, attemptsUsed: null, now: new Date('2026-12-30T00:00:00Z'), ...over,
    });
}

/** n games for a key, spaced `gap` minutes apart starting at `start`, scores base, base+step... */
function games(key: string, n: number, start: number, gap: number, base = 1000, step = 10): RecapScoreRow[] {
    return Array.from({ length: n }, (_, i) => row(key, base + i * step, start + i * gap));
}

describe('run recap compute helpers', () => {
    it('dbTimeMs reads both shapes as UTC', () => {
        expect(dbTimeMs('2026-11-20 14:04:59')).toBe(Date.UTC(2026, 10, 20, 14, 4, 59));
        expect(dbTimeMs('2026-11-20T14:04:59.000Z')).toBe(Date.UTC(2026, 10, 20, 14, 4, 59));
        expect(dbTimeMs('2026-11-20T14:04:59')).toBe(Date.UTC(2026, 10, 20, 14, 4, 59));
    });

    it('median: odd is the middle, even is the rounded mean of the middle two', () => {
        expect(medianOf([5, 1, 3])).toBe(3);
        expect(medianOf([1, 2, 3, 4])).toBe(3);
        expect(medianOf([1, 2])).toBe(2);
        expect(medianOf([])).toBe(0);
    });

    it('session gap: exactly 20:00 stays in the session, 20:01 starts a new one', () => {
        const m = 60_000;
        expect(sessionsOf([0, 20 * m]).length).toBe(1);
        expect(sessionsOf([0, 20 * m + 1000]).length).toBe(2);
        expect(sessionsOf([0, 5 * m, 40 * m]).map(s => s.count)).toEqual([2, 1]);
    });

    it('local day and hour honour the zone and DST', () => {
        // 2026-11-01 05:30 UTC is 00:30 CDT; 2026-11-02 05:30 UTC is 23:30 CST the day before.
        expect(localDayKey(Date.UTC(2026, 10, 1, 5, 30), TZ)).toBe('2026-11-01');
        expect(localHour(Date.UTC(2026, 10, 1, 5, 30), TZ)).toBe(0);
        expect(localDayKey(Date.UTC(2026, 10, 2, 5, 30), TZ)).toBe('2026-11-01');
        expect(localHour(Date.UTC(2026, 10, 2, 5, 30), TZ)).toBe(23);
        expect(dayLabel('2026-11-20')).toBe('Fri 11/20');
    });

    it('score formatters', () => {
        expect(abbrevScore(950)).toBe('950');
        expect(abbrevScore(31_411_440)).toBe('31.4M');
        expect(abbrevScore(92_000_000)).toBe('92.0M');
        expect(abbrevScore(8_600_000_000)).toBe('8.6B');
        expect(abbrevScore(1_200_000_000_000)).toBe('1.2T');
        expect(abbrevScore(999_960)).toBe('1.0M');
        expect(wordsScore(8_580_000_000)).toBe('8.58 billion');
        expect(wordsScore(116_170_221)).toBe('116 million');
    });
});

describe('lead timeline', () => {
    it('needs a strictly greater best; the leader improving is a step only; takes_back after losing it', () => {
        const rows = [
            row('a', 100, 0), row('b', 150, 1), row('b', 150, 2), row('a', 120, 3),   // a never retakes with 120
            row('b', 200, 4),                                                          // b improves: step only
            row('a', 500, 5),                                                          // a takes first
            row('b', 600, 6),                                                          // b takes back
            row('a', 600, 7),                                                          // equal: no change
        ];
        const t = leadTimeline(rows);
        expect(t.changes.map(c => [c.player_key, c.kind])).toEqual([
            ['a', 'first'], ['b', 'takes_first'], ['a', 'takes_back'], ['b', 'takes_back'],
        ]);
        expect(t.steps.map(s => s.score)).toEqual([100, 150, 200, 500, 600]);
    });

    it('wins_it is only set on a completed run', () => {
        const rows = [row('a', 1, 0), row('b', 2, 1)];
        expect(compute(rows).lead_changes.map(c => c.wins_it)).toEqual([false, true]);
        expect(compute(rows, { state: 'active' }).lead_changes.map(c => c.wins_it)).toEqual([false, false]);
    });
});

describe('computeRunRecap', () => {
    it('no scores: an empty recap', () => {
        const r = compute([]);
        expect(r.players).toEqual([]);
        expect(r.hero.winner_key).toBeNull();
        expect(r.hero.best).toBeNull();
        expect(r.lead_changes).toEqual([]);
        expect(r.awards).toEqual([]);
        expect(r.per_day).toBeNull();
    });

    it('one score: one first change, no awards', () => {
        const r = compute([row('a', 10, 0)]);
        expect(r.lead_changes).toHaveLength(1);
        expect(r.lead_changes[0]!.wins_it).toBe(true);
        expect(r.awards).toEqual([]);
        expect(r.players[0]!.games).toBe(1);
        expect(r.players[0]!.average).toBe(10);
        expect(r.players[0]!.personal_bests).toBe(1);
    });

    it('typed-only: stats null, play_stats none, no per-day', () => {
        const r = compute([row('a', 10, 0, 'community'), row('b', 20, 5, 'tournament')]);
        expect(r.players.map(p => p.play_stats)).toEqual(['none', 'none']);
        expect(r.players[0]!.games).toBeNull();
        expect(r.totals).toMatchObject({ witness_games: 0, witness_players: 0, other_only_players: 2, players: 2 });
        expect(r.per_day).toBeNull();
        expect(r.awards).toEqual([]);
        expect(r.players[0]!.best_source).toBe('other');
        expect(r.hero.winning_game_no).toBeNull();
    });

    it('typed rows count for the lead but never for games, average or PBs', () => {
        const rows = [...games('a', 4, 0, 5, 100, 10), row('a', 9999, 60, 'community'), ...games('b', 4, 2, 5, 50, 10)];
        const r = compute(rows);
        const a = r.players.find(p => p.key === 'a')!;
        expect(a.best).toBe(9999);
        expect(a.best_source).toBe('other');
        expect(a.best_game_no).toBeNull();
        expect(a.games).toBe(4);
        expect(a.average).toBe(115);
        expect(a.personal_bests).toBe(4);
        const detail = r.detail.get('a')!;
        expect(detail.games.filter(g => g.n === null)).toHaveLength(1);
        expect(detail.games.find(g => g.score === 9999)!.is_best).toBe(true);
    });

    it('a player with one Witness game: average = median = best, one session, one PB, no streak', () => {
        const r = compute([row('a', 777, 0), ...games('b', 6, 3, 3)]);
        const a = r.players.find(p => p.key === 'a')!;
        expect([a.average, a.median, a.best, a.sessions, a.personal_bests, a.best_game_no]).toEqual([777, 777, 777, 1, 1, 1]);
    });

    it('personal bests count game #1', () => {
        const rows = [row('a', 5, 0), row('a', 3, 1), row('a', 9, 2), row('a', 9, 3), row('b', 1, 4)];
        expect(compute(rows).players.find(p => p.key === 'a')!.personal_bests).toBe(2);
    });

    it('per-day lists zero days between, in the local zone', () => {
        // Fri 11/20 06:00 CST, then Sun 11/22 06:00 CST.
        const rows = [row('a', 1, 0), row('a', 2, 60), row('a', 3, 2 * 24 * 60), row('b', 4, 10)];
        const r = compute(rows);
        expect(r.per_day!.map(b => [b.label, b.games])).toEqual([['Fri 11/20', 3], ['Sat 11/21', 0], ['Sun 11/22', 1]]);
    });

    it('a span over 14 days buckets by week from Monday', () => {
        const day = 24 * 60;
        const rows = [row('a', 1, 0), row('a', 2, 1), row('b', 3, 2), row('a', 5, 20 * day), row('b', 9, 20 * day + 1)];
        const r = compute(rows);
        expect(r.per_day!.every(b => b.kind === 'week')).toBe(true);
        expect(r.per_day![0]!.key).toBe('2026-11-16');
        expect(r.per_day![0]!.label).toBe('Week of Nov 16');
        expect(r.per_day!.reduce((s, b) => s + b.games, 0)).toBe(5);
    });

    it('a run across the 2026-11-01 DST change buckets days correctly', () => {
        // Sat 10/31 23:30 CDT, Sun 11/01 00:30 CDT, Sun 11/01 23:30 CST, Mon 11/02 00:30 CST.
        const t = (iso: string) => ({ ...row('a', 1, 0), created_at: iso.replace('T', ' ').slice(0, 19) });
        const rows = [
            { ...t('2026-11-01T04:30:00Z'), score: 1, history_id: ++hid },
            { ...t('2026-11-01T05:30:00Z'), score: 2, history_id: ++hid },
            { ...t('2026-11-02T05:30:00Z'), score: 3, history_id: ++hid },
            { ...t('2026-11-02T06:30:00Z'), score: 4, history_id: ++hid },
            { ...row('b', 9, 0), created_at: '2026-11-01 06:00:00' },
        ];
        const r = compute(rows);
        expect(r.per_day!.map(b => [b.key, b.games])).toEqual([['2026-10-31', 1], ['2026-11-01', 3], ['2026-11-02', 1]]);
    });

    it('legacy run with no start date still computes', () => {
        const r = compute([...games('a', 3, 0, 5), ...games('b', 3, 1, 5)], { start_date: null, end_date: null, state: 'active' });
        expect(r.totals.witness_games).toBe(6);
    });

    it('tied best: the board rank decides and a tie does not take the lead', () => {
        const rows = [row('a', 100, 0), row('b', 100, 1)];
        const r = compute(rows, { standings: [
            { key: 'a', rank: 1, history_id: rows[0]!.history_id, score: 100, created_at: rows[0]!.created_at },
            { key: 'b', rank: 2, history_id: rows[1]!.history_id, score: 100, created_at: rows[1]!.created_at },
        ] });
        expect(r.lead_changes).toHaveLength(1);
        expect(r.hero.winner_key).toBe('a');
        expect(r.facts.closest_finish_ratio).toBe(0);
    });

    it('comeback and closest finish ratios', () => {
        const rows = [row('a', 1000, 0), row('b', 400, 1), row('b', 1500, 2)];
        const r = compute(rows);
        expect(r.facts.comeback_ratio).toBeCloseTo(0.6, 5);
        expect(r.facts.closest_finish_ratio).toBeCloseTo((1500 - 1000) / 1500, 5);
        // wire to wire: null
        expect(compute([row('a', 10, 0), row('b', 5, 1)]).facts.comeback_ratio).toBeNull();
    });

    it('hero carries the winner game number, day game and time before close', () => {
        const rows = [...games('a', 3, 0, 5), ...games('b', 3, 1, 5, 10, 1)];
        const r = compute(rows, { close_at: '2026-11-21 12:00:00' });
        expect(r.hero.winner_key).toBe('a');
        expect(r.hero.winning_game_no).toBe(3);
        expect(r.hero.game_of_day).toBe(3);
        expect(r.hero.winner_games).toBe(3);
        expect(r.hero.ms_before_close).toBe(Date.UTC(2026, 10, 21, 12) - dbTimeMs(rows[2]!.created_at));
        expect(compute(rows, { state: 'active', close_at: '2026-11-21 12:00:00' }).hero.ms_before_close).toBeNull();
    });

    it('limited attempts: attempts_used only for shown players', () => {
        const rows = [...games('a', 3, 0, 5), ...games('b', 3, 1, 5)];
        const r = compute(rows, { attemptsUsed: new Map([['a', 7], ['b', 4]]), prefs: new Map([['b', { playStats: false, timeOfDay: false }]]) });
        expect(r.players.find(p => p.key === 'a')!.attempts_used).toBe(7);
        expect(r.players.find(p => p.key === 'b')!.attempts_used).toBeNull();
    });
});

describe('privacy', () => {
    it('a hidden player leaves totals, per-day, awards and facts, but not standings or the lead', () => {
        const rows = [...games('a', 12, 0, 3), ...games('b', 8, 1, 3, 900, 5), ...games('c', 4, 2, 3, 10, 1)];
        const prefs = new Map<string, RecapPrefs>([['a', { playStats: false, timeOfDay: false }]]);
        const r = compute(rows, { prefs });
        const a = r.players.find(p => p.key === 'a')!;
        expect(a.play_stats).toBe('hidden');
        expect([a.games, a.average, a.median, a.sessions, a.personal_bests, a.days_played, a.best_game_no, a.attempts_used]).toEqual(Array(8).fill(null));
        expect(a.best).toBeGreaterThan(0);
        expect(r.totals).toMatchObject({ witness_games: 12, witness_players: 2, hidden_players: 1 });
        expect(r.facts.most_games).toEqual({ player_key: 'b', games: 8 });
        expect(r.awards.flatMap(x => x.player_keys)).not.toContain('a');
        expect(r.detail.get('a')).toEqual({ games: [], sessions: [], hours: null });
        expect(r.lead_changes.some(c => c.player_key === 'a')).toBe(true);
    });

    it('a hidden winner has null hero numbers', () => {
        const rows = [...games('a', 4, 0, 3, 5000), ...games('b', 4, 1, 3)];
        const r = compute(rows, { prefs: new Map([['a', { playStats: false, timeOfDay: false }]]) });
        expect(r.hero.winner_key).toBe('a');
        expect(r.hero.best).toBe(5030);
        expect(r.hero.winning_game_no).toBeNull();
        expect(r.hero.winner_games).toBeNull();
        expect(r.hero.winner_days).toBeNull();
        expect(r.hero.game_of_day).toBeNull();
    });

    it('night owl and early bird exist only for opted-in players', () => {
        // 2026-11-20 06:00 UTC is midnight CST... build rows at 06:00-07:00 UTC (00:00-01:00 local).
        const owl = Array.from({ length: 6 }, (_, i) => ({ ...row('owl', 100 + i, 0), created_at: `2026-11-20 06:${String(i * 5).padStart(2, '0')}:00` }));
        const bird = Array.from({ length: 6 }, (_, i) => ({ ...row('bird', 100 + i, 0), created_at: `2026-11-20 12:${String(i * 5).padStart(2, '0')}:00` }));
        const rows = [...owl, ...bird];
        const off = compute(rows);
        expect(off.awards.some(a => a.id === 'night_owl' || a.id === 'early_bird')).toBe(false);
        expect(off.detail.get('owl')!.hours).toBeNull();
        expect(off.detail.get('owl')!.games.every(g => g.time === null)).toBe(true);
        const on = compute(rows, { prefs: new Map([['owl', { playStats: true, timeOfDay: true }], ['bird', { playStats: true, timeOfDay: true }]]) });
        expect(on.awards.find(a => a.id === 'night_owl')).toMatchObject({ player_keys: ['owl'], value: 6, detail: '6 games between midnight and 5 am' });
        expect(on.awards.find(a => a.id === 'early_bird')).toMatchObject({ player_keys: ['bird'], value: 6, detail: '6 games between 5 and 9 am' });
        expect(on.detail.get('owl')!.hours![0]).toBe(6);
        expect(on.detail.get('owl')!.games[0]!.time).toBe('00:00');
    });
});

describe('awards', () => {
    const find = (r: ReturnType<typeof compute>, id: string) => r.awards.find(a => a.id === id);

    it('need two players with Witness games', () => {
        expect(compute(games('a', 30, 0, 2)).awards).toEqual([]);
    });

    it('most games needs 3 games; a 3-way tie is shared; a 4-way tie is omitted', () => {
        const three = compute([...games('a', 4, 0, 30), ...games('b', 4, 1, 30), ...games('c', 4, 2, 30), ...games('d', 3, 3, 30)]);
        expect(find(three, 'most_games')!.player_keys.sort()).toEqual(['a', 'b', 'c']);
        expect(find(three, 'most_games')!.detail).toBe('4 games each');
        const four = compute([...games('a', 4, 0, 30), ...games('b', 4, 1, 30), ...games('c', 4, 2, 30), ...games('d', 4, 3, 30)]);
        expect(find(four, 'most_games')).toBeUndefined();
        const two = compute([...games('a', 2, 0, 30), ...games('b', 2, 1, 30)]);
        expect(find(two, 'most_games')).toBeUndefined();
    });

    it('longest streak needs 5 games in one session and reports minutes', () => {
        const r = compute([...games('a', 6, 0, 10), ...games('b', 4, 1, 10)]);
        expect(find(r, 'longest_streak')).toMatchObject({ player_keys: ['a'], value: 6, detail: '6 games in 50 minutes' });
        expect(r.facts.longest_streak).toEqual({ player_key: 'a', games: 6, minutes: 50 });
        expect(find(compute([...games('a', 4, 0, 10), ...games('b', 4, 1, 10)]), 'longest_streak')).toBeUndefined();
    });

    it('longest session needs 3 games and 30 minutes, and is dropped when it is the streak session', () => {
        // a: one 6-game 50 min session = also the streak, so no separate award.
        const same = compute([...games('a', 6, 0, 10), ...games('b', 4, 1, 10)]);
        expect(find(same, 'longest_session')).toBeUndefined();
        // b: a longer-in-time 4-game session (4 games over 60 min) is separate from a's 6-game streak.
        const sep = compute([...games('a', 6, 0, 4), ...games('b', 4, 1, 20)]);
        expect(find(sep, 'longest_streak')!.player_keys).toEqual(['a']);
        expect(find(sep, 'longest_session')).toMatchObject({ player_keys: ['b'], detail: '4 games over 60 minutes' });
        expect(find(compute([...games('a', 3, 0, 5), ...games('b', 3, 1, 5)]), 'longest_session')).toBeUndefined();
    });

    it('busiest day needs 5 games on one day', () => {
        const r = compute([...games('a', 5, 0, 30), ...games('b', 3, 1, 30)]);
        expect(find(r, 'busiest_day')).toMatchObject({ player_keys: ['a'], detail: '5 games on Fri 11/20' });
        expect(find(compute([...games('a', 4, 0, 30), ...games('b', 3, 1, 30)]), 'busiest_day')).toBeUndefined();
    });

    it('most personal bests needs 3, and prints "8 each" for a tie', () => {
        const r = compute([...games('a', 5, 0, 30), ...games('b', 5, 1, 30)]);
        expect(find(r, 'most_personal_bests')).toMatchObject({ value: 5, detail: '5 each' });
        expect(find(compute([...games('a', 2, 0, 30), ...games('b', 2, 1, 30)]), 'most_personal_bests')).toBeUndefined();
    });

    it('best first game needs 3 players with Witness games', () => {
        const rows = [row('a', 100, 0), row('b', 300, 1), row('c', 200, 2), row('a', 5, 3)];
        const r = compute(rows);
        expect(find(r, 'best_first_game')).toMatchObject({ player_keys: ['b'], detail: '300 on game #1, good for the lead' });
        expect(find(compute(rows.filter(x => x.key !== 'c')), 'best_first_game')).toBeUndefined();
    });

    it('most consistent needs 10 games and names the quartiles', () => {
        const steady = Array.from({ length: 10 }, (_, i) => row('steady', 1000 + i, i));
        const wild = Array.from({ length: 10 }, (_, i) => row('wild', i % 2 ? 10 : 5000, i));
        const r = compute([...steady, ...wild]);
        expect(find(r, 'most_consistent')!.player_keys).toEqual(['steady']);
        expect(find(r, 'most_consistent')!.detail).toMatch(/^half their games between 1\.0K and 1\.0K$/);
        expect(find(compute([...steady.slice(0, 9), ...wild]), 'most_consistent')!.player_keys).toEqual(['wild']);
    });

    it('keeps at most seven, in catalogue order', () => {
        const r = compute([...games('a', 30, 0, 2), ...games('b', 30, 1, 2), ...games('c', 12, 5, 2, 7000, 3)]);
        expect(r.awards.length).toBeLessThanOrEqual(7);
        const order = ['most_games', 'longest_streak', 'longest_session', 'busiest_day', 'most_personal_bests', 'best_first_game', 'most_consistent', 'night_owl', 'early_bird'];
        const idx = r.awards.map(a => order.indexOf(a.id));
        expect(idx).toEqual([...idx].sort((x, y) => x - y));
    });
});
