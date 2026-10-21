/**
 * Integrity mode — Open play / Sanctioned play (v2.166.0, ADR 0027; Castcade
 * ADR 0005) — the pure half of the tournament form's "Integrity" section: its
 * state, its defaults (the server's, `src/utils/sanctionedRules.ts`), the
 * client-side validation and its slice of the create / update body.
 *
 * The two list rules are held as TEXT in the form (a comma list, a line per
 * hash) so the admin can type freely; they become arrays on the wire. The
 * server normalises whatever arrives (`normalizeSanctionedRules`), so the
 * payload need not be perfect — the validation here exists so an admin is told
 * about a mistyped hash before the save silently drops it.
 *
 * Kept out of `components/TournamentForm.tsx` so the form file keeps exporting
 * components (react-refresh) and so these stay unit-testable without a render.
 */

export type IntegrityMode = 'open' | 'sanctioned';

export interface SanctionedRulesForm {
  /** The game's required table (when the runner named one) must be the one played. */
  requireNamedTable: boolean;
  /** No physics-set or flipper override on the table, no tweak-menu difficulty override. */
  requireStockPhysics: boolean;
  /** Every ROM machine adjustment at its factory value, except `adjustmentsAllowed`. */
  requireFactoryAdjustments: boolean;
  /** Comma-separated adjustment labels that may differ from factory. */
  adjustmentsAllowed: string;
  /** VPX / VPinMAME builds must be of an accepted family (official, Panasony, nightly when allowed, or blessed). */
  requireKnownBuild: boolean;
  allowNightlyBuilds: boolean;
  /** One SHA-256 (64 hex) per line of `unknown`-family binaries the runner has blessed. */
  blessedBuildHashes: string;
  /** VPX `TiltSensitivity` 0–1000; higher tilts sooner; 0 = analog tilt off. */
  minTiltSensitivity: number;
  /** `PBWAccelGainX/Y` in percent; 150 is VPX's default. */
  maxAccelGain: number;
  requireNudgeFilter: boolean;
}

/** Mirrors `DEFAULT_SANCTIONED_RULES` on the server. */
export const defaultSanctionedRules: SanctionedRulesForm = {
  requireNamedTable: true,
  requireStockPhysics: true,
  requireFactoryAdjustments: true,
  adjustmentsAllowed: 'Free Play',
  requireKnownBuild: true,
  allowNightlyBuilds: true,
  blessedBuildHashes: '',
  minTiltSensitivity: 300,
  maxAccelGain: 150,
  requireNudgeFilter: false,
};

export const TILT_SENSITIVITY_MIN = 0;
export const TILT_SENSITIVITY_MAX = 1000;
export const ACCEL_GAIN_MIN = 50;
export const ACCEL_GAIN_MAX = 400;

const SHA256_RE = /^[0-9a-f]{64}$/;

export function normalizeIntegrityMode(value: unknown): IntegrityMode {
  return value === 'sanctioned' ? 'sanctioned' : 'open';
}

