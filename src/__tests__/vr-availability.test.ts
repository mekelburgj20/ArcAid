import { describe, it, expect } from 'vitest';
import {
    normalizeTournamentRulesInput,
    passesplatformRules,
    resolveSubmittablePlatforms,
    vrHeadsetMatchesGame,
    type TournamentRules,
} from '../utils/platformRules.js';

/**
 * ADR 0019 — engine-scoped VR availability.
 *
 * The bug: a tournament requiring `engines.required=[zaccaria, fx_classic,
 * star_wars, fx]` + `devices.required=[vr_headset]` admitted Banzai Run,
 * whose `fx` platform (flat Pinball FX, PC/console) and `vr` feature (a VPX
 * VR-Room mod, via VPS) come from two DIFFERENT products — the old rule
 * pooled availability facts into two flat sets and evaluated the axes
 * independently, so "has FX somewhere" × "has VR somewhere" admitted a
 * combination that exists nowhere. An id-anchored audit of the live 280-game
 * VR pick list found 10 confirmed false positives of this class: Banzai Run,
 * Black Knight 2000, Earthshaker, Godzilla (Sega 1998), Jurassic Park, South
 * Park, Swords of Fury, The Machine - Bride of Pin-bot, Tomb Raider
 * (Original 2025), Whirlwind.
 */

function rulesWith(engines: string[], devices: string[]): TournamentRules {
    return normalizeTournamentRulesInput({
        engines: { required: engines, excluded: [] },
        devices: { required: devices, excluded: ['pc', 'atgames', 'real_cabinet', 'standalone_other', 'console'] },
    });
}

describe('ADR 0019 — the Banzai Run false-positive regression', () => {
    const BANZAI_RUN_PLATFORMS = ['vpx', 'real', 'fx'];
    const WG_VR_RULES = rulesWith(['zaccaria', 'fx_classic', 'star_wars', 'fx'], ['vr_headset']);

    it('no longer admits Banzai Run — `fx` platform + generic `vr` feature, no FX VR evidence', () => {
        expect(passesplatformRules(BANZAI_RUN_PLATFORMS, WG_VR_RULES, ['vr', 'vpxs'])).toBe(false);
    });

    it('admits it once the FX VR importer stamps `fx_vr` evidence (Diner-shape re-sync)', () => {
        expect(passesplatformRules(BANZAI_RUN_PLATFORMS, WG_VR_RULES, ['vr', 'vpxs', 'fx_vr'])).toBe(true);
    });

    it('admits a game with `fx_classic_vr` evidence under the same rules (Back to the Future-shape)', () => {
        expect(passesplatformRules(['vpx', 'fx_classic'], WG_VR_RULES, ['vr', 'fx_classic_vr'])).toBe(true);
    });
});

describe('ADR 0019 — wholesale (\'always\') engines qualify with NO per-table evidence', () => {
    it('a plain `vpx` game with no `vr` feature qualifies when `vpx` is required', () => {
        const rules = rulesWith(['vpx'], ['vr_headset']);
        expect(passesplatformRules(['vpx'], rules, [])).toBe(true);
    });

    it('the same `vpx`-wholesale fact does NOT leak into an `fx` requirement', () => {
        const rules = rulesWith(['fx'], ['vr_headset']);
        expect(passesplatformRules(['vpx'], rules, [])).toBe(false);
    });

    it('zaccaria is wholesale — every table qualifies (owner ruling: Zaccaria VR Steam app)', () => {
        const rules = rulesWith(['zaccaria'], ['vr_headset']);
        expect(passesplatformRules(['zaccaria'], rules, [])).toBe(true);
        expect(passesplatformRules(['zaccaria'], rules, ['nothing-relevant'])).toBe(true);
    });

    it('star_wars is wholesale — the product IS a VR app', () => {
        const rules = rulesWith(['star_wars'], ['vr_headset']);
        expect(passesplatformRules(['star_wars'], rules, [])).toBe(true);
    });

    it('fp is wholesale — BAM provides the same wholesale VR capability (owner ruling)', () => {
        const rules = rulesWith(['fp'], ['vr_headset']);
        expect(passesplatformRules(['fp'], rules, [])).toBe(true);
        expect(passesplatformRules(['bam'], rules, [])).toBe(true);
    });
});

describe('ADR 0019 — engine-less `vr_headset` rules (no engines required)', () => {
    const engineLessVr = rulesWith([], ['vr_headset']);

    it('a game with a known non-VR-eligible engine and NO evidence does not match', () => {
        expect(passesplatformRules(['fx'], engineLessVr, [])).toBe(false);
    });

    it('the same game matches once it carries `fx_vr` evidence', () => {
        expect(passesplatformRules(['fx'], engineLessVr, ['fx_vr'])).toBe(true);
    });

    it('a legacy platform-less / unrecognized-engine row with feature `vr` falls back to the generic check', () => {
        expect(passesplatformRules([], engineLessVr, ['vr'])).toBe(true);
        expect(passesplatformRules(['some-room-invented-tag'], engineLessVr, ['vr'])).toBe(true);
    });

    it('a legacy `pinball_fx_vr` platform token (pre-refold row) counts as per-table evidence for `fx`', () => {
        // With NO engine required...
        expect(passesplatformRules(['pinball_fx_vr'], engineLessVr, [])).toBe(true);
        // ...and with `fx` explicitly required.
        const fxRequiredVr = rulesWith(['fx'], ['vr_headset']);
        expect(passesplatformRules(['pinball_fx_vr'], fxRequiredVr, [])).toBe(true);
    });
});

describe('ADR 0019 — `vrHeadsetMatchesGame` directly', () => {
    it('an engine absent from ENGINE_VR_AVAILABILITY never qualifies, required or not', () => {
        expect(vrHeadsetMatchesGame(['atgames_native'], [], ['atgames_native'])).toBe(false);
        expect(vrHeadsetMatchesGame(['atgames_native'], ['vr'], [])).toBe(false);
    });

    it('an unrecognized engine token with generic `vr` still falls back when engine-less', () => {
        expect(vrHeadsetMatchesGame(['nes'], ['vr'], [])).toBe(false); // `nes` IS a recognized (non-VR) engine
        expect(vrHeadsetMatchesGame([], ['vr'], [])).toBe(true); // truly no engine signal at all
    });
});

describe('ADR 0019 — `excluded` axis is untouched (pins current `resolveSubmittablePlatforms` output)', () => {
    it('vr_headset in `excluded` behaves exactly as before this ADR', () => {
        const WHO_DUNNIT = ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'];
        const rules = normalizeTournamentRulesInput({
            devices: { required: [], excluded: ['vr_headset'] },
        });
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, rules))
            .toEqual(['vpx', 'vpxs', 'real', 'pinball_fx', 'atgames']);
    });

    it('a mixed engine+device excluded set is unchanged', () => {
        const WHO_DUNNIT = ['vpx', 'vpxs', 'real', 'pinball_fx', 'pinball_fx_vr', 'atgames'];
        const rules = normalizeTournamentRulesInput({
            engines: { required: [], excluded: ['real'] },
            devices: { required: [], excluded: ['vr_headset'] },
        });
        expect(resolveSubmittablePlatforms(WHO_DUNNIT, rules))
            .toEqual(['vpx', 'vpxs', 'pinball_fx', 'atgames']);
    });
});
