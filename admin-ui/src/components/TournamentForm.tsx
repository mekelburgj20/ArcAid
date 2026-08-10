import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import ScheduleBuilder from './ScheduleBuilder';
import { InfoTip } from './Tooltip';
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

export interface TournamentFormState {
  name: string;
  tag: string;
  mode: string;
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
   *  `/my-pick` still work either way. */
  allowDynasty: boolean;
  platformRules: PlatformRules;
  cleanupRule: CleanupRule;
  schedule: { cron: string; timezone: string };
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
  schedule: { cron: '0 0 * * *', timezone: 'America/Chicago' },
};

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

export function parseCadence(cadenceJson: string): { cron: string; timezone: string } {
  try {
    const c = JSON.parse(cadenceJson);
    return { cron: c.cron || '0 0 * * *', timezone: c.timezone || 'America/Chicago' };
  } catch {
    return { cron: '0 0 * * *', timezone: 'America/Chicago' };
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
export function NumberStepper({ value, onChange, min = 0 }: { value: number; onChange: (v: number) => void; min?: number }) {
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
      const clamped = Math.max(min, parsed);
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
      const clamped = Math.max(min, parsed);
      lastEmitted.current = clamped;
      onChange(clamped);
    }
  };

  const stepBy = (delta: number) => {
    setDraft(null);
    const clamped = Math.max(min, value + delta);
    lastEmitted.current = clamped;
    onChange(clamped);
  };

  return (
    <div className="flex items-center gap-0">
      <button type="button" onClick={() => stepBy(-1)}
        className="px-3 py-2 bg-raised border border-border rounded-l text-muted hover:text-neon-cyan hover:border-neon-cyan transition-colors text-sm font-bold">−</button>
      <input type="number" min={min} value={draft ?? String(value)} onChange={handleChange} onBlur={commit}
        className="w-14 text-center px-1 py-2 bg-raised border-y border-border text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
      <button type="button" onClick={() => stepBy(1)}
        className="px-3 py-2 bg-raised border border-border rounded-r text-muted hover:text-neon-cyan hover:border-neon-cyan transition-colors text-sm font-bold">+</button>
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

function CleanupRuleEditor({ value, onChange }: { value: CleanupRule; onChange: (v: CleanupRule) => void }) {
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
          value={{ cron: value.cron ?? '0 22 * * 3', timezone: value.timezone ?? 'America/Chicago' }}
          onChange={s => onChange({ ...value, cron: s.cron, timezone: s.timezone })}
        />
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
}

export default function TournamentFormFields({ state, set, platforms }: TournamentFormFieldsProps) {
  const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";
  const selectClass = `${inputClass} cursor-pointer`;

  return (
    <>
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
            Channel ID <InfoTip text="Discord channel ID for announcements. Right-click a channel in Discord → Copy Channel ID." />
          </label>
          <input type="text" placeholder="Optional" value={state.channel} onChange={e => set('channel', e.target.value)} className={inputClass} />
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-4">
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5 whitespace-nowrap">
            Lineup Position <InfoTip text="Controls ordering on iScored. 0 = top of lineup. All games for a tournament (active + locked) are grouped together. Lower numbers appear higher." />
          </label>
          <NumberStepper value={state.displayOrder} onChange={v => set('displayOrder', v)} min={0} />
        </div>
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5 whitespace-nowrap">
            Active Slots <InfoTip text="How many games can be active simultaneously. Each slot rotates independently with its own winner picking the next game." />
          </label>
          <NumberStepper value={state.maxActiveGames} onChange={v => set('maxActiveGames', v)} min={1} />
        </div>
      </div>
      <div className="mb-4">
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
          Game Rotation <InfoTip text="Controls how games are selected after a game completes." />
        </label>
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={state.winnerPicks} onChange={e => set('winnerPicks', e.target.checked)} className="accent-neon-cyan" />
            <span className="text-sm text-muted">Winner picks next game</span>
            <InfoTip text="When enabled, the winner of a completed game gets a pick window to choose the next game. Runner-up gets a window if the winner doesn't pick." />
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={state.autoPick} onChange={e => set('autoPick', e.target.checked)} className="accent-neon-cyan" />
            <span className="text-sm text-muted">Auto-pick if no selection</span>
            <InfoTip text="When enabled, the system automatically picks and activates a random eligible game if no one picks. If winner picks is disabled, auto-pick happens immediately after rotation." />
          </label>
          {!state.winnerPicks && state.autoPick && (
            <p className="text-xs text-neon-amber ml-6">Games will be auto-picked immediately after completion.</p>
          )}
          {!state.winnerPicks && !state.autoPick && (
            <p className="text-xs text-neon-magenta ml-6">An admin must manually activate games after completion.</p>
          )}
          {state.winnerPicks && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={state.allowDynasty} onChange={e => set('allowDynasty', e.target.checked)} className="accent-neon-cyan" />
              <span className="text-sm text-muted">Allow Dynasty (a back-to-back winner keeps pick rights)</span>
              <InfoTip text="When off, a winner who also won the previous round can't pick again — their pick passes on (they can still nominate or forfeit via /my-pick)." />
            </label>
          )}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mt-3">
            <div>
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                Cooldown Days <InfoTip text="How many days before a game can be picked again for this tournament." />
              </label>
              <NumberStepper value={state.eligibilityDays} onChange={v => set('eligibilityDays', v)} min={1} />
            </div>
            {state.winnerPicks && (
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
      <div className="mb-4">
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
          Platform Rules <InfoTip text="Two independent controls. Engines are what produced the score (VPX, FX, a real machine); devices are the hardware it ran on (PC, AtGames cabinet, VR headset). 'Must be available on' decides which games can be picked; 'Not allowed on' blocks score submissions. Both sets of rules apply together." />
        </label>
        <PlatformRulesEditor platforms={platforms} rules={state.platformRules} onChange={r => set('platformRules', r)} />
      </div>
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
        <CleanupRuleEditor value={state.cleanupRule} onChange={r => set('cleanupRule', r)} />
      </div>
    </>
  );
}
