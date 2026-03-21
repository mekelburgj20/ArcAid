import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useRoom } from '../contexts/RoomContext';
import { useToast } from '../components/Toast';
import { useTheme, THEMES, type ThemeId } from '../components/ThemeProvider';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import ConfirmModal from '../components/ConfirmModal';
import LoadingState from '../components/LoadingState';
import { InfoTip } from '../components/Tooltip';

interface LocalAdmin {
  id: string;
  username: string;
  display_name: string;
  created_at: string;
}

interface DiscordAdmin {
  discord_user_id: string;
  role: string;
}

interface PendingInvite {
  id: string;
  token: string;
  display_name: string;
  discord_user_id: string | null;
  created_by: string | null;
  expires_at: string;
  created_at: string;
}

const SENSITIVE_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET', 'ISCORED_PASSWORD', 'ADMIN_PASSWORD_HASH'];

const CATEGORIES: Record<string, string[]> = {
  'Game Room': ['GAME_ROOM_NAME', 'GAME_ROOM_SLUG'],
  'Discord': ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'DISCORD_ADMIN_ROLE_ID', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'],
  'iScored': ['ISCORED_USERNAME', 'ISCORED_PASSWORD', 'ISCORED_PUBLIC_URL'],
  'Tournament Defaults': ['GAME_ELIGIBILITY_DAYS', 'WINNER_PICK_WINDOW_MIN', 'RUNNERUP_PICK_WINDOW_MIN', 'BOT_TIMEZONE'],
  'System': ['PORT', 'LOG_LEVEL', 'MAX_LOG_LINES', 'BACKUP_RETENTION_DAYS', 'SETUP_COMPLETE'],
  'Scoreboard Branding': ['SCOREBOARD_BG_MODE', 'LOGO_POSITION', 'LOGO_MAX_HEIGHT'],
};

const TOGGLE_SETTINGS: Record<string, { label: string; description: string; defaultOn?: boolean }> = {
  'ISCORED_ENABLED': {
    label: 'iScored Integration',
    description: 'When enabled, games are created and managed on iScored. Disable to use ArcAid leaderboards only.',
    defaultOn: true,
  },
  'DISCORD_MENTIONS_ENABLED': {
    label: 'Discord @Mentions',
    description: 'When enabled, the bot @mentions users in announcements (winner picks, reminders, etc.). Disable to use display names instead.',
    defaultOn: true,
  },
  'ENABLE_CALLOUTS': {
    label: 'Callouts (Easter Egg)',
    description: 'When enabled, the bot responds to trigger words defined in data/callouts.json.',
  },
};

