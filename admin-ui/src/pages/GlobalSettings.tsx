import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import { THEMES, useTheme, type ThemeId } from '../components/ThemeProvider';

const GLOBAL_KEYS = [
  'DISCORD_BOT_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_CLIENT_SECRET',
  'JWT_SECRET',
  'PORT',
  'MAX_LOG_LINES',
  'BACKUP_RETENTION_DAYS',
  'ISCORED_API_ENABLED',
  'ISCORED_API_POLL_INTERVAL',
  'OPDB_API_KEY',
  'TWITCH_CLIENT_ID',
  'TWITCH_CLIENT_SECRET',
  'GLOBAL_PAGE_THEME',
  'NOTIFY_HIGH_VALUE_DEFAULT_ON',
  'WEB_PUSH_VAPID_PUBLIC_KEY',
  'WEB_PUSH_VAPID_PRIVATE_KEY',
  'OG_META_ENABLED',
];

const SENSITIVE_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET', 'JWT_SECRET', 'OPDB_API_KEY', 'TWITCH_CLIENT_SECRET', 'WEB_PUSH_VAPID_PRIVATE_KEY'];

const SETTING_LABELS: Record<string, { label: string; description: string }> = {
  DISCORD_BOT_TOKEN: { label: 'Discord Bot Token', description: 'Bot token from the Discord Developer Portal.' },
  DISCORD_CLIENT_ID: { label: 'Discord Client ID', description: 'OAuth2 client ID for Discord login.' },
  DISCORD_CLIENT_SECRET: { label: 'Discord Client Secret', description: 'OAuth2 client secret for Discord login.' },
  JWT_SECRET: { label: 'JWT Secret', description: 'Secret used to sign authentication tokens.' },
  PORT: { label: 'Port', description: 'HTTP server port (default: 3001).' },
  MAX_LOG_LINES: { label: 'Max Log Lines', description: 'Maximum number of log lines returned by the API.' },
  BACKUP_RETENTION_DAYS: { label: 'Backup Retention Days', description: 'How many days to keep automatic backups.' },
  ISCORED_API_ENABLED: { label: 'iScored API Enabled', description: 'Use iScored REST API for score sync instead of Playwright. Set to "false" to revert to Playwright.' },
  ISCORED_API_POLL_INTERVAL: { label: 'iScored Poll Interval (seconds)', description: 'How often to poll iScored for new scores. Default: 30. Hot-reloads on save.' },
  OPDB_API_KEY: { label: 'OPDB API Key', description: 'API token for OPDB pinball catalogue sync. Register at https://opdb.org. Encrypted at rest.' },
  TWITCH_CLIENT_ID: { label: 'Twitch Client ID', description: 'Twitch app client ID for IGDB arcade/console catalogue sync. Create an app at https://dev.twitch.tv/console.' },
  TWITCH_CLIENT_SECRET: { label: 'Twitch Client Secret', description: 'Twitch app client secret for IGDB catalogue sync. Encrypted at rest.' },
  NOTIFY_HIGH_VALUE_DEFAULT_ON: { label: 'High-Value Notifications Default-On', description: 'When enabled, Discord-linked users receive dethrone + tournament-win DMs by default. An explicit per-user preference (on or off) always overrides this. Disabled or absent = opt-in only.' },
  WEB_PUSH_VAPID_PUBLIC_KEY: { label: 'Web Push VAPID Public Key', description: 'Public half of the VAPID keypair for browser push notifications. Generate a pair with "npm run generate-vapid-keys". Both keys must be set for push to activate; rotating the pair invalidates every existing browser subscription.' },
  WEB_PUSH_VAPID_PRIVATE_KEY: { label: 'Web Push VAPID Private Key', description: 'Private half of the VAPID keypair for browser push notifications. Encrypted at rest.' },
  OG_META_ENABLED: { label: 'Link-Preview Meta (OG Tags)', description: 'Inject Open Graph tags into game/player pages for link-preview crawlers (Discord, Slack, Twitter). Kill-switch: set to Disabled if link previews misbehave. Humans always get the normal app either way.' },
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
  const { adminTheme, setAdminTheme } = useTheme();

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
                  {key === 'NOTIFY_HIGH_VALUE_DEFAULT_ON' ? (
                    <select
                      value={value === 'true' ? 'true' : 'false'}
                      onChange={e => handleChange(key, e.target.value)}
                      className={`${inputClass} flex-1`}
                    >
                      <option value="false">Disabled (opt-in only)</option>
                      <option value="true">Enabled (default-on for Discord users)</option>
                    </select>
                  ) : key === 'OG_META_ENABLED' ? (
                    /* S16 — default-ON kill-switch: absent/anything-but-"false" = enabled. */
                    <select
                      value={value === 'false' ? 'false' : 'true'}
                      onChange={e => handleChange(key, e.target.value)}
                      className={`${inputClass} flex-1`}
                    >
                      <option value="true">Enabled (default)</option>
                      <option value="false">Disabled (kill-switch)</option>
                    </select>
                  ) : (
                    <>
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
                    </>
                  )}
                </div>
                {meta?.description && <p className="text-xs text-faint mt-1 ml-[16.5rem] pl-3">{meta.description}</p>}
              </div>
            );
          })}
        </div>
      </NeonCard>

      <NeonCard title="Theme" className="mb-4">
        <div className="space-y-4">
          <div>
            <label className="text-xs text-faint block mb-1">Global Pages Theme</label>
            <select
              value={settings.GLOBAL_PAGE_THEME || 'dark'}
              onChange={e => handleChange('GLOBAL_PAGE_THEME', e.target.value)}
              className={inputClass}
            >
              {Object.entries(THEMES).map(([id, { label, description }]) => (
                <option key={id} value={id}>{label} — {description}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Theme for the Global Leaderboard, Catalogue, Game Detail pages, and the landing page. Applies to all visitors.</p>
          </div>
          <div>
            <label className="text-xs text-faint block mb-1">Admin Theme</label>
            <select
              value={adminTheme}
              onChange={e => {
                const newTheme = e.target.value as ThemeId;
                setAdminTheme(newTheme);
                api.post('/me/preferences', { ui_theme: newTheme }).catch(() => {
                  toast('Failed to save theme preference', 'error');
                });
              }}
              className={inputClass}
            >
              {Object.entries(THEMES).map(([id, { label, description }]) => (
                <option key={id} value={id}>{label} — {description}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Your admin theme. Only affects your session — other admins see their own preference.</p>
          </div>
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
            placeholder="e.g. @DiscordUser or 123456789012345678"
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
