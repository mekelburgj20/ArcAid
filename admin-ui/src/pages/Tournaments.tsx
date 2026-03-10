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
  cadence: string;
  guild_id?: string;
  discord_channel_id?: string;
  discord_role_id?: string;
  is_active: number;
}

function parseCadence(cadenceJson: string): { cron: string; timezone: string } {
  try {
    const c = JSON.parse(cadenceJson);
    return { cron: c.cron || '0 0 * * *', timezone: c.timezone || 'America/Chicago' };
  } catch {
    return { cron: '0 0 * * *', timezone: 'America/Chicago' };
  }
}

function formatCadenceDisplay(cadenceJson: string): string {
  try {
    const c = JSON.parse(cadenceJson);
    const cron = c.cron || '';
    const parts = cron.split(' ');
    if (parts.length !== 5) return cron;

    const min = parts[0];
    const hr = parts[1];
    const dom = parts[2];
    const dow = parts[4];
    const time = `${hr.padStart(2, '0')}:${min.padStart(2, '0')}`;
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const tz = c.timezone ? ` ${c.timezone.split('/').pop()?.replace(/_/g, ' ')}` : '';

    if (dom !== '*') return `${ordinal(parseInt(dom))} of month at ${time}${tz}`;
    if (dow !== '*') return `${days[parseInt(dow)] || dow} at ${time}${tz}`;
    return `Daily at ${time}${tz}`;
  } catch {
    return 'Not set';
  }
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export default function Tournaments() {
  const { toast } = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Tournament | null>(null);
  const [editTarget, setEditTarget] = useState<Tournament | null>(null);

  // Create form state
  const [newName, setNewName] = useState('');
  const [newTag, setNewTag] = useState('');
  const [newChannel, setNewChannel] = useState('');
  const [schedule, setSchedule] = useState({ cron: '0 0 * * *', timezone: 'America/Chicago' });

  // Edit form state
  const [editName, setEditName] = useState('');
  const [editTag, setEditTag] = useState('');
  const [editChannel, setEditChannel] = useState('');
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

  useEffect(() => { fetchTournaments(); }, []);

  const handleCreate = async () => {
    if (!newName.trim() || !newTag.trim()) return;
    try {
      await api.post('/tournaments', {
        id: uuidv4(),
        name: newName,
        type: newTag.trim().toUpperCase(),
        cadence: { cron: schedule.cron, autoRotate: true, autoLock: true, timezone: schedule.timezone },
        guild_id: '',
        discord_channel_id: newChannel,
        discord_role_id: '',
        is_active: true,
      });
      setNewName('');
      setNewTag('');
      setNewChannel('');
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
    setEditChannel(t.discord_channel_id || '');
    setEditSchedule(parseCadence(t.cadence));
  };

  const handleEditSave = async () => {
    if (!editTarget || !editName.trim() || !editTag.trim()) return;
    setEditSaving(true);
    try {
      await api.put(`/tournaments/${editTarget.id}`, {
        name: editName,
        type: editTag.trim().toUpperCase(),
        cadence: { cron: editSchedule.cron, autoRotate: true, autoLock: true, timezone: editSchedule.timezone },
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

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Tournaments</h1>

      {/* Create Form */}
      <NeonCard glowColor="cyan" className="mb-6" title="Create New Tournament">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Name</label>
            <input type="text" placeholder="e.g. The Daily Grind" value={newName} onChange={e => setNewName(e.target.value)} className={inputClass} />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Tag <span className="text-faint">(iScored tag)</span></label>
            <input type="text" placeholder="e.g. DG, WG-VPXS" value={newTag} onChange={e => setNewTag(e.target.value)} className={`${inputClass} font-mono`} />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Channel ID <span className="text-faint">(optional)</span></label>
            <input type="text" placeholder="Discord channel ID" value={newChannel} onChange={e => setNewChannel(e.target.value)} className={inputClass} />
          </div>
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
            { key: 'cadence', header: 'Schedule', render: t => (
              <span className="text-sm text-neon-amber">{formatCadenceDisplay(t.cadence)}</span>
            )},
            { key: 'discord_channel_id', header: 'Channel', render: t => <span className="text-sm text-muted">{t.discord_channel_id || 'Not set'}</span> },
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
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Name</label>
                <input type="text" value={editName} onChange={e => setEditName(e.target.value)} className={inputClass} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Tag</label>
                <input type="text" value={editTag} onChange={e => setEditTag(e.target.value)} className={`${inputClass} font-mono`} />
              </div>
              <div>
                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Channel ID</label>
                <input type="text" placeholder="Optional" value={editChannel} onChange={e => setEditChannel(e.target.value)} className={inputClass} />
              </div>
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
