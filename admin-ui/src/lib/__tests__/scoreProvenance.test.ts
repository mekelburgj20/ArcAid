import { describe, it, expect } from 'vitest';
import {
    UNKNOWN,
    devicesForEngineAndPlatforms,
    enginesFromLegacyPlatforms,
    getDeviceDisplay,
    getEngineDisplay,
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

    it('renders human labels, with unknown reading as "Unknown"', () => {
        expect(getEngineDisplay('vpx')).toBe('Visual Pinball X');
        expect(getDeviceDisplay('atgames')).toBe('AtGames Cabinet');
        expect(getEngineDisplay(UNKNOWN)).toBe('Unknown');
        expect(getDeviceDisplay(UNKNOWN)).toBe('Unknown');
    });
});
