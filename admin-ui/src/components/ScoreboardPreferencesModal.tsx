import { useEffect, useState } from 'react';
import { X, RotateCcw, Monitor, Smartphone, ChevronDown, ChevronRight } from 'lucide-react';
import { THEMES } from './ThemeProvider';
import type { ScoreboardStyle } from '../lib/scoreboardThemes';
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../lib/scoreboardThemes';

interface ScoreboardPreferencesModalProps {
  open: boolean;
  onClose: () => void;
  playerToken: string;
  /** Current room config (room admin defaults) */
  roomConfig: Record<string, string>;
  /** Called after prefs are saved so scoreboard re-fetches */
  onSaved: () => void;
}

type DeviceType = 'desktop' | 'mobile';

// ── Preference definitions ────────────────────────────────────────────────

interface PrefDef {
  key: string;
  label: string;
  description?: string;
  type: 'select' | 'number' | 'toggle' | 'range';
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
}

const STYLE_OPTIONS: { value: ScoreboardStyle; label: string; description: string }[] = [
  { value: 'banner', label: 'Banner', description: 'Background images' },
  { value: 'showcase', label: 'Showcase', description: 'Art-forward with podium' },
  { value: 'minimal', label: 'Minimal', description: 'Typography only' },
];

const THEME_OPTIONS = Object.entries(SHOWCASE_THEMES).map(([id, cfg]) => ({
  value: id,
  label: (cfg as any).label || id,
  description: (cfg as any).description || '',
}));

const TOGGLE_PREFS: PrefDef[] = [
  { key: 'SCOREBOARD_HIDE_EMPTY', label: 'Hide Empty Games', description: 'Hide game cards with no scores from the scoreboard', type: 'toggle' },
  { key: 'SCOREBOARD_TITLE_HIDDEN', label: 'Hide Game Room Title', description: 'Hide the game room name/heading on the scoreboard', type: 'toggle' },
  { key: 'SCOREBOARD_GAME_TITLE_ENHANCE', label: 'Enhance Game Title Visibility', description: 'Add a dark backdrop behind game title text for readability', type: 'toggle' },
  { key: 'SCOREBOARD_CARD_BG_FILL', label: 'Card Background Fill', description: 'Game background images fill the entire card for an immersive look', type: 'toggle' },
  { key: 'SCOREBOARD_RANKINGS_STICKY', label: 'Always Visible Rankings', description: 'Keep the Overall Rankings card pinned on screen', type: 'toggle' },
  { key: 'SCOREBOARD_SHOW_TIMER', label: 'Show Countdown Timer', description: 'Display time remaining until next rotation', type: 'toggle' },
];

const SELECT_PREFS: PrefDef[] = [
  {
    key: 'SCOREBOARD_LAYOUT', label: 'Card Layout', type: 'select',
    options: [
      { value: 'scroll', label: 'Horizontal Scroll' },
      { value: 'vertical', label: 'Vertical Scroll' },
      { value: 'grid', label: 'Grid' },
    ],
  },
  {
    key: 'SCOREBOARD_QR_MODE', label: 'QR Codes', type: 'select',
    options: [
      { value: 'disabled', label: 'Disabled' },
      { value: 'kiosk-only', label: 'Kiosk Only' },
      { value: 'all', label: 'All Leaderboards' },
    ],
  },
  {
    key: 'SCOREBOARD_RANKINGS_POSITION', label: 'Rankings Position', type: 'select',
    options: [
      { value: 'left', label: 'Left' },
      { value: 'right', label: 'Right' },
      { value: 'top', label: 'Top' },
      { value: 'bottom', label: 'Bottom' },
      { value: 'hidden', label: 'Hidden' },
    ],
  },
  {
    key: 'SCOREBOARD_RANKINGS_STYLE', label: 'Rankings Card Style',
    description: 'Match the scoreboard style or pick a distinct treatment for ranking cards.',
    type: 'select',
    options: [
      { value: 'match', label: 'Match Leaderboard' },
      { value: 'plaque', label: 'Plaque (hall-of-fame frame)' },
      { value: 'compact', label: 'Compact List (no chrome)' },
      { value: 'sidebar', label: 'Sidebar Block (narrow column)' },
    ],
  },
  {
    key: 'SCOREBOARD_QR_POSITION', label: 'QR Code Position', type: 'select',
    options: [
      { value: 'top-right', label: 'Top Right' },
      { value: 'bottom-right', label: 'Bottom Right' },
      { value: 'bottom-center', label: 'Bottom Center (Overhang)' },
    ],
  },
  {
    key: 'SCOREBOARD_GAME_TITLE_STYLE', label: 'Game Title Style', type: 'select',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'glow', label: 'Neon Cyan' },
      { value: 'neon-magenta', label: 'Neon Magenta' },
      { value: 'chrome', label: 'Chrome' },
      { value: 'fire', label: 'Fire' },
      { value: 'plasma', label: 'Plasma' },
      { value: 'backglass', label: 'Backglass' },
      { value: 'marquee', label: 'Marquee' },
      { value: 'retro', label: 'Retro' },
      { value: 'pixel', label: 'Pixel' },
      { value: 'shadow', label: 'Shadow' },
      { value: 'outlined', label: 'Outlined' },
    ],
  },
];

