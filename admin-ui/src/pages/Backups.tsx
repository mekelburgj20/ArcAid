import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import DataTable from '../components/DataTable';
import LoadingState from '../components/LoadingState';
import ConfirmModal from '../components/ConfirmModal';
import { useToast } from '../components/Toast';

interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

export default function Backups() {
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [confirmRestore, setConfirmRestore] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();

  const loadBackups = () => {
    setLoading(true);
    api.get<BackupInfo[]>('/backups')
      .then(setBackups)
      .catch(err => {
        toast(err.message || 'Failed to load backups', 'error');
        setBackups([]);
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => { loadBackups(); }, []);

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.post<{ success: boolean }>('/backups', {});
      toast('Backup created', 'success');
      loadBackups();
    } catch (err: any) {
      toast(err.message || 'Backup failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = async (name: string) => {
    setConfirmRestore(null);
    setRestoring(name);
    try {
      await api.post<{ success: boolean; message: string }>(`/backups/${encodeURIComponent(name)}/restore`, {});
      toast('Backup restored. The server will restart shortly.', 'success');
    } catch (err: any) {
      toast(err.message || 'Restore failed', 'error');
    } finally {
      setRestoring(null);
    }
  };

  const columns = [
    {
      key: 'name',
      header: 'Backup Name',
      render: (item: BackupInfo) => (
        <span className="font-medium font-mono text-sm">{item.name}</span>
      ),
    },
    {
      key: 'size',
      header: 'Size',
      render: (item: BackupInfo) => (
        <span className="text-muted text-sm">{formatBytes(item.size)}</span>
      ),
    },
    {
      key: 'createdAt',
      header: 'Created',
      render: (item: BackupInfo) => (
        <span className="text-muted text-sm">
          {new Date(item.createdAt).toLocaleString()}
        </span>
      ),
    },
    {
      key: 'actions',
      header: '',
      className: 'text-right',
      render: (item: BackupInfo) => (
        <NeonButton
          variant="danger"
          onClick={() => setConfirmRestore(item.name)}
          disabled={restoring !== null}
        >
          {restoring === item.name ? 'Restoring...' : 'Restore'}
        </NeonButton>
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="font-display text-2xl font-bold">Backups</h1>
        <div className="flex flex-wrap gap-2">
          <NeonButton onClick={handleCreate} disabled={creating || loading}>
            {creating ? 'Creating...' : 'Create Backup'}
          </NeonButton>
          <NeonButton variant="ghost" onClick={loadBackups} disabled={loading}>
            Refresh
          </NeonButton>
        </div>
      </div>

      <NeonCard glowColor="amber" className="mb-6">
        <div className="flex items-start gap-3">
          <span className="text-neon-amber text-lg">!</span>
          <div>
            <p className="text-sm font-medium text-neon-amber mb-1">Restore Warning</p>
            <p className="text-muted text-sm">
              Restoring a backup will replace the current database and restart the server.
              This action cannot be undone. Make sure you have a recent backup before restoring an older one.
            </p>
          </div>
        </div>
      </NeonCard>

      <NeonCard>
        {loading ? (
          <LoadingState message="Loading backups..." />
        ) : (
          <DataTable
            columns={columns}
            data={backups}
            emptyMessage="No backups found. Backups are created automatically during maintenance cycles."
            keyExtractor={(item) => item.name}
          />
        )}
      </NeonCard>

      {confirmRestore && (
        <ConfirmModal
          title="Restore Backup"
          message={`Are you sure you want to restore "${confirmRestore}"? This will replace the current database and restart the server.`}
          confirmLabel="Restore"
          onConfirm={() => handleRestore(confirmRestore)}
          onCancel={() => setConfirmRestore(null)}
        />
      )}
    </div>
  );
}
