import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';

const GLOBAL_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'JWT_SECRET',
  'PORT',
  'MAX_LOG_LINES',
  'BACKUP_RETENTION_DAYS',
];

const SENSITIVE_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET', 'JWT_SECRET'];

const SETTING_LABELS: Record<string, { label: string; description: string }> = {
  DISCORD_BOT_TOKEN: { label: 'Discord Bot Token', description: 'Bot token from the Discord Developer Portal.' },
  DISCORD_CLIENT_ID: { label: 'Discord Client ID', description: 'OAuth2 client ID for Discord login.' },
  DISCORD_CLIENT_SECRET: { label: 'Discord Client Secret', description: 'OAuth2 client secret for Discord login.' },
  JWT_SECRET: { label: 'JWT Secret', description: 'Secret used to sign authentication tokens.' },
  PORT: { label: 'Port', description: 'HTTP server port (default: 3001).' },
  MAX_LOG_LINES: { label: 'Max Log Lines', description: 'Maximum number of log lines returned by the API.' },
  BACKUP_RETENTION_DAYS: { label: 'Backup Retention Days', description: 'How many days to keep automatic backups.' },
};

interface SuperAdmin {
  discord_user_id: string;
  username?: string;
}

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

export default function GlobalSettings() {
  const { toast } = useToast();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // Super admins
  const [superAdmins, setSuperAdmins] = useState<SuperAdmin[]>([]);
  const [newAdminId, setNewAdminId] = useState('');
  const [addingAdmin, setAddingAdmin] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get<Record<string, string>>('/admin/settings'),
      api.get<SuperAdmin[]>('/admin/super-admins').catch(() => [] as SuperAdmin[]),
    ]).then(([settingsData, admins]) => {
      setSettings(settingsData);
      setSuperAdmins(admins);
    }).catch(() => {
      toast('Failed to load settings', 'error');
    }).finally(() => setLoading(false));
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const toSave: Record<string, string> = {};
      for (const key of GLOBAL_KEYS) {
        if (settings[key] !== undefined) toSave[key] = settings[key];
      }
      await api.post('/admin/settings', toSave);
      toast('Settings saved', 'success');
    } catch {
      toast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const toggleReveal = (key: string) => {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const isSensitive = (key: string) => SENSITIVE_KEYS.includes(key);

  const handleAddSuperAdmin = async () => {
    if (!newAdminId.trim()) return;
    setAddingAdmin(true);
    try {
      await api.post('/admin/super-admins', { discord_user: newAdminId.trim() });
      setSuperAdmins(await api.get<SuperAdmin[]>('/admin/super-admins'));
      setNewAdminId('');
      toast('Super admin added', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to add super admin', 'error');
    } finally {
      setAddingAdmin(false);
    }
  };

  const handleRemoveSuperAdmin = async (discordUserId: string) => {
    try {
      await api.delete(`/admin/super-admins/${discordUserId}`);
      setSuperAdmins(prev => prev.filter(a => a.discord_user_id !== discordUserId));
      toast('Super admin removed', 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to remove super admin', 'error');
    }
  };

  if (loading) return <LoadingState message="Loading settings..." />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold">Global Settings</h1>
        <NeonButton onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save All Changes'}
        </NeonButton>
      </div>

      <NeonCard title="Configuration" className="mb-4">
        <div className="space-y-3">
          {GLOBAL_KEYS.map(key => {
            const meta = SETTING_LABELS[key];
            const value = settings[key] ?? '';
            return (
              <div key={key}>
                <div className="flex items-center gap-3">
                  <label className="w-64 shrink-0 text-sm font-mono text-muted" title={meta?.description}>
                    {meta?.label || key}
                  </label>
                  <input
                    type={isSensitive(key) && !revealed.has(key) ? 'password' : 'text'}
                    value={value}
                    onChange={e => handleChange(key, e.target.value)}
                    className={`${inputClass} flex-1`}
                  />
                  {isSensitive(key) && (
                    <button
                      onClick={() => toggleReveal(key)}
                      className="text-xs text-faint hover:text-muted cursor-pointer bg-transparent border-none"
                    >
                      {revealed.has(key) ? 'Hide' : 'Show'}
                    </button>
                  )}
                </div>
                {meta?.description && <p className="text-xs text-faint mt-1 ml-[16.5rem] pl-3">{meta.description}</p>}
              </div>
            );
          })}
        </div>
      </NeonCard>

      <NeonCard title="Super Admins" className="mb-4">
        <p className="text-muted text-sm mb-4">
          Super admins can manage all game rooms, global settings, and other super admins.
          Add users by their Discord username or user ID.
        </p>

        {superAdmins.length > 0 ? (
          <div className="space-y-2 mb-4">
            {superAdmins.map(admin => (
              <div key={admin.discord_user_id} className="flex items-center justify-between bg-raised border border-border rounded px-3 py-2">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-primary">{admin.discord_user_id}</span>
                  {admin.username && <span className="text-xs text-muted">({admin.username})</span>}
                </div>
                <button
                  onClick={() => handleRemoveSuperAdmin(admin.discord_user_id)}
                  className="text-xs text-faint hover:text-neon-magenta cursor-pointer bg-transparent border-none"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-faint text-sm mb-4">No super admins configured.</p>
        )}

        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Discord username or ID"
            value={newAdminId}
            onChange={e => setNewAdminId(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAddSuperAdmin()}
            className={`${inputClass} w-64`}
          />
          <NeonButton variant="secondary" onClick={handleAddSuperAdmin} disabled={addingAdmin || !newAdminId.trim()}>
            {addingAdmin ? 'Adding...' : 'Add'}
          </NeonButton>
        </div>
      </NeonCard>
    </div>
  );
}
