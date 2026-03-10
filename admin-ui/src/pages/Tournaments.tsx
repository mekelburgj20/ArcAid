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

export default function Tournaments() {
  const { toast } = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Tournament | null>(null);
  const [editTarget, setEditTarget] = useState<Tournament | null>(null);
  const [platforms, setPlatforms] = useState<string[]>([]);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [newMode, setNewMode] = useState('pinball');
  const [newChannel, setNewChannel] = useState('');
  const [newPlatformRules, setNewPlatformRules] = useState<PlatformRules>({ ...defaultPlatformRules });
  const [schedule, setSchedule] = useState({ cron: '0 0 * * *', timezone: 'America/Chicago' });

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editTag, setEditTag] = useState('');
  const [editMode, setEditMode] = useState('pinball');
  const [editChannel, setEditChannel] = useState('');
  const [editPlatformRules, setEditPlatformRules] = useState<PlatformRules>({ ...defaultPlatformRules });
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

  useEffect(() => { fetchTournaments(); fetchPlatforms(); }, []);

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
      });
      setNewName(''); setNewTag(''); setNewChannel(''); setNewMode('pinball');
      setNewPlatformRules({ ...defaultPlatformRules });
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
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Name</label>
            <input type="text" placeholder="e.g. The Daily Grind" value={newName} onChange={e => setNewName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Tag <span className="text-faint">(iScored)</span></label>
            <input type="text" placeholder="e.g. DG, WG-VPXS" value={newTag} onChange={e => setNewTag(e.target.value)} className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Mode</label>
            <select value={newMode} onChange={e => setNewMode(e.target.value)} className={selectClass}>
              <option value="pinball">Pinball</option>
              <option value="videogame">Video Game</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Channel ID <span className="text-faint">(optional)</span></label>
            <input type="text" placeholder="Discord channel ID" value={newChannel} onChange={e => setNewChannel(e.target.value)} className={inputClass} />
          </div>
        </div>
        <div className="mb-4">
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">Platform Rules</label>
          <PlatformRulesEditor platforms={platforms} rules={newPlatformRules} onChange={setNewPlatformRules} />
        </div>
        <div className="mb-4">
          <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">Schedule</label>
          <ScheduleBuilder value={schedule} onChange={setSchedule} />
        </div>
        <NeonButton onClick={handleCreate} disabled={!newName.trim() || !newTag.trim()}>Create Tournament</NeonButton>
      </NeonCard>

      {/* Tournament List */}
      <NeonCard title="Active Tournaments">
        <DataTable<Tournament>
          columns={[
            { key: 'name', header: 'Name', render: t => <span className="font-medium">{t.name}</span> },
            { key: 'type', header: 'Tag', render: t => <TournamentBadge type={t.type} /> },
            { key: 'mode', header: 'Mode', render: t => (
              <span className={`text-xs px-2 py-0.5 rounded ${t.mode === 'pinball' ? 'bg-neon-amber/15 text-neon-amber' : 'bg-neon-cyan/15 text-neon-cyan'}`}>
                {t.mode === 'pinball' ? 'Pinball' : 'Video Game'}
              </span>
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

      {/* Edit Modal */}
      {editTarget && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
          <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h2 className="font-display text-lg font-bold mb-4">Edit Tournament</h2>
            <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-4">
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Name</label>
                <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Tag</label>
                <input type="text" value={editTag} onChange={e => setEditTag(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Mode</label>
                <select value={editMode} onChange={e => setEditMode(e.target.value)} className={selectClass}>
                  <option value="pinball">Pinball</option>
                  <option value="videogame">Video Game</option>
                </select>
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Channel ID</label>
                <input type="text" placeholder="Optional" value={editChannel} onChange={e => setEditChannel(e.target.value)} className={inputClass} />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">Platform Rules</label>
              <PlatformRulesEditor platforms={platforms} rules={editPlatformRules} onChange={setEditPlatformRules} />
            </div>
            <div className="mb-6">
              <label className="block text-xs font-display uppercase tracking-wider text-muted mb-2">Schedule</label>
              <ScheduleBuilder value={editSchedule} onChange={setEditSchedule} />
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
