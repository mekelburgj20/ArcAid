/**
 * Integrity mode — Open play / Sanctioned play (v2.165.0, ADR 0027; Castcade ADR 0005).
 *
 * A tournament is in ONE of two modes. **Open play** (the default, every
 * tournament that existed before this) accepts any table of the game. **Sanctioned
 * play** names the table and adds fairness rules: stock physics, factory machine
 * adjustments, a known build, and bounds on the accelerometer nudge settings.
 *
 * The evidence comes from the Castcade companion with EVERY score it posts
 * (`GET /api/witness/score` — `vps_game`, `vps_table`, `table_sha256`, `ini`,
 * `adjustments`, `build`, later `fingerprint`), in both modes. The rules are
 * evaluated in both modes too, and the verdict is stored with the score either
 * way, so an Open-play runner can see what Sanctioned play would have said.
 *
 * ## What a verdict may and may not do
 *
 * Badge, never gate (ADR 0017/0020/0021): no verdict filters a room board or
 * changes a rank. The ONE place a verdict acts is the AUTO-INGEST into a
 * tournament that opted into Sanctioned play — a failing score is not written
 * to that tournament's board (`not_sanctioned` on the wire, with the reasons)
 * and falls through to the player's Global record exactly as an unmatched
 * score does. Rooms stay badge-only. A score typed by hand carries no evidence
 * and is never touched by any of this.
 *
 * ## Why the evaluation is a pure function
 *
 * So the companion (preflight, Castcade F5), the ingest path and the runner's
 * review page can all give the SAME answer for the same evidence. Nothing in
 * here reads the database.
 *
 * ## The honest ceiling
 *
 * The companion measures settings on the player's machine, from files the
 * player owns. A modified companion, or settings changed in-game after the
 * measurement, are outside what this can see (castcade
 * `docs/design/fairness-and-table-identity.md` §5, §5a). The verdict is the
 * best evidence available, surfaced for a human; it is not anti-cheat.
 */

export type IntegrityMode = 'open' | 'sanctioned';

export const INTEGRITY_MODES: readonly IntegrityMode[] = ['open', 'sanctioned'] as const;

export function normalizeIntegrityMode(value: unknown): IntegrityMode {
    return value === 'sanctioned' ? 'sanctioned' : 'open';
}

/**
 * The Sanctioned-play rule set a runner tunes per tournament. Every field has
 * a default so a tournament switched to Sanctioned play with no further
 * configuration behaves sensibly; the stored JSON holds only what the runner
 * set and `normalizeSanctionedRules` fills the rest.
 */
export type SanctionedRules = {
    /** The game's `required_vps_table_id` (when set) must match the table the companion identified. */
    require_named_table: boolean;
    /** No physics-set override on the table and no difficulty override in the tweak menu. */
    require_stock_physics: boolean;
    /** Every machine adjustment at its factory default, except the labels in `adjustments_allowed`. */
    require_factory_adjustments: boolean;
    /** Adjustment labels (case-insensitive) that may differ from factory. Free play is harmless and routine. */
    adjustments_allowed: string[];
    /** The VPX and VPinMAME builds must be of an accepted family (never "official only"). */
    require_known_build: boolean;
    /** The `nightly` family passes (`require_known_build` on). Owner default: on. */
    allow_nightly_builds: boolean;
    /** SHA-256 hashes of `unknown`-family binaries the runner has blessed for this tournament. */
    blessed_build_hashes: string[];
    /**
     * VPX's analog-tilt plumb bob: `TiltSensitivity` 0–1000, HIGHER tilts
     * sooner, 0 = analog tilt off. Applies only while the accelerometer is on.
     * Owner's provisional number is 300 (VPX's own default is 400).
     */
    min_tilt_sensitivity: number;
    /** `PBWAccelGainX/Y` in percent; 150 is VPX's default. Bounds the payoff of a held tilt. */
    max_accel_gain: number;
    /** `EnableNudgeFilter` must be on. Off by default: the 10.8.0 filter blocks little. */
    require_nudge_filter: boolean;
};

export const DEFAULT_SANCTIONED_RULES: Readonly<SanctionedRules> = Object.freeze({
    require_named_table: true,
    require_stock_physics: true,
    require_factory_adjustments: true,
    adjustments_allowed: ['Free Play'],
    require_known_build: true,
    allow_nightly_builds: true,
    blessed_build_hashes: [],
    min_tilt_sensitivity: 300,
    max_accel_gain: 150,
    require_nudge_filter: false,
});

