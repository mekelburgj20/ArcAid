import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import { rankName, nameRankSqlCase, nameRankSqlParams } from '../utils/searchRank.js';

/**
 * Search-relevance work package (owner ask 2026-08-13). Pins the tier scheme
 * from `tmp/search-relevance-contract.md` against the owner's own "Strike"
 * example set, for both the pure-JS ranker (Discord autocompletes) and the
 * SQL CASE fragment (backend search sites).
 */

const STRIKE_NAMES = [
    'Strike',
    'Strike Zone',
    'Strike Master',
    'Lucky Strike',
    'Triple Strike',
    'Striker',
    'Strikes and Spares',
    'Star Wars: Episode V The Empire Strikes Back',
    'Gold Strike',
    'Bowl A Strike',
];
const STRIKE_EXPECTED_TIERS = [0, 1, 1, 2, 2, 3, 3, 3, 2, 2];
const STRIKE_EXPECTED_ORDER = [
    'Strike',
    'Strike Master',
    'Strike Zone',
    'Bowl A Strike',
    'Gold Strike',
    'Lucky Strike',
    'Triple Strike',
    'Star Wars: Episode V The Empire Strikes Back',
    'Striker',
    'Strikes and Spares',
];

describe('rankName (JS ranker)', () => {
    it('assigns the owner\'s "strike" example set to the documented tiers', () => {
        expect(STRIKE_NAMES.map(n => rankName(n, 'strike'))).toEqual(STRIKE_EXPECTED_TIERS);
    });

    it('sorts the strike set tier-ascending, alphabetical within tier', () => {
        const sorted = [...STRIKE_NAMES].sort((a, b) => {
            const diff = rankName(a, 'strike') - rankName(b, 'strike');
            if (diff !== 0) return diff;
            return a.localeCompare(b);
        });
        expect(sorted).toEqual(STRIKE_EXPECTED_ORDER);
    });

    it('is case-insensitive and trims surrounding whitespace on both sides', () => {
        expect(rankName('STRIKE ZONE', '  strike  ')).toBe(1);
        expect(rankName('  Strike  ', 'strike')).toBe(0);
    });

    it('an empty query ranks tier 4 — callers must guard for the "untouched default order" rule', () => {
        expect(rankName('Strike', '')).toBe(4);
    });

    it('treats % and [ as literal characters, never as wildcards', () => {
        expect(rankName('100% Off Deal', '100%')).toBe(1);
        expect(rankName('Something Else Entirely', '100%')).toBe(4);
        expect(rankName('[Test] Table', '[test]')).toBe(1);
    });
});

describe('nameRankSqlCase / nameRankSqlParams (SQL fragment)', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    async function sqlRank(name: string, query: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ rank: number }>(
            `SELECT ${nameRankSqlCase('t.name')} as rank FROM (SELECT ? AS name) t`,
            ...nameRankSqlParams(query), name,
        );
        return row!.rank;
    }

    it('assigns the owner\'s "strike" example set to the documented tiers', async () => {
        const tiers: number[] = [];
        for (const name of STRIKE_NAMES) {
            tiers.push(await sqlRank(name, 'strike'));
        }
        expect(tiers).toEqual(STRIKE_EXPECTED_TIERS);
    });

    it('agrees with the JS ranker on every name in the strike set', async () => {
        for (const name of STRIKE_NAMES) {
            expect(await sqlRank(name, 'strike')).toBe(rankName(name, 'strike'));
        }
    });

    it('treats % and _ as literal characters in the LIKE-based tiers', async () => {
        expect(await sqlRank('100% Off Deal', '100%')).toBe(1);
        expect(await sqlRank('Something Else Entirely', '100%')).toBe(4);
        expect(await sqlRank('under_score item', 'under_score')).toBe(1);
        expect(await sqlRank('underXscore item', 'under_score')).toBe(4);
    });

    it('treats [ as a literal character in the GLOB-based tiers', async () => {
        // "[test]" as a whole word inside the name — tier 2.
        expect(await sqlRank('Arcade [test] Cabinet', '[test]')).toBe(2);
        // "[test]" at the very start — tier 1.
        expect(await sqlRank('[Test] Table', '[test]')).toBe(1);
        // Exact.
        expect(await sqlRank('[test]', '[test]')).toBe(0);
    });

    it('ranks a name with no match at all as tier 4', async () => {
        expect(await sqlRank('Completely Different', 'strike')).toBe(4);
    });
});
