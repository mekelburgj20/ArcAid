import { describe, it, expect } from 'vitest';
import {
    CANONICAL_ENGINES,
    CATALOGUE_PLATFORM_FEATURE,
    DEVICE_AVAILABILITY_FEATURES,
    LEGACY_PLATFORM_MAP,
    UNKNOWN,
    foldCataloguePlatforms,
    isCanonicalEngine,
} from '../utils/scoreProvenance.js';

/**
 * The catalogue fold (ADR 0016 §"Catalogue describes engines, not devices",
 * contract §2).
 *
 * `global_games.platforms` mixed "what this table was authored for" with "what
 * it happens to be available on". The fold separates them: engines stay in
 * `platforms`, availability moves to `features`. ONE helper does it, for the
 * migration and for all seven importers — because a migration that cleans the
 * data and an importer that re-pollutes it on the next sync is worse than
 * neither (hazard H-F).
 *
 * Every row of the contract's fold table is asserted below. A row missing here
 * is a legacy id whose catalogue meaning nobody decided.
 */

/** [input legacy id, expected engines, expected features] — contract §2's table. */
const FOLD_TABLE: Array<[string, string[], string[]]> = [
    ['real',                  ['real'],           []],
    ['vpx',                   ['vpx'],            []],
    ['vpxs',                  ['vpx'],            ['vpxs']],
    ['vpxs_manual',           ['vpx'],            ['vpxs_manual']],
    ['vp9',                   ['vp9'],            []],
    ['fp',                    ['fp'],             []],
    ['bam',                   ['fp'],             ['bam']],
    ['pinball_fx',            ['fx'],             []],
    ['pinball_fx_vr',         ['fx'],             ['vr']],
    ['pinball_fx_classic',    ['fx_classic'],     []],
    ['pinball_fx_classic_vr', ['fx_classic'],     ['vr']],
    ['pinball_fx_midnight',   ['fx_midnight'],    []],
    ['star_wars_pinball_vr',  ['star_wars'],      ['vr']],
    ['zaccaria',              ['zaccaria'],       []],
    ['zaccaria_vr',           ['zaccaria'],       ['vr']],
    ['atgames',               ['atgames_native'], ['atgames']],
    // console / arcade / pc ids: the id already IS the engine.
    ['nes',                   ['nes'],            []],
    ['snes',                  ['snes'],           []],
    ['arcade',                ['arcade'],         []],
    ['pc',                    ['pc'],             []],
];

describe('foldCataloguePlatforms — the contract §2 fold table', () => {
    it.each(FOLD_TABLE)('folds %s → engines %j + features %j', (input, engines, features) => {
        const fold = foldCataloguePlatforms([input]);
        expect(fold.engines).toEqual(engines);
        expect(fold.features).toEqual(features);
        expect(fold.dropped).toEqual([]);
    });

    it('accepts the alias spellings a catalogue row or room tag can carry', () => {
        // These reach `platforms` through importers and free-form room tags,
        // so folding only the canonical spelling would drop real availability.
        expect(foldCataloguePlatforms(['VPX Standalone'])).toEqual({
            engines: ['vpx'], features: ['vpxs'], dropped: [],
        });
        expect(foldCataloguePlatforms(['VPX Standalone (Manual Install)'])).toEqual({
            engines: ['vpx'], features: ['vpxs_manual'], dropped: [],
        });
        expect(foldCataloguePlatforms(['Pinball FX VR'])).toEqual({
            engines: ['fx'], features: ['vr'], dropped: [],
        });
        expect(foldCataloguePlatforms(['ATGAMES'])).toEqual({
            engines: ['atgames_native'], features: ['atgames'], dropped: [],
        });
    });

    it('folds the bare `vr` seed token to a feature with no engine', () => {
        // From the original `PLATFORMS` seed (['AtGames','VPXS','VR','IRL']).
        // It states availability and nothing about what produced a score, so it
        // is a feature — and specifically NOT junk, which would lose the fact.
        expect(foldCataloguePlatforms(['vr'])).toEqual({
            engines: [], features: ['vr'], dropped: [],
        });
    });

    it('dedups engines that several legacy ids collapse onto', () => {
        const fold = foldCataloguePlatforms(['vpx', 'vpxs', 'vpxs_manual']);
        expect(fold.engines).toEqual(['vpx']);
        expect(fold.features).toEqual(['vpxs', 'vpxs_manual']);
    });

    it('dedups repeated tokens and repeated features', () => {
        const fold = foldCataloguePlatforms(['zaccaria_vr', 'pinball_fx_vr', 'zaccaria_vr']);
        expect(fold.engines).toEqual(['zaccaria', 'fx']);
        expect(fold.features).toEqual(['vr']);
    });

    it('preserves first-seen engine order — this IS the primary-chip rule', () => {
        // `engines[0]` is the primary chip on every card surface (hazard H-E).
        // Whichever legacy id appeared first in the source list wins, so a
        // re-ordered importer payload cannot silently re-brand a game.
        expect(foldCataloguePlatforms(['vpxs', 'real', 'pinball_fx']).engines)
            .toEqual(['vpx', 'real', 'fx']);
        expect(foldCataloguePlatforms(['pinball_fx', 'real', 'vpxs']).engines)
            .toEqual(['fx', 'real', 'vpx']);
    });

    it('routes junk to `dropped` rather than discarding it silently', () => {
        // `fx2` is the real one: it is NOT a legacy id (`fx3` is), so it has
        // always resolved to nothing. Callers log these — the migration with
        // the row id, so a bad token is findable instead of merely absent.
        const fold = foldCataloguePlatforms(['vpx', 'fx2', 'total nonsense', 'vpx']);
        expect(fold.engines).toEqual(['vpx']);
        expect(fold.features).toEqual([]);
        expect(fold.dropped).toEqual(['fx2', 'total nonsense']);
    });

    it('dedups dropped tokens too', () => {
        expect(foldCataloguePlatforms(['fx2', 'FX2', ' fx2 ']).dropped).toEqual(['fx2']);
    });

    it('ignores empty and whitespace-only tokens without calling them junk', () => {
        expect(foldCataloguePlatforms(['', '   ', 'vpx'])).toEqual({
            engines: ['vpx'], features: [], dropped: [],
        });
        expect(foldCataloguePlatforms([])).toEqual({ engines: [], features: [], dropped: [] });
    });
});