/** The comma list → trimmed, de-duplicated labels. */
export function parseAdjustmentsAllowed(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(',')) {
    const s = part.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The hash textarea → trimmed, lower-cased, non-empty lines (valid or not). */
export function parseHashLines(text: string): string[] {
  return text.split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(Boolean);
}

export function isSha256Hex(s: string): boolean {
  return SHA256_RE.test(s);
}

/**
 * Client-side validation. Empty when the mode is Open (the rules are kept but
 * not enforced) or when every hash line is a SHA-256. The number fields are
 * clamped by their steppers so they cannot be wrong here.
 */
export function getIntegrityErrors(mode: IntegrityMode, rules: SanctionedRulesForm): string[] {
  if (mode !== 'sanctioned') return [];
  const errors: string[] = [];
  const bad = parseHashLines(rules.blessedBuildHashes).filter(h => !isSha256Hex(h));
  if (bad.length > 0) {
    errors.push(bad.length === 1
      ? `"${bad[0].length > 20 ? `${bad[0].slice(0, 20)}…` : bad[0]}" is not a SHA-256 (64 hex characters).`
      : `${bad.length} blessed build hashes are not SHA-256 (64 hex characters each).`);
  }
  return errors;
}

/** The wire shape of `sanctioned_rules` (the server's `SanctionedRules`). */
export interface SanctionedRulesWire {
  require_named_table: boolean;
  require_stock_physics: boolean;
  require_factory_adjustments: boolean;
  adjustments_allowed: string[];
  require_known_build: boolean;
  allow_nightly_builds: boolean;
  blessed_build_hashes: string[];
  min_tilt_sensitivity: number;
  max_accel_gain: number;
  require_nudge_filter: boolean;
}

export function sanctionedRulesToWire(rules: SanctionedRulesForm): SanctionedRulesWire {
  return {
    require_named_table: rules.requireNamedTable,
    require_stock_physics: rules.requireStockPhysics,
    require_factory_adjustments: rules.requireFactoryAdjustments,
    adjustments_allowed: parseAdjustmentsAllowed(rules.adjustmentsAllowed),
    require_known_build: rules.requireKnownBuild,
    allow_nightly_builds: rules.allowNightlyBuilds,
    blessed_build_hashes: parseHashLines(rules.blessedBuildHashes),
    min_tilt_sensitivity: rules.minTiltSensitivity,
    max_accel_gain: rules.maxAccelGain,
    require_nudge_filter: rules.requireNudgeFilter,
  };
}

/**
 * The integrity block of the tournament create / update body. The rules travel
 * in BOTH modes, so a runner's tuned rule set survives a switch to Open play
 * and back; the server only enforces them while the mode is Sanctioned.
 */
export function integrityPayload(mode: IntegrityMode, rules: SanctionedRulesForm): Record<string, unknown> {
  return {
    integrity_mode: mode,
    sanctioned_rules: sanctionedRulesToWire(rules),
  };
}

/** Raw integrity columns as `GET /:roomId/tournaments` ships them. */
export interface IntegrityColumns {
  integrity_mode?: string | null;
  /** JSON string (the column) — an already-parsed object is tolerated too. */
  sanctioned_rules?: string | Record<string, unknown> | null;
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

function int(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function strings(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return v.filter((x): x is string => typeof x === 'string').map(s => s.trim()).filter(Boolean);
}

/**
 * The stored blob → form state, merged over the defaults. Tolerates null, a
 * JSON string, an object, garbage and partial objects (the server stores only
 * a complete set, but an older row or a hand edit must not blank the form).
 */
export function sanctionedRulesFromRow(raw: unknown): SanctionedRulesForm {
  let parsed: unknown = raw;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { parsed = null; }
  }
  const o = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  const d = defaultSanctionedRules;
  const allowed = strings(o.adjustments_allowed);
  const hashes = strings(o.blessed_build_hashes);
  return {
    requireNamedTable: bool(o.require_named_table, d.requireNamedTable),
    requireStockPhysics: bool(o.require_stock_physics, d.requireStockPhysics),
    requireFactoryAdjustments: bool(o.require_factory_adjustments, d.requireFactoryAdjustments),
    adjustmentsAllowed: allowed ? allowed.join(', ') : d.adjustmentsAllowed,
    requireKnownBuild: bool(o.require_known_build, d.requireKnownBuild),
    allowNightlyBuilds: bool(o.allow_nightly_builds, d.allowNightlyBuilds),
    blessedBuildHashes: hashes ? hashes.join('\n') : d.blessedBuildHashes,
    // The server stores 0–1000 for the gain too; the form's stepper is tighter
    // (50–400) because anything outside that is a typo, not a policy.
    minTiltSensitivity: int(o.min_tilt_sensitivity, d.minTiltSensitivity, TILT_SENSITIVITY_MIN, TILT_SENSITIVITY_MAX),
    maxAccelGain: int(o.max_accel_gain, d.maxAccelGain, ACCEL_GAIN_MIN, ACCEL_GAIN_MAX),
    requireNudgeFilter: bool(o.require_nudge_filter, d.requireNudgeFilter),
  };
}

export function integrityModeFromRow(t: IntegrityColumns): IntegrityMode {
  return normalizeIntegrityMode(t.integrity_mode);
}

export const INTEGRITY_MODE_LABEL: Record<IntegrityMode, string> = {
  open: 'Open play',
  sanctioned: 'Sanctioned play',
};

export const INTEGRITY_MODE_HELP: Record<IntegrityMode, string> = {
  open: 'Any table of the game counts. Conditions are recorded and shown as badges, never used to hold a score out.',
  sanctioned: 'Only the named table, stock physics, factory adjustments and a known build count. A score that fails is held out of this tournament and recorded on the player\'s Global Scoreboard instead.',
};