const MAX_LIST = 64;

function bool(value: unknown, fallback: boolean): boolean {
    return typeof value === 'boolean' ? value : fallback;
}

function int(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, Math.round(n)));
}

function stringList(value: unknown, maxLen: number): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const v of value) {
        if (typeof v !== 'string') continue;
        const s = v.trim().slice(0, maxLen);
        if (s && !out.includes(s)) out.push(s);
        if (out.length >= MAX_LIST) break;
    }
    return out;
}

/**
 * The stored blob (or a request body) → a complete rule set. Unknown keys are
 * dropped, wrong types fall back to the default, lists are trimmed and capped.
 * Accepts `null`/`undefined` (= all defaults) and a JSON string (the column).
 */
export function normalizeSanctionedRules(input: unknown): SanctionedRules {
    let raw: unknown = input;
    if (typeof raw === 'string') {
        try { raw = JSON.parse(raw); } catch { raw = null; }
    }
    const o = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw as Record<string, unknown> : {};
    const d = DEFAULT_SANCTIONED_RULES;
    return {
        require_named_table: bool(o.require_named_table, d.require_named_table),
        require_stock_physics: bool(o.require_stock_physics, d.require_stock_physics),
        require_factory_adjustments: bool(o.require_factory_adjustments, d.require_factory_adjustments),
        adjustments_allowed: 'adjustments_allowed' in o ? stringList(o.adjustments_allowed, 80) : [...d.adjustments_allowed],
        require_known_build: bool(o.require_known_build, d.require_known_build),
        allow_nightly_builds: bool(o.allow_nightly_builds, d.allow_nightly_builds),
        blessed_build_hashes: stringList(o.blessed_build_hashes, 64).map(h => h.toLowerCase()).filter(h => /^[0-9a-f]{64}$/.test(h)),
        min_tilt_sensitivity: int(o.min_tilt_sensitivity, d.min_tilt_sensitivity, 0, 1000),
        max_accel_gain: int(o.max_accel_gain, d.max_accel_gain, 0, 1000),
        require_nudge_filter: bool(o.require_nudge_filter, d.require_nudge_filter),
    };
}

// ---------------------------------------------------------------------------
// Evidence — what the companion sends with a score (castcade
// `docs/arcaid-side-changes.md` item 11 has the exact shapes).
// ---------------------------------------------------------------------------

export type BuildFamily = 'official' | 'panasony' | 'nightly' | 'unknown';

export type BinaryEvidence = {
    sha256: string | null;
    version: string | null;
    /** The companion's id for an official release build, or null. */
    known: string | null;
    family: BuildFamily;
};

export type BuildEvidence = {
    vpx: BinaryEvidence | null;
    vpinmame: BinaryEvidence | null;
    /** VPinMAME's per-ROM cheat option. */
    cheat: boolean | null;
};

export type IniEvidence = {
    /** Physics-set override on the table file (0 = stock). */
    set: number | null;
    set_name: string | null;
    flippers: boolean | null;
    /** No physics set and no flipper override. */
    stock: boolean | null;
    difficulty: number | null;
    /** The tweak-menu difficulty override, when saved. */
    difficulty_override: number | null;
    slope: number | null;
    nudge: number | null;
    legacy_nudge: boolean | null;
    nudge_filter: boolean | null;
    nudge_sensitivity: number | null;
    /** `PBWEnabled`; null = key absent = VPX default (on). */
    accel: boolean | null;
    accel_gain_x: number | null;
    accel_gain_y: number | null;
    accel_max_x: number | null;
    accel_max_y: number | null;
    accel_velocity: boolean | null;
    /** The tilt sensitivity VPX actually uses (stored value, else VPX's default 400). */
    tilt_sens: number | null;
    tilt_sens_set: boolean | null;
    options: Record<string, unknown>;
    overrides: string[];
    table_ini: boolean | null;
};

export type AdjustmentItem = { l: string; v: unknown; d?: unknown; t?: string };

export type AdjustmentsEvidence = {
    total: number;
    items: AdjustmentItem[];
    /** Labels whose stored value differs from the map's factory default. */
    non_factory: string[];
};