describe('foldCataloguePlatforms — idempotence', () => {
    /**
     * The migration re-runs on every deploy that has not recorded it, and every
     * importer folds unconditionally without checking whether a row was already
     * migrated. Both are only safe because folding an already-folded list is a
     * fixed point.
     */
    it('is a fixed point on the engine axis for every canonical engine id', () => {
        for (const id of Object.keys(CANONICAL_ENGINES)) {
            const fold = foldCataloguePlatforms([id]);
            expect(fold.engines, id).toEqual([id]);
            expect(fold.dropped, id).toEqual([]);
            // An engine id asserts nothing about availability, so a second fold
            // must not invent a feature. (`atgames` → `atgames_native` carries
            // feature `atgames`; `atgames_native` itself does not.)
            expect(fold.features, id).toEqual([]);
        }
    });

    it('re-folding any legacy list changes nothing', () => {
        const inputs = [
            ['vpx', 'vpxs', 'atgames'],
            ['pinball_fx_vr', 'zaccaria_vr', 'star_wars_pinball_vr'],
            ['bam', 'fp', 'vr'],
            ['real', 'nes', 'fx2'],
            Object.keys(LEGACY_PLATFORM_MAP),
        ];
        for (const input of inputs) {
            const once = foldCataloguePlatforms(input);
            const twice = foldCataloguePlatforms(once.engines);
            expect(twice.engines, JSON.stringify(input)).toEqual(once.engines);
            expect(twice.features, JSON.stringify(input)).toEqual([]);
            expect(twice.dropped, JSON.stringify(input)).toEqual([]);
        }
    });

    it('converges a half-migrated row rather than degrading it', () => {
        // Engines already folded, one legacy id left behind (an importer that
        // ran between the migration and the release, say).
        const fold = foldCataloguePlatforms(['vpx', 'atgames']);
        expect(fold.engines).toEqual(['vpx', 'atgames_native']);
        expect(fold.features).toEqual(['atgames']);
    });
});

describe('fold tables — structural invariants', () => {
    it('emits only canonical engine ids', () => {
        // A fold that produced a non-canonical id would reopen hazard H-A:
        // `enginesFromLegacyPlatforms` would read it as unknown and the submit
        // picker would auto-lock to Unspecified — the bug this phase kills.
        const all = foldCataloguePlatforms(Object.keys(LEGACY_PLATFORM_MAP));
        for (const engine of all.engines) {
            expect(isCanonicalEngine(engine), engine).toBe(true);
        }
    });

    it('keys every feature entry on a token the taxonomy or the seed knows', () => {
        for (const token of Object.keys(CATALOGUE_PLATFORM_FEATURE)) {
            expect(
                Object.prototype.hasOwnProperty.call(LEGACY_PLATFORM_MAP, token),
                `feature key "${token}" is not a legacy platform id`,
            ).toBe(true);
        }
    });

    it('gives every legacy id an engine, a feature, or both — nothing silently vanishes', () => {
        for (const [token, prov] of Object.entries(LEGACY_PLATFORM_MAP)) {
            const fold = foldCataloguePlatforms([token]);
            const hasMeaning = fold.engines.length > 0 || fold.features.length > 0;
            expect(hasMeaning, `legacy id "${token}" folds to nothing`).toBe(true);
            expect(fold.dropped, token).toEqual([]);
            // The engine half must agree with the score-axis taxonomy, except
            // where an explicit catalogue override applies (`atgames`).
            if (prov.engine !== UNKNOWN) expect(fold.engines, token).toContain(prov.engine);
        }
    });

    it('lists only real features under each device, and only real devices', () => {
        const knownFeatures = new Set(Object.values(CATALOGUE_PLATFORM_FEATURE));
        for (const [device, features] of Object.entries(DEVICE_AVAILABILITY_FEATURES)) {
            expect(features.length, device).toBeGreaterThan(0);
            for (const f of features) {
                expect(knownFeatures.has(f), `${device} → unknown feature "${f}"`).toBe(true);
            }
        }
    });

    it('maps every legacy id that denoted a device onto that device\'s feature set', () => {
        // The equivalence guarantee in one assertion: if a legacy token used to
        // match a device-`required` rule (because `LEGACY_PLATFORM_MAP` gave it
        // that device), its folded form must still carry a feature that device
        // recognises — otherwise `required: ['atgames']` quietly starts
        // admitting fewer games than it does today (hazard H-C).
        for (const [token, prov] of Object.entries(LEGACY_PLATFORM_MAP)) {
            const wanted = DEVICE_AVAILABILITY_FEATURES[prov.device];
            if (!wanted) continue;
            const fold = foldCataloguePlatforms([token]);
            expect(
                fold.features.some(f => wanted.includes(f)),
                `"${token}" denoted device ${prov.device} but folds to features ${JSON.stringify(fold.features)}`,
            ).toBe(true);
        }
    });
});
