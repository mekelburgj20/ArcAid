import { describe, it, expect } from 'vitest';
import { normalizePlatformList, getPlatformDisplay } from '../platforms';
import {
    CANONICAL_ENGINES,
    foldCataloguePlatforms,
    getLegacyPlatformLabel,
} from '../scoreProvenance';

/**
 * ADR 0016 catalogue phase §6 — the frontend reads an ENGINE catalogue.
 *
 * The load-bearing case is the FE sibling of hazard H-B. `lib/platforms.ts` is
 * an alias table over the OLD taxonomy, and one of its aliases collides with
 * the new engine namespace: `ALIASES['fx'] = 'pinball_fx'`. `GameLibrary` runs
 * every catalogue value through `normalizePlatformList` — for its list, its
 * platform filter and its tag matching — so a row storing the engine id `fx`
 * would have been re-legacied client-side, and the chip, the filter chip and
 * the row would then disagree about what the game is on.
 */

describe('normalizePlatformList — engine ids survive the alias table', () => {
    it('passes every canonical engine id through untouched', () => {
        for (const id of Object.keys(CANONICAL_ENGINES)) {
            expect(normalizePlatformList([id]), id).toEqual([id]);
        }
    });

    it('does not re-legacy `fx` to `pinball_fx`', () => {
        // The specific collision. Before the guard this returned
        // ['pinball_fx'], and the filter chip built from the same call could
        // never match the row it came from.
        expect(normalizePlatformList(['fx'])).toEqual(['fx']);
        expect(normalizePlatformList(['fx_classic'])).toEqual(['fx_classic']);
        expect(normalizePlatformList(['atgames_native'])).toEqual(['atgames_native']);
    });

    it('still alias-folds legacy ids exactly as before', () => {
        // Rows written before migration 129, and any room tag, are unchanged —
        // the guard only decides what happens to the new vocabulary.
        expect(normalizePlatformList(['VPX'])).toEqual(['vpx']);
        expect(normalizePlatformList(['FX3'])).toEqual(['pinball_fx_classic']);
        expect(normalizePlatformList(['vpx', 'VPX', ' vpx '])).toEqual(['vpx']);
    });

    it('keeps a free-form room tag verbatim rather than dropping it', () => {
        expect(normalizePlatformList(['my custom tag'])).toEqual(['my custom tag']);
    });

    it('preserves first-seen order — the primary chip depends on it', () => {
        expect(normalizePlatformList(['fx', 'real', 'vpx'])).toEqual(['fx', 'real', 'vpx']);
    });
});

describe('engine chips render a real label, never a raw token', () => {
    it('labels every canonical engine', () => {
        for (const id of Object.keys(CANONICAL_ENGINES)) {
            const label = getLegacyPlatformLabel(id);
            expect(label, id).toBeTruthy();
            expect(label, id).not.toBe('Unspecified');
            // A raw id leaking onto a chip reads as a rendering bug —
            // "ATGAMES_NATIVE" rather than "AtGames Native".
            expect(label, id).not.toContain('_');
        }
    });

    it('labels the four engines that only exist in the new taxonomy', () => {
        expect(getLegacyPlatformLabel('fx_classic')).toBe('FX Classic');
        expect(getLegacyPlatformLabel('fx_midnight')).toBe('Pinball M');
        expect(getLegacyPlatformLabel('star_wars')).toBe('SW Pinball');
        expect(getLegacyPlatformLabel('atgames_native')).toBe('AtGames Native');
    });

    it('gives a folded row and its legacy predecessor the same chip', () => {
        // Mid-rollout both shapes exist. A user must not see a game's engine
        // change name depending on when the row was last synced.
        for (const legacy of ['vpxs', 'vpxs_manual', 'pinball_fx_vr', 'zaccaria_vr', 'bam']) {
            const [engine] = foldCataloguePlatforms([legacy]).engines;
            expect(getLegacyPlatformLabel(legacy), legacy).toBe(getLegacyPlatformLabel(engine));
        }
    });

    it('leaves room tags to the old display helper', () => {
        // Tags are free-form strings on the old axis, not engines. Folding one
        // would claim a meaning it does not have.
        expect(getPlatformDisplay('some room tag')).toBeTruthy();
    });
});

describe('GameLibrary platform sort key', () => {
    /** Mirrors `primaryEngineLabel` in `pages/GameLibrary.tsx`. */
    const primaryEngineLabel = (raw: string): string => {
        const first = normalizePlatformList(JSON.parse(raw || '[]'))[0];
        return first ? getLegacyPlatformLabel(first, false) : '￿';
    };

    it('sorts on the label the column shows, not the raw JSON string', () => {
        // The old comparator compared `'["vpx"]'` against `'["atgames"]'`
        // character by character — leading `[` and `"` on both sides, so the
        // order followed whatever the importer wrote first and the column
        // sorted by a value the user could not see.
        const rows = ['["vpx"]', '["atgames_native"]', '["fx"]', '[]'];
        const sorted = [...rows].sort((a, b) =>
            primaryEngineLabel(a).localeCompare(primaryEngineLabel(b), undefined, { sensitivity: 'base' }));
        expect(sorted).toEqual(['["atgames_native"]', '["fx"]', '["vpx"]', '[]']);
    });

    it('parks an empty platform list last, where "None" belongs', () => {
        expect(primaryEngineLabel('[]')).toBe('￿');
    });
});
