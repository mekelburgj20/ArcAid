import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import ScheduleBuilder from './ScheduleBuilder';
import EventSettingsFields from './EventSettingsFields';
import { defaultEventState, type EventFormState } from '../lib/eventTime';
import { InfoTip } from './Tooltip';
import { DEFAULT_TIMEZONE } from '../lib/timezone';
import { defaultSeasonState, getSeasonErrors, type SeasonFormState } from '../lib/seasonForm';
import {
  defaultPollState,
  describePollTimes,
  getPollErrors,
  POLL_LOCK_NOTE,
  POLL_MAX_OFFSET_H,
  TIE_RULE_LABEL,
  type PollFormState,
  type PollTieRule,
} from '../lib/pollForm';
import {
  ACCEL_GAIN_MAX,
  ACCEL_GAIN_MIN,
  INTEGRITY_MODE_HELP,
  INTEGRITY_MODE_LABEL,
  TILT_SENSITIVITY_MAX,
  TILT_SENSITIVITY_MIN,
  defaultSanctionedRules,
  getIntegrityErrors,
  type IntegrityMode,
  type SanctionedRulesForm,
} from '../lib/integrityForm';
import {
  CANONICAL_DEVICES,
  LEGACY_PLATFORM_MAP,
  UNKNOWN,
  devicesForEngine,
  enginesFromLegacyPlatforms,
  getDeviceDisplay,
  getEngineDisplay,
  mapLegacyPlatform,
  normalizeProvenanceToken,
} from '../lib/scoreProvenance';

// --- Types ---

/**
 * `tournaments.platform_rules` — ADR 0016 P2 §2's two-axis shape. Mirrors
 * `TournamentRules` in `src/utils/platformRules.ts`.
 *
 * Each axis keeps ADR 0009's orthogonal pair unchanged:
 *   `required` — "Must be available on": GAME eligibility only, never a picker filter.
 *   `excluded` — "Not allowed on": SUBMISSION filter only, never affects eligibility.
 */
export interface AxisRules {
  required: string[];
  excluded: string[];
}

export interface PlatformRules {
  engines: AxisRules;
  devices: AxisRules;
  restrictedText: string;
}

export interface CleanupRule {
  mode: 'immediate' | 'retain' | 'scheduled';
  count?: number;
  cron?: string;
  timezone?: string;
}

export type TournamentFormat = 'rotation' | 'event';

export interface TournamentFormState {
  name: string;
  tag: string;
  mode: string;
  /**
   * v2.135.0 (ADR 0017). 'rotation' is every tournament that existed before the
   * Live Event format — a perpetual cron-rotated slot machine. 'event' is
   * time-boxed: N scheduled rounds, an optional check-in roster, a frozen
   * result, and NO cron at all.
   *
   * The two formats' scheduling is mutually exclusive, so flipping this swaps
   * whole sections of the form rather than adding fields to it.
   */
  format: TournamentFormat;
  /** Only meaningful when `format === 'event'`. */
  event: EventFormState;
  channel: string;
  displayOrder: number;
  maxActiveGames: number;
  winnerPicks: boolean;
  autoPick: boolean;
  eligibilityDays: number;
  winnerPickWindowMin: number;
  runnerupPickWindowMin: number;
  /** Next-win disposition (ROADMAP, locked 2026-08-09) — default ON = today's
   *  behavior (a winner may take the same slot back-to-back). OFF blocks
   *  their own 'use-my-queue' path on a repeat win; nominate/forfeit via
   *  `/pick-game` still work either way. */
  allowDynasty: boolean;
  platformRules: PlatformRules;
  cleanupRule: CleanupRule;
  schedule: { cron: string; timezone: string };
  /**
   * Season block (docs/season-format-plan.md §3.1) — the bound only. Only
   * meaningful when `format === 'rotation'`. Forces nothing (ADR 0026).
   */
  season: SeasonFormState;
  /**
   * Pick by poll (ADR 0026) — a Game Rotation method. Only meaningful when
   * `format === 'rotation'`. Forces winner picks + auto-pick off, one active
   * slot and a 0-day cooldown on the server, so the form shows those locked
   * while it is on (the admin's own values come back if it is switched off).
   */
  poll: PollFormState;
  /**
   * Integrity mode (v2.166.0, ADR 0027; Castcade ADR 0005). Open play (the
   * default, every tournament before this) accepts any table of the game;
   * Sanctioned play names the table and adds fairness rules that gate ONLY the
   * auto-ingest into this tournament. Boards stay badge-never-gate either way.
   */
  integrityMode: IntegrityMode;
  /** Kept (and sent) in both modes so a tuned rule set survives a switch. */
  sanctionedRules: SanctionedRulesForm;
  /**
   * Limited attempts (v2.167.0, ADR 0029): game starts per player per table.
   * null = unlimited (blank field). Always sent, so blanking it switches the
   * limit off.
   */
  maxAttempts: number | null;
  /**
   * v2.178.0 (W38, ADR 0033 §4) — "Players press Start attempts first". Off by
   * default: every play that ends inside the window counts. On: plays go to
   * the Global Scoreboard and use no attempt until the player presses Start
   * attempts for that table. Always sent; read only with a limit.
   */
  requireAttemptStart: boolean;
  /**
   * v2.169.0 (W20) — events only: a score whose game the Arcaid Witness saw
   * start before the round opened. 'prevent' (default) = it does not count;
   * 'flag' = it counts with a warning badge. Always sent.
   */
  witnessFlagMode: 'prevent' | 'flag';
}

// --- Defaults ---

export const defaultPlatformRules: PlatformRules = {
  engines: { required: [], excluded: [] },
  devices: { required: [], excluded: [] },
  restrictedText: '',
};
export const defaultCleanupRule: CleanupRule = { mode: 'retain', count: 0 };

export const defaultFormState: TournamentFormState = {
  name: '',
  tag: '',
  mode: 'pinball',
  format: 'rotation',
  event: { ...defaultEventState, rounds: [...defaultEventState.rounds] },
  channel: '',
  displayOrder: 0,
  maxActiveGames: 1,
  winnerPicks: true,
  autoPick: true,
  eligibilityDays: 120,
  winnerPickWindowMin: 60,
  runnerupPickWindowMin: 30,
  allowDynasty: true,
  platformRules: { ...defaultPlatformRules },
  cleanupRule: { ...defaultCleanupRule },
  schedule: { cron: '0 0 * * *', timezone: DEFAULT_TIMEZONE },
  season: { ...defaultSeasonState },
  poll: { ...defaultPollState },
  integrityMode: 'open',
  sanctionedRules: { ...defaultSanctionedRules },
  maxAttempts: null,
  requireAttemptStart: false,
  witnessFlagMode: 'prevent',
};