export type WitnessEvidence = {
    vpsGame: string | null;
    vpsTable: string | null;
    tableSha256: string | null;
    tableSaveRev: number | null;
    /** Playfield fingerprint (Castcade F4, not yet shipped). */
    fingerprint: string | null;
    ini: IniEvidence | null;
    adjustments: AdjustmentsEvidence | null;
    build: BuildEvidence | null;
    /**
     * v2.168.0 (castcade F6 / B6, hook 0.4.0): what VPX had IN FORCE during the game, read inside
     * the table — the sample at game start and every in-game change. The ini says what VPX loaded;
     * the tweak menu changes difficulty, slope and nudge in memory without touching a file, and
     * this is the only evidence of that. Null from basic mode, a cabinet, or a hook before 0.4.0.
     */
    engine: EngineEvidence | null;
    /**
     * v2.170.0 (castcade B6.1 / ArcAid W41, companion ≥ 0.2.13): how player 1's score moved during
     * the game. FLAG ONLY, NEVER A GATE (owner ruling 2026-10-25): `evaluateSanctioned` never reads
     * it, it is stored on the trail and shown to the runner, nothing else. Null when not sent.
     */
    scorePlausibility: ScorePlausibilityEvidence | null;
};

/** `score_plausibility` (castcade `scorePlausibilityWire`): facts about the score's jumps, never a verdict. */
export type ScorePlausibilityEvidence = {
    /** Score changes seen during the game (up or down). */
    samples: number;
    /** Greatest common divisor of every upward jump; null with no jump. */
    gcd: number | null;
    /** The step the jumps were checked against (10 for ROM games), null when not checked (original tables). */
    step: number | null;
    /** Upward jumps that are not a multiple of `step`. */
    off_step: number;
    /** The biggest single upward jump (`t` = seconds since the table loaded). */
    largest: { points: number; t: number | null; ball: number | null } | null;
    /** The companion's sentence when something is flagged (off_step > 0), else null. */
    flag: string | null;
};

/** One `engine` sample from the hook (four-decimal floats; a field is null when that read failed in VPX). */
export type EngineSample = {
    /** Seconds since the hook initialised (the journal clock). */
    t: number | null;
    /**
     * `GlobalDifficulty` 0–1: the live slope sits at slope_min + difficulty × (slope_max − slope_min).
     * Companion 0.2.12 sent VPX's script-API 0–100 number; `parseEngineSample` divides a value above 1
     * by 100, so this is always 0–1 after parsing (v2.170.0, W40 / castcade F10).
     */
    difficulty: number | null;
    slope_min: number | null;
    slope_max: number | null;
    /** `OverridePhysics`: 0 = the table's own physics, 1–8 = a global physics set in force. */
    physics_set: number | null;
    gravity: number | null;
    friction: number | null;
    elasticity: number | null;
    elasticity_falloff: number | null;
    scatter: number | null;
    nudge_time: number | null;
    /** `NudgeGetCalibration`: the in-memory nudge gains, maxima, dead zone and tilt sensitivity. */
    nudge: { xmax: number | null; ymax: number | null; xgain: number | null; ygain: number | null; dead_zone: number | null; tilt: number | null } | null;
};

export type EngineEvidence = {
    /** In force when the game started (the hook's last sample before `game_start`). */
    start: EngineSample | null;
    /** Every sample the hook wrote while the game ran — each one is a change (the hook writes only on change). */
    changes: EngineSample[];
};

/** Largest JSON blob accepted for one evidence param (the companion's `ini` is ~400 bytes). */
export const EVIDENCE_PARAM_MAX_BYTES = 16 * 1024;

function asObject(v: unknown): Record<string, unknown> | null {
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}
function nOrNull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function bOrNull(v: unknown): boolean | null {
    return typeof v === 'boolean' ? v : null;
}
function sOrNull(v: unknown, max = 200): string | null {
    return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : null;
}

function parseJsonParam(raw: unknown): unknown {
    if (typeof raw !== 'string' || raw.length === 0 || raw.length > EVIDENCE_PARAM_MAX_BYTES) return null;
    try { return JSON.parse(raw); } catch { return null; }
}

