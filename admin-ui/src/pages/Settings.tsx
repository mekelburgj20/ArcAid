import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useToast } from '../components/Toast';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';

const SENSITIVE_KEYS = ['DISCORD_BOT_TOKEN', 'ISCORED_PASSWORD', 'ADMIN_PASSWORD_HASH'];

const CATEGORIES: Record<string, string[]> = {
  'Discord': ['DISCORD_BOT_TOKEN', 'DISCORD_CLIENT_ID', 'DISCORD_GUILD_ID', 'DISCORD_ANNOUNCEMENT_CHANNEL_ID'],
  'iScored': ['ISCORED_USERNAME', 'ISCORED_PASSWORD', 'ISCORED_PUBLIC_URL'],
  'Tournament Defaults': ['GAME_ELIGIBILITY_DAYS', 'WINNER_PICK_WINDOW_MIN', 'RUNNERUP_PICK_WINDOW_MIN', 'BOT_TIMEZONE'],
  'System': ['PORT', 'LOG_LEVEL', 'MAX_LOG_LINES', 'BACKUP_RETENTION_DAYS', 'SETUP_COMPLETE'],
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
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  useEffect(() => {
    api.get<Record<string, string>>('/settings')
      .then(data => { setSettings(data); setLoading(false); })
      .catch(() => { toast('Failed to load settings', 'error'); setLoading(false); });
  }, []);

  const handleChange = (key: string, value: string) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api.post('/settings', settings);
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

  // Group settings by category
  const categorized = Object.entries(CATEGORIES).map(([category, keys]) => ({
    category,
    entries: keys.filter(k => k in settings).map(k => [k, settings[k]] as [string, string]),
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

      <NeonCard title="Platforms" className="mb-4">
        <p className="text-muted text-sm mb-3">
          Master list of platforms available for game library entries and tournament platform rules.
        </p>
        <PlatformsEditor
          platforms={(() => { try { return JSON.parse(settings.PLATFORMS || '[]'); } catch { return []; } })()}
          onChange={p => handleChange('PLATFORMS', JSON.stringify(p))}
        />
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
