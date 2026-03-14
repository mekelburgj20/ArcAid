import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import { useTheme, THEMES, type ThemeId } from '../components/ThemeProvider';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';

const SENSITIVE_KEYS = ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_SECRET', 'ISCORED_PASSWORD', 'ADMIN_PASSWORD_HASH'];

const CATEGORIES: Record<string, string[]> = {
  'Game Room': ['GAME_ROOM_NAME', 'GAME_ROOM_SLUG'],
  'Discord': ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_GUILD_ID', 'DISCORD_ADMIN_ROLE_ID', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'],
  'iScored': ['ISCORED_USERNAME', 'ISCORED_PASSWORD', 'ISCORED_PUBLIC_URL'],
  'Tournament Defaults': ['GAME_ELIGIBILITY_DAYS', 'WINNER_PICK_WINDOW_MIN', 'RUNNERUP_PICK_WINDOW_MIN', 'BOT_TIMEZONE'],
  'System': ['PORT', 'LOG_LEVEL', 'MAX_LOG_LINES', 'BACKUP_RETENTION_DAYS', 'SETUP_COMPLETE'],
};

const TOGGLE_SETTINGS: Record<string, { label: string; description: string }> = {
  'ENABLE_CALLOUTS': {
    label: 'Callouts (Easter Egg)',
    description: 'When enabled, the bot responds to trigger words defined in data/callouts.json.',
  },
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

  useEffect(() => {
    api.get<Record<string, string>>('/settings')
      .then(data => {
        setSettings(data);
        // Sync global theme from settings
        if (data.UI_THEME && data.UI_THEME !== globalTheme) {
          setGlobalTheme(data.UI_THEME as ThemeId);
        }
        setLoading(false);
      })
      .catch(() => { toast('Failed to load settings', 'error'); setLoading(false); });
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Filter out ADMIN_PASSWORD_HASH — server rejects it via this endpoint
      const { ADMIN_PASSWORD_HASH: _, ...toSave } = settings;
      await api.post('/settings', toSave);
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
              {Object.entries(THEMES).map(([id, { label }]) => (
                <option key={id} value={id}>{label}</option>
              ))}
            </select>
            <p className="text-xs text-muted mt-1">Overrides the global theme for your admin session only. Does not affect other admins or the public portal.</p>
          </div>
        </div>
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
          {Object.entries(TOGGLE_SETTINGS).map(([key, { label, description }]) => (
            <div key={key} className="flex items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-primary">{label}</p>
                <p className="text-xs text-muted">{description}</p>
              </div>
              <button
                onClick={() => handleChange(key, settings[key] === 'true' ? 'false' : 'true')}
                className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                  settings[key] === 'true' ? 'bg-neon-cyan' : 'bg-raised border border-border'
                }`}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                    settings[key] === 'true' ? 'translate-x-6' : ''
                  }`}
                />
              </button>
            </div>
          ))}
        </div>
      </NeonCard>

      {categorized.map(({ category, entries }) => entries.length > 0 && (
        <NeonCard key={category} title={category} className="mb-4">
          <div className="space-y-3">
            {entries.map(([key, value]) => (
              <div key={key} className="flex items-center gap-3">
                <label className="w-64 shrink-0 text-sm font-mono text-muted">{key}</label>
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
            ))}
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
                await api.post('/scheduler/reload', {});
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
                const result = await api.post<{ submissionsUpdated: number; scoresUpdated: number }>('/admin/merge-player', {
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
    </div>
  );
}
