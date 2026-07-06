import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import DataTable from '../components/DataTable';
import LoadingState from '../components/LoadingState';
import { useToast } from '../components/Toast';

interface BackupInfo {
  name: string;
  size: number;
  createdAt: string;
}

interface BackupConfig {
  enabled: boolean;
  cron: string;
  retentionCount: number | null;
  retentionDays: number | null;
}

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

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
  const [restoreConfirmText, setRestoreConfirmText] = useState('');
  const [creating, setCreating] = useState(false);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const { toast } = useToast();

  // Schedule / retention config (mirrors GlobalSettings' form pattern).
  const [config, setConfig] = useState<Record<string, string>>({});
  const [configLoading, setConfigLoading] = useState(true);
  const [savingConfig, setSavingConfig] = useState(false);

  const loadBackups = () => {
    setLoading(true);
    api.get<BackupInfo[]>('/admin/backups')
      .then(setBackups)
      .catch(err => {
        toast(err.message || 'Failed to load backups', 'error');
        setBackups([]);
      })
      .finally(() => setLoading(false));
  };

  const loadConfig = () => {
    setConfigLoading(true);
    api.get<BackupConfig>('/admin/backups/config')
      .then(cfg => {
        setConfig({
          enabled: cfg.enabled ? 'true' : 'false',
          cron: cfg.cron ?? '',
          retentionCount: cfg.retentionCount != null ? String(cfg.retentionCount) : '',
          retentionDays: cfg.retentionDays != null ? String(cfg.retentionDays) : '',
        });
      })
      .catch(err => {
        toast(err.message || 'Failed to load backup schedule', 'error');
      })
      .finally(() => setConfigLoading(false));
  };

  useEffect(() => {
    loadBackups();
    loadConfig();
  }, []);

  const handleChange = (key: string, value: string) => {
    setConfig(prev => ({ ...prev, [key]: value }));
  };

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      const body: {
        enabled?: boolean;
        cron?: string;
        retentionCount?: number | null;
        retentionDays?: number | null;
      } = {
        enabled: config.enabled === 'true',
        cron: (config.cron ?? '').trim(),
        retentionCount: config.retentionCount?.trim() ? Number(config.retentionCount) : null,
        retentionDays: config.retentionDays?.trim() ? Number(config.retentionDays) : null,
      };
      await api.put('/admin/backups/config', body);
      toast('Backup schedule saved', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to save backup schedule', 'error');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await api.post<{ success: boolean }>('/admin/backups', {});
      toast('Backup created', 'success');
      loadBackups();
    } catch (err: any) {
      toast(err.message || 'Backup failed', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleVerify = async (name: string) => {
    setVerifying(name);
    try {
      const res = await api.get<{ ok: boolean; result: string }>(
        `/admin/backups/${encodeURIComponent(name)}/verify`,
      );
      toast(
        res.ok ? `Integrity OK: ${res.result}` : `Integrity failed: ${res.result}`,
        res.ok ? 'success' : 'error',
      );
    } catch (err: any) {
      toast(err.message || 'Verify failed', 'error');
    } finally {
      setVerifying(null);
    }
  };

  const handleDownload = async (name: string) => {
    try {
      await api.download(`/admin/backups/${encodeURIComponent(name)}/download`, name);
    } catch (err: any) {
      toast(err.message || 'Download failed', 'error');
    }
  };

  const openRestore = (name: string) => {
    setRestoreConfirmText('');
    setConfirmRestore(name);
  };

  const handleRestore = async (name: string) => {
    setConfirmRestore(null);
    setRestoreConfirmText('');
    setRestoring(name);
    try {
      await api.post<{ success: boolean; message: string }>(`/admin/backups/${encodeURIComponent(name)}/restore`, {});
      toast('Backup restored. The server will restart shortly.', 'success');
    } catch (err: any) {
      toast(err.message || 'Restore failed', 'error');
    } finally {
      setRestoring(null);
    }
  };

  const handleDelete = async (name: string) => {
    setConfirmDelete(null);
    setDeleting(name);
    try {
      await api.delete(`/admin/backups/${encodeURIComponent(name)}`);
      toast(`Backup "${name}" deleted`, 'success');
      loadBackups();
    } catch (err: any) {
      toast(err.message || 'Delete failed', 'error');
    } finally {
      setDeleting(null);
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
        <div className="flex justify-end gap-2">
          <NeonButton
            variant="ghost"
            onClick={() => handleVerify(item.name)}
            disabled={verifying !== null}
          >
            {verifying === item.name ? 'Verifying...' : 'Verify'}
          </NeonButton>
          <NeonButton
            variant="ghost"
            onClick={() => handleDownload(item.name)}
          >
            Download
          </NeonButton>
          <NeonButton
            variant="danger"
            onClick={() => openRestore(item.name)}
            disabled={restoring !== null}
          >
            {restoring === item.name ? 'Restoring...' : 'Restore'}
          </NeonButton>
          <NeonButton
            variant="ghost"
            onClick={() => setConfirmDelete(item.name)}
            disabled={deleting !== null}
          >
            {deleting === item.name ? 'Deleting...' : 'Delete'}
          </NeonButton>
        </div>
      ),
    },
  ];

  return (
    <div>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-6">
        <h1 className="font-display text-2xl font-bold">Backups</h1>
        <div className="flex flex-wrap gap-2">
          <NeonButton onClick={handleCreate} disabled={creating || loading}>
            {creating ? 'Creating...' : 'Create Backup Now'}
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

      <NeonCard title="Schedule & Retention" className="mb-6">
        {configLoading ? (
          <LoadingState message="Loading schedule..." />
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-3">
              <label className="w-64 shrink-0 text-sm font-mono text-muted" title="Enable scheduled automatic backups.">
                Automatic Backups
              </label>
              <select
                value={config.enabled ?? 'false'}
                onChange={e => handleChange('enabled', e.target.value)}
                className={`${inputClass} flex-1`}
              >
                <option value="true">Enabled</option>
                <option value="false">Disabled</option>
              </select>
            </div>

            <div>
              <div className="flex items-center gap-3">
                <label className="w-64 shrink-0 text-sm font-mono text-muted" title="Cron expression controlling when scheduled backups run.">
                  Schedule (cron)
                </label>
                <input
                  type="text"
                  value={config.cron ?? ''}
                  onChange={e => handleChange('cron', e.target.value)}
                  placeholder="0 3 * * *"
                  className={`${inputClass} flex-1`}
                />
              </div>
              <p className="text-xs text-faint mt-1 ml-[16.5rem] pl-3">
                Standard 5-field cron expression (e.g. <span className="font-mono">0 3 * * *</span> for daily at 03:00). Invalid expressions are rejected.
              </p>
            </div>

            <div>
              <div className="flex items-center gap-3">
                <label className="w-64 shrink-0 text-sm font-mono text-muted" title="Maximum number of backups to keep; older backups beyond this count are pruned.">
                  Retention Count
                </label>
                <input
                  type="number"
                  min={0}
                  value={config.retentionCount ?? ''}
                  onChange={e => handleChange('retentionCount', e.target.value)}
                  placeholder="(no count limit)"
                  className={`${inputClass} flex-1`}
                />
              </div>
              <p className="text-xs text-faint mt-1 ml-[16.5rem] pl-3">
                Keep at most this many backups. Leave blank for no count-based pruning.
              </p>
            </div>

            <div>
              <div className="flex items-center gap-3">
                <label className="w-64 shrink-0 text-sm font-mono text-muted" title="Maximum age in days before a backup is pruned.">
                  Retention Days
                </label>
                <input
                  type="number"
                  min={0}
                  value={config.retentionDays ?? ''}
                  onChange={e => handleChange('retentionDays', e.target.value)}
                  placeholder="(no age limit)"
                  className={`${inputClass} flex-1`}
                />
              </div>
              <p className="text-xs text-faint mt-1 ml-[16.5rem] pl-3">
                Delete backups older than this many days. Leave blank for no age-based pruning.
              </p>
            </div>

            <div className="flex justify-end">
              <NeonButton onClick={handleSaveConfig} disabled={savingConfig}>
                {savingConfig ? 'Saving...' : 'Save Schedule'}
              </NeonButton>
            </div>
          </div>
        )}
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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm"
          onClick={() => { setConfirmRestore(null); setRestoreConfirmText(''); }}
        >
          <div
            className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-primary mb-2">Restore Backup</h3>
            <p className="text-muted mb-4">
              This will overwrite the live database with{' '}
              <span className="font-mono text-primary">{confirmRestore}</span> and restart the server.
              This cannot be undone. Type the backup name to confirm.
            </p>
            <input
              type="text"
              value={restoreConfirmText}
              onChange={e => setRestoreConfirmText(e.target.value)}
              placeholder={confirmRestore}
              autoFocus
              className={`${inputClass} mb-6`}
            />
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => { setConfirmRestore(null); setRestoreConfirmText(''); }}>
                Cancel
              </NeonButton>
              <NeonButton
                variant="danger"
                onClick={() => handleRestore(confirmRestore)}
                disabled={restoreConfirmText !== confirmRestore}
              >
                Restore
              </NeonButton>
            </div>
          </div>
        </div>
      )}

      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm"
          onClick={() => setConfirmDelete(null)}
        >
          <div
            className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-primary mb-2">Delete Backup</h3>
            <p className="text-muted mb-4">
              Permanently delete <span className="font-mono text-primary">{confirmDelete}</span>?
              This removes the backup and cannot be undone.
              {backups.length === 1 && (
                <span className="block mt-2 text-neon-amber">This is your only backup — you'll have none left.</span>
              )}
            </p>
            <div className="flex justify-end gap-3">
              <NeonButton variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </NeonButton>
              <NeonButton variant="danger" onClick={() => handleDelete(confirmDelete)}>
                Delete
              </NeonButton>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
