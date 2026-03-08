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

export default function Tournaments() {
  const { toast } = useToast();
  const [tournaments, setTournaments] = useState<Tournament[]>([]);
  const [loading, setLoading] = useState(true);
  const [deleteTarget, setDeleteTarget] = useState<Tournament | null>(null);

  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState('daily');
  const [newCron, setNewCron] = useState('0 0 * * *');
  const [newChannel, setNewChannel] = useState('');

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
    if (!newName.trim()) return;
    try {
      await api.post('/tournaments', {
        id: uuidv4(),
        name: newName,
        type: newType,
        cadence: { cron: newCron, autoRotate: true, autoLock: true },
        guild_id: '',
        discord_channel_id: newChannel,
        discord_role_id: '',
        is_active: true,
      });
      setNewName('');
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

  if (loading) return <LoadingState message="Loading tournaments..." />;

  return (
    <div>
      <h1 className="font-display text-2xl font-bold mb-6">Tournaments</h1>

      {/* Create Form */}
      <NeonCard glowColor="cyan" className="mb-6" title="Create New Tournament">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 mb-4">
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Name</label>
            <input
              type="text" placeholder="e.g. The Daily Grind" value={newName} onChange={e => setNewName(e.target.value)}
              className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Type / Tag</label>
            <input
              type="text" placeholder="e.g. DG" value={newType} onChange={e => setNewType(e.target.value)}
              className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Cron Schedule</label>
            <input
              type="text" placeholder="0 0 * * *" value={newCron} onChange={e => setNewCron(e.target.value)}
              className="w-full px-3 py-2 bg-raised border border-border rounded text-primary font-mono placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
            />
          </div>
          <div>
            <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">Channel ID</label>
            <input
              type="text" placeholder="Optional" value={newChannel} onChange={e => setNewChannel(e.target.value)}
              className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
            />
          </div>
        </div>
        <NeonButton onClick={handleCreate} disabled={!newName.trim()}>Create Tournament</NeonButton>
      </NeonCard>

      {/* Tournament List */}
      <NeonCard title="Active Tournaments">
        <DataTable<Tournament>
          columns={[
            { key: 'name', header: 'Name', render: t => <span className="font-medium">{t.name}</span> },
            { key: 'type', header: 'Type', render: t => <TournamentBadge type={t.type} /> },
            { key: 'cadence', header: 'Schedule', render: t => {
              try { return <code className="text-sm text-neon-amber font-mono">{JSON.parse(t.cadence).cron || 'None'}</code>; }
              catch { return <span className="text-faint">None</span>; }
            }},
            { key: 'discord_channel_id', header: 'Channel', render: t => <span className="text-sm text-muted">{t.discord_channel_id || 'Not set'}</span> },
            { key: 'actions', header: '', render: t => (
              <NeonButton variant="danger" onClick={() => setDeleteTarget(t)} className="text-xs px-2 py-1">Delete</NeonButton>
            ), className: 'text-right' },
          ]}
          data={tournaments}
          keyExtractor={t => t.id}
          emptyMessage="No tournaments configured yet."
        />
      </NeonCard>

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