/** A blank create form seeded with the ROOM's timezone (schedule + event). */
export function defaultFormStateFor(timezone: string): TournamentFormState {
  return {
    ...defaultFormState,
    event: { ...defaultFormState.event, rounds: [...defaultFormState.event.rounds], timezone },
    schedule: { ...defaultFormState.schedule, timezone },
  };
}

// --- Reducer ---

type FormAction =
  | { type: 'SET_FIELD'; field: keyof TournamentFormState; value: any }
  | { type: 'RESET'; state: TournamentFormState };

function formReducer(state: TournamentFormState, action: FormAction): TournamentFormState {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'RESET':
      return action.state;
  }
}

// --- Hook ---

export function useTournamentForm(initial: TournamentFormState = defaultFormState) {
  const [state, dispatch] = useReducer(formReducer, initial);
  const set = <K extends keyof TournamentFormState>(field: K, value: TournamentFormState[K]) =>
    dispatch({ type: 'SET_FIELD', field, value });
  const reset = (s: TournamentFormState = defaultFormState) => dispatch({ type: 'RESET', state: s });
  return { state, set, reset };
}

// --- Parsers ---

/**
 * A saved cadence's zone is the per-tournament override; `fallbackTimezone`
 * (the room's zone) applies only when the cadence carries none.
 */
export function parseCadence(cadenceJson: string, fallbackTimezone: string = DEFAULT_TIMEZONE): { cron: string; timezone: string } {
  try {
    const c = JSON.parse(cadenceJson);
    return { cron: c.cron || '0 0 * * *', timezone: c.timezone || fallbackTimezone };
  } catch {
    return { cron: '0 0 * * *', timezone: fallbackTimezone };
  }
}

function asTokens(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const token = normalizeProvenanceToken(v);
    if (token && !out.includes(token)) out.push(token);
  }
  return out;
}

/**
 * Lift a flat list of legacy platform ids onto the two axes — the FE twin of
 * `liftLegacyPlatformIds` in `src/utils/platformRules.ts`.
 *
 * `GET /:roomId/tournaments` already ships the lifted shape (TournamentService
 * re-serialises every row through `parseTournamentRules`), so in practice this
 * never fires. It exists so the form can still render a raw legacy blob if one
 * ever reaches it, rather than silently showing "no rules" for a tournament
 * that has them — which is exactly how an admin would save the restriction away.
 *
 * An id maps to an engine, a device, or BOTH (`vpxs` → vpx + atgames; `real` →
 * real + real_cabinet; every `*_vr` id → engine + vr_headset). Both halves are
 * kept: dropping the device half would widen the restriction. An unrecognised
 * id stays verbatim on the engine axis.
 */
export function liftLegacyPlatformIds(ids: string[]): { engines: string[]; devices: string[] } {
  const engines: string[] = [];
  const devices: string[] = [];
  for (const raw of ids) {
    const token = normalizeProvenanceToken(raw);
    if (!token) continue;
    const prov = LEGACY_PLATFORM_MAP[token];
    if (!prov || (prov.engine === UNKNOWN && prov.device === UNKNOWN)) {
      if (!engines.includes(token)) engines.push(token);
      continue;
    }
    if (prov.engine !== UNKNOWN && !engines.includes(prov.engine)) engines.push(prov.engine);
    if (prov.device !== UNKNOWN && !devices.includes(prov.device)) devices.push(prov.device);
  }
  return { engines, devices };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parsePlatformRules(json: string): PlatformRules {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ...defaultPlatformRules };
  }
  if (!isPlainObject(parsed)) return { ...defaultPlatformRules };
  const r = parsed;

  const restrictedText = typeof r.restrictedText === 'string' ? r.restrictedText : '';
  const isTwoAxis = isPlainObject(r.engines) || isPlainObject(r.devices);

  if (isTwoAxis) {
    const e = isPlainObject(r.engines) ? r.engines : {};
    const d = isPlainObject(r.devices) ? r.devices : {};
    return {
      engines: { required: asTokens(e.required), excluded: asTokens(e.excluded) },
      devices: { required: asTokens(d.required), excluded: asTokens(d.excluded) },
      restrictedText,
    };
  }

  const req = liftLegacyPlatformIds(asTokens(r.required));
  const exc = liftLegacyPlatformIds(asTokens(r.excluded));
  return {
    engines: { required: req.engines, excluded: exc.engines },
    devices: { required: req.devices, excluded: exc.devices },
    restrictedText,
  };
}

export function parseCleanupRule(raw: string | undefined): CleanupRule {
  if (!raw) return { ...defaultCleanupRule };
  try { return JSON.parse(raw); } catch { return { ...defaultCleanupRule }; }
}

// --- Sub-components ---

/**
 * Draft-state number input: the field can go empty while the user is
 * actively editing (deleting the last digit no longer snaps to `min`).
 * `draft === null` means "not editing" — the input renders `String(value)`
 * straight from the prop. `draft` is the user's in-progress raw text
 * (empty allowed) while typing; it commits (clamped) on blur, or reverts
 * to the last valid `value` if left empty/invalid.
 */
