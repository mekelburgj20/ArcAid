import { useReducer, useState } from 'react';
import ScheduleBuilder from './ScheduleBuilder';
import { InfoTip } from './Tooltip';
import { getPlatformDisplay } from '../lib/platforms';

// --- Types ---

export interface PlatformRules {
  required: string[];
  excluded: string[];
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
  platformRules: PlatformRules;
  cleanupRule: CleanupRule;
  schedule: { cron: string; timezone: string };
}

// --- Defaults ---

export const defaultPlatformRules: PlatformRules = { required: [], excluded: [], restrictedText: '' };
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

export function parsePlatformRules(json: string): PlatformRules {
  try {
    const r = JSON.parse(json);
    return { required: r.required || [], excluded: r.excluded || [], restrictedText: r.restrictedText || '' };
  } catch {
    return { ...defaultPlatformRules };
  }
}

export function parseCleanupRule(raw: string | undefined): CleanupRule {
  if (!raw) return { ...defaultCleanupRule };
  try { return JSON.parse(raw); } catch { return { ...defaultCleanupRule }; }
}

// --- Sub-components ---

function NumberStepper({ value, onChange, min = 0 }: { value: number; onChange: (v: number) => void; min?: number }) {
  return (
    <div className="flex items-center gap-0">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))}
        className="px-3 py-2 bg-raised border border-border rounded-l text-muted hover:text-neon-cyan hover:border-neon-cyan transition-colors text-sm font-bold">−</button>
      <input type="number" min={min} value={value} onChange={e => onChange(Math.max(min, parseInt(e.target.value) || 0))}
        className="w-14 text-center px-1 py-2 bg-raised border-y border-border text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" />
      <button type="button" onClick={() => onChange(value + 1)}
        className="px-3 py-2 bg-raised border border-border rounded-r text-muted hover:text-neon-cyan hover:border-neon-cyan transition-colors text-sm font-bold">+</button>
    </div>
  );
}

function PlatformRulesEditor({ platforms, rules, onChange, onAddPlatform }: {
  platforms: string[];
  rules: PlatformRules;
  onChange: (r: PlatformRules) => void;
  onAddPlatform?: (name: string) => void;
}) {
  const [newPlatform, setNewPlatform] = useState('');

  const toggle = (list: 'required' | 'excluded', p: string) => {
    const current = rules[list];
    const next = current.includes(p) ? current.filter(x => x !== p) : [...current, p];
    onChange({ ...rules, [list]: next });
  };

  const handleAdd = () => {
    const name = newPlatform.trim();
    if (!name || platforms.some(p => p.toUpperCase() === name.toUpperCase())) return;
    onAddPlatform?.(name);
    setNewPlatform('');
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Must be available on <span className="text-faint">(game must list at least one)</span>
        </label>
        <div className="flex flex-wrap gap-2 items-center">
          {platforms.map(p => (
            <button key={`req-${p}`} type="button" onClick={() => toggle('required', p)}
              className={`px-3 py-1 rounded text-xs border cursor-pointer transition-colors ${
                rules.required.includes(p)
                  ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                  : 'bg-raised border-border text-muted hover:border-neon-cyan/50'
              }`}>{getPlatformDisplay(p)}</button>
          ))}
          {platforms.length === 0 && <span className="text-faint text-xs">No platforms configured.</span>}
        </div>
      </div>
      <div>
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Not allowed on <span className="text-faint">(blocks score submissions, not game selection)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {platforms.map(p => (
            <button key={`exc-${p}`} type="button" onClick={() => toggle('excluded', p)}
              className={`px-3 py-1 rounded text-xs border cursor-pointer transition-colors ${
                rules.excluded.includes(p)
                  ? 'bg-neon-magenta/20 border-neon-magenta text-neon-magenta'
                  : 'bg-raised border-border text-muted hover:border-neon-magenta/50'
              }`}>{getPlatformDisplay(p)}</button>
          ))}
        </div>
      </div>
      {onAddPlatform && (
        <div>
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
            Add platform
          </label>
          <div className="flex gap-2">
            <input type="text" placeholder="e.g. Steam" value={newPlatform}
              onChange={e => setNewPlatform(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAdd(); } }}
              className="px-3 py-1.5 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors w-40" />
            <button type="button" onClick={handleAdd}
              disabled={!newPlatform.trim()}
              className="px-3 py-1.5 rounded text-xs border border-border text-muted hover:border-neon-cyan hover:text-neon-cyan transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer">
              + Add
            </button>
          </div>
        </div>
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
  platforms: string[];
  onAddPlatform?: (name: string) => void;
}

export default function TournamentFormFields({ state, set, platforms, onAddPlatform }: TournamentFormFieldsProps) {
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
          Platform Rules <InfoTip text="Control which platforms are required or excluded when picking games for this tournament." />
        </label>
        <PlatformRulesEditor platforms={platforms} rules={state.platformRules} onChange={r => set('platformRules', r)} onAddPlatform={onAddPlatform} />
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
