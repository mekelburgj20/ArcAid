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

/** A hook 0.4.0 `engine` object: the owner's Monster Bash as sampled 2026-10-22, optionally with in-game changes. */
function engineOf(start: Partial<Record<string, unknown>> = {}, changes: Array<Partial<Record<string, unknown>>> = []): string {
    const sample = (over: Partial<Record<string, unknown>>) => ({
        t: 0.5, difficulty: 0.56, slope_min: 6.2, slope_max: 6.2, physics_set: 0, gravity: 0.97, friction: 0.075, elasticity: 0.25,
        elasticity_falloff: 0, scatter: 0, nudge_time: 5, nudge: { xmax: 700, ymax: 700, xgain: 115, ygain: 115, dead_zone: 0, tilt: 500 },
        ...over,
    });
    return JSON.stringify({ start: sample(start), changes: changes.map(sample) });
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

describe('engine evidence (v2.168.0, castcade hook 0.4.0): what was in force during the game', () => {
    const withEngine = (engine: string | null, over: Parameters<typeof rigEvidence>[0] = {}): WitnessEvidence => {
        const e = rigEvidence(over);
        return { ...e, engine: engine === null ? null : parseWitnessEvidence({ engine })!.engine };
    };

    it('parses the hook object and drops junk; absent engine is skipped, never a failure', () => {
        expect(parseWitnessEvidence({ engine: engineOf() })!.engine).toMatchObject({ start: { difficulty: 0.56, physics_set: 0, nudge: { tilt: 500 } }, changes: [] });
        expect(parseWitnessEvidence({ engine: '{"start":"nope","changes":"nope"}' })).toBeNull();
        expect(parseWitnessEvidence({ engine: 'not json' })).toBeNull();
        const v = run(withEngine(null));
        expect(v.verdict).toBe('pass');
        expect(v.checks.find(c => c.rule === 'engine')).toMatchObject({ status: 'skipped' });
    });

    it('a quiet game with the file values in force passes and says so', () => {
        const v = run(withEngine(engineOf()));
        expect(v.verdict).toBe('pass');
        expect(v.checks.find(c => c.rule === 'engine')).toMatchObject({ status: 'pass', detail: 'in force for the whole game: difficulty 56%, slope 6.20°, physics set 0, tilt sensitivity 500' });
        expect(v.checks.find(c => c.rule === 'tilt_sensitivity')).toMatchObject({ status: 'pass', detail: 'tilt sensitivity 500 (live)' });
    });

    it('an in-game change (the tweak menu) flags the game and names what moved', () => {
        const v = run(withEngine(engineOf({}, [{ t: 412.3, difficulty: 0.9 }, { t: 500, difficulty: 0.9, nudge: { xmax: 700, ymax: 700, xgain: 115, ygain: 115, dead_zone: 0, tilt: 10 } }])));
        expect(v.verdict).toBe('flagged');
        expect(v.reasons).toEqual(['physics or difficulty changed during the game (2 changes: difficulty 56% → 90%, tilt sensitivity 500 → 10)']);
    });

    it('a live physics set, or a live difficulty that differs from the table file, fails even when the ini looked stock', () => {
        expect(run(withEngine(engineOf({ physics_set: 3 }))).reasons).toEqual(['physics set 3 was in force']);
        expect(run(withEngine(engineOf({ difficulty: 0.9 }))).reasons).toEqual(['difficulty in force 90% differs from the table\'s 56%']);
        // A saved override is the stock_physics rule's job; the engine rule does not double-report it.
        const v = run(withEngine(engineOf({ difficulty: 0.9 }), { ini: { difficulty_override: 0.9, difficulty: 0.9 } }));
        expect(v.checks.find(c => c.rule === 'stock_physics')).toMatchObject({ status: 'fail' });
        expect(v.checks.find(c => c.rule === 'engine')).toMatchObject({ status: 'pass' });
    });

    it('the live tilt sensitivity beats the ini for the minimum (the ini may be a session stale)', () => {
        const v = run(withEngine(engineOf({ nudge: { xmax: 700, ymax: 700, xgain: 115, ygain: 115, dead_zone: 0, tilt: 10 } })));
        expect(v.reasons).toEqual(['tilt sensitivity 10 (live) is below the minimum 300']);
        expect(run(withEngine(engineOf()), { require_stock_physics: false }).checks.find(c => c.rule === 'engine')).toMatchObject({ status: 'skipped', detail: 'rule off' });
    });
});

describe('engine difficulty on the 0–100 scale (v2.170.0, W40 / castcade F10: companion 0.2.12)', () => {
    /** Medieval Madness as 0.2.12 sent it 2026-10-25: table file 0.5, engine 50 (VPX's script-API scale). */
    const mm = (start: Partial<Record<string, unknown>>, changes: Array<Partial<Record<string, unknown>>> = []): WitnessEvidence => {
        const e = rigEvidence({ ini: { difficulty: 0.5 } });
        return { ...e, engine: parseWitnessEvidence({ engine: engineOf({ slope_min: 6, slope_max: 7, ...start }, changes) })!.engine };
    };

    it('reads a difficulty above 1 as a percentage, in start and in every change', () => {
        const parsed = parseWitnessEvidence({ engine: engineOf({ difficulty: 50 }, [{ difficulty: 56.25 }]) })!.engine!;
        expect(parsed.start!.difficulty).toBe(0.5);
        expect(parsed.changes[0]!.difficulty).toBe(0.5625);
    });

    it('a 0.2.12 sample (difficulty 50, table 0.5) passes the difficulty check, with the slope from 0.5', () => {
        const v = run(mm({ difficulty: 50 }));
        expect(v.verdict).toBe('pass');
        expect(v.checks.find(c => c.rule === 'engine')).toMatchObject({ status: 'pass', detail: 'in force for the whole game: difficulty 50%, slope 6.50°, physics set 0, tilt sensitivity 500' });
    });

    it('a 0–1 sample (0.2.13+) reads exactly as before, and a real 0.2.12 difference still fails', () => {
        expect(run(mm({ difficulty: 0.5 })).checks.find(c => c.rule === 'engine')).toMatchObject({ status: 'pass', detail: expect.stringContaining('difficulty 50%, slope 6.50°') });
        expect(run(mm({ difficulty: 90 })).reasons).toEqual(['difficulty in force 90% differs from the table\'s 50%']);
        // A 0.2.12 in-game change is named on the 0–1 scale too.
        expect(run(mm({ difficulty: 50 }, [{ difficulty: 80 }])).reasons).toEqual(['physics or difficulty changed during the game (1 change: difficulty 50% → 80%)']);
    });
});

describe('score_plausibility (v2.170.0, W41 / castcade B6.1): flag only, never a gate', () => {
    const FLAGGED = JSON.stringify({ samples: 212, gcd: 1, step: 10, off_step: 1, largest: { points: 9000001, t: 410.25, ball: 3 }, flag: '1 score change not a multiple of 10 (first +9,000,001); ROM scores move in steps of 10' });

    it('parses the companion object and drops junk (malformed = dropped, never a failure)', () => {
        const base = { vps_table: 'uVgZUZdK' };
        expect(parseWitnessEvidence({ ...base, score_plausibility: FLAGGED })!.scorePlausibility).toEqual({
            samples: 212, gcd: 1, step: 10, off_step: 1, largest: { points: 9000001, t: 410.25, ball: 3 },
            flag: '1 score change not a multiple of 10 (first +9,000,001); ROM scores move in steps of 10',
        });
        expect(parseWitnessEvidence({ ...base, score_plausibility: '{"samples":3,"gcd":null,"step":null,"off_step":0,"largest":null,"flag":null}' })!.scorePlausibility)
            .toEqual({ samples: 3, gcd: null, step: null, off_step: 0, largest: null, flag: null });
        expect(parseWitnessEvidence({ ...base, score_plausibility: 'not json' })!.scorePlausibility).toBeNull();
        expect(parseWitnessEvidence({ ...base, score_plausibility: '{"samples":"lots","off_step":0}' })!.scorePlausibility).toBeNull();
        expect(parseWitnessEvidence({ ...base, score_plausibility: '[1,2]' })!.scorePlausibility).toBeNull();
        expect(parseWitnessEvidence({ ...base })!.scorePlausibility).toBeNull();
        // On its own it is not evidence: it never turns a "no evidence" score into an evaluated one.
        expect(parseWitnessEvidence({ score_plausibility: FLAGGED })).toBeNull();
    });

    it('a flagged score_plausibility does not change the Sanctioned evaluation, passing or failing', () => {
        const flaggedPlaus = parseWitnessEvidence({ vps_table: 'x', score_plausibility: FLAGGED })!.scorePlausibility;
        expect(flaggedPlaus?.flag).toBeTruthy();
        for (const base of [rigEvidence(), rigEvidence({ ini: { tilt_sens: 10 } })]) {
            const without = run({ ...base, scorePlausibility: null });
            const withFlag = run({ ...base, scorePlausibility: flaggedPlaus });
            expect(withFlag).toEqual(without);
            expect(withFlag.checks.map(c => c.rule)).not.toContain('score_plausibility');
        }
        expect(run(rigEvidence()).verdict).toBe('pass');
    });
});