function parseBinary(v: unknown): BinaryEvidence | null {
    const o = asObject(v);
    if (!o) return null;
    const familyRaw = o.family;
    const family: BuildFamily = familyRaw === 'official' || familyRaw === 'panasony' || familyRaw === 'nightly' ? familyRaw : 'unknown';
    const sha = sOrNull(o.sha256, 64);
    return {
        sha256: sha && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null,
        version: sOrNull(o.version, 80),
        known: sOrNull(o.known, 80),
        // An older companion (0.2.5/0.2.6) sent no family: a proven official
        // hash still reads as official.
        family: familyRaw === undefined && o.known ? 'official' : family,
    };
}

export function parseBuildEvidence(raw: unknown): BuildEvidence | null {
    const o = asObject(typeof raw === 'string' ? parseJsonParam(raw) : raw);
    if (!o) return null;
    return { vpx: parseBinary(o.vpx), vpinmame: parseBinary(o.vpinmame), cheat: bOrNull(o.cheat) };
}

export function parseIniEvidence(raw: unknown): IniEvidence | null {
    const o = asObject(typeof raw === 'string' ? parseJsonParam(raw) : raw);
    if (!o) return null;
    const options = asObject(o.options) ?? {};
    return {
        set: nOrNull(o.set),
        set_name: sOrNull(o.set_name, 80),
        flippers: bOrNull(o.flippers),
        stock: bOrNull(o.stock),
        difficulty: nOrNull(o.difficulty),
        difficulty_override: nOrNull(o.difficulty_override),
        slope: nOrNull(o.slope),
        nudge: nOrNull(o.nudge),
        legacy_nudge: bOrNull(o.legacy_nudge),
        nudge_filter: bOrNull(o.nudge_filter),
        nudge_sensitivity: nOrNull(o.nudge_sensitivity),
        accel: bOrNull(o.accel),
        accel_gain_x: nOrNull(o.accel_gain_x),
        accel_gain_y: nOrNull(o.accel_gain_y),
        accel_max_x: nOrNull(o.accel_max_x),
        accel_max_y: nOrNull(o.accel_max_y),
        accel_velocity: bOrNull(o.accel_velocity),
        tilt_sens: nOrNull(o.tilt_sens),
        tilt_sens_set: bOrNull(o.tilt_sens_set),
        options: Object.fromEntries(Object.entries(options).slice(0, 64)),
        overrides: stringList(o.overrides, 80),
        table_ini: bOrNull(o.table_ini),
    };
}

/**
 * v2.170.0 (W40 / castcade F10): companion 0.2.12 sends `difficulty` on VPX's script-API scale 0–100
 * (Medieval Madness: table file 0.5, engine 50); 0.2.13+ sends 0–1 like the ini. A value above 1 is
 * a percentage. Applied at parse time, so the stored rows from 0.2.12 read right too (`rowToEvidence`
 * re-parses the stored `engine` through here).
 */
export function normalizeEngineDifficulty(v: number | null): number | null {
    if (v == null) return null;
    return v > 1 ? Math.round(v * 100) / 10000 : v;
}

function parseEngineSample(raw: unknown): EngineSample | null {
    const o = asObject(raw);
    if (!o) return null;
    const n = asObject(o.nudge);
    return {
        t: nOrNull(o.t),
        difficulty: normalizeEngineDifficulty(nOrNull(o.difficulty)),
        slope_min: nOrNull(o.slope_min),
        slope_max: nOrNull(o.slope_max),
        physics_set: nOrNull(o.physics_set),
        gravity: nOrNull(o.gravity),
        friction: nOrNull(o.friction),
        elasticity: nOrNull(o.elasticity),
        elasticity_falloff: nOrNull(o.elasticity_falloff),
        scatter: nOrNull(o.scatter),
        nudge_time: nOrNull(o.nudge_time),
        nudge: n ? { xmax: nOrNull(n.xmax), ymax: nOrNull(n.ymax), xgain: nOrNull(n.xgain), ygain: nOrNull(n.ygain), dead_zone: nOrNull(n.dead_zone), tilt: nOrNull(n.tilt) } : null,
    };
}

/** `engine` (castcade `engineWire`): `{ start, changes[] }`; same rule as every evidence param — malformed = dropped. */
export function parseEngineEvidence(raw: unknown): EngineEvidence | null {
    const o = asObject(typeof raw === 'string' ? parseJsonParam(raw) : raw);
    if (!o) return null;
    const start = parseEngineSample(o.start);
    const changes = Array.isArray(o.changes) ? o.changes.slice(0, 64).map(parseEngineSample).filter((x): x is EngineSample => x !== null) : [];
    if (!start && changes.length === 0) return null;
    return { start, changes };
}

