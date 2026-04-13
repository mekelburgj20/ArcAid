import { useEffect, useState } from 'react';
import { X, RotateCcw } from 'lucide-react';
import { THEMES } from './ThemeProvider';

interface ScoreboardPreferencesModalProps {
  open: boolean;
  onClose: () => void;
  playerToken: string;
  /** Current room config (room admin defaults) */
  roomConfig: Record<string, string>;
  /** Called after prefs are saved so scoreboard re-fetches */
  onSaved: () => void;
}

const PREF_KEYS = [
  {
    key: 'SCOREBOARD_LAYOUT',
    label: 'Card Layout',
    type: 'select' as const,
    options: [
      { value: 'scroll', label: 'Horizontal Scroll' },
      { value: 'vertical', label: 'Vertical Scroll' },
      { value: 'grid', label: 'Grid' },
    ],
  },
  {
    key: 'SCOREBOARD_MAX_SCORES',
    label: 'Scores Per Card',
    type: 'number' as const,
    min: 1,
    max: 50,
  },
  {
    key: 'SCOREBOARD_ZOOM',
    label: 'Zoom (%)',
    type: 'number' as const,
    min: 50,
    max: 200,
  },
  {
    key: 'SCOREBOARD_HIDE_EMPTY',
    label: 'Hide Empty Games',
    type: 'toggle' as const,
  },
];

const selectClass = 'w-full px-3 py-1.5 bg-raised border border-border rounded text-primary text-sm';
const inputClass = 'w-20 px-2 py-1.5 bg-raised border border-border rounded text-primary text-sm text-center';

export default function ScoreboardPreferencesModal({
  open,
  onClose,
  playerToken,
  roomConfig,
  onSaved,
}: ScoreboardPreferencesModalProps) {
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open || !playerToken) return;
    fetch('/api/me/scoreboard-preferences', {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => (r.ok ? r.json() : {}))
      .then(data => { setPrefs(data || {}); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [open, playerToken]);

  const handleChange = (key: string, value: string) => {
    setPrefs(prev => ({ ...prev, [key]: value }));
  };

  const handleClear = (key: string) => {
    setPrefs(prev => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      // Build the payload: explicitly set keys with values, clear removed keys by sending null
      const payload: Record<string, string | null> = {};
      // For every PREF_KEY, either set the value or null (to revert to room default)
      for (const { key } of PREF_KEYS) {
        payload[key] = prefs[key] ?? null;
      }
      // Also handle theme
      payload['UI_THEME'] = prefs['UI_THEME'] ?? null;

      await fetch('/api/me/scoreboard-preferences', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${playerToken}`,
        },
        body: JSON.stringify(payload),
      });
      onSaved();
      onClose();
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  const getEffective = (key: string) => prefs[key] ?? roomConfig[key] ?? '';
  const hasOverride = (key: string) => key in prefs && prefs[key] !== undefined;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-md mx-4 max-h-[85vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-display font-bold text-primary">Display Preferences</h2>
          <button onClick={onClose} className="p-1 text-muted hover:text-primary cursor-pointer">
            <X size={20} />
          </button>
        </div>

        {!loaded ? (
          <div className="px-5 py-8 text-center text-muted text-sm">Loading...</div>
        ) : (
          <div className="px-5 py-4 space-y-4">
            <p className="text-xs text-muted">
              Override room defaults for your scoreboard view. Clear a setting to use the room admin's default.
            </p>

            {/* Theme override */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-sm font-medium text-primary">Theme</label>
                {hasOverride('UI_THEME') && (
                  <button onClick={() => handleClear('UI_THEME')} className="text-xs text-muted hover:text-neon-cyan flex items-center gap-1 cursor-pointer" title="Reset to room default">
                    <RotateCcw size={12} /> Reset
                  </button>
                )}
              </div>
              <select
                value={getEffective('UI_THEME') || 'dark'}
                onChange={e => handleChange('UI_THEME', e.target.value)}
                className={selectClass}
              >
                <option value="">Room default</option>
                {Object.entries(THEMES).map(([id, { label }]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </div>

            {/* Setting overrides */}
            {PREF_KEYS.map(({ key, label, type, options, min, max }) => (
              <div key={key}>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium text-primary">{label}</label>
                  {hasOverride(key) && (
                    <button onClick={() => handleClear(key)} className="text-xs text-muted hover:text-neon-cyan flex items-center gap-1 cursor-pointer" title="Reset to room default">
                      <RotateCcw size={12} /> Reset
                    </button>
                  )}
                </div>
                {type === 'select' && (
                  <select
                    value={getEffective(key)}
                    onChange={e => handleChange(key, e.target.value)}
                    className={selectClass}
                  >
                    {options!.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                )}
                {type === 'number' && (
                  <input
                    type="number"
                    value={getEffective(key)}
                    onChange={e => handleChange(key, e.target.value)}
                    min={min}
                    max={max}
                    className={inputClass}
                  />
                )}
                {type === 'toggle' && (
                  <button
                    onClick={() => handleChange(key, getEffective(key) === 'true' ? 'false' : 'true')}
                    className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer ${
                      getEffective(key) === 'true' ? 'bg-neon-cyan' : 'bg-raised border border-border'
                    }`}
                  >
                    <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      getEffective(key) === 'true' ? 'translate-x-6' : 'translate-x-1'
                    }`} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Footer */}
        <div className="px-5 py-4 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-primary rounded border border-border cursor-pointer"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 text-sm bg-neon-cyan text-deep font-medium rounded hover:bg-neon-cyan/80 disabled:opacity-50 cursor-pointer"
          >
            {saving ? 'Saving...' : 'Save Preferences'}
          </button>
        </div>
      </div>
    </div>
  );
}