const SETTING_LABELS: Record<string, { label: string; description: string }> = {
  // Game Room
  GAME_ROOM_NAME: { label: 'Game Room Name', description: 'Display name shown on the public landing page and all public pages.' },
  GAME_ROOM_SLUG: { label: 'Game Room Slug', description: 'URL identifier for your room (e.g. "my_room" → /my_room/). Lowercase, no spaces.' },
  // Discord
  DISCORD_BOT_TOKEN: { label: 'Bot Token', description: 'Bot authentication token from the Discord Developer Portal. Keep this secret.' },
  DISCORD_CLIENT_ID: { label: 'Client ID', description: 'OAuth2 application client ID from the Discord Developer Portal.' },
  DISCORD_CLIENT_SECRET: { label: 'Client Secret', description: 'OAuth2 client secret used for admin Discord login. Keep this secret.' },
  DISCORD_GUILD_ID: { label: 'Guild ID', description: 'Your Discord server ID. Right-click server name → Copy Server ID (requires Developer Mode).' },
  DISCORD_ADMIN_ROLE_ID: { label: 'Admin Role ID', description: 'Discord role that grants access to admin bot commands. Right-click role → Copy Role ID.' },
  DISCORD_ANNOUNCEMENT_CHANNEL_ID: { label: 'Default Announcement Channel ID', description: 'Default channel for tournament announcements. Used when a tournament doesn\'t have its own channel configured. Right-click channel → Copy Channel ID.' },
  // iScored
  ISCORED_USERNAME: { label: 'iScored Username', description: 'Login email or username for your room\'s iScored.info account.' },
  ISCORED_PASSWORD: { label: 'iScored Password', description: 'Password for the iScored account. Used for automated game creation and score scraping.' },
  ISCORED_PUBLIC_URL: { label: 'iScored Public URL', description: 'Public leaderboard URL for score scraping (e.g. https://iscored.info/your_account).' },
  // Tournament Defaults
  WINNER_PICK_WINDOW_MIN: { label: 'Winner Pick Window (minutes)', description: 'How long the winner has to pick the next game before it falls to the runner-up.' },
  RUNNERUP_PICK_WINDOW_MIN: { label: 'Runner-up Pick Window (minutes)', description: 'How long the runner-up has to pick if the winner doesn\'t. After this, auto-select kicks in.' },
  GAME_ELIGIBILITY_DAYS: { label: 'Game Eligibility Cooldown (days)', description: 'How many days before a previously played game can be picked again. Prevents repeat picks.' },
  BOT_TIMEZONE: { label: 'Bot Timezone', description: 'Default timezone for all schedules (e.g. America/Chicago). Can be overridden per tournament.' },
  // System
  PORT: { label: 'Port', description: 'HTTP server port (default: 3001).' },
  LOG_LEVEL: { label: 'Log Level', description: 'Logging verbosity: debug, info, warn, or error.' },
  MAX_LOG_LINES: { label: 'Max Log Lines', description: 'Maximum number of log lines returned by the API.' },
  BACKUP_RETENTION_DAYS: { label: 'Backup Retention (days)', description: 'How many days to keep automatic database backups before cleanup.' },
  SETUP_COMPLETE: { label: 'Setup Complete', description: 'Marks whether initial setup has been finished. Set automatically.' },
  // Scoreboard Branding
  SCOREBOARD_BG_MODE: { label: 'Background Mode', description: 'How the background image is displayed: cover (fill screen), contain (fit), repeat (tile), or center.' },
  LOGO_POSITION: { label: 'Logo Position', description: 'Where the logo appears relative to the scoreboard title: left, right, above, or below.' },
  LOGO_MAX_HEIGHT: { label: 'Logo Max Height (px)', description: 'Maximum height of the logo in pixels. Default: 64.' },
};

const inputClass = "w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors";

