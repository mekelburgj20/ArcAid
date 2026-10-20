import { describe, it, expect } from 'vitest';
import {
    DEFAULT_SANCTIONED_RULES, evaluateSanctioned, normalizeSanctionedRules, parseWitnessEvidence,
    type GameRequirements, type WitnessEvidence,
} from '../utils/sanctionedRules.js';

/**
 * Integrity mode — the Sanctioned rules as a pure function (v2.165.0, ADR 0027).
 *
 * The evaluation decides whether an auto-ingested witness score is written to
 * a Sanctioned tournament's board, so every branch that could hold a legitimate
 * score out — or let a rigged one in — is pinned here against the evidence the
 * Castcade companion actually sends (castcade `docs/arcaid-side-changes.md`
 * item 11). The route-level behaviour is in `witness-integrity.test.ts`.
 */

const NONE: GameRequirements = { requiredVpsTableId: null, requiredRom: null, requiredFingerprint: null };
const SHA = 'a'.repeat(64);

/** The owner's rig on 2026-10-20, as 0.2.8 reported it: Panasony VPX, VPinMAME nightly, accelerometer on. */
function rigEvidence(over: Partial<{ ini: Record<string, unknown>; build: Record<string, unknown>; adjustments: Record<string, unknown> | null }> = {}): WitnessEvidence {
    const ini = {
        set: 0, set_name: null, flippers: false, stock: true, difficulty: 0.56, difficulty_override: null,
        slope: 6.2, nudge: 0.0008, legacy_nudge: false, nudge_filter: false, nudge_sensitivity: null,
        accel: true, accel_gain_x: 115, accel_gain_y: 115, accel_max_x: 100, accel_max_y: 100, accel_velocity: false,
        tilt_sens: 500, tilt_sens_set: true, options: {}, overrides: [], table_ini: true,
        ...(over.ini ?? {}),
    };
    const build = {
        vpx: { sha256: SHA, version: '10.8.0.2078.Panasony', known: null, family: 'panasony' },
        vpinmame: { sha256: 'b'.repeat(64), version: '3, 7, 0, 222', known: null, family: 'nightly' },
        cheat: false,
        ...(over.build ?? {}),
    };
    return parseWitnessEvidence({
        vps_game: 'fXaQ33KC', vps_table: 'uVgZUZdK', table_sha256: SHA, table_save_rev: '12',
        ini: JSON.stringify(ini),
        build: JSON.stringify(build),
        ...(over.adjustments === null ? {} : { adjustments: JSON.stringify(over.adjustments ?? { total: 52, items: [], non_factory: [] }) }),
    })!;
}

const run = (evidence: WitnessEvidence | null, rules: Partial<Parameters<typeof normalizeSanctionedRules>[0] & object> = {}, requirements = NONE, rom: string | null = 'tftc_400') =>
    evaluateSanctioned({ rules: normalizeSanctionedRules(rules), requirements, evidence, rom });

describe('normalizeSanctionedRules', () => {
    it('fills every field from the defaults and tolerates a JSON string, null and junk', () => {
        expect(normalizeSanctionedRules(null)).toEqual(DEFAULT_SANCTIONED_RULES);
        expect(normalizeSanctionedRules('{"min_tilt_sensitivity":350}').min_tilt_sensitivity).toBe(350);
        expect(normalizeSanctionedRules('not json')).toEqual(DEFAULT_SANCTIONED_RULES);
        expect(normalizeSanctionedRules({ min_tilt_sensitivity: 'abc', bogus: true })).toEqual(DEFAULT_SANCTIONED_RULES);
    });

    it('clamps numbers and cleans lists (blessed hashes must be 64 hex)', () => {
        const r = normalizeSanctionedRules({
            min_tilt_sensitivity: 5000, max_accel_gain: -3,
            blessed_build_hashes: [SHA.toUpperCase(), 'nope', 42],
            adjustments_allowed: [' Free Play ', 'Free Play', '', 7],
        });
        expect(r.min_tilt_sensitivity).toBe(1000);
        expect(r.max_accel_gain).toBe(0);
        expect(r.blessed_build_hashes).toEqual([SHA]);
        expect(r.adjustments_allowed).toEqual(['Free Play']);
    });

    it('an explicit empty allow-list means "nothing may differ" — it is not replaced by the default', () => {
        expect(normalizeSanctionedRules({ adjustments_allowed: [] }).adjustments_allowed).toEqual([]);
    });
});

describe('parseWitnessEvidence', () => {
    it('returns null when nothing evidence-like is present (a cabinet, or a 0.2.3 companion)', () => {
        expect(parseWitnessEvidence({ table: 'Bad Cats', score: '1' })).toBeNull();
    });

    it('drops a malformed or oversized JSON param and keeps the rest', () => {
        const e = parseWitnessEvidence({ vps_game: 'fXaQ33KC', ini: '{nope', build: 'x'.repeat(20_000) });
        expect(e).toMatchObject({ vpsGame: 'fXaQ33KC', ini: null, build: null });
    });

    it('reads an older companion build object (no family) as official when a known id is present', () => {
        const e = parseWitnessEvidence({ build: JSON.stringify({ vpx: { sha256: SHA, version: '10.8.0.2051', known: 'vpx-10.8.0-2051-gl-x64' }, cheat: false }) });
        expect(e!.build!.vpx!.family).toBe('official');
    });
});

