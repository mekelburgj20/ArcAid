import { describe, it, expect } from 'vitest';
import {
    UNKNOWN,
    devicesForEngineAndPlatforms,
    enginesFromLegacyPlatforms,
    getDeviceDisplay,
    getEngineCategory,
    getEngineCategoryLabel,
    getEngineDisplay,
    getLegacyPlatformLabel,
    isDeviceInformative,
    isEngineDeviceCompatible,
} from '../scoreProvenance';

/**
 * Picker semantics for the SubmissionSheet (ADR 0016 §4). The BE↔FE parity test
 * (`src/__tests__/scoreProvenance-parity.test.ts`) proves this module matches
 * the backend; these tests pin the behaviour the form actually relies on, so a
 * change that keeps parity but breaks the UX still fails.
 */
describe('submission picker derivation', () => {
    it('derives one engine option per distinct engine, so the field auto-locks', () => {
        // vpx and vpxs are the SAME engine — the picker must not show both.
        expect(enginesFromLegacyPlatforms(['vpx', 'vpxs', 'vpxs_manual'])).toEqual(['vpx']);
    });

    it('offers every distinct engine for a multi-surface game', () => {
        // WHO dunnit, the ADR's worked example.
        const engines = enginesFromLegacyPlatforms(['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames']);
        expect(engines).toEqual(['vpx', 'real', 'fx']);
    });

    it('auto-locks to unknown for an AtGames-only game rather than blocking submission', () => {
        expect(enginesFromLegacyPlatforms(['atgames'])).toEqual([UNKNOWN]);
    });

    it('returns no engines for a game with no platforms at all (blocking state)', () => {
        expect(enginesFromLegacyPlatforms([])).toEqual([]);
    });

    it('locks the device when only one can run the engine', () => {
        expect(devicesForEngineAndPlatforms('real', ['real'])).toEqual(['real_cabinet']);
        expect(devicesForEngineAndPlatforms('atgames_native', ['atgames'])).toEqual(['atgames']);
    });

    it('offers AtGames as a device for a VPX game — the case that motivated the split', () => {
        expect(devicesForEngineAndPlatforms('vpx', ['vpx'])).toContain('atgames');
        expect(devicesForEngineAndPlatforms('vpx', ['vpx'])).toContain('pc');
    });

    it('guarantees a device implied by the game platforms is always offered', () => {
        // Even if the compat map were narrower than the catalogue claims.
        expect(devicesForEngineAndPlatforms('vp9', ['vp9', 'atgames'])).toContain('atgames');
    });

    it('rejects an incompatible pair the same way the server does', () => {
        expect(isEngineDeviceCompatible('real', 'pc')).toBe(false);
        expect(isEngineDeviceCompatible('vpx', 'atgames')).toBe(true);
        // 'unknown' is the explicit no-claim value and is always compatible.
        expect(isEngineDeviceCompatible(UNKNOWN, 'pc')).toBe(true);
        expect(isEngineDeviceCompatible('real', UNKNOWN)).toBe(true);
    });

    it('renders human labels, with unknown reading as "Unspecified"', () => {
        expect(getEngineDisplay('vpx')).toBe('Visual Pinball X');
        expect(getDeviceDisplay('atgames')).toBe('AtGames Cabinet');
        // P3: "Unspecified", not "Unknown" — a score whose provenance nobody
        // recorded must say so rather than looking like a rendering bug.
        expect(getEngineDisplay(UNKNOWN)).toBe('Unspecified');
        expect(getDeviceDisplay(UNKNOWN)).toBe('Unspecified');
    });
});

/**
 * Fidelity categories (ADR 0016 §"Fidelity categories derive from engine only",
 * P3 contract §1). These are the assertions that stop `unknown` from being
 * quietly filed into a band it cannot support.
 */
describe('fidelity categories', () => {
    it('maps each engine to its documented band', () => {
        expect(getEngineCategoryLabel('real')).toBe('Real');
        for (const e of ['vpx', 'vp9', 'fp']) {
            expect(getEngineCategoryLabel(e), e).toBe('Simulation');
        }
        for (const e of ['fx', 'fx_classic', 'fx_midnight', 'zaccaria', 'star_wars', 'atgames_native']) {
            expect(getEngineCategoryLabel(e), e).toBe('Arcade-Style');
        }
        for (const e of ['arcade', 'nes', 'snes', 'switch', 'pc']) {
            expect(getEngineCategoryLabel(e), e).toBe('Video Games');
        }
    });

    it('gives the unknown engine NO category at all', () => {
        expect(getEngineCategory(UNKNOWN)).toBeNull();
        expect(getEngineCategoryLabel(UNKNOWN)).toBeNull();
        expect(getEngineCategoryLabel(null)).toBeNull();
        expect(getEngineCategoryLabel('not-an-engine')).toBeNull();
    });

    it('never lets the device affect the category', () => {
        // The AtGames case ADR 0016 exists for: a VPX table on an AtGames
        // cabinet is a Simulation score, not an "AtGames" one.
        for (const device of ['pc', 'atgames', 'vr_headset', 'standalone_other', UNKNOWN]) {
            expect(getEngineCategoryLabel('vpx'), device).toBe('Simulation');
        }
        expect(getEngineCategoryLabel('fx')).toBe('Arcade-Style');
    });

    it('suppresses a device tag that carries no information', () => {
        // Engines with exactly one compatible device tell the reader nothing.
        expect(isDeviceInformative('real', 'real_cabinet')).toBe(false);
        expect(isDeviceInformative('atgames_native', 'atgames')).toBe(false);
        expect(isDeviceInformative('star_wars', 'vr_headset')).toBe(false);
        // …but the pair the split exists for is kept.
        expect(isDeviceInformative('vpx', 'atgames')).toBe(true);
        expect(isDeviceInformative('fx', 'vr_headset')).toBe(true);
        // Unknown device is never rendered as a second "Unspecified".
        expect(isDeviceInformative('vpx', UNKNOWN)).toBe(false);
    });
});

describe('legacy catalogue platform labels', () => {
    it('folds conflated legacy ids onto their engine', () => {
        expect(getLegacyPlatformLabel('vpxs')).toBe('VPX');
        expect(getLegacyPlatformLabel('vpxs_manual')).toBe('VPX');
        expect(getLegacyPlatformLabel('pinball_fx_vr')).toBe('FX');
        expect(getLegacyPlatformLabel('bam')).toBe('Future Pinball');
    });

    it('falls back to the device when the id carries no engine', () => {
        // `atgames` is a device, not an engine — labelling it "Unspecified"
        // would erase a real catalogue fact.
        expect(getLegacyPlatformLabel('atgames')).toBe('AtGames');
        expect(getLegacyPlatformLabel('vr')).toBe('VR');
    });

    it('labels the FX2 era as FX Classic, like the FX3 era', () => {
        // Zen rebranded the line; both generations are the same engine. The
        // map already folded the VR spellings this way.
        expect(getLegacyPlatformLabel('fx2')).toBe('FX Classic');
        expect(getLegacyPlatformLabel('fx3')).toBe('FX Classic');
    });

    it('uppercases an id in neither taxonomy rather than inventing one', () => {
        expect(getLegacyPlatformLabel('xyzzy')).toBe('XYZZY');
        expect(getLegacyPlatformLabel('')).toBe('');
    });
});