/**
 * `score_plausibility` (castcade B6.1): same rule as every evidence param — optional, malformed =
 * dropped, never a 400. `samples` and `off_step` must be non-negative integers; everything else
 * degrades to null on its own.
 */
export function parseScorePlausibility(raw: unknown): ScorePlausibilityEvidence | null {
    const o = asObject(typeof raw === 'string' ? parseJsonParam(raw) : raw);
    if (!o) return null;
    const samples = o.samples;
    const offStep = o.off_step;
    if (typeof samples !== 'number' || !Number.isInteger(samples) || samples < 0) return null;
    if (typeof offStep !== 'number' || !Number.isInteger(offStep) || offStep < 0) return null;
    const l = asObject(o.largest);
    const points = l ? nOrNull(l.points) : null;
    return {
        samples,
        gcd: nOrNull(o.gcd),
        step: nOrNull(o.step),
        off_step: offStep,
        largest: l && points != null ? { points, t: nOrNull(l.t), ball: nOrNull(l.ball) } : null,
        flag: sOrNull(o.flag, 300),
    };
}

export function parseAdjustmentsEvidence(raw: unknown): AdjustmentsEvidence | null {
    const o = asObject(typeof raw === 'string' ? parseJsonParam(raw) : raw);
    if (!o) return null;
    const items: AdjustmentItem[] = [];
    if (Array.isArray(o.items)) {
        for (const it of o.items.slice(0, 256)) {
            const io = asObject(it);
            if (!io || typeof io.l !== 'string') continue;
            const item: AdjustmentItem = { l: io.l.slice(0, 80), v: io.v ?? null };
            if ('d' in io) item.d = io.d ?? null;
            if (typeof io.t === 'string') item.t = io.t.slice(0, 80);
            items.push(item);
        }
    }
    return {
        total: int(o.total, items.length, 0, 10_000),
        items,
        non_factory: stringList(o.non_factory, 80),
    };
}

/**
 * The query string of `GET /api/witness/score` → evidence. Every param is
 * optional (a cabinet sends none; a 0.2.4 companion sends identity only), and
 * a malformed one is dropped rather than failing the score — the score is the
 * record, the evidence is about it.
 */
