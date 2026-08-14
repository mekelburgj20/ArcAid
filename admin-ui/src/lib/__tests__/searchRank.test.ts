import { describe, it, expect } from 'vitest';
import { rankName, compareByRank } from '../searchRank';

/**
 * Search-relevance work package (owner ask 2026-08-13). Pins the tier scheme
 * from `tmp/search-relevance-contract.md` against the owner's own "Strike"
 * example set. Mirrors `src/__tests__/searchRank.test.ts` on the backend.
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

describe('rankName', () => {
  it('assigns the owner\'s "strike" example set to the documented tiers', () => {
    expect(STRIKE_NAMES.map(n => rankName(n, 'strike'))).toEqual(STRIKE_EXPECTED_TIERS);
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
    expect(rankName('[test]', '[test]')).toBe(0);
  });
});

describe('compareByRank', () => {
  it('sorts the strike set tier-ascending, alphabetical within tier', () => {
    const sorted = [...STRIKE_NAMES].sort(compareByRank('strike', (n: string) => n));
    expect(sorted).toEqual(STRIKE_EXPECTED_ORDER);
  });

  it('works against object rows via the nameOf extractor', () => {
    const rows = STRIKE_NAMES.map(name => ({ name, id: name.length }));
    const sorted = [...rows].sort(compareByRank('strike', r => r.name));
    expect(sorted.map(r => r.name)).toEqual(STRIKE_EXPECTED_ORDER);
  });

  it('leaves order untouched for an empty query relative to a stable pre-sort', () => {
    // Every name ranks tier 4 with an empty query, so a stable sort should
    // fall back to the array's incoming (already alphabetical) order.
    const alphabetical = [...STRIKE_NAMES].sort((a, b) => a.localeCompare(b));
    const sorted = [...alphabetical].sort(compareByRank('', (n: string) => n));
    expect(sorted).toEqual(alphabetical);
  });
});
