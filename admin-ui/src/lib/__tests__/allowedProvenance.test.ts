import { describe, it, expect } from 'vitest';
import {
    allowedDevicesForEngine,
    allowedDevicesForEngines,
    allowedEngines,
    parseSubmitPlatformsResponse,
} from '../allowedProvenance';
import {
    devicesForEngineAndPlatforms,
    enginesFromLegacyPlatforms,
} from '../scoreProvenance';

/**
 * `GameInfoPopup`'s "What's allowed" section and `SubmissionSheet`'s pickers
 * both call this module. These tests pin it to the derivation SubmissionSheet
 * used before the extraction — if the module ever stops being a faithful
 * restatement of `enginesFromLegacyPlatforms` / `devicesForEngineAndPlatforms`
 * minus exclusions, the card starts advertising options the picker refuses.
 */
describe('allowedProvenance — parity with the picker derivation', () => {
    const submittable = ['vpx', 'pinball_fx', 'atgames'];
    const features = ['vpxs'];

    it('allowedEngines is enginesFromLegacyPlatforms minus engine exclusions', () => {
        expect(allowedEngines(submittable, [])).toEqual(enginesFromLegacyPlatforms(submittable));
        expect(allowedEngines(submittable, ['fx'])).toEqual(
            enginesFromLegacyPlatforms(submittable).filter(e => e !== 'fx'),
        );
    });

    it('allowedDevicesForEngine is devicesForEngineAndPlatforms minus device exclusions', () => {
        expect(allowedDevicesForEngine('vpx', submittable, features, [])).toEqual(
            devicesForEngineAndPlatforms('vpx', submittable, features),
        );
        expect(allowedDevicesForEngine('vpx', submittable, features, ['atgames'])).toEqual(
            devicesForEngineAndPlatforms('vpx', submittable, features).filter(d => d !== 'atgames'),
        );
    });

    it('allowedDevicesForEngines unions per-engine device sets, first-seen order, deduped', () => {
        const engines = allowedEngines(submittable, []);
        const union = allowedDevicesForEngines(engines, submittable, features, []);
        expect(new Set(union).size).toBe(union.length);
        for (const engine of engines) {
            for (const device of allowedDevicesForEngine(engine, submittable, features, [])) {
                expect(union).toContain(device);
            }
        }
        // Every member of the union is reachable from some allowed engine —
        // the popup must never name hardware no picker would offer.
        for (const device of union) {
            expect(
                engines.some(e => allowedDevicesForEngine(e, submittable, features, []).includes(device)),
            ).toBe(true);
        }
    });

    it('device exclusions apply across the whole union, not just one engine', () => {
        const engines = allowedEngines(submittable, []);
        expect(allowedDevicesForEngines(engines, submittable, features, ['atgames'])).not.toContain('atgames');
    });
});

describe('parseSubmitPlatformsResponse', () => {
    it('reads both axes and distinguishes "no active tournament" from "empty rules"', () => {
        const none = parseSubmitPlatformsResponse({
            platforms: ['vpx'], submittable: ['vpx'], features: [], tournamentRules: null,
        });
        expect(none.hasTournament).toBe(false);
        expect(none.exclusions).toEqual({ engines: [], devices: [] });

        const empty = parseSubmitPlatformsResponse({
            platforms: ['vpx'], submittable: ['vpx'], features: [],
            tournamentRules: { engines: { required: [], excluded: [] }, devices: { required: [], excluded: [] } },
        });
        expect(empty.hasTournament).toBe(true);
    });

    it('keeps only the excluded half of each axis — required is game eligibility (ADR 0009)', () => {
        const parsed = parseSubmitPlatformsResponse({
            platforms: ['vpx', 'real'], submittable: ['vpx'], features: ['vpxs'],
            tournamentRules: {
                engines: { required: ['vpx'], excluded: ['real'] },
                devices: { required: ['atgames'], excluded: ['pc'] },
            },
        });
        expect(parsed.exclusions).toEqual({ engines: ['real'], devices: ['pc'] });
        expect(parsed.features).toEqual(['vpxs']);
    });

    it('picks up restrictedText when present and normalizes blank/absent to null', () => {
        expect(parseSubmitPlatformsResponse({
            tournamentRules: { restrictedText: '  AtGames cabinets only.  ' },
        }).restrictedText).toBe('AtGames cabinets only.');
        expect(parseSubmitPlatformsResponse({
            tournamentRules: { restrictedText: '   ' },
        }).restrictedText).toBeNull();
        expect(parseSubmitPlatformsResponse({ tournamentRules: null }).restrictedText).toBeNull();
    });

    it('survives a garbage payload without throwing', () => {
        const parsed = parseSubmitPlatformsResponse({ platforms: 'nope', submittable: null, tournamentRules: 'x' });
        expect(parsed.platforms).toEqual([]);
        expect(parsed.submittable).toEqual([]);
        expect(parsed.exclusions).toEqual({ engines: [], devices: [] });
    });
});