export function NumberStepper({ value, onChange, min = 0, max, disabled, ariaLabel }: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  /** Optional upper clamp. */
  max?: number;
  /** Locked fields (e.g. the ones a season forces) render read-only. */
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const clamp = (n: number) => (max === undefined ? Math.max(min, n) : Math.min(max, Math.max(min, n)));
  const [draft, setDraft] = useState<string | null>(null);
  // Tracks the last value *we* emitted via onChange, so the effect below
  // can tell "value changed because our own onChange echoed back" apart
  // from "value changed externally" (e.g. this stepper instance reused
  // across form opens with a new initial value) — only the latter should
  // blow away an in-progress draft.
  const lastEmitted = useRef<number | null>(null);

  useEffect(() => {
    if (lastEmitted.current !== null && value === lastEmitted.current) return;
    setDraft(null);
  }, [value]);

  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    const parsed = parseInt(trimmed, 10);
    if (trimmed !== '' && !Number.isNaN(parsed)) {
      const clamped = clamp(parsed);
      lastEmitted.current = clamped;
      onChange(clamped);
    }
    // invalid/empty: fall through — clearing draft reverts the rendered
    // input to `value` (the last committed number), no onChange needed.
    setDraft(null);
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    setDraft(raw);
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const parsed = parseInt(trimmed, 10);
    if (!Number.isNaN(parsed)) {
      const clamped = clamp(parsed);
      lastEmitted.current = clamped;
      onChange(clamped);
    }
  };

  const stepBy = (delta: number) => {
    setDraft(null);
    const clamped = clamp(value + delta);
    lastEmitted.current = clamped;
    onChange(clamped);
  };

  return (
    <div className="flex items-center gap-0">
      <button type="button" onClick={() => stepBy(-1)} disabled={disabled} aria-label={ariaLabel ? `Decrease ${ariaLabel}` : undefined}
        className="px-3 py-2 bg-raised border border-border rounded-l text-muted hover:text-neon-cyan hover:border-neon-cyan transition-colors text-sm font-bold disabled:opacity-50 disabled:pointer-events-none">−</button>
      <input type="number" min={min} max={max} value={draft ?? String(value)} onChange={handleChange} onBlur={commit} disabled={disabled} aria-label={ariaLabel}
        className="w-14 text-center px-1 py-2 bg-raised border-y border-border text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors disabled:opacity-50 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
      <button type="button" onClick={() => stepBy(1)} disabled={disabled} aria-label={ariaLabel ? `Increase ${ariaLabel}` : undefined}
        className="px-3 py-2 bg-raised border border-border rounded-r text-muted hover:text-neon-cyan hover:border-neon-cyan transition-colors text-sm font-bold disabled:opacity-50 disabled:pointer-events-none">+</button>
    </div>
  );
}

/**
 * Detects ids that are simultaneously required AND excluded ON THE SAME AXIS —
 * a contradiction that admits games but rejects every submission from them.
 * Returns display labels, per axis, so the message can name what clashed.
 *
 * Deliberately per-axis: engine `fx` required + device `atgames` excluded is
 * the *intended* "FX titles, but not on cabinets" configuration, not a conflict.
 * Exported so tournament Create / Save handlers can gate on it as well.
 */
export function getPlatformRuleConflicts(rules: PlatformRules): string[] {
  const out: string[] = [];
  const collect = (axis: AxisRules, label: (id: string) => string) => {
    if (axis.required.length === 0 || axis.excluded.length === 0) return;
    const exc = new Set(axis.excluded.map(p => p.toLowerCase()));
    for (const p of axis.required) {
      if (exc.has(p.toLowerCase())) out.push(label(p));
    }
  };
  collect(rules.engines, getEngineDisplay);
  collect(rules.devices, getDeviceDisplay);
  return out;
}

/**
 * Engine chips a room can restrict on: the engines its catalogue actually
 * offers (`enginesFromLegacyPlatforms` folds `vpxs` → `vpx` etc.), plus
 * anything the tournament already has selected so an existing rule is never
 * invisible in the form it is about to be saved from.
 */