export function parseWitnessEvidence(query: Record<string, unknown>): WitnessEvidence | null {
    const vpsGame = sOrNull(query.vps_game, 40);
    const vpsTable = sOrNull(query.vps_table, 40);
    const sha = sOrNull(query.table_sha256, 64);
    const rev = query.table_save_rev !== undefined ? Number(query.table_save_rev) : NaN;
    const fingerprint = sOrNull(query.fingerprint, 128);
    const ini = parseIniEvidence(query.ini);
    const adjustments = parseAdjustmentsEvidence(query.adjustments);
    const build = parseBuildEvidence(query.build);
    const engine = parseEngineEvidence(query.engine);
    const scorePlausibility = parseScorePlausibility(query.score_plausibility);
    // `score_plausibility` alone does not make evidence: it must never turn a "no evidence" score
    // (no badge, ADR 0027 / W13) into an evaluated one (flag only, never a gate — W41). Every
    // companion that sends it (≥ 0.2.13, live mode) sends identity and ini alongside.
    if (!vpsGame && !vpsTable && !sha && !fingerprint && !ini && !adjustments && !build && !engine) return null;
    return {
        vpsGame, vpsTable,
        tableSha256: sha && /^[0-9a-f]{64}$/i.test(sha) ? sha.toLowerCase() : null,
        tableSaveRev: Number.isFinite(rev) ? Math.floor(rev) : null,
        fingerprint,
        ini, adjustments, build, engine, scorePlausibility,
    };
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** What the runner required of ONE tournament game (the `games` row). */
export type GameRequirements = {
    requiredVpsTableId: string | null;
    requiredRom: string | null;
    requiredFingerprint: string | null;
};

export type RuleId =
    | 'evidence' | 'named_table' | 'rom' | 'fingerprint' | 'stock_physics'
    | 'factory_adjustments' | 'known_build' | 'cheat' | 'tilt_sensitivity' | 'accel_gain' | 'nudge_filter'
    /** v2.168.0: the values in force during the game, from inside the table (castcade hook 0.4.0). */
    | 'engine';

export type RuleCheck = {
    rule: RuleId;
    /** `pass` / `fail`, or `skipped` when the rule is off, unconfigured, or not applicable (no accelerometer). */
    status: 'pass' | 'fail' | 'skipped';
    detail: string;
};

export type Verdict = {
    /** `pass` = every applicable rule passed; `flagged` = at least one failed. */
    verdict: 'pass' | 'flagged';
    checks: RuleCheck[];
    /** The failing checks' details, in order — what the companion shows and the log prints. */
    reasons: string[];
};

export type EvaluateInput = {
    rules: SanctionedRules;
    requirements: GameRequirements;
    evidence: WitnessEvidence | null;
    /** The ROM the device reported with the score (outside the evidence object). */
    rom?: string | null;
};

function normRom(s: string | null | undefined): string {
    return (s ?? '').trim().toLowerCase();
}

/**
 * Apply the Sanctioned rules to one score's evidence. Pure. Used identically
 * for a Sanctioned tournament (where `flagged` means the score is not written
 * to it) and an Open one (where it is a badge for the runner).
 */
export function evaluateSanctioned(input: EvaluateInput): Verdict {
    const { rules, requirements, evidence } = input;
    const checks: RuleCheck[] = [];
    const pass = (rule: RuleId, detail: string) => checks.push({ rule, status: 'pass', detail });
    const fail = (rule: RuleId, detail: string) => checks.push({ rule, status: 'fail', detail });
    const skip = (rule: RuleId, detail: string) => checks.push({ rule, status: 'skipped', detail });

    if (!evidence) {
        // A cabinet Witness or a hand-typed score: nothing to check against.
        // Every rule that needs evidence fails as one line rather than seven.
        fail('evidence', 'no evidence came with this score (a cabinet Witness, or a Castcade older than 0.2.5)');
        return finish(checks);
    }
    pass('evidence', 'evidence present');

    // --- the named table ---------------------------------------------------
    if (!rules.require_named_table) {
        skip('named_table', 'rule off');
    } else if (!requirements.requiredVpsTableId) {
        skip('named_table', 'no required table set for this game');
    } else if (!evidence.vpsTable) {
        fail('named_table', 'the table was not identified (no VPS table id reported)');
    } else if (evidence.vpsTable !== requirements.requiredVpsTableId) {
        fail('named_table', `a different table of this game was played (${evidence.vpsTable}, required ${requirements.requiredVpsTableId})`);
    } else {
        pass('named_table', `required table ${requirements.requiredVpsTableId}`);
    }

    if (!requirements.requiredRom) {
        skip('rom', 'no required ROM set');
    } else if (!normRom(input.rom)) {
        fail('rom', `no ROM reported (required ${requirements.requiredRom})`);
    } else if (normRom(input.rom) !== normRom(requirements.requiredRom)) {
        fail('rom', `ROM ${input.rom} is not the required ${requirements.requiredRom}`);
    } else {
        pass('rom', `ROM ${requirements.requiredRom}`);
    }

    if (!requirements.requiredFingerprint) {
        skip('fingerprint', 'no blessed fingerprint set');
    } else if (!evidence.fingerprint) {
        fail('fingerprint', 'no playfield fingerprint reported');
    } else if (evidence.fingerprint !== requirements.requiredFingerprint) {
        fail('fingerprint', 'the playfield fingerprint does not match the blessed one');
    } else {
        pass('fingerprint', 'playfield fingerprint matches');
    }

    // --- settings ------------------------------------------------------------
    const ini = evidence.ini;
    if (!rules.require_stock_physics) {
        skip('stock_physics', 'rule off');
    } else if (!ini) {
        fail('stock_physics', 'settings were not reported');
    } else {
        const problems: string[] = [];
        if (ini.stock === false || (ini.set != null && ini.set !== 0)) {
            problems.push(ini.set_name ? `physics set "${ini.set_name}" overrides the table` : 'a physics set overrides the table');
        }
        if (ini.flippers === true) problems.push('flipper physics are overridden');
        if (ini.difficulty_override != null) problems.push(`difficulty overridden to ${Math.round(ini.difficulty_override * 100)}%`);
        if (problems.length > 0) fail('stock_physics', problems.join('; '));
        else pass('stock_physics', `stock physics${ini.slope != null ? `, slope ${ini.slope}°` : ''}`);
    }

    // --- machine adjustments ---------------------------------------------------
    // --- engine: what was IN FORCE while the game ran (v2.168.0) ----------------------
    // The ini is what VPX loaded; the tweak menu and a community build's own pages change
    // difficulty, slope and nudge in memory. The hook samples at game start and at every key
    // press and writes only on change, so any `changes` means an in-game edit. Absent =
    // unverifiable (basic mode, a cabinet, a hook before 0.4.0): skipped, never a failure —
    // the same treatment the adjustments map gets.
    const engine = evidence.engine;
    if (!rules.require_stock_physics) {
        skip('engine', 'rule off');
    } else if (!engine || !engine.start) {
        skip('engine', 'in-game values were not reported (basic mode or a hook before 0.4.0)');
    } else {
        const st = engine.start;
        const pct = (v: number | null) => (v == null ? '?' : `${Math.round(v * 100)}%`);
        const problems: string[] = [];
        if (engine.changes.length > 0) {
            const last = engine.changes[engine.changes.length - 1] as EngineSample;
            const what: string[] = [];
            if (last.difficulty != null && st.difficulty != null && Math.abs(last.difficulty - st.difficulty) > 0.005) what.push(`difficulty ${pct(st.difficulty)} → ${pct(last.difficulty)}`);
            if (last.physics_set != null && last.physics_set !== st.physics_set) what.push(`physics set ${st.physics_set ?? '?'} → ${last.physics_set}`);
            const t0 = st.nudge?.tilt ?? null;
            const t1 = last.nudge?.tilt ?? null;
            if (t1 != null && t1 !== t0) what.push(`tilt sensitivity ${t0 ?? '?'} → ${t1}`);
            if ((last.nudge?.xgain ?? null) !== (st.nudge?.xgain ?? null) || (last.nudge?.ygain ?? null) !== (st.nudge?.ygain ?? null)) what.push('nudge gain changed');
            problems.push(`physics or difficulty changed during the game (${engine.changes.length} change${engine.changes.length === 1 ? '' : 's'}${what.length > 0 ? `: ${what.join(', ')}` : ''})`);
        }
        if (st.physics_set != null && st.physics_set !== 0) problems.push(`physics set ${st.physics_set} was in force`);
        // The live difficulty against what the table file says (the ini's `difficulty` with no override
        // IS the file's value); a saved override already fails stock_physics above.
        if (ini && ini.difficulty_override == null && ini.difficulty != null && st.difficulty != null && Math.abs(st.difficulty - ini.difficulty) > 0.005) {
            problems.push(`difficulty in force ${pct(st.difficulty)} differs from the table's ${pct(ini.difficulty)}`);
        }
        if (problems.length > 0) fail('engine', problems.join('; '));
        else {
            const slope = st.slope_min != null && st.slope_max != null && st.difficulty != null ? st.slope_min + st.difficulty * (st.slope_max - st.slope_min) : null;
            pass('engine', `in force for the whole game: difficulty ${pct(st.difficulty)}${slope != null ? `, slope ${slope.toFixed(2)}°` : ''}, physics set ${st.physics_set ?? '?'}${st.nudge?.tilt != null ? `, tilt sensitivity ${st.nudge.tilt}` : ''}`);
        }
    }

    const adj = evidence.adjustments;
    if (!rules.require_factory_adjustments) {
        skip('factory_adjustments', 'rule off');
    } else if (!adj) {
        // Only 92 of 383 maps describe adjustments. Absence is not "factory",
        // and it is not the player's doing either: unverifiable, not failed.
        skip('factory_adjustments', 'no adjustments map for this ROM (unverifiable)');
    } else {
        const allowed = new Set(rules.adjustments_allowed.map(s => s.toLowerCase()));
        const offending = adj.non_factory.filter(l => !allowed.has(l.toLowerCase()));
        if (offending.length > 0) fail('factory_adjustments', `non-factory adjustments: ${offending.join(', ')}`);
        else pass('factory_adjustments', adj.non_factory.length > 0 ? `factory except allowed (${adj.non_factory.join(', ')})` : 'factory adjustments');
    }

    // --- builds ----------------------------------------------------------------
    const build = evidence.build;
    if (!rules.require_known_build) {
        skip('known_build', 'rule off');
    } else if (!build) {
        fail('known_build', 'builds were not reported');
    } else {
        const problems: string[] = [];
        const judge = (label: string, b: BinaryEvidence | null) => {
            if (!b) return;
            switch (b.family) {
                case 'official':
                case 'panasony':
                    return;
                case 'nightly':
                    if (!rules.allow_nightly_builds) problems.push(`${label} ${b.version ?? ''} is a nightly build and this tournament does not allow them`.replace(/\s+/g, ' '));
                    return;
                default:
                    if (!(b.sha256 && rules.blessed_build_hashes.includes(b.sha256))) {
                        problems.push(`${label} ${b.version ?? ''} is an unrecognised build the runner has not blessed`.replace(/\s+/g, ' '));
                    }
            }
        };
        judge('VPX', build.vpx);
        judge('VPinMAME', build.vpinmame);
        if (!build.vpx) problems.push('the VPX build was not reported');
        if (problems.length > 0) fail('known_build', problems.join('; '));
        else pass('known_build', describeBuilds(build));
    }

    if (build?.cheat === true) fail('cheat', 'VPinMAME cheat option is ON for this ROM');
    else if (build) pass('cheat', 'cheat off');
    else skip('cheat', 'builds were not reported');

    // --- accelerometer -----------------------------------------------------------
    // Only when an accelerometer is in play: `accel` null means the key is
    // absent, which VPX treats as on, so only an explicit false opts out.
    const accelOn = ini != null && ini.accel !== false;
    if (!ini) {
        skip('tilt_sensitivity', 'settings were not reported');
        skip('accel_gain', 'settings were not reported');
        skip('nudge_filter', 'settings were not reported');
    } else if (!accelOn) {
        skip('tilt_sensitivity', 'accelerometer off');
        skip('accel_gain', 'accelerometer off');
        skip('nudge_filter', 'accelerometer off');
    } else {
        // v2.168.0: the live value from inside the table beats the ini's (the ini may be one session stale).
        const liveTilt = evidence.engine?.start?.nudge?.tilt ?? null;
        const tilt = liveTilt ?? ini.tilt_sens;
        const live = liveTilt != null ? ' (live)' : '';
        if (rules.min_tilt_sensitivity <= 0) {
            skip('tilt_sensitivity', 'no minimum set');
        } else if (tilt == null) {
            fail('tilt_sensitivity', 'tilt sensitivity was not reported');
        } else if (tilt === 0) {
            fail('tilt_sensitivity', `analog tilt is off (tilt sensitivity 0${live}; minimum ${rules.min_tilt_sensitivity})`);
        } else if (tilt < rules.min_tilt_sensitivity) {
            fail('tilt_sensitivity', `tilt sensitivity ${tilt}${live} is below the minimum ${rules.min_tilt_sensitivity}`);
        } else {
            pass('tilt_sensitivity', `tilt sensitivity ${tilt}${live}`);
        }

        const gains = [ini.accel_gain_x, ini.accel_gain_y].filter((g): g is number => g != null);
        if (rules.max_accel_gain <= 0) {
            skip('accel_gain', 'no maximum set');
        } else if (gains.some(g => g > rules.max_accel_gain)) {
            fail('accel_gain', `accelerometer gain ${gains.join('/')}% exceeds the maximum ${rules.max_accel_gain}%`);
        } else {
            pass('accel_gain', gains.length > 0 ? `accelerometer gain ${gains.join('/')}%` : 'accelerometer gain at VPX default');
        }

        if (!rules.require_nudge_filter) skip('nudge_filter', 'rule off');
        else if (ini.nudge_filter === true) pass('nudge_filter', 'nudge filter on');
        else fail('nudge_filter', 'the nudge filter is off');
    }

    return finish(checks);
}

function describeBuilds(b: BuildEvidence): string {
    const part = (label: string, x: BinaryEvidence | null) => x ? `${label} ${x.version ?? ''} (${x.family})`.replace(/\s+/g, ' ') : null;
    return [part('VPX', b.vpx), part('VPinMAME', b.vpinmame)].filter(Boolean).join('; ');
}

function finish(checks: RuleCheck[]): Verdict {
    const reasons = checks.filter(c => c.status === 'fail').map(c => c.detail);
    return { verdict: reasons.length === 0 ? 'pass' : 'flagged', checks, reasons };
}