function PlatformsEditor({ platforms, onChange }: { platforms: string[]; onChange: (p: string[]) => void }) {
  const [newPlatform, setNewPlatform] = useState('');

  const handleAdd = () => {
    const name = newPlatform.trim();
    if (!name || platforms.includes(name)) return;
    onChange([...platforms, name]);
    setNewPlatform('');
  };

  const handleRemove = (p: string) => {
    onChange(platforms.filter(x => x !== p));
  };

  const handleRename = (old: string, updated: string) => {
    onChange(platforms.map(x => x === old ? updated : x));
  };

  return (
    <div>
      <div className="flex flex-wrap gap-2 mb-3">
        {platforms.map(p => (
          <div key={p} className="flex items-center gap-1 bg-raised border border-border rounded px-2 py-1">
            <input
              type="text"
              value={p}
              onChange={e => handleRename(p, e.target.value)}
              className="bg-transparent text-sm text-primary border-none outline-none w-24"
            />
            <button
              onClick={() => handleRemove(p)}
              className="text-faint hover:text-neon-magenta text-xs cursor-pointer bg-transparent border-none"
              title="Remove platform"
            >
              &times;
            </button>
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="New platform name"
          value={newPlatform}
          onChange={e => setNewPlatform(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAdd()}
          className={`${inputClass} w-48`}
        />
        <NeonButton variant="secondary" onClick={handleAdd}>Add</NeonButton>
      </div>
    </div>
  );
}

export default function Settings() {
  const room = useRoom();
  const { toast } = useToast();
  const { globalTheme, setGlobalTheme, userTheme, setUserTheme } = useTheme();
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reloadingScheduler, setReloadingScheduler] = useState(false);
  const [merging, setMerging] = useState(false);
  const [mergeFrom, setMergeFrom] = useState('');
  const [mergeTo, setMergeTo] = useState('');
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  // Users state
  const [localAdmins, setLocalAdmins] = useState<LocalAdmin[]>([]);
  const [discordAdmins, setDiscordAdmins] = useState<DiscordAdmin[]>([]);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);
  const [showInviteForm, setShowInviteForm] = useState(false);
  const [showDiscordForm, setShowDiscordForm] = useState(false);
  const [inviteDisplayName, setInviteDisplayName] = useState('');
  const [inviteDiscordId, setInviteDiscordId] = useState('');
  const [inviting, setInviting] = useState(false);
  const [newDiscordUser, setNewDiscordUser] = useState('');
  const [addingDiscord, setAddingDiscord] = useState(false);
  const [deleteAdminTarget, setDeleteAdminTarget] = useState<LocalAdmin | null>(null);
  const [copiedToken, setCopiedToken] = useState<string | null>(null);

  // Branding upload state
  const [bgUrl, setBgUrl] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [uploadingBg, setUploadingBg] = useState(false);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const fetchAdmins = async () => {
    try {
      const data = await api.get<{ localAdmins: LocalAdmin[]; discordAdmins: DiscordAdmin[] }>(`/rooms/${room.roomId}/admins`);
      setLocalAdmins(data.localAdmins);
      setDiscordAdmins(data.discordAdmins);
    } catch {}
  };

  const fetchInvites = async () => {
    try {
      const data = await api.get<PendingInvite[]>(`/rooms/${room.roomId}/admins/invites`);
      setPendingInvites(data);
    } catch {}
  };

  const handleInvite = async () => {
    if (!inviteDisplayName.trim()) { toast('Display name required', 'error'); return; }
    setInviting(true);
    try {
      const result = await api.post<{ id: string; token: string; dmSent: boolean }>(`/rooms/${room.roomId}/admins/invites`, {
        display_name: inviteDisplayName.trim(),
        discord_user: inviteDiscordId.trim() || undefined,
      });
      const inviteUrl = `${window.location.origin}/invite/${result.token}`;
      if (result.dmSent) {
        toast('Invite sent via Discord DM', 'success');
      } else if (inviteDiscordId.trim()) {
        toast('Invite created but Discord DM could not be sent. Copy the link to share manually.', 'error');
      } else {
        toast('Invite created. Copy the link to share.', 'success');
      }
      // Auto-copy to clipboard
      try { await navigator.clipboard.writeText(inviteUrl); } catch {}
      setInviteDisplayName('');
      setInviteDiscordId('');
      setShowInviteForm(false);
      fetchInvites();
    } catch (err: any) {
      toast(err.message || 'Failed to create invite', 'error');
    } finally {
      setInviting(false);
    }
  };

  const handleDeleteAdmin = async () => {
    if (!deleteAdminTarget) return;
    try {
      await api.delete(`/rooms/${room.roomId}/admins/local/${deleteAdminTarget.id}`);
      toast(`Removed ${deleteAdminTarget.display_name || deleteAdminTarget.username}`, 'success');
      setDeleteAdminTarget(null);
      fetchAdmins();
    } catch {
      toast('Failed to remove admin', 'error');
    }
  };

  const handleCancelInvite = async (id: string) => {
    try {
      await api.delete(`/rooms/${room.roomId}/admins/invites/${id}`);
      toast('Invite cancelled', 'success');
      fetchInvites();
    } catch {
      toast('Failed to cancel invite', 'error');
    }
  };

  const handleAddDiscordAdmin = async () => {
    if (!newDiscordUser.trim()) return;
    setAddingDiscord(true);
    try {
      await api.post(`/rooms/${room.roomId}/admins/discord`, { discord_user: newDiscordUser.trim() });
      toast('Discord admin added. They can now log in via Discord OAuth.', 'success');
      setNewDiscordUser('');
      setShowDiscordForm(false);
      fetchAdmins();
    } catch (err: any) {
      toast(err.message || 'Failed to add Discord admin', 'error');
    } finally {
      setAddingDiscord(false);
    }
  };

  const handleRemoveDiscordAdmin = async (discordUserId: string) => {
    try {
      await api.delete(`/rooms/${room.roomId}/admins/discord/${discordUserId}`);
      toast('Discord admin removed', 'success');
      fetchAdmins();
    } catch {
      toast('Failed to remove Discord admin', 'error');
    }
  };

  const copyInviteLink = async (token: string) => {
    const url = `${window.location.origin}/invite/${token}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedToken(token);
      setTimeout(() => setCopiedToken(null), 2000);
    } catch {
      toast('Failed to copy link', 'error');
    }
  };

  useEffect(() => {
    api.get<Record<string, string>>(`/rooms/${room.roomId}/settings`)
      .then(data => {
        setSettings(data);
        // Sync global theme from settings
        if (data.UI_THEME && data.UI_THEME !== globalTheme) {
          setGlobalTheme(data.UI_THEME as ThemeId);
        }
        setBgUrl(data.SCOREBOARD_BG_URL || '');
        setLogoUrl(data.LOGO_URL || '');
        setLoading(false);
      })
      .catch(() => { toast('Failed to load settings', 'error'); setLoading(false); });
    fetchAdmins();
    fetchInvites();
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Filter out ADMIN_PASSWORD_HASH — server rejects it via this endpoint
      const { ADMIN_PASSWORD_HASH: _, ...toSave } = settings;
      await api.post(`/rooms/${room.roomId}/settings`, toSave);
      toast('Settings saved', 'success');
    } catch {
      toast('Failed to save settings', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleAdd = () => {
    if (!newKey.trim()) return;
    setSettings(prev => ({ ...prev, [newKey.trim().toUpperCase()]: newValue }));
    setNewKey('');
    setNewValue('');
  };

  const toggleReveal = (key: string) => {
    setRevealed(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  const isSensitive = (key: string) => SENSITIVE_KEYS.some(s => key.includes(s));

  // Group settings by category — always show all keys (default to empty string if not in DB)
  const categorized = Object.entries(CATEGORIES).map(([category, keys]) => ({
    category,
    entries: keys.map(k => [k, settings[k] ?? ''] as [string, string]),
  }));

  const uncategorizedKeys = Object.keys(settings).filter(k => !Object.values(CATEGORIES).flat().includes(k));

  if (loading) return <LoadingState message="Loading settings..." />;

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="font-display text-2xl font-bold">Settings</h1>
        <NeonButton onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save All Changes'}
        </NeonButton>
      </div>

      <NeonCard title="Theme" className="mb-4">
        <div className="space-y-4">
          {/* Global Theme */}
          <div>
            <label className="text-xs text-faint block mb-1">Global Theme (Public Portal Default)</label>
            <select
              value={settings.UI_THEME || globalTheme}
              onChange={e => {
                const newTheme = e.target.value as ThemeId;
                handleChange('UI_THEME', newTheme);
                setGlobalTheme(newTheme);
                // Preview immediately if no personal override
                if (!userTheme) {
                  // Theme applies automatically via context
                }
              }}
              className={inputClass}
            >
              {Object.entries(THEMES).map(([id, { label, description }]) => (
                <option key={id} value={id}>{label} — {description}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Applied to the public scoreboard and as the default for all admins.</p>
          </div>

          {/* Personal Theme Override */}
          <div>
            <label className="text-xs text-faint block mb-1">My Theme (Personal Override)</label>
            <select
              value={userTheme || ''}
              onChange={e => {
                const val = e.target.value as ThemeId | '';
                const newTheme = val || null;
                setUserTheme(newTheme);
                // Persist to server
                api.post('/me/preferences', { ui_theme: newTheme }).catch(() => {
                  toast('Failed to save theme preference', 'error');
                });
              }}
              className={inputClass}
            >
              <option value="">(Use Global Default)</option>
              {Object.entries(THEMES).map(([id, { label, description }]) => (
                <option key={id} value={id}>{label} — {description}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Overrides the global theme for your admin session only. Does not affect other admins or the public portal.</p>
          </div>
        </div>
      </NeonCard>

      <NeonCard title="Scoreboard Branding" className="mb-4">
        <div className="space-y-6">
          {/* Background Image */}
          <div>
            <p className="text-xs font-display uppercase tracking-wider text-muted mb-2">Background Image</p>
            {bgUrl && (
              <div className="mb-3">
                <img src={bgUrl} alt="Background preview" className="max-h-32 rounded border border-border object-cover" />
              </div>
            )}
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadingBg}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploadingBg(true);
                  try {
                    const formData = new FormData();
                    formData.append('file', file);
                    const result = await api.upload<{ success: boolean; url: string }>(`/rooms/${room.roomId}/admin/upload/background`, formData);
                    setBgUrl(result.url);
                    setSettings(prev => ({ ...prev, SCOREBOARD_BG_URL: result.url }));
                    toast('Background uploaded', 'success');
                  } catch (err: any) {
                    toast(err.message || 'Upload failed', 'error');
                  } finally {
                    setUploadingBg(false);
                    e.target.value = '';
                  }
                }}
                className="text-sm text-muted"
              />
              {bgUrl && (
                <NeonButton
                  variant="ghost"
                  className="text-xs text-neon-magenta"
                  disabled={uploadingBg}
                  onClick={async () => {
                    setUploadingBg(true);
                    try {
                      await api.delete(`/rooms/${room.roomId}/admin/upload/background`);
                      setBgUrl('');
                      setSettings(prev => {
                        const next = { ...prev };
                        delete next.SCOREBOARD_BG_URL;
                        return next;
                      });
                      toast('Background removed', 'success');
                    } catch {
                      toast('Failed to remove background', 'error');
                    } finally {
                      setUploadingBg(false);
                    }
                  }}
                >
                  Remove
                </NeonButton>
              )}
            </div>
            {uploadingBg && <p className="text-xs text-muted mt-1">Uploading...</p>}
            <p className="text-xs text-faint mt-2">PNG, JPEG, or WebP. Max 5 MB. Displayed behind the scoreboard.</p>

            <div className="mt-3">
              <label className="text-xs text-faint block mb-1">Background Mode</label>
              <select
                value={settings.SCOREBOARD_BG_MODE || 'cover'}
                onChange={e => handleChange('SCOREBOARD_BG_MODE', e.target.value)}
                className={inputClass}
              >
                <option value="cover">Cover (fill screen)</option>
                <option value="contain">Contain (fit)</option>
                <option value="repeat">Repeat (tile)</option>
                <option value="center">Center</option>
              </select>
            </div>
          </div>

          {/* Logo Image */}
          <div>
            <p className="text-xs font-display uppercase tracking-wider text-muted mb-2">Logo</p>
            {logoUrl && (
              <div className="mb-3">
                <img src={logoUrl} alt="Logo preview" className="max-h-16 rounded border border-border object-contain" />
              </div>
            )}
            <div className="flex items-center gap-3">
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={uploadingLogo}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  setUploadingLogo(true);
                  try {
                    const formData = new FormData();
                    formData.append('file', file);
                    const result = await api.upload<{ success: boolean; url: string }>(`/rooms/${room.roomId}/admin/upload/logo`, formData);
                    setLogoUrl(result.url);
                    setSettings(prev => ({ ...prev, LOGO_URL: result.url }));
                    toast('Logo uploaded', 'success');
                  } catch (err: any) {
                    toast(err.message || 'Upload failed', 'error');
                  } finally {
                    setUploadingLogo(false);
                    e.target.value = '';
                  }
                }}
                className="text-sm text-muted"
              />
              {logoUrl && (
                <NeonButton
                  variant="ghost"
                  className="text-xs text-neon-magenta"
                  disabled={uploadingLogo}
                  onClick={async () => {
                    setUploadingLogo(true);
                    try {
                      await api.delete(`/rooms/${room.roomId}/admin/upload/logo`);
                      setLogoUrl('');
                      setSettings(prev => {
                        const next = { ...prev };
                        delete next.LOGO_URL;
                        return next;
                      });
                      toast('Logo removed', 'success');
                    } catch {
                      toast('Failed to remove logo', 'error');
                    } finally {
                      setUploadingLogo(false);
                    }
                  }}
                >
                  Remove
                </NeonButton>
              )}
            </div>
            {uploadingLogo && <p className="text-xs text-muted mt-1">Uploading...</p>}
            <p className="text-xs text-faint mt-2">PNG, JPEG, or WebP. Max 5 MB. Shown alongside the scoreboard title.</p>

            <div className="grid grid-cols-2 gap-3 mt-3">
              <div>
                <label className="text-xs text-faint block mb-1">Logo Position</label>
                <select
                  value={settings.LOGO_POSITION || 'left'}
                  onChange={e => handleChange('LOGO_POSITION', e.target.value)}
                  className={inputClass}
                >
                  <option value="left">Left of title</option>
                  <option value="right">Right of title</option>
                  <option value="above">Above title</option>
                  <option value="below">Below title</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-faint block mb-1">Logo Max Height (px)</label>
                <input
                  type="number"
                  value={settings.LOGO_MAX_HEIGHT || '64'}
                  onChange={e => handleChange('LOGO_MAX_HEIGHT', e.target.value)}
                  className={inputClass}
                  min="16"
                  max="256"
                />
              </div>
            </div>
          </div>
        </div>
      </NeonCard>

      <NeonCard title="Users" className="mb-4">
        <p className="text-muted text-sm mb-4">
          Manage admin accounts for this game room.
        </p>

        {/* Discord Admins */}
        <p className="text-xs font-display uppercase tracking-wider text-muted mb-2">Discord Admins</p>
        <p className="text-xs text-faint mb-3">Log in via Discord OAuth — no password needed.</p>
        {discordAdmins.length > 0 ? (
          <div className="space-y-2 mb-3">
            {discordAdmins.map(admin => (
              <div key={admin.discord_user_id} className="flex items-center justify-between bg-raised border border-border rounded px-4 py-2">
                <div className="flex items-center gap-2">
                  <svg width="16" height="12" viewBox="0 0 71 55" fill="none" className="text-[#5865F2] flex-shrink-0">
                    <path d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.440769 45.4204 0.525289C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.525289C25.5141 0.443589 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309-0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978ZM23.7259 37.3253C20.2276 37.3253 17.3451 34.1136 17.3451 30.1693C17.3451 26.225 20.1717 23.0133 23.7259 23.0133C27.308 23.0133 30.1626 26.2532 30.1099 30.1693C30.1099 34.1136 27.2802 37.3253 23.7259 37.3253ZM47.3178 37.3253C43.8196 37.3253 40.9371 34.1136 40.9371 30.1693C40.9371 26.225 43.7636 23.0133 47.3178 23.0133C50.9 23.0133 53.7545 26.2532 53.7018 30.1693C53.7018 34.1136 50.9 37.3253 47.3178 37.3253Z" fill="currentColor"/>
                  </svg>
                  <span className="font-mono text-sm text-primary">{admin.discord_user_id}</span>
                </div>
                <NeonButton
                  variant="ghost"
                  className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                  onClick={() => handleRemoveDiscordAdmin(admin.discord_user_id)}
                >
                  Remove
                </NeonButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-faint text-sm mb-3">No Discord admins.</p>
        )}

        {showDiscordForm ? (
          <div className="border border-border rounded p-4 space-y-3 mb-6">
            <div>
              <label className="text-xs text-faint block mb-1">Discord Username *</label>
              <input
                type="text"
                placeholder="e.g. ChuckRibbits"
                value={newDiscordUser}
                onChange={e => setNewDiscordUser(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddDiscordAdmin()}
                className={inputClass}
                autoFocus
              />
              <p className="text-xs text-faint mt-1">Username or numeric ID. They'll be able to log in via Discord immediately.</p>
            </div>
            <div className="flex gap-2">
              <NeonButton onClick={handleAddDiscordAdmin} disabled={addingDiscord || !newDiscordUser.trim()}>
                {addingDiscord ? 'Adding...' : 'Add Discord Admin'}
              </NeonButton>
              <NeonButton variant="ghost" onClick={() => setShowDiscordForm(false)} disabled={addingDiscord}>
                Cancel
              </NeonButton>
            </div>
          </div>
        ) : (
          <div className="mb-6">
            <NeonButton onClick={() => setShowDiscordForm(true)}>Add Discord Admin</NeonButton>
          </div>
        )}

        {/* Local Admins (username/password) */}
        <p className="text-xs font-display uppercase tracking-wider text-muted mb-2">Local Admins</p>
        <p className="text-xs text-faint mb-3">Username/password accounts for users without Discord.</p>
        {localAdmins.length > 0 ? (
          <div className="space-y-2 mb-3">
            {localAdmins.map(admin => (
              <div key={admin.id} className="flex items-center justify-between bg-raised border border-border rounded px-4 py-2">
                <div>
                  <span className="text-sm font-medium text-primary">{admin.display_name || admin.username}</span>
                  <span className="text-xs text-faint ml-2">@{admin.username}</span>
                </div>
                <NeonButton
                  variant="ghost"
                  className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                  onClick={() => setDeleteAdminTarget(admin)}
                >
                  Remove
                </NeonButton>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-faint text-sm mb-3">No local admin accounts.</p>
        )}

        {/* Pending invites */}
        {pendingInvites.length > 0 && (
          <div className="mb-3">
            <p className="text-xs font-display uppercase tracking-wider text-muted mb-2">Pending Invites</p>
            <div className="space-y-2">
              {pendingInvites.map(inv => (
                <div key={inv.id} className="flex items-center justify-between bg-raised border border-neon-amber/20 rounded px-4 py-2">
                  <div>
                    <span className="text-sm text-primary">{inv.display_name}</span>
                    <span className="text-xs text-faint ml-2">
                      expires {new Date(inv.expires_at).toLocaleDateString()}
                    </span>
                  </div>
                  <div className="flex gap-1">
                    <NeonButton
                      variant="ghost"
                      className="text-xs px-2 py-1"
                      onClick={() => copyInviteLink(inv.token)}
                    >
                      {copiedToken === inv.token ? 'Copied!' : 'Copy Link'}
                    </NeonButton>
                    <NeonButton
                      variant="ghost"
                      className="text-xs px-2 py-1 text-neon-magenta hover:text-neon-magenta"
                      onClick={() => handleCancelInvite(inv.id)}
                    >
                      Cancel
                    </NeonButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Invite form for local admin */}
        {showInviteForm ? (
          <div className="border border-border rounded p-4 space-y-3">
            <div>
              <label className="text-xs text-faint block mb-1">Display Name *</label>
              <input
                type="text"
                placeholder="e.g. John Smith"
                value={inviteDisplayName}
                onChange={e => setInviteDisplayName(e.target.value)}
                className={inputClass}
                autoFocus
              />
            </div>
            <div>
              <label className="text-xs text-faint block mb-1">Discord Username (optional)</label>
              <input
                type="text"
                placeholder="e.g. ChuckRibbits"
                value={inviteDiscordId}
                onChange={e => setInviteDiscordId(e.target.value)}
                className={inputClass}
              />
              <p className="text-xs text-faint mt-1">If provided, the invite link will be sent via Discord DM.</p>
            </div>
            <div className="flex gap-2">
              <NeonButton onClick={handleInvite} disabled={inviting || !inviteDisplayName.trim()}>
                {inviting ? 'Sending...' : 'Send Invite'}
              </NeonButton>
              <NeonButton variant="ghost" onClick={() => setShowInviteForm(false)} disabled={inviting}>
                Cancel
              </NeonButton>
            </div>
          </div>
        ) : (
          <NeonButton variant="secondary" onClick={() => setShowInviteForm(true)}>Invite Local User</NeonButton>
        )}
      </NeonCard>

      <NeonCard title="Platforms" className="mb-4">
        <p className="text-muted text-sm mb-3">
          Master list of platforms available for game library entries and tournament platform rules.
        </p>
        <PlatformsEditor
          platforms={(() => { try { return JSON.parse(settings.PLATFORMS || '[]'); } catch { return []; } })()}
          onChange={p => handleChange('PLATFORMS', JSON.stringify(p))}
        />
      </NeonCard>

      <NeonCard title="Features" className="mb-4">
        <div className="space-y-4">
          {Object.entries(TOGGLE_SETTINGS).map(([key, { label, description, defaultOn }]) => {
            const isOn = settings[key] !== undefined ? settings[key] === 'true' : !!defaultOn;
            return (
              <div key={key} className="flex items-center justify-between gap-4">
                <div>
                  <p className="text-sm font-medium text-primary">{label}</p>
                  <p className="text-xs text-muted">{description}</p>
                </div>
                <button
                  onClick={() => handleChange(key, isOn ? 'false' : 'true')}
                  className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                    isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                      isOn ? 'translate-x-6' : ''
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </NeonCard>

      {categorized.map(({ category, entries }) => entries.length > 0 && (
        <NeonCard key={category} title={category} className="mb-4">
          <div className="space-y-3">
            {entries.map(([key, value]) => {
              const meta = SETTING_LABELS[key];
              return (
                <div key={key}>
                  <div className="flex items-center gap-3">
                    <label className="w-64 shrink-0 text-sm font-mono text-muted flex items-center">
                      {meta?.label || key}
                      {meta?.description && <InfoTip text={meta.description} />}
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
                </div>
              );
            })}
          </div>
        </NeonCard>
      ))}

      {uncategorizedKeys.length > 0 && (
        <NeonCard title="Other" className="mb-4">
          <div className="space-y-3">
            {uncategorizedKeys.map(key => (
              <div key={key} className="flex items-center gap-3">
                <label className="w-64 shrink-0 text-sm font-mono text-muted">{key}</label>
                <input
                  type={isSensitive(key) && !revealed.has(key) ? 'password' : 'text'}
                  value={settings[key]}
                  onChange={e => handleChange(key, e.target.value)}
                  className={`${inputClass} flex-1`}
                />
              </div>
            ))}
          </div>
        </NeonCard>
      )}

      <NeonCard title="System Actions" className="mb-4">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <p className="text-sm text-muted">
              Reload tournament schedules after changing cron settings, timezones, or activating/deactivating tournaments.
              This happens automatically when you save tournament changes, but you can trigger it manually here.
            </p>
          </div>
          <NeonButton
            variant="secondary"
            onClick={async () => {
              setReloadingScheduler(true);
              try {
                await api.post(`/rooms/${room.roomId}/scheduler/reload`, {});
                toast('Scheduler reloaded', 'success');
              } catch {
                toast('Failed to reload scheduler', 'error');
              } finally {
                setReloadingScheduler(false);
              }
            }}
            disabled={reloadingScheduler}
          >
            {reloadingScheduler ? 'Reloading...' : 'Reload Scheduler'}
          </NeonButton>
        </div>
      </NeonCard>

      <NeonCard title="Merge / Rename Player" className="mb-4">
        <p className="text-sm text-muted mb-3">
          Rename a player or merge two usernames into one. Updates all submissions, scores, and user mappings.
          If the name was also wrong on iScored, fix it there first to prevent re-importing the old name on next sync.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label className="text-xs text-faint block mb-1">From (old/wrong name)</label>
            <input
              type="text"
              placeholder="mekelburj"
              value={mergeFrom}
              onChange={e => setMergeFrom(e.target.value)}
              className={`${inputClass} w-48`}
            />
          </div>
          <div>
            <label className="text-xs text-faint block mb-1">To (correct name)</label>
            <input
              type="text"
              placeholder="mekelburgj"
              value={mergeTo}
              onChange={e => setMergeTo(e.target.value)}
              className={`${inputClass} w-48`}
            />
          </div>
          <NeonButton
            variant="secondary"
            disabled={merging || !mergeFrom.trim() || !mergeTo.trim()}
            onClick={async () => {
              if (!confirm(`Rename all records from "${mergeFrom}" to "${mergeTo}"? This cannot be undone.`)) return;
              setMerging(true);
              try {
                const result = await api.post<{ submissionsUpdated: number; scoresUpdated: number }>(`/rooms/${room.roomId}/admin/merge-player`, {
                  fromUsername: mergeFrom.trim(),
                  toUsername: mergeTo.trim(),
                });
                toast(`Merged: ${result.submissionsUpdated} submissions, ${result.scoresUpdated} scores updated`, 'success');
                setMergeFrom('');
                setMergeTo('');
              } catch {
                toast('Failed to merge player', 'error');
              } finally {
                setMerging(false);
              }
            }}
          >
            {merging ? 'Merging...' : 'Merge'}
          </NeonButton>
        </div>
      </NeonCard>

      <NeonCard title="Add Custom Setting" className="mb-4">
        <div className="flex gap-3">
          <input type="text" placeholder="KEY_NAME" value={newKey} onChange={e => setNewKey(e.target.value)} className={`${inputClass} w-48`} />
          <input type="text" placeholder="Value" value={newValue} onChange={e => setNewValue(e.target.value)} className={`${inputClass} flex-1`} />
          <NeonButton variant="secondary" onClick={handleAdd}>Add</NeonButton>
        </div>
      </NeonCard>

      {deleteAdminTarget && (
        <ConfirmModal
          title="Remove Admin"
          message={`Are you sure you want to remove ${deleteAdminTarget.display_name || deleteAdminTarget.username}? They will no longer be able to log in.`}
          confirmLabel="Remove"
          onConfirm={handleDeleteAdmin}
          onCancel={() => setDeleteAdminTarget(null)}
        />
      )}
    </div>
  );
}