export function engineOptionsFor(platforms: string[], rules: PlatformRules): string[] {
  const out = enginesFromLegacyPlatforms(platforms).filter(e => e !== UNKNOWN);
  for (const id of [...rules.engines.required, ...rules.engines.excluded]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Device chips: every device that can run one of the room's engines, plus any
 * device its catalogue ids name outright (`atgames`, `real` → real_cabinet),
 * plus anything already selected. Ordered by the canonical device list so the
 * chips don't reshuffle as a room's catalogue grows.
 */
export function deviceOptionsFor(platforms: string[], rules: PlatformRules): string[] {
  const found = new Set<string>();
  for (const engine of enginesFromLegacyPlatforms(platforms)) {
    if (engine === UNKNOWN) continue;
    for (const d of devicesForEngine(engine)) found.add(d);
  }
  for (const p of platforms) {
    const { device } = mapLegacyPlatform(p);
    if (device !== UNKNOWN) found.add(device);
  }
  const out = Object.keys(CANONICAL_DEVICES).filter(d => found.has(d));
  for (const id of [...rules.devices.required, ...rules.devices.excluded]) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * One axis's Must / Not-allowed chip pair. The labels are unchanged from the
 * single-control version — they tested well and ADR 0009's semantics behind
 * them have not moved; only the namespace they range over has.
 */
function AxisEditor({ axis, options, label, emptyText, onToggle }: {
  axis: AxisRules;
  options: string[];
  label: (id: string) => string;
  emptyText: string;
  onToggle: (list: 'required' | 'excluded', id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Must be available on <span className="text-faint">(game must list at least one)</span>
        </label>
        <div className="flex flex-wrap gap-2 items-center">
          {options.map(id => (
            <button key={`req-${id}`} type="button" onClick={() => onToggle('required', id)}
              className={`px-3 py-1 rounded text-xs border cursor-pointer transition-colors ${
                axis.required.includes(id)
                  ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                  : 'bg-raised border-border text-muted hover:border-neon-cyan/50'
              }`}>{label(id)}</button>
          ))}
          {options.length === 0 && <span className="text-faint text-xs">{emptyText}</span>}
        </div>
      </div>
      <div>
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Not allowed on <span className="text-faint">(blocks score submissions, not game selection)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {options.map(id => (
            <button key={`exc-${id}`} type="button" onClick={() => onToggle('excluded', id)}
              className={`px-3 py-1 rounded text-xs border cursor-pointer transition-colors ${
                axis.excluded.includes(id)
                  ? 'bg-neon-magenta/20 border-neon-magenta text-neon-magenta'
                  : 'bg-raised border-border text-muted hover:border-neon-magenta/50'
              }`}>{label(id)}</button>
          ))}
        </div>
      </div>
    </div>
  );
}

function PlatformRulesEditor({ platforms, rules, onChange }: {
  platforms: string[];
  rules: PlatformRules;
  onChange: (r: PlatformRules) => void;
}) {
  const conflicts = getPlatformRuleConflicts(rules);
  const engineOptions = useMemo(() => engineOptionsFor(platforms, rules), [platforms, rules]);
  const deviceOptions = useMemo(() => deviceOptionsFor(platforms, rules), [platforms, rules]);

  const toggle = (axisKey: 'engines' | 'devices') =>
    (list: 'required' | 'excluded', id: string) => {
      const current = rules[axisKey][list];
      const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id];
      onChange({ ...rules, [axisKey]: { ...rules[axisKey], [list]: next } });
    };

  return (
    <div className="space-y-5">
      <div className="rounded border border-border/60 p-3 space-y-3">
        <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/80">
          Engines <span className="normal-case tracking-normal text-faint">— what the score was played on (VPX, FX, a real machine)</span>
        </p>
        <AxisEditor
          axis={rules.engines}
          options={engineOptions}
          label={getEngineDisplay}
          emptyText="No engines configured."
          onToggle={toggle('engines')}
        />
      </div>
      <div className="rounded border border-border/60 p-3 space-y-3">
        <p className="text-xs font-display uppercase tracking-wider text-neon-cyan/80">
          Devices <span className="normal-case tracking-normal text-faint">— the hardware it ran on (PC, AtGames cabinet, VR headset)</span>
        </p>
        <AxisEditor
          axis={rules.devices}
          options={deviceOptions}
          label={getDeviceDisplay}
          emptyText="No devices configured."
          onToggle={toggle('devices')}
        />
      </div>
      {conflicts.length > 0 && (
        <p className="text-xs text-neon-magenta">
          {conflicts.join(', ')} can't be both required and not allowed — every submission would be rejected.
        </p>
      )}
      <div>
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Restriction note <span className="text-faint">(shown in announcements)</span>
        </label>
        <input type="text" placeholder="e.g. Must be played on VPX only"
          value={rules.restrictedText}
          onChange={e => onChange({ ...rules, restrictedText: e.target.value })}
          className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors" />
      </div>
    </div>
  );
}

function CleanupRuleEditor({ value, onChange, roomTimezone = DEFAULT_TIMEZONE }: { value: CleanupRule; onChange: (v: CleanupRule) => void; roomTimezone?: string }) {
  const selectClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors cursor-pointer";

  return (
    <div className="space-y-3">
      <select
        value={value.mode}
        onChange={e => {
          const mode = e.target.value as CleanupRule['mode'];
          if (mode === 'immediate') onChange({ mode: 'immediate' });
          else if (mode === 'retain') onChange({ mode: 'retain', count: value.count ?? 0 });
          else onChange({ mode: 'scheduled', cron: value.cron ?? '0 22 * * 3', timezone: value.timezone });
        }}
        className={selectClass}
      >
        <option value="immediate">Hide immediately on rotation</option>
        <option value="retain">Keep last N visible</option>
        <option value="scheduled">Hide on a schedule</option>
      </select>
      {value.mode === 'retain' && (
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted whitespace-nowrap">Keep visible:</span>
          <NumberStepper value={value.count ?? 0} onChange={c => onChange({ ...value, count: c })} min={0} />
          <span className="text-sm text-faint">completed game(s)</span>
        </div>
      )}
      {value.mode === 'scheduled' && (
        <ScheduleBuilder
          value={{ cron: value.cron ?? '0 22 * * 3', timezone: value.timezone ?? roomTimezone }}
          onChange={s => onChange({ ...value, cron: s.cron, timezone: s.timezone })}
        />
      )}
    </div>
  );
}

/**
 * Season block (docs/season-format-plan.md §8.1, §13) — a bounded grind: N
 * tables, each table's finishing places earning Countdown points on the
 * season's ranking group. Rotation-only. As of v2.162.0 (ADR 0026) this is the
 * bound ONLY — how each table is chosen is the Game Rotation section's job
 * (winner picks, auto-pick, an admin, or Pick by poll), and a Season forces
 * nothing.
 */
function SeasonSection({ season, onChange }: {
  season: SeasonFormState;
  onChange: (s: SeasonFormState) => void;
}) {
  const labelClass = "block text-xs font-display uppercase tracking-wider text-muted mb-1.5";
  const patch = (p: Partial<SeasonFormState>) => onChange({ ...season, ...p });
  const errors = getSeasonErrors(season);

  return (
    <div className="mb-4 rounded border border-border/60 p-3" data-testid="season-section">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={season.enabled}
          onChange={e => patch({ enabled: e.target.checked })}
          className="accent-neon-cyan"
          aria-label="Run as a Season"
        />
        <span className="text-sm text-primary font-medium">Run as a Season</span>
        <InfoTip text="A Season is a fixed number of tables, one per rotation. Each table's finishing places earn Countdown points that add up to season standings, scored by the season's ranking group on the Rankings page (50 for 1st by default, editable there)." />
      </label>
      {!season.enabled && (
        <p className="text-xs text-faint mt-1.5 ml-6">Off — this tournament rotates forever.</p>
      )}
      {season.enabled && (
        <div className="mt-3 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>
                Tables in the season <InfoTip text="How many tables the season runs. After the last one it stops rotating and announces the final standings." />
              </label>
              <NumberStepper value={season.tableCount} onChange={v => patch({ tableCount: v })} min={1} max={200} ariaLabel="Tables in the season" />
            </div>
          </div>
          {errors.length > 0 && (
            <ul className="text-xs text-neon-magenta space-y-0.5" role="alert">
              {errors.map(e => <li key={e}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Pick by poll (ADR 0026) — the poll settings shown under the "Pick by poll"
 * checkbox in the Game Rotation section. The poll queue itself is run from the
 * Polls / Season panel on the Tournaments page.
 */
function PollSettings({ poll, onChange, schedule }: {
  poll: PollFormState;
  onChange: (p: PollFormState) => void;
  schedule: { cron: string; timezone: string };
}) {
  const selectClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors cursor-pointer";
  const labelClass = "block text-xs font-display uppercase tracking-wider text-muted mb-1.5";
  const patch = (p: Partial<PollFormState>) => onChange({ ...poll, ...p });
  const errors = getPollErrors(poll, schedule.cron);
  const echo = describePollTimes(schedule.cron, schedule.timezone, poll.opensBeforeH, poll.closesBeforeH);

  return (
    <div className="ml-6 mt-2 space-y-4 rounded border border-border/60 p-3" data-testid="poll-settings">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass}>
            Poll opens (hours before rotation) <InfoTip text="When each poll opens, counted back from the rotation that starts the table it picks. 96 = Monday for a Friday rotation." />
          </label>
          <NumberStepper value={poll.opensBeforeH} onChange={v => patch({ opensBeforeH: v })} min={2} max={POLL_MAX_OFFSET_H} ariaLabel="Poll opens hours before rotation" />
        </div>
        <div>
          <label className={labelClass}>
            Poll closes (hours before rotation) <InfoTip text="When voting ends. At least 1 hour (Discord's minimum), and before the table starts so a tie can be settled in time." />
          </label>
          <NumberStepper value={poll.closesBeforeH} onChange={v => patch({ closesBeforeH: v })} min={1} max={POLL_MAX_OFFSET_H} ariaLabel="Poll closes hours before rotation" />
        </div>
      </div>
      <p className="text-xs text-muted" data-testid="poll-echo">
        {echo ?? `Each poll opens ${poll.opensBeforeH} h and closes ${poll.closesBeforeH} h before its rotation.`}
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className={labelClass} htmlFor="poll-tie-rule">
            Poll Tie-breaker <InfoTip text="What happens when two or more tables tie for the most votes. Admin decides: nothing is queued and the rotation waits until an admin picks one of the tied tables on the Polls panel." />
          </label>
          <select id="poll-tie-rule" value={poll.tieRule} onChange={e => patch({ tieRule: e.target.value as PollTieRule })} className={selectClass}>
            {(Object.keys(TIE_RULE_LABEL) as PollTieRule[]).map(r => (
              <option key={r} value={r}>{TIE_RULE_LABEL[r]}</option>
            ))}
          </select>
        </div>
      </div>
      {errors.length > 0 && (
        <ul className="text-xs text-neon-magenta space-y-0.5" role="alert">
          {errors.map(e => <li key={e}>{e}</li>)}
        </ul>
      )}
    </div>
  );
}

/**
 * Limited attempts (v2.167.0, ADR 0029). Blank = unlimited. A positive whole
 * number turns the tournament into an Arcaid-Witness-only one (Castcade on a
 * PC, the Witness app on a cabinet): every game start counts, and manual
 * (phone / Discord) entry is refused by the server.
 */
function LimitedAttemptsField({ value, onChange, requireStart, onRequireStartChange }: {
  value: number | null; onChange: (v: number | null) => void;
  requireStart: boolean; onRequireStartChange: (v: boolean) => void;
}) {
  return (
    <div className="mb-4" data-testid="limited-attempts">
      <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5" htmlFor="tournament-max-attempts">
        Limited attempts <InfoTip text="Each player gets this many game starts per table. Every start counts, however it ends. Scores come only from Arcaid Witness: Castcade live mode on a PC, the Witness app on an AtGames cabinet. Phone and Discord entry are off for this tournament." />
      </label>
      <input
        id="tournament-max-attempts"
        type="number"
        inputMode="numeric"
        min={1}
        max={999}
        step={1}
        placeholder="Unlimited"
        aria-label="Limited attempts"
        value={value ?? ''}
        onChange={e => {
          // Blank = unlimited; anything that is not a whole number 1–999 is
          // ignored (the field keeps its last valid value).
          const raw = e.target.value;
          if (raw.trim() === '') { onChange(null); return; }
          const n = Number(raw);
          if (Number.isInteger(n) && n >= 1 && n <= 999) onChange(n);
        }}
        className="w-32 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
      />
      <p className="text-xs text-faint mt-1">
        {value == null
          ? 'Blank = unlimited: players may play as often as they like and the best score counts.'
          : `Each player gets ${value} game start${value === 1 ? '' : 's'} per table. Scores come only from Arcaid Witness.`}
      </p>
      {value != null && (
        <label className="flex items-start gap-2 mt-3 text-sm text-primary cursor-pointer" data-testid="require-attempt-start">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={requireStart}
            onChange={e => onRequireStartChange(e.target.checked)}
          />
          <span>
            Players press "Start attempts" first
            <span className="block text-xs text-faint mt-0.5">
              {requireStart
                ? 'Until a player presses Start attempts on a table (on its game page), their plays there go to the Global Scoreboard and use no attempt. Good for long rounds: warm up, then start.'
                : 'Off: every play that ends while the table is open counts and uses an attempt. Plays before the table opens never count.'}
            </span>
          </span>
        </label>
      )}
    </div>
  );
}

/**
 * v2.169.0 (W20, owner ruling 2026-10-23) — events only. What happens to a score
 * whose game the Arcaid Witness saw START before the round opened (gearing up).
 */
function WitnessFlagModeField({ value, onChange }: { value: 'prevent' | 'flag'; onChange: (v: 'prevent' | 'flag') => void }) {
  return (
    <div className="mb-4" data-testid="witness-flag-mode">
      <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5" htmlFor="tournament-witness-flag-mode">
        Games started before the round <InfoTip text="The Arcaid Witness sees when a game started. A game started before its round opened (gearing up) can be left out of the standings, or counted with a warning. Only games the Witness timed can be caught: AtGames cabinet tables with a ROM, and PC tables imported into Castcade. A no-ROM cabinet table or a PC table that was not imported reports one reading at exit and is never flagged." />
      </label>
      <select
        id="tournament-witness-flag-mode"
        aria-label="Games started before the round"
        value={value}
        onChange={e => onChange(e.target.value === 'flag' ? 'flag' : 'prevent')}
        className="px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors"
      >
        <option value="prevent">Don't count them (recommended)</option>
        <option value="flag">Count them, with a warning</option>
      </select>
      <p className="text-xs text-faint mt-1">
        {value === 'prevent'
          ? "A game started early is shown as not counted; the player's best game started inside the round counts instead."
          : 'A game started early counts and shows a warning. Use this if a cabinet clock is known to be wrong.'}
      </p>
    </div>
  );
}

/**
 * Integrity section (v2.166.0, ADR 0027; Castcade ADR 0005) — Open play or
 * Sanctioned play, and the Sanctioned rule set. The rules are measured by the
 * Castcade companion with every score it posts and judged by the SAME pure
 * function on the server, the companion's preflight and the runner's review
 * panel; this section only edits what that function is given. Which TABLE a
 * game requires is picked per game on the Integrity panel (Tournaments page),
 * because a tournament's games are not known when its form is filled in.
 */
function IntegritySection({ mode, rules, onModeChange, onRulesChange }: {
  mode: IntegrityMode;
  rules: SanctionedRulesForm;
  onModeChange: (m: IntegrityMode) => void;
  onRulesChange: (r: SanctionedRulesForm) => void;
}) {
  const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";
  const labelClass = "block text-xs font-display uppercase tracking-wider text-muted mb-1.5";
  const patch = (p: Partial<SanctionedRulesForm>) => onRulesChange({ ...rules, ...p });
  const errors = getIntegrityErrors(mode, rules);

  const check = (key: keyof Pick<SanctionedRulesForm,
    'requireNamedTable' | 'requireStockPhysics' | 'requireFactoryAdjustments' | 'requireKnownBuild' | 'allowNightlyBuilds' | 'requireNudgeFilter'>,
    label: string, tip: string, disabled = false) => (
    <label className="flex items-center gap-2 cursor-pointer">
      <input type="checkbox" checked={rules[key]} disabled={disabled} aria-label={label}
        onChange={e => patch({ [key]: e.target.checked } as Partial<SanctionedRulesForm>)}
        className="accent-neon-cyan disabled:opacity-50" />
      <span className="text-sm text-muted">{label}</span>
      <InfoTip text={tip} />
    </label>
  );

  return (
    <div className="mb-4" data-testid="integrity-section">
      <label className={labelClass.replace('mb-1.5', 'mb-2')}>
        Integrity <InfoTip text="How strictly a Castcade-reported score has to match this tournament's conditions before it lands on its board. Conditions are measured on the player's PC and sent with every score in both modes; only Sanctioned play holds a failing score out. Room boards never filter or re-rank on a verdict." />
      </label>
      <div className="inline-flex rounded border border-border overflow-hidden">
        {(['open', 'sanctioned'] as const).map(m => (
          <button
            key={m}
            type="button"
            onClick={() => onModeChange(m)}
            aria-pressed={mode === m}
            className={`px-4 py-2 text-sm transition-colors cursor-pointer ${
              mode === m ? 'bg-neon-cyan/20 text-neon-cyan' : 'bg-raised text-muted hover:text-primary'
            }`}
          >{INTEGRITY_MODE_LABEL[m]}</button>
        ))}
      </div>
      <p className="text-xs text-faint mt-1.5">{INTEGRITY_MODE_HELP[mode]}</p>

      {mode === 'sanctioned' && (
        <div className="mt-3 rounded border border-border/60 p-3 space-y-4" data-testid="sanctioned-rules">
          <p className="text-xs text-faint">
            Pick the required table for each game on the Integrity panel once the tournament has games. These rules apply to every game in it.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2">
            {check('requireNamedTable', 'Require the named table',
              'The score must come from the table named for the game on the Integrity panel. With no table named for a game, this rule is skipped for it.')}
            {check('requireStockPhysics', 'Require stock physics',
              'No physics-set override on the table file, no flipper physics override, and no difficulty override from the in-game tweak menu.')}
            {check('requireFactoryAdjustments', 'Require factory adjustments',
              'ROM machine adjustments at factory values; Free Play is allowed by default')}
            {check('requireKnownBuild', 'Require a known build',
              'Official 10.8.0 and the Panasony VR community build pass; nightlies pass when allowed; anything else needs its SHA-256 blessed here')}
            {check('allowNightlyBuilds', 'Allow nightly builds',
              'A VPX or VPinMAME nightly build passes the known-build rule. Off = only official, Panasony or blessed builds.', !rules.requireKnownBuild)}
            {check('requireNudgeFilter', 'Require the nudge filter',
              'VPX\'s EnableNudgeFilter must be on. Off by default: the 10.8.0 filter blocks little, and many players never touch it.')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className={labelClass}>
                Minimum tilt sensitivity <InfoTip text="VPX Keys/Nudge setting, 0–1000; higher tilts sooner; VPX default 400" />
              </label>
              <NumberStepper value={rules.minTiltSensitivity} onChange={v => patch({ minTiltSensitivity: v })}
                min={TILT_SENSITIVITY_MIN} max={TILT_SENSITIVITY_MAX} ariaLabel="Minimum tilt sensitivity" />
              <p className="text-xs text-faint mt-1">0 = no minimum. Only checked while the accelerometer is on.</p>
            </div>
            <div>
              <label className={labelClass}>
                Maximum accelerometer gain (%) <InfoTip text="VPX accelerometer gain in %, 150 is the VPX default" />
              </label>
              <NumberStepper value={rules.maxAccelGain} onChange={v => patch({ maxAccelGain: v })}
                min={ACCEL_GAIN_MIN} max={ACCEL_GAIN_MAX} ariaLabel="Maximum accelerometer gain" />
            </div>
          </div>
          <div>
            <label className={labelClass} htmlFor="integrity-adjustments-allowed">
              Allowed adjustments <InfoTip text="Machine adjustment labels (as the ROM names them) that may differ from factory without failing the factory-adjustments rule. Comma-separated, case-insensitive." />
            </label>
            <input id="integrity-adjustments-allowed" type="text" placeholder="e.g. Free Play, Balls Per Game" aria-label="Allowed adjustments"
              value={rules.adjustmentsAllowed} onChange={e => patch({ adjustmentsAllowed: e.target.value })}
              className={inputClass} disabled={!rules.requireFactoryAdjustments} />
          </div>
          <div>
            <label className={labelClass} htmlFor="integrity-blessed-hashes">
              Blessed build hashes <InfoTip text="SHA-256 of a VPX or VPinMAME binary that is neither official, Panasony nor a nightly but that you accept for this tournament. One per line; the Castcade Status page shows a player's build hash." />
            </label>
            <textarea id="integrity-blessed-hashes" rows={2} placeholder="One SHA-256 (64 hex characters) per line" aria-label="Blessed build hashes"
              value={rules.blessedBuildHashes} onChange={e => patch({ blessedBuildHashes: e.target.value })}
              className={`${inputClass} font-mono text-xs`} disabled={!rules.requireKnownBuild} spellCheck={false} />
          </div>
          {errors.length > 0 && (
            <ul className="text-xs text-neon-magenta space-y-0.5" role="alert">
              {errors.map(e => <li key={e}>{e}</li>)}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// --- Main Form Component ---

interface TournamentFormFieldsProps {
  state: TournamentFormState;
  set: <K extends keyof TournamentFormState>(field: K, value: TournamentFormState[K]) => void;
  /**
   * The room's catalogue platform ids (legacy namespace, from
   * `GET /:roomId/platforms/available`). The rule editor derives its engine and
   * device chip lists from these — the catalogue is still a legacy-id list, so
   * this stays the input even though the rules no longer are.
   */
  platforms: string[];
  /** Room id — the round editor's game-name autocomplete needs it. */
  roomId?: string;
  /**
   * Round numbers already ACTIVE or COMPLETED, rendered read-only. The server
   * refuses to change them (`ROUND_LOCKED`); showing them as editable would
   * invite a save that can only fail.
   */
  lockedRounds?: number[];
  /**
   * The room's default timezone (`ROOM_TIMEZONE`). Seeds the cleanup schedule
   * when the rule carries no zone of its own.
   */
  roomTimezone?: string;
  /**
   * W33 (owner ruling 2026-10-25): an existing tournament's format can't be
   * changed — the server answers 409 FORMAT_LOCKED. The edit modal sets this
   * so the toggle reads as fixed rather than inviting a save that fails.
   */
  formatLocked?: boolean;
}

export default function TournamentFormFields({ state, set, platforms, roomId, lockedRounds, roomTimezone = DEFAULT_TIMEZONE, formatLocked = false }: TournamentFormFieldsProps) {
  const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";
  const selectClass = `${inputClass} cursor-pointer`;

  const isEvent = state.format === 'event';
  // Pick by poll forces these on the server (TournamentService, ADR 0026) —
  // show the forced values, locked, rather than the admin's own (which return
  // if it is turned off). A Season alone forces nothing.
  const pollOn = !isEvent && state.poll.enabled;
  // 'Announcements' select — see the comment at its JSX. Only meaningful while
  // the admin is mid-edit; the stored value is always state.channel.
  const [channelMode, setChannelMode] = useState<'default' | 'custom' | 'none' | null>(null);

  return (
    <>
      <div className="mb-4">
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Format <InfoTip text="Rotation runs forever: one game at a time, rotating on a schedule, the winner picking next. Event is a single night: rounds with exact start and end times, an optional check-in list, and a final result. Scores outside a round's window are refused." />
        </label>
        <div className="inline-flex rounded border border-border overflow-hidden">
          {(['rotation', 'event'] as const).map(fmt => (
            <button
              key={fmt}
              type="button"
              onClick={() => set('format', fmt)}
              disabled={formatLocked && state.format !== fmt}
              aria-pressed={state.format === fmt}
              className={`px-4 py-2 text-sm transition-colors ${
                state.format === fmt
                  ? 'bg-neon-cyan/20 text-neon-cyan'
                  : formatLocked
                    ? 'bg-raised text-faint cursor-not-allowed'
                    : 'bg-raised text-muted hover:text-primary cursor-pointer'
              }`}
            >{fmt === 'rotation' ? 'Rotation' : 'Event'}</button>
          ))}
        </div>
        <p className="text-xs text-faint mt-1.5">
          {formatLocked && <>The format can't be changed after a tournament is created. To switch, create a new tournament. </>}
          {isEvent
            ? 'Time-boxed rounds on the server clock. Scores before a round opens or after it closes are refused.'
            : 'Runs continuously — the winner picks the next game and the schedule rotates it.'}
        </p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
            Name <InfoTip text="Display name for this tournament, shown in Discord and the admin UI." />
          </label>
          <input type="text" placeholder="e.g. The Daily Grind" value={state.name} onChange={e => set('name', e.target.value)} className={inputClass} />
        </div>
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
            Tag <InfoTip text="Short code used as the iScored game tag prefix (e.g. DG, WG-VPXS). Must be unique per tournament." />
          </label>
          <input type="text" placeholder="e.g. DG, WG-VPXS" value={state.tag} onChange={e => set('tag', e.target.value)} className={`${inputClass} font-mono`} />
        </div>
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
            Mode <InfoTip text="Pinball uses table/grind terminology. Video Game uses game/tournament terminology." />
          </label>
          <select value={state.mode} onChange={e => set('mode', e.target.value)} className={selectClass}>
            <option value="pinball">Pinball</option>
            <option value="videogame">Video Game</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
            Announcements <InfoTip text="Where this tournament's Discord announcements go. 'Room default' uses the room's announcement channel; 'Don't post' keeps this tournament off Discord entirely — the right choice for a test run in a live room." />
          </label>
          {/* v2.140.0 — an EMPTY channel falls back to the room's announcement
              channel, so before this select there was no way to run a QUIET
              tournament in a room that has one: the owner's AtGames test event
              posted straight into the live Daily Grind channel. 'none' is a
              sentinel the shared resolver recognises, stored in the same
              column. channelMode overrides the derivation only while the admin
              is mid-edit (picked "specific" but hasn't typed the id yet). */}
          <select
            value={channelMode ?? (state.channel === '' ? 'default' : state.channel === 'none' ? 'none' : 'custom')}
            onChange={e => {
              const v = e.target.value as 'default' | 'custom' | 'none';
              setChannelMode(v);
              if (v === 'default') set('channel', '');
              else if (v === 'none') set('channel', 'none');
              else if (state.channel === 'none') set('channel', '');
            }}
            className={selectClass}
          >
            <option value="default">Room default channel</option>
            <option value="custom">A specific channel…</option>
            <option value="none">Don't post to Discord</option>
          </select>
          {(channelMode ?? (state.channel === '' ? 'default' : state.channel === 'none' ? 'none' : 'custom')) === 'custom' && (
            <input
              type="text" placeholder="Channel ID (right-click the channel → Copy Channel ID)"
              value={state.channel === 'none' ? '' : state.channel}
              onChange={e => set('channel', e.target.value)}
              className={`${inputClass} mt-1.5`}
            />
          )}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5 whitespace-nowrap">
            Lineup Position <InfoTip text="Controls ordering on iScored. 0 = top of lineup. All games for a tournament (active + locked) are grouped together. Lower numbers appear higher." />
          </label>
          <NumberStepper value={state.displayOrder} onChange={v => set('displayOrder', v)} min={0} />
        </div>
        {!isEvent && (
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5 whitespace-nowrap">
              Active Slots <InfoTip text="How many games can be active simultaneously. Each slot rotates independently with its own winner picking the next game." />
            </label>
            <NumberStepper value={pollOn ? 1 : state.maxActiveGames} onChange={v => set('maxActiveGames', v)} min={1} disabled={pollOn} ariaLabel="Active Slots" />
            {pollOn && <p className="text-xs text-faint mt-1">Fixed at 1 while Pick by poll is on.</p>}
          </div>
        )}
      </div>

      {/* An event's rounds ARE its schedule and its rotation, so the rotation,
          schedule and cleanup controls below are not merely irrelevant here —
          showing them would imply a second, competing clock. */}
      {isEvent && (
        <EventSettingsFields
          state={state.event}
          onChange={e => set('event', e)}
          roomId={roomId}
          lockedRounds={lockedRounds}
        />
      )}

      {!isEvent && (
      <div className="mb-4">
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
          Game Rotation <InfoTip text="Controls how games are selected after a game completes." />
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={pollOn ? false : state.winnerPicks} disabled={pollOn} aria-label="Winner picks next game" onChange={e => set('winnerPicks', e.target.checked)} className="accent-neon-cyan disabled:opacity-50" />
            <span className="text-sm text-muted">Winner picks next game</span>
            <InfoTip text="When enabled, the winner of a completed game gets a pick window to choose the next game. Runner-up gets a window if the winner doesn't pick." />
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={pollOn ? false : state.autoPick} disabled={pollOn} aria-label="Auto-pick if no selection" onChange={e => set('autoPick', e.target.checked)} className="accent-neon-cyan disabled:opacity-50" />
            <span className="text-sm text-muted">Auto-pick if no selection</span>
            <InfoTip text="When enabled, the system automatically picks and activates a random eligible game if no one picks. If winner picks is disabled, auto-pick happens immediately after rotation." />
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={state.poll.enabled} aria-label="Pick by poll" onChange={e => set('poll', { ...state.poll, enabled: e.target.checked })} className="accent-neon-cyan" />
            <span className="text-sm text-muted">Pick by poll</span>
            <InfoTip text="The community picks each next table in a poll Arcaid posts to Discord and the room page. You curate the candidates on the Polls panel (Tournaments page); the winner is queued when the poll closes." />
          </label>
          {pollOn && (
            <>
              <p className="text-xs text-faint ml-6">{POLL_LOCK_NOTE}</p>
              <PollSettings poll={state.poll} onChange={p => set('poll', p)} schedule={state.schedule} />
            </>
          )}
          {!pollOn && !state.winnerPicks && state.autoPick && (
            <p className="text-xs text-neon-amber ml-6">Games will be auto-picked immediately after completion.</p>
          )}
          {!pollOn && !state.winnerPicks && !state.autoPick && (
            <p className="text-xs text-neon-magenta ml-6">An admin must manually activate games after completion.</p>
          )}
          {!pollOn && state.winnerPicks && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={state.allowDynasty} onChange={e => set('allowDynasty', e.target.checked)} className="accent-neon-cyan" />
              <span className="text-sm text-muted">Allow Dynasty (a back-to-back winner keeps pick rights)</span>
              <InfoTip text="When off, a winner who also won the previous round can't pick again — their pick passes on (they can still nominate or forfeit via /pick-game)." />
            </label>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                Cooldown Days <InfoTip text="How many days before a game can be picked again for this tournament." />
              </label>
              <NumberStepper value={pollOn ? 0 : state.eligibilityDays} onChange={v => set('eligibilityDays', v)} min={pollOn ? 0 : 1} disabled={pollOn} ariaLabel="Cooldown Days" />
              {pollOn && <p className="text-xs text-faint mt-1">Fixed at 0 while Pick by poll is on.</p>}
            </div>
            {!pollOn && state.winnerPicks && (
              <>
                <div>
                  <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                    Winner Window (min) <InfoTip text="Minutes the winner has to pick the next game before it passes to runner-up." />
                  </label>
                  <NumberStepper value={state.winnerPickWindowMin} onChange={v => set('winnerPickWindowMin', v)} min={1} />
                </div>
                <div>
                  <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                    Runner-up Window (min) <InfoTip text="Minutes the runner-up has to pick after the winner times out." />
                  </label>
                  <NumberStepper value={state.runnerupPickWindowMin} onChange={v => set('runnerupPickWindowMin', v)} min={1} />
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      )}
      {!isEvent && (
        <SeasonSection season={state.season} onChange={s => set('season', s)} />
      )}
      <div className="mb-4">
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
          Platform Rules <InfoTip text="Two independent controls. Engines are what produced the score (VPX, FX, a real machine); devices are the hardware it ran on (PC, AtGames cabinet, VR headset). 'Must be available on' decides which games can be picked; 'Not allowed on' blocks score submissions. Both sets of rules apply together." />
        </label>
        <PlatformRulesEditor platforms={platforms} rules={state.platformRules} onChange={r => set('platformRules', r)} />
      </div>
      <IntegritySection
        mode={state.integrityMode}
        rules={state.sanctionedRules}
        onModeChange={m => set('integrityMode', m)}
        onRulesChange={r => set('sanctionedRules', r)}
      />
      <LimitedAttemptsField
        value={state.maxAttempts}
        onChange={v => set('maxAttempts', v)}
        requireStart={state.requireAttemptStart}
        onRequireStartChange={v => set('requireAttemptStart', v)}
      />
      {isEvent && (
        <WitnessFlagModeField value={state.witnessFlagMode} onChange={v => set('witnessFlagMode', v)} />
      )}
      {!isEvent && (
        <>
          <div className="mb-4">
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
              Schedule <InfoTip text="When maintenance runs: locks the current game, scrapes scores, picks the next game, and announces results." />
            </label>
            <ScheduleBuilder value={state.schedule} onChange={s => set('schedule', s)} />
          </div>
          <div className="mb-4">
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
              Completed Game Cleanup <InfoTip text="Controls when finished games are hidden on iScored. 'Immediate' hides on rotation. 'Keep last N' retains recent games. 'Scheduled' hides all completed games on a cron schedule (e.g. weekly)." />
            </label>
            <CleanupRuleEditor value={state.cleanupRule} onChange={r => set('cleanupRule', r)} roomTimezone={roomTimezone} />
          </div>
        </>
      )}
    </>
  );
}