const ADVANCED_NUMBER_PREFS: PrefDef[] = [
  { key: 'SCOREBOARD_MAX_SCORES', label: 'Scores Per Card', description: 'Maximum visible scores per game card', type: 'number', min: 1, max: 50 },
  { key: 'SCOREBOARD_MIN_SCORES', label: 'Min Card Height (scores)', description: 'Minimum card height expressed as score rows', type: 'number', min: 1, max: 50 },
  { key: 'SCOREBOARD_CARD_SPACING', label: 'Card Spacing (px)', description: 'Gap between game cards in pixels', type: 'number', min: 0, max: 100 },
  { key: 'SCOREBOARD_TITLE_FONT_SIZE', label: 'Title Font Size (px)', description: '0 = style default. Override game title font size.', type: 'number', min: 0, max: 72 },
  { key: 'SCOREBOARD_QR_SIZE', label: 'QR Code Size (px)', description: 'Size of QR codes on game cards. Default: 30 (~25% larger than legacy 24).', type: 'number', min: 16, max: 200 },
  { key: 'SCOREBOARD_QR_OVERLAP_PX', label: 'QR Code Bottom Edge Overlap (px)', description: 'For bottom-anchored QR positions: pixels the QR overlaps into the card. 0 = QR touches the bottom edge from below; higher = more of the QR sits inside the card. Default: 10.', type: 'number', min: 0, max: 200 },
];

const MOBILE_PREFS: PrefDef[] = [
  { key: 'SCOREBOARD_MOBILE_VERTICAL', label: 'Mobile Vertical Scroll', description: 'When on, cards stack vertically on mobile. When off, mobile uses the same layout as desktop.', type: 'toggle' },
  { key: 'SCOREBOARD_MOBILE_SCALE', label: 'Mobile Scale Factor', description: 'Scale cards on mobile (0.3-1.0). Default 0.85 = 85% of desktop size.', type: 'number', min: 0.3, max: 1.0, step: 0.1 },
];

const ZOOM_PREF: PrefDef = { key: 'SCOREBOARD_ZOOM', label: 'Zoom', type: 'range', min: 50, max: 200, suffix: '%' };

// ── Styles ──────────────────────────────────────────────────────────────────

const selectClass = 'w-full px-3 py-1.5 bg-raised border border-border rounded text-primary text-sm';
const inputClass = 'w-20 px-2 py-1.5 bg-raised border border-border rounded text-primary text-sm text-center';