describe('evaluateSanctioned', () => {
    it('no evidence at all fails as one line', () => {
        const v = run(null);
        expect(v.verdict).toBe('flagged');
        expect(v.reasons).toHaveLength(1);
        expect(v.reasons[0]).toMatch(/no evidence/);
    });

    it("the owner's rig with the defaults passes: Panasony VPX, VPinMAME nightly, accelerometer at 115%, tilt 500", () => {
        const v = run(rigEvidence());
        expect(v.verdict).toBe('pass');
        expect(v.checks.find(c => c.rule === 'known_build')).toMatchObject({ status: 'pass' });
        expect(v.checks.find(c => c.rule === 'named_table')).toMatchObject({ status: 'skipped' });
    });

    it('tilt sensitivity 10 (the owner\'s actual setting) fails the 300 minimum, and 0 reads as analog tilt off', () => {
        expect(run(rigEvidence({ ini: { tilt_sens: 10 } })).reasons).toEqual(['tilt sensitivity 10 is below the minimum 300']);
        expect(run(rigEvidence({ ini: { tilt_sens: 0 } })).reasons[0]).toMatch(/analog tilt is off/);
        // VPX's own default (the companion reports 400 when the key is absent) passes.
        expect(run(rigEvidence({ ini: { tilt_sens: 400, tilt_sens_set: false } })).verdict).toBe('pass');
    });

    it('the accelerometer rules do not apply when the accelerometer is off, and the runner can raise the bar', () => {
        expect(run(rigEvidence({ ini: { accel: false, tilt_sens: 10 } })).verdict).toBe('pass');
        expect(run(rigEvidence(), { min_tilt_sensitivity: 600 }).reasons[0]).toMatch(/500 is below the minimum 600/);
        expect(run(rigEvidence({ ini: { accel_gain_y: 200 } })).reasons[0]).toMatch(/gain 115\/200% exceeds the maximum 150%/);
        expect(run(rigEvidence(), { require_nudge_filter: true }).reasons[0]).toMatch(/nudge filter is off/);
    });

    it('stock physics: a physics set, a flipper override or a difficulty override each fail', () => {
        expect(run(rigEvidence({ ini: { set: 1, set_name: 'Mousing Around', stock: false } })).reasons[0]).toMatch(/physics set "Mousing Around"/);
        expect(run(rigEvidence({ ini: { flippers: true, stock: false } })).reasons[0]).toMatch(/flipper physics/);
        expect(run(rigEvidence({ ini: { difficulty_override: 0.9 } })).reasons[0]).toMatch(/difficulty overridden to 90%/);
        expect(run(rigEvidence({ ini: { difficulty_override: 0.9 } }), { require_stock_physics: false }).verdict).toBe('pass');
    });

    it('adjustments: absence is unverifiable (skipped, not failed); free play is allowed by default; anything else fails', () => {
        expect(run(rigEvidence({ adjustments: null })).checks.find(c => c.rule === 'factory_adjustments')).toMatchObject({ status: 'skipped' });
        expect(run(rigEvidence({ adjustments: { total: 52, items: [], non_factory: ['Free Play'] } })).verdict).toBe('pass');
        const v = run(rigEvidence({ adjustments: { total: 52, items: [], non_factory: ['Free Play', 'Balls Per Game'] } }));
        expect(v.reasons).toEqual(['non-factory adjustments: Balls Per Game']);
        expect(run(rigEvidence({ adjustments: { total: 52, items: [], non_factory: ['Balls Per Game'] } }), { adjustments_allowed: ['balls per game'] }).verdict).toBe('pass');
    });

    it('builds: official and Panasony pass; nightly passes unless the runner turns it off; unknown needs a blessed hash; cheat always fails', () => {
        expect(run(rigEvidence(), { allow_nightly_builds: false }).reasons[0]).toMatch(/VPinMAME .* nightly/);
        const unknown = rigEvidence({ build: { vpx: { sha256: SHA, version: '10.8.0.9999', known: null, family: 'unknown' } } });
        expect(run(unknown).reasons[0]).toMatch(/VPX .* unrecognised build/);
        expect(run(unknown, { blessed_build_hashes: [SHA] }).verdict).toBe('pass');
        expect(run(rigEvidence({ build: { cheat: true } })).reasons).toEqual(['VPinMAME cheat option is ON for this ROM']);
        expect(run(rigEvidence({ build: { cheat: true } }), { require_known_build: false }).reasons).toEqual(['VPinMAME cheat option is ON for this ROM']);
    });

    it('the named table: unconfigured skips, a different table fails, an unidentified table fails, a match passes', () => {
        const req = { ...NONE, requiredVpsTableId: 'uVgZUZdK' };
        expect(run(rigEvidence(), {}, req).verdict).toBe('pass');
        expect(run(rigEvidence(), {}, { ...NONE, requiredVpsTableId: 'OTHER' }).reasons[0]).toMatch(/different table .*uVgZUZdK, required OTHER/);
        const noTable = parseWitnessEvidence({ vps_game: 'fXaQ33KC', ini: JSON.stringify({ stock: true }), build: JSON.stringify({ vpx: { family: 'official' }, cheat: false }) })!;
        expect(run(noTable, {}, req).reasons[0]).toMatch(/not identified/);
        expect(run(rigEvidence(), { require_named_table: false }, { ...NONE, requiredVpsTableId: 'OTHER' }).verdict).toBe('pass');
    });

    it('the required ROM and the blessed fingerprint behave the same way', () => {
        expect(run(rigEvidence(), {}, { ...NONE, requiredRom: 'TFTC_400' }).verdict).toBe('pass');
        expect(run(rigEvidence(), {}, { ...NONE, requiredRom: 'tftc_303' }).reasons[0]).toMatch(/ROM tftc_400 is not the required tftc_303/);
        expect(run(rigEvidence(), {}, { ...NONE, requiredFingerprint: 'fp1' }).reasons[0]).toMatch(/no playfield fingerprint/);
    });
});
