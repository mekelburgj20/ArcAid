import { describe, it, expect } from 'vitest';
import {
    rankAutoPick, ratingAdjusted, tier2Weight, benchReasonFor, formatQueueCredit,
    BAYES_C, THIN_MIN_ROUNDS,
    type AutoPickSignals, type AutoPickPlayerQueue, type AutoPickRound,
} from '../utils/autoPickRanking.js';

// ---------------------------------------------------------------------------
// The ONE auto-pick ranking (v2.219.0, ADR 0036, WORK.md A25). Pure: every
// signal is handed in, the rng is injected.
// ---------------------------------------------------------------------------

const games = (...names: string[]) => names.map(name => ({ name }));

let rowid = 0;
function queue(userId: string, ...names: string[]): AutoPickPlayerQueue {
    return { userId, rows: names.map(name => ({ gameId: `${userId}-${name}-${++rowid}`, name, rowid })) };
}

function signals(over: Partial<AutoPickSignals> = {}): AutoPickSignals {
    return {
        queues: [], ratings: new Map(), siteMean: 4, roomPlayers: new Map(),
        rounds: [], activeNames: new Set(), ...over,
    };
}

/** A deterministic rng (mulberry32). */
function seeded(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

describe('Tier 1 — ranked choice over the queues', () => {
    it('scores 3/2/1 by position and nothing deeper', () => {
        const r = rankAutoPick(games('A', 'B', 'C', 'D'), signals({ queues: [queue('u1', 'A', 'B', 'C', 'D')] }))!;
        expect(r.tier).toBe(1);
        expect(r.pick.name).toBe('A');
        expect(r.points).toBe(3);
        expect(r.tally).toEqual([{ name: 'A', points: 3 }, { name: 'B', points: 2 }, { name: 'C', points: 1 }]);
    });

    it('skips an ineligible (held / cooling) head so the next row moves up', () => {
        // 'Held' is not in the eligible set (on cooldown) — B becomes #1.
        const r = rankAutoPick(games('B', 'C'), signals({ queues: [queue('u1', 'Held', 'B', 'C')] }))!;
        expect(r.pick.name).toBe('B');
        expect(r.points).toBe(3);
        expect(r.tally).toEqual([{ name: 'B', points: 3 }, { name: 'C', points: 2 }]);
    });

    it('drops names that are already ACTIVE (Tier 0)', () => {
        const r = rankAutoPick(games('A', 'B'), signals({
            queues: [queue('u1', 'A', 'B')], activeNames: new Set(['a']),
        }))!;
        expect(r.pick.name).toBe('B');
        expect(r.points).toBe(3);
    });

    it('returns null when every eligible name is ACTIVE', () => {
        expect(rankAutoPick(games('A'), signals({ activeNames: new Set(['a']) }))).toBeNull();
    });

    it('counts the same table twice in one queue once, crediting both rows', () => {
        const q = queue('u1', 'A', 'a', 'B');
        const r = rankAutoPick(games('A', 'B'), signals({ queues: [q] }))!;
        expect(r.tally).toEqual([{ name: 'A', points: 3 }, { name: 'B', points: 2 }]);
        expect(r.contributors).toEqual([{ userId: 'u1', gameIds: [q.rows[0]!.gameId, q.rows[1]!.gameId], points: 3 }]);
    });

    it('adds points across queues — two #2s beat one #1', () => {
        const r = rankAutoPick(games('A', 'B', 'C'), signals({
            queues: [queue('u1', 'A', 'B'), queue('u2', 'C', 'B'), queue('u3', 'C2', 'B')],
        }))!;
        // u3's C2 is not eligible, so B is u3's #1 (3) — B = 2 + 2 + 3 = 7.
        expect(r.pick.name).toBe('B');
        expect(r.points).toBe(7);
        expect(r.contributors!.map(c => c.userId)).toEqual(['u3', 'u1', 'u2']);

        const r2 = rankAutoPick(games('A', 'B', 'C'), signals({
            queues: [queue('u1', 'A', 'B'), queue('u2', 'C', 'B')],
        }))!;
        expect(r2.pick.name).toBe('B'); // 4 beats 3 and 3
        expect(r2.points).toBe(4);
    });

    it('breaks a points tie by Tier 2 weight, then by earliest queued', () => {
        const qa = queue('u1', 'A');
        const qb = queue('u2', 'B');
        // Equal weight → earliest rowid (A, queued first).
        expect(rankAutoPick(games('A', 'B'), signals({ queues: [qb, qa] }))!.pick.name).toBe('A');
        // B is better rated → B wins the tie.
        const r = rankAutoPick(games('A', 'B'), signals({
            queues: [qa, qb], ratings: new Map([['b', { sum: 10, count: 2, memberLow: false }]]),
        }))!;
        expect(r.pick.name).toBe('B');
    });

    it('is deterministic — the rng is never consulted', () => {
        const rng = () => { throw new Error('rng used in Tier 1'); };
        const r = rankAutoPick(games('A', 'B'), signals({ queues: [queue('u1', 'B', 'A')] }), rng)!;
        expect(r.pick.name).toBe('B');
    });
});

describe('Tier 2 — weighted roam', () => {
    it('Bayes-adjusts with BAYES_C pseudo-votes at the site mean; unrated = mean', () => {
        expect(BAYES_C).toBe(5);
        expect(ratingAdjusted(undefined, 3.5)).toBe(3.5);
        // Two raters averaging 5 against a mean of 4: (5×4 + 10) / 7.
        expect(ratingAdjusted({ sum: 10, count: 2, memberLow: false }, 4)).toBeCloseTo(30 / 7, 10);
    });

    it('weights by rating × (1 + ln(1 + room players))', () => {
        const s = signals({ roomPlayers: new Map([['a', 6]]) });
        expect(tier2Weight('a', s)).toBeCloseTo(4 * (1 + Math.log(7)), 10);
        expect(tier2Weight('b', s)).toBeCloseTo(4, 10);
    });

    it('draws over cumulative weights with the injected rng', () => {
        // a: weight 4 × (1 + ln 7) ≈ 11.78; b: 4. Total ≈ 15.78.
        const s = signals({ roomPlayers: new Map([['a', 6]]) });
        expect(rankAutoPick(games('A', 'B'), s, () => 0.1)!.pick.name).toBe('A');
        expect(rankAutoPick(games('A', 'B'), s, () => 0.9)!.pick.name).toBe('B');
        const r = rankAutoPick(games('A', 'B'), s, () => 0.1)!;
        expect(r.tier).toBe(2);
        expect(r.tally).toEqual([]);
        expect(r.poolSize).toBe(2);
    });

    it('is reproducible with a seeded rng', () => {
        const s = signals({ roomPlayers: new Map([['a', 3], ['c', 9]]) });
        const draws = (seed: number) => {
            const rng = seeded(seed);
            return Array.from({ length: 40 }, () => rankAutoPick(games('A', 'B', 'C', 'D'), s, rng)!.pick.name);
        };
        expect(draws(7)).toEqual(draws(7));
        // And it actually roams: more than one name comes up over 40 draws.
        expect(new Set(draws(7)).size).toBeGreaterThan(1);
    });
});

describe('bench rules', () => {
    it('(a) a room member rating ≤ 2 benches the table until the wider rating clears it', () => {
        const low = signals({ ratings: new Map([['a', { sum: 2, count: 1, memberLow: true }]]) });
        expect(benchReasonFor('a', low)).toBe('low_rating');
        const r = rankAutoPick(games('A', 'B'), low, () => 0)!;
        expect(r.pick.name).toBe('B');
        expect(r.tier).toBe(2);

        // Cleared: ≥ 3 raters averaging ≥ 3.0.
        const cleared = signals({ ratings: new Map([['a', { sum: 2 + 4 + 4, count: 3, memberLow: true }]]) });
        expect(benchReasonFor('a', cleared)).toBeUndefined();
        // Not cleared: 3 raters averaging below 3.
        const notCleared = signals({ ratings: new Map([['a', { sum: 2 + 3 + 3, count: 3, memberLow: true }]]) });
        expect(benchReasonFor('a', notCleared)).toBe('low_rating');
    });

    function rounds(n: number, extra: AutoPickRound[] = []): AutoPickRound[] {
        const out: AutoPickRound[] = [];
        for (let i = 0; i < n; i++) {
            out.push({ name: `R${i}`, startDate: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(), participants: 10 });
        }
        return [...out, ...extra];
    }

    it('(b) a most-recent run below half the median turnout benches — only from THIN_MIN_ROUNDS rounds', () => {
        const thin: AutoPickRound = { name: 'A', startDate: '2026-06-01T00:00:00.000Z', participants: 4 };
        expect(benchReasonFor('a', signals({ rounds: rounds(THIN_MIN_ROUNDS - 2, [thin]) }))).toBeUndefined();
        expect(benchReasonFor('a', signals({ rounds: rounds(THIN_MIN_ROUNDS - 1, [thin]) }))).toBe('thin_turnout');
    });

    it('(b) judges the MOST RECENT run only', () => {
        const older: AutoPickRound = { name: 'A', startDate: '2026-05-01T00:00:00.000Z', participants: 1 };
        const newer: AutoPickRound = { name: 'A', startDate: '2026-06-01T00:00:00.000Z', participants: 9 };
        expect(benchReasonFor('a', signals({ rounds: rounds(10, [older, newer]) }))).toBeUndefined();
        expect(benchReasonFor('a', signals({ rounds: rounds(10, [newer, { ...older, startDate: '2026-07-01T00:00:00.000Z' }]) }))).toBe('thin_turnout');
    });

    it('Tier 3 draws the benched names only when Tiers 1 and 2 are empty', () => {
        const s = signals({ ratings: new Map([['a', { sum: 1, count: 1, memberLow: true }]]) });
        const r = rankAutoPick(games('A'), s, () => 0.5)!;
        expect(r.tier).toBe(3);
        expect(r.pick.name).toBe('A');
        expect(r.benchReason).toBe('low_rating');

        // A queue vote beats the bench: Tier 1 wins even on a benched name.
        const q = rankAutoPick(games('A', 'B'), { ...s, queues: [queue('u1', 'A')] })!;
        expect(q.tier).toBe(1);
        expect(q.pick.name).toBe('A');
    });
});

describe('formatQueueCredit', () => {
    it('joins labels in plain English', () => {
        expect(formatQueueCredit(['A'])).toBe('A');
        expect(formatQueueCredit(['A', 'B'])).toBe('A and B');
        expect(formatQueueCredit(['A', 'B', 'C'])).toBe('A, B and C');
    });
});