// ── Component ───────────────────────────────────────────────────────────────

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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [device, setDevice] = useState<DeviceType>(window.innerWidth <= 640 ? 'mobile' : 'desktop');

  useEffect(() => {
    if (!open || !playerToken) return;
    setLoaded(false);
    fetch(`/api/me/scoreboard-preferences?device=${device}`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => (r.ok ? r.json() : {}))
      .then(data => { setPrefs(data || {}); setLoaded(true); })
      .catch(() => setLoaded(true));
  }, [open, playerToken, device]);

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

      // Theme
      payload['UI_THEME'] = prefs['UI_THEME'] ?? null;
      // Style + theme
      payload['SCOREBOARD_STYLE'] = prefs['SCOREBOARD_STYLE'] ?? null;
      payload['SCOREBOARD_THEME'] = prefs['SCOREBOARD_THEME'] ?? null;

      // All toggle prefs
      for (const { key } of TOGGLE_PREFS) {
        payload[key] = prefs[key] ?? null;
      }
      // All select prefs
      for (const { key } of SELECT_PREFS) {
        payload[key] = prefs[key] ?? null;
      }
      // Advanced number prefs
      for (const { key } of ADVANCED_NUMBER_PREFS) {
        payload[key] = prefs[key] ?? null;
      }
      // Mobile prefs
      for (const { key } of MOBILE_PREFS) {
        payload[key] = prefs[key] ?? null;
      }
      // Zoom
      payload[ZOOM_PREF.key] = prefs[ZOOM_PREF.key] ?? null;

      await fetch(`/api/me/scoreboard-preferences?device=${device}`, {
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

  const currentStyle = (getEffective('SCOREBOARD_STYLE') || 'banner') as ScoreboardStyle;

  // ── Reset button ────────────────────────────────────────────────────────

  const ResetBtn = ({ k }: { k: string }) =>
    hasOverride(k) ? (
      <button onClick={() => handleClear(k)} className="text-xs text-muted hover:text-neon-cyan flex items-center gap-1 cursor-pointer shrink-0" title="Reset to room default">
        <RotateCcw size={12} /> Reset
      </button>
    ) : null;

  // ── Render helpers ──────────────────────────────────────────────────────

  const renderToggle = (def: PrefDef) => {
    const val = getEffective(def.key);
    // For show_timer the default is true (setting !== 'false'), for others default is false (setting === 'true')
    const isOn = def.key === 'SCOREBOARD_SHOW_TIMER'
      ? val !== 'false'
      : val === 'true';
    return (
      <div key={def.key} className="flex items-center justify-between py-2">
        <div className="flex-1 mr-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-primary">{def.label}</span>
            <ResetBtn k={def.key} />
          </div>
          {def.description && <p className="text-xs text-muted mt-0.5">{def.description}</p>}
        </div>
        <button
          onClick={() => handleChange(def.key, isOn ? 'false' : 'true')}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer shrink-0 ${
            isOn ? 'bg-neon-cyan' : 'bg-raised border border-border'
          }`}
        >
          <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
            isOn ? 'translate-x-6' : 'translate-x-1'
          }`} />
        </button>
      </div>
    );
  };

  const renderSelect = (def: PrefDef) => (
    <div key={def.key} className="py-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-medium text-primary">{def.label}</span>
        <ResetBtn k={def.key} />
      </div>
      <select
        value={getEffective(def.key)}
        onChange={e => handleChange(def.key, e.target.value)}
        className={selectClass}
      >
        {def.options!.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );

  const renderNumber = (def: PrefDef) => (
    <div key={def.key} className="flex items-center justify-between py-2">
      <div className="flex-1 mr-4">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-primary">{def.label}</span>
          <ResetBtn k={def.key} />
        </div>
        {def.description && <p className="text-xs text-muted mt-0.5">{def.description}</p>}
      </div>
      <input
        type="number"
        value={getEffective(def.key)}
        onChange={e => handleChange(def.key, e.target.value)}
        min={def.min}
        max={def.max}
        step={def.step}
        className={inputClass}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header with device toggle */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-display font-bold text-primary">Display Preferences</h2>
          <div className="flex items-center gap-2">
            {/* Device toggle */}
            <div className="flex items-center bg-raised border border-border rounded-lg p-0.5">
              <button
                onClick={() => setDevice('desktop')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  device === 'desktop' ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-muted hover:text-primary'
                }`}
                title="Desktop preferences"
              >
                <Monitor size={14} />
                <span className="hidden sm:inline">Desktop</span>
              </button>
              <button
                onClick={() => setDevice('mobile')}
                className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors cursor-pointer ${
                  device === 'mobile' ? 'bg-neon-cyan/20 text-neon-cyan' : 'text-muted hover:text-primary'
                }`}
                title="Mobile preferences"
              >
                <Smartphone size={14} />
                <span className="hidden sm:inline">Mobile</span>
              </button>
            </div>
            <button onClick={onClose} className="p-1 text-muted hover:text-primary cursor-pointer">
              <X size={20} />
            </button>
          </div>
        </div>

        {!loaded ? (
          <div className="px-5 py-8 text-center text-muted text-sm">Loading...</div>
        ) : (
          <div className="px-5 py-4 space-y-1">
            <p className="text-xs text-muted mb-3">
              Override room defaults for your {device} leaderboard view. Reset a setting to use the room admin's default.
            </p>

            {/* ── Card Style ───────────────────────────────────────── */}
            <div className="py-2">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-primary">Card Style</span>
                <ResetBtn k="SCOREBOARD_STYLE" />
              </div>
              <div className="grid grid-cols-3 gap-2">
                {STYLE_OPTIONS.map(s => {
                  const isActive = currentStyle === s.value;
                  return (
                    <button
                      key={s.value}
                      onClick={() => {
                        handleChange('SCOREBOARD_STYLE', s.value);
                        if (s.value === 'showcase' && !prefs['SCOREBOARD_THEME']) {
                          handleChange('SCOREBOARD_THEME', DEFAULT_SHOWCASE_THEME);
                        }
                      }}
                      className={`px-3 py-2 rounded-lg border text-center text-xs transition-all cursor-pointer ${
                        isActive
                          ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                          : 'border-border text-muted hover:border-primary/40 hover:text-primary'
                      }`}
                    >
                      <div className="font-semibold">{s.label}</div>
                      <div className="text-[10px] mt-0.5 opacity-70">{s.description}</div>
                    </button>
                  );
                })}
              </div>
            </div>

            {/* ── Showcase Theme (only if showcase) ────────────────── */}
            {currentStyle === 'showcase' && (
              <div className="py-2">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-primary">Theme</span>
                  <ResetBtn k="SCOREBOARD_THEME" />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {THEME_OPTIONS.map(t => {
                    const isActive = (getEffective('SCOREBOARD_THEME') || DEFAULT_SHOWCASE_THEME) === t.value;
                    return (
                      <button
                        key={t.value}
                        onClick={() => handleChange('SCOREBOARD_THEME', t.value)}
                        className={`px-3 py-2 rounded-lg border text-left text-xs transition-all cursor-pointer ${
                          isActive
                            ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                            : 'border-border text-muted hover:border-primary/40 hover:text-primary'
                        }`}
                      >
                        <div className="font-semibold">{t.label}</div>
                        {t.description && <div className="text-[10px] mt-0.5 opacity-70">{t.description}</div>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── UI Theme ─────────────────────────────────────────── */}
            <div className="py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-primary">UI Theme</span>
                <ResetBtn k="UI_THEME" />
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

            {/* ── Toggles ──────────────────────────────────────────── */}
            <div className="border-t border-border pt-2 mt-2">
              {TOGGLE_PREFS.map(renderToggle)}
            </div>

            {/* ── Selects ──────────────────────────────────────────── */}
            <div className="border-t border-border pt-2 mt-2">
              {SELECT_PREFS.map(renderSelect)}
            </div>

            {/* ── Zoom slider ──────────────────────────────────────── */}
            <div className="border-t border-border pt-3 mt-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-primary">{ZOOM_PREF.label}</span>
                <div className="flex items-center gap-2">
                  <ResetBtn k={ZOOM_PREF.key} />
                  <span className="text-sm text-neon-cyan font-mono w-12 text-right">{getEffective(ZOOM_PREF.key) || '100'}%</span>
                </div>
              </div>
              <input
                type="range"
                min={ZOOM_PREF.min}
                max={ZOOM_PREF.max}
                value={getEffective(ZOOM_PREF.key) || '100'}
                onChange={e => handleChange(ZOOM_PREF.key, e.target.value)}
                className="w-full accent-neon-cyan cursor-pointer"
              />
            </div>

            {/* ── Advanced (collapsible) ───────────────────────────── */}
            <div className="border-t border-border pt-2 mt-2">
              <button
                onClick={() => setAdvancedOpen(!advancedOpen)}
                className="flex items-center gap-1 text-xs font-semibold text-muted hover:text-primary uppercase tracking-wider cursor-pointer w-full py-1"
              >
                {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                Advanced
              </button>
              {advancedOpen && (
                <div className="mt-1 space-y-0">
                  {ADVANCED_NUMBER_PREFS.map(renderNumber)}

                  <div className="border-t border-border/50 pt-2 mt-2">
                    <span className="text-xs text-muted uppercase tracking-wider">Mobile</span>
                  </div>
                  {MOBILE_PREFS.map(def =>
                    def.type === 'toggle' ? renderToggle(def) : renderNumber(def)
                  )}
                </div>
              )}
            </div>
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
