import { useEffect, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import TournamentBadge from '../components/TournamentBadge';
import DataTable from '../components/DataTable';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import ScheduleBuilder from '../components/ScheduleBuilder';
import { InfoTip } from '../components/Tooltip';

interface Tournament {
  id: string;
  name: string;
  type: string;
  mode: string;
  cadence: string;
  platform_rules: string;
  guild_id?: string;
  discord_channel_id?: string;
  discord_role_id?: string;
  is_active: number;
  display_order: number;
  cleanup_rule: string;
}

interface PlatformRules {
  required: string[];
  excluded: string[];
  restrictedText: string;
}

const defaultPlatformRules: PlatformRules = { required: [], excluded: [], restrictedText: '' };

function parseCadence(cadenceJson: string): { cron: string; timezone: string } {
  try {
    const c = JSON.parse(cadenceJson);
    return { cron: c.cron || '0 0 * * *', timezone: c.timezone || 'America/Chicago' };
  } catch {
    return { cron: '0 0 * * *', timezone: 'America/Chicago' };
  }
}

function parsePlatformRules(json: string): PlatformRules {
  try {
    const r = JSON.parse(json);
    return { required: r.required || [], excluded: r.excluded || [], restrictedText: r.restrictedText || '' };
  } catch {
    return { ...defaultPlatformRules };
  }
}

function formatCadenceDisplay(cadenceJson: string): string {
  try {
    const c = JSON.parse(cadenceJson);
    const cron = c.cron || '';
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;
    const min = parts[0]; const hr = parts[1]; const dom = parts[2]; const dow = parts[4];
    const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const tz = c.timezone ? ` ${c.timezone.split('/').pop()?.replace(/_/g, ' ')}` : '';
    if (dom !== '*') return `${ordinal(parseInt(dom))} of month at ${time}${tz}`;
    if (dow !== '*') return `${days[parseInt(dow)] || dow} at ${time}${tz}`;
    return `Daily at ${time}${tz}`;
  } catch { return 'Not set'; }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function PlatformRulesEditor({ platforms, rules, onChange }: {
  platforms: string[];
  rules: PlatformRules;
  onChange: (r: PlatformRules) => void;
}) {
  const toggle = (list: 'required' | 'excluded', p: string) => {
    const current = rules[list];
    const next = current.includes(p) ? current.filter(x => x !== p) : [...current, p];
    onChange({ ...rules, [list]: next });
  };

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Must be available on <span className="text-faint">(game must list at least one)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {platforms.map(p => (
            <button key={`req-${p}`} type="button" onClick={() => toggle('required', p)}
              className={`px-3 py-1 rounded text-xs border cursor-pointer transition-colors ${
                rules.required.includes(p)
                  ? 'bg-neon-cyan/20 border-neon-cyan text-neon-cyan'
                  : 'bg-raised border-border text-muted hover:border-neon-cyan/50'
              }`}>{p}</button>
          ))}
          {platforms.length === 0 && <span className="text-faint text-xs">No platforms configured. Add them in Settings.</span>}
        </div>
      </div>
      <div>
        <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
          Not allowed on <span className="text-faint">(game cannot be on these)</span>
        </label>
        <div className="flex flex-wrap gap-2">
          {platforms.map(p => (
            <button key={`exc-${p}`} type="button" onClick={() => toggle('excluded', p)}
              className={`px-3 py-1 rounded text-xs border cursor-pointer transition-colors ${
                rules.excluded.includes(p)
                  ? 'bg-neon-magenta/20 border-neon-magenta text-neon-magenta'
                  : 'bg-raised border-border text-muted hover:border-neon-magenta/50'
              }`}>{p}</button>
          ))}
        </div>
      </div>
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

interface CleanupRule {
  mode: 'immediate' | 'retain' | 'scheduled';
  count?: number;
  cron?: string;
  timezone?: string;
}

const defaultCleanupRule: CleanupRule = { mode: 'retain', count: 0 };

function parseCleanupRule(raw: string | undefined): CleanupRule {
  if (!raw) return { ...defaultCleanupRule };
  try { return JSON.parse(raw); } catch { return { ...defaultCleanupRule }; }
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

interface ActiveGame {
  id: string;
  name: string;
  tournament_id: string;
  tournament_name: string;
  iscored_id: string | null;
  start_date: string;
}

export default function Tournaments() {
  const { toast } = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Tournament | null>(null);
  const [editTarget, setEditTarget] = useState<Tournament | null>(null);
  const [platforms, setPlatforms] = useState<string[]>([]);
  const [activeGames, setActiveGames] = useState<ActiveGame[]>([]);
  const [deactivateTarget, setDeactivateTarget] = useState<ActiveGame | null>(null);
  const [deactivating, setDeactivating] = useState(false);
  const [reordering, setReordering] = useState(false);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [newMode, setNewMode] = useState('pinball');
  const [newChannel, setNewChannel] = useState('');
  const [newDisplayOrder, setNewDisplayOrder] = useState(0);
  const [newPlatformRules, setNewPlatformRules] = useState<PlatformRules>({ ...defaultPlatformRules });
  const [newCleanupRule, setNewCleanupRule] = useState<CleanupRule>({ ...defaultCleanupRule });
  const [schedule, setSchedule] = useState({ cron: '0 0 * * *', timezone: 'America/Chicago' });

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editTag, setEditTag] = useState('');
  const [editMode, setEditMode] = useState('pinball');
  const [editChannel, setEditChannel] = useState('');
  const [editDisplayOrder, setEditDisplayOrder] = useState(0);
  const [editPlatformRules, setEditPlatformRules] = useState<PlatformRules>({ ...defaultPlatformRules });
  const [editCleanupRule, setEditCleanupRule] = useState<CleanupRule>({ ...defaultCleanupRule });
  const [editSchedule, setEditSchedule] = useState({ cron: '0 0 * * *', timezone: 'America/Chicago' });
  const [editSaving, setEditSaving] = useState(false);

  const fetchTournaments = async () => {
    try {
      setTournaments(await api.get<Tournament[]>('/tournaments'));
    } catch {
      toast('Failed to load tournaments', 'error');
    } finally {
      setLoading(false);
    }
  };

  const fetchPlatforms = async () => {
    try {
      const settings = await api.get<Record<string, string>>('/settings');
      if (settings.PLATFORMS) {
        try { setPlatforms(JSON.parse(settings.PLATFORMS)); } catch {}
      }
    } catch {}
  };

  const fetchActiveGames = async () => {
    try {
      setActiveGames(await api.get<ActiveGame[]>('/games/active'));
    } catch {}
  };

  const handleReorderLineup = async () => {
    setReordering(true);
    try {
      await api.post('/tournaments/reorder-lineup', {});
      toast('iScored lineup reordered', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to reorder lineup', 'error');
    } finally {
      setReordering(false);
    }
  };

  const handleDeactivate = async (dbOnly: boolean = false) => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      await api.post(`/games/${deactivateTarget.id}/deactivate`, { dbOnly });
      toast(`${deactivateTarget.name} deactivated${dbOnly ? ' (DB only)' : ''}`, 'success');
      setDeactivateTarget(null);
      fetchActiveGames();
    } catch (err: any) {
      toast(err.message || 'Failed to deactivate game', 'error');
    } finally {
      setDeactivating(false);
    }
  };

  useEffect(() => { fetchTournaments(); fetchPlatforms(); fetchActiveGames(); }, []);

  const handleCreate = async () => {
    if (!newName.trim() || !newTag.trim()) return;
    try {
      await api.post('/tournaments', {
        id: uuidv4(),
        name: newName,
        type: newTag.trim().toUpperCase(),
        mode: newMode,
        cadence: { cron: schedule.cron, autoRotate: true, autoLock: true, timezone: schedule.timezone },
        platform_rules: newPlatformRules,
        guild_id: '',
        discord_channel_id: newChannel,
        discord_role_id: '',
        is_active: true,
        display_order: newDisplayOrder,
        cleanup_rule: newCleanupRule,
      });
      setNewName(''); setNewTag(''); setNewChannel(''); setNewMode('pinball'); setNewDisplayOrder(0);
      setNewPlatformRules({ ...defaultPlatformRules });
      setNewCleanupRule({ ...defaultCleanupRule });
      setSchedule({ cron: '0 0 * * *', timezone: 'America/Chicago' });
      toast('Tournament created', 'success');
      fetchTournaments();
    } catch {
      toast('Failed to create tournament', 'error');
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.delete(`/tournaments/${deleteTarget.id}`);
      toast('Tournament deleted', 'success');
      setDeleteTarget(null);
      fetchTournaments();
    } catch {
      toast('Failed to delete tournament', 'error');
    }
  };

  const openEdit = (t: Tournament) => {
    setEditTarget(t);
    setEditName(t.name);
    setEditTag(t.type);
    setEditMode(t.mode || 'pinball');
    setEditChannel(t.discord_channel_id || '');
    setEditDisplayOrder(t.display_order || 0);
    setEditCleanupRule(parseCleanupRule(t.cleanup_rule));
    setEditSchedule(parseCadence(t.cadence));
    setEditPlatformRules(parsePlatformRules(t.platform_rules));
  };

  const handleEditSave = async () => {
    if (!editTarget || !editName.trim() || !editTag.trim()) return;
    setEditSaving(true);
    try {
      await api.put(`/tournaments/${editTarget.id}`, {
        name: editName,
        type: editTag.trim().toUpperCase(),
        mode: editMode,
        cadence: { cron: editSchedule.cron, autoRotate: true, autoLock: true, timezone: editSchedule.timezone },
        platform_rules: editPlatformRules,
        guild_id: editTarget.guild_id || '',
        discord_channel_id: editChannel,
        discord_role_id: editTarget.discord_role_id || '',
        is_active: true,
        display_order: editDisplayOrder,
        cleanup_rule: editCleanupRule,
      });
      toast('Tournament updated', 'success');
      setEditTarget(null);
      fetchTournaments();
    } catch {
      toast('Failed to update tournament', 'error');
    } finally {
      setEditSaving(false);
    }
  };

  if (loading) return <LoadingState message="Loading tournaments..." />;

  const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";
  const selectClass = `${inputClass} cursor-pointer`;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Tournaments</h1>

      {/* Create Form */}
      <NeonCard glowColor="cyan" className="mb-6" title="Create New Tournament">
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
              Name <InfoTip text="Display name for this tournament, shown in Discord and the admin UI." />
            </label>
            <input type="text" placeholder="e.g. The Daily Grind" value={newName} onChange={e => setNewName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
              Tag <InfoTip text="Short code used as the iScored game tag prefix (e.g. DG, WG-VPXS). Must be unique per tournament." />
            </label>
            <input type="text" placeholder="e.g. DG, WG-VPXS" value={newTag} onChange={e => setNewTag(e.target.value)} className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
              Mode <InfoTip text="Pinball uses table/grind terminology. Video Game uses game/tournament terminology." />
            </label>
            <select value={newMode} onChange={e => setNewMode(e.target.value)} className={selectClass}>
              <option value="pinball">Pinball</option>
              <option value="videogame">Video Game</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
              Channel ID <InfoTip text="Discord channel ID for announcements. Right-click a channel in Discord → Copy Channel ID." />
            </label>
            <input type="text" placeholder="Optional" value={newChannel} onChange={e => setNewChannel(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
              Lineup Position <InfoTip text="Controls ordering on iScored. 0 = top of lineup. All games for a tournament (active + locked) are grouped together. Lower numbers appear higher." />
            </label>
            <NumberStepper value={newDisplayOrder} onChange={setNewDisplayOrder} min={0} />
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
            Platform Rules <InfoTip text="Control which platforms are required or excluded when picking games for this tournament." />
          </label>
          <PlatformRulesEditor platforms={platforms} rules={newPlatformRules} onChange={setNewPlatformRules} />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
            Schedule <InfoTip text="When maintenance runs: locks the current game, scrapes scores, picks the next game, and announces results." />
          </label>
          <ScheduleBuilder value={schedule} onChange={setSchedule} />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
            Completed Game Cleanup <InfoTip text="Controls when finished games are hidden on iScored. 'Immediate' hides on rotation. 'Keep last N' retains recent games. 'Scheduled' hides all completed games on a cron schedule (e.g. weekly)." />
          </label>
          <CleanupRuleEditor value={newCleanupRule} onChange={setNewCleanupRule} />
        </div>
        <NeonButton onClick={handleCreate} disabled={!newName.trim() || !newTag.trim()}>Create Tournament</NeonButton>
      </NeonCard>

      {/* Tournament List */}
      <NeonCard>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-sm font-bold uppercase tracking-wider text-muted">Active Tournaments</h3>
          <NeonButton variant="ghost" onClick={handleReorderLineup} disabled={reordering} className="text-xs px-3 py-1">
            {reordering ? 'Reordering...' : 'Sync iScored Lineup'}
          </NeonButton>
        </div>
        <DataTable<Tournament>
          columns={[
            { key: 'name', header: 'Name', render: t => <span className="font-medium">{t.name}</span> },
            { key: 'type', header: 'Tag', render: t => <TournamentBadge type={t.type} /> },
            { key: 'mode', header: 'Mode', render: t => (
              <span className={`text-xs px-2 py-0.5 rounded ${t.mode === 'pinball' ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan'}`}>
                {t.mode === 'pinball' ? 'Pinball' : 'Video Game'}
              </span>
            )},
            { key: 'display_order', header: 'Pos', render: t => (
              <span className="text-sm text-muted font-mono">{t.display_order ?? 0}</span>
            )},
            { key: 'cadence', header: 'Schedule', render: t => (
              <span className="text-sm text-neon-amber">{formatCadenceDisplay(t.cadence)}</span>
            )},
            { key: 'actions', header: '', render: t => (
              <div className="flex gap-2 justify-end">
                <NeonButton variant="ghost" onClick={() => openEdit(t)} className="text-xs px-2 py-1">Edit</NeonButton>
                <NeonButton variant="danger" onClick={() => setDeleteTarget(t)} className="text-xs px-2 py-1">Delete</NeonButton>
              </div>
            ), className: 'text-right' },
          ]}
          data={tournaments}
          keyExtractor={t => t.id}
          emptyMessage="No tournaments configured yet."
        />
      </NeonCard>

      {/* Active Games */}
      <NeonCard title="Active Games" className="mt-6">
        <DataTable<ActiveGame>
          columns={[
            { key: 'name', header: 'Game', render: g => <span className="font-medium">{g.name}</span> },
            { key: 'tournament_name', header: 'Tournament', render: g => <span className="text-muted">{g.tournament_name}</span> },
            { key: 'start_date', header: 'Started', render: g => (
              <span className="text-sm text-muted">{g.start_date ? new Date(g.start_date).toLocaleString() : '—'}</span>
            )},
            { key: 'iscored_id', header: 'iScored', render: g => (
              <span className={`text-xs ${g.iscored_id ? 'text-neon-green' : 'text-faint'}`}>{g.iscored_id ? 'Linked' : 'No'}</span>
            )},
            { key: 'actions', header: '', render: g => (
              <div className="flex justify-end">
                <NeonButton variant="danger" onClick={() => setDeactivateTarget(g)} className="text-xs px-2 py-1">Deactivate</NeonButton>
              </div>
            ), className: 'text-right' },
          ]}
          data={activeGames}
          keyExtractor={g => g.id}
          emptyMessage="No active games."
        />
      </NeonCard>

      {/* Deactivate Confirm */}
      {deactivateTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md">
            <h2 className="font-display text-lg font-bold mb-2">Deactivate Game</h2>
            <p className="text-muted text-sm mb-4">
              Deactivate <span className="text-primary font-medium">"{deactivateTarget.name}"</span> from {deactivateTarget.tournament_name}? Scores are preserved.
            </p>
            <div className="space-y-2 mb-4">
              <NeonButton
                variant="danger"
                className="w-full"
                onClick={() => handleDeactivate(false)}
                disabled={deactivating}
              >
                {deactivating ? 'Deactivating...' : 'Deactivate + Lock on iScored'}
              </NeonButton>
              <NeonButton
                variant="secondary"
                className="w-full"
                onClick={() => handleDeactivate(true)}
                disabled={deactivating}
              >
                DB Only (don't touch iScored)
              </NeonButton>
            </div>
            <NeonButton variant="ghost" onClick={() => setDeactivateTarget(null)} disabled={deactivating}>
              Cancel
            </NeonButton>
          </div>
        </div>
      )}

      {/* Edit Modal */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="font-display text-lg font-bold mb-4">Edit Tournament</h2>
            <div className="grid grid-cols-1 md:grid-cols-5 gap-4 mb-4">
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                  Name <InfoTip text="Display name for this tournament, shown in Discord and the admin UI." />
                </label>
                <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                  Tag <InfoTip text="Short code used as the iScored game tag prefix (e.g. DG, WG-VPXS). Must be unique per tournament." />
                </label>
                <input type="text" value={editTag} onChange={e => setEditTag(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                  Mode <InfoTip text="Pinball uses table/grind terminology. Video Game uses game/tournament terminology." />
                </label>
                <select value={editMode} onChange={e => setEditMode(e.target.value)} className={selectClass}>
                  <option value="pinball">Pinball</option>
                  <option value="videogame">Video Game</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                  Channel ID <InfoTip text="Discord channel ID for announcements. Right-click a channel in Discord → Copy Channel ID." />
                </label>
                <input type="text" placeholder="Optional" value={editChannel} onChange={e => setEditChannel(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                  Lineup Position <InfoTip text="Controls ordering on iScored. 0 = top of lineup. All games for a tournament (active + locked) are grouped together. Lower numbers appear higher." />
                </label>
                <NumberStepper value={editDisplayOrder} onChange={setEditDisplayOrder} min={0} />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
                Platform Rules <InfoTip text="Control which platforms are required or excluded when picking games for this tournament." />
              </label>
              <PlatformRulesEditor platforms={platforms} rules={editPlatformRules} onChange={setEditPlatformRules} />
            </div>
            <div className="mb-6">
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
                Schedule <InfoTip text="When maintenance runs: locks the current game, scrapes scores, picks the next game, and announces results." />
              </label>
              <ScheduleBuilder value={editSchedule} onChange={setEditSchedule} />
            </div>
            <div className="mb-6">
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">
                Completed Game Cleanup <InfoTip text="Controls when finished games are hidden on iScored. 'Immediate' hides on rotation. 'Keep last N' retains recent games. 'Scheduled' hides all completed games on a cron schedule (e.g. weekly)." />
              </label>
              <CleanupRuleEditor value={editCleanupRule} onChange={setEditCleanupRule} />
            </div>
            <div className="flex gap-3 justify-end">
              <NeonButton variant="ghost" onClick={() => setEditTarget(null)} disabled={editSaving}>Cancel</NeonButton>
              <NeonButton onClick={handleEditSave} disabled={editSaving || !editName.trim() || !editTag.trim()}>
                {editSaving ? 'Saving...' : 'Save Changes'}
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {deleteTarget && (
        <ConfirmModal
          title="Delete Tournament"
          message={`Are you sure you want to delete "${deleteTarget.name}"? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={handleDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </div>
  );
}
