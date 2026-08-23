import { useEffect, useState } from 'react';
import { X, RotateCcw, Monitor, Smartphone, ChevronDown, ChevronRight } from 'lucide-react';
import { useTheme } from './ThemeProvider';
import type { ThemeId } from '../lib/themeIds';
import AppearanceControl from './AppearanceControl';
import ThemePicker from './ThemePicker';
import { saveRoomTheme } from '../lib/roomThemes';
import type { ScoreboardStyle } from '../lib/scoreboardThemes';
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../lib/scoreboardThemes';
import { TOGGLE_DEFAULT_ON } from '../lib/scoreboardConfig';

interface ScoreboardPreferencesModalProps {
  open: boolean;
  onClose: () => void;
  playerToken: string;
  /** Current room config (room admin defaults) */
  roomConfig: Record<string, string>;
  /** Called after prefs are saved so scoreboard re-fetches */
  onSaved: () => void;
  /**
   * v2.132.0 — false on non-room pages (global scoreboard, /friends, the
   * landing page…), where the whole "This room" section is hidden.
   *
   * It also disables Save, and that is load-bearing rather than cosmetic:
   * `handleSave` enumerates EVERY scoreboard pref key and posts the unset
   * ones as `null`, which the backend deletes. Off-room the prefs were never
   * fetched, so a Save there would wipe the viewer's whole override set.
   */
  roomScoped?: boolean;
  /**
   * v2.132.0 — `game_rooms.id` for the room on screen. The per-room theme
   * override is keyed by it (NOT by device, and not by slug); without it the
   * picker still repaints locally but cannot persist.
   */
  roomId?: string;
  /** Room name for the "This room" caption; falls back to generic copy. */
  roomName?: string;
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
  /** Renders the switch as the NEGATION of the stored key — for keys named
   *  "…_ENABLED" surfaced to viewers as "Hide …". */
  invert?: boolean;
}

const STYLE_OPTIONS: { value: ScoreboardStyle; label: string; description: string }[] = [
  // Style-system revamp Phase 1: Arcade leads here for the same reason it leads
  // the admin picker — it is the flagship and the seeded default. This list is
  // a SECOND hardcoded copy of the style set (the admin-side one lives in
  // StyleThemePicker); a style missing here is silently unavailable to viewers.
  { value: 'arcade', label: 'Arcade', description: 'Neon art cards with a podium' },
  { value: 'banner', label: 'Banner', description: 'Background images' },
  { value: 'showcase', label: 'Showcase', description: 'Art-forward with podium' },
  { value: 'minimal', label: 'Minimal', description: 'Typography only' },
];

const THEME_OPTIONS = Object.entries(SHOWCASE_THEMES).map(([id, cfg]) => ({
  value: id,
  // Style-system revamp P0 (honesty fix): ShowcaseThemeConfig's field is
  // `name`, not `label` — viewers were seeing raw theme ids here.
  label: cfg.name || id,
  description: cfg.description || '',
}));

// Style-system revamp P0 (honesty fix): SCOREBOARD_GAME_TITLE_ENHANCE is read
// only by the legacy deriveCardProps path — it does nothing on any room using
// a card style (which is now every room, post P0 seed fix). Removed from both
// admin Settings and here until Phase 1 retires the legacy derivation.
const TOGGLE_PREFS: PrefDef[] = [
  { key: 'SCOREBOARD_HIDE_EMPTY', label: 'Hide Empty Games', description: 'Hide game cards with no scores from the scoreboard', type: 'toggle' },
  { key: 'SCOREBOARD_TITLE_HIDDEN', label: 'Hide Game Room Title', description: 'Hide the game room name/heading on the scoreboard', type: 'toggle' },
  // Owner ask, 2026-08-15 — viewers could already hide the room TITLE but not
  // the logo beside it. Note the inverted sense: the stored key is
  // SCOREBOARD_LOGO_ENABLED (default on), so this pref is rendered through
  // `invert` rather than adding a second key that means the opposite.
  { key: 'SCOREBOARD_LOGO_ENABLED', label: 'Hide Game Room Logo', description: 'Hide the room logo shown beside the leaderboard title', type: 'toggle', invert: true },
  { key: 'SCOREBOARD_CARD_BG_FILL', label: 'Card Background Fill', description: 'Game background images fill the entire card for an immersive look', type: 'toggle' },
  // Owner ask, 2026-08-19. Inverted for the same reason as the logo above: the
  // stored key is SCOREBOARD_GAME_HEADER_ENABLED (default on), and a viewer
  // reaching for this is looking for a way to switch the art OFF.
  { key: 'SCOREBOARD_GAME_HEADER_ENABLED', label: 'Hide Game Art', description: "Hide the art block at the top of each game card. Titles, tournament labels and countdowns stay.", type: 'toggle', invert: true },
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
    description: 'Match the scoreboard style or pick a distinct treatment for ranking cards. Ticker is a text strip — card background styles don\'t apply to it.',
    type: 'select',
    options: [
      { value: 'match', label: 'Match Leaderboard' },
      { value: 'plaque', label: 'Plaque (hall-of-fame frame)' },
      { value: 'compact', label: 'Compact List (no chrome)' },
      { value: 'sidebar', label: 'Sidebar Block (narrow column)' },
      { value: 'ticker', label: 'Scrolling Ticker (top of scoreboard, above the header)' },
    ],
  },
  {
    key: 'SCOREBOARD_QR_POSITION', label: 'QR Code Position', type: 'select',
    options: [
      { value: 'top-center', label: 'Top' },
      { value: 'bottom-center', label: 'Bottom' },
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
      { value: 'arcade-red', label: 'Arcade Red' },
      { value: 'arcade-cyan', label: 'Arcade Cyan' },
      { value: 'arcade-amber', label: 'Arcade Amber' },
      { value: 'arcade-green', label: 'Arcade Green' },
      { value: 'holo', label: 'Holo Sweep' },
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
  { key: 'SCOREBOARD_QR_OFFSET_PX', label: 'QR Code Offset (px)', description: 'Distance from the card edge. Negative overlaps the border, positive moves it away. Default: -10.', type: 'number', min: -200, max: 200 },
];

const MOBILE_PREFS: PrefDef[] = [
  { key: 'SCOREBOARD_MOBILE_VERTICAL', label: 'Mobile Vertical Scroll', description: 'When on, cards stack vertically on mobile. When off, mobile uses the same layout as desktop.', type: 'toggle' },
  { key: 'SCOREBOARD_MOBILE_SCALE', label: 'Mobile Density', description: 'Shrink cards to fit more on screen (0.3-1.0). Default 1.0 = full size, matching desktop.', type: 'number', min: 0.3, max: 1.0, step: 0.1 },
];

// Style-system revamp P0 (item 5): range aligned to match StyleThemePicker's
// admin control (50-150) — was 50-200 here, letting a viewer set a zoom value
// the room's own admin-facing control couldn't reach.
const ZOOM_PREF: PrefDef = { key: 'SCOREBOARD_ZOOM', label: 'Zoom', type: 'range', min: 50, max: 150, suffix: '%' };

// ── Tiering (Style-system revamp P3) ────────────────────────────────────────
// The top level is four controls — Card Style (with its conditional Showcase
// theme picker, which is part of the style choice), UI Theme, Card Layout and
// Zoom. Everything else lives under the collapsible Advanced section, grouped
// by what it affects. This is a re-tiering ONLY: every key defined above is
// still rendered somewhere and still written by handleSave.

const TOP_LEVEL_SELECT_KEY = 'SCOREBOARD_LAYOUT';

/** Every non-top-level pref, keyed for group lookup. */
const PREF_BY_KEY: Record<string, PrefDef> = Object.fromEntries(
  [...TOGGLE_PREFS, ...SELECT_PREFS, ...ADVANCED_NUMBER_PREFS, ...MOBILE_PREFS].map(d => [d.key, d]),
);

interface AdvancedGroup {
  id: 'cards' | 'rankings' | 'qr' | 'mobile';
  caption: string;
  keys: string[];
}

const ADVANCED_GROUPS: AdvancedGroup[] = [
  {
    id: 'cards',
    caption: 'Cards & header',
    keys: [
      'SCOREBOARD_HIDE_EMPTY',
      'SCOREBOARD_TITLE_HIDDEN',
      'SCOREBOARD_LOGO_ENABLED',
      'SCOREBOARD_CARD_BG_FILL',
      'SCOREBOARD_GAME_HEADER_ENABLED',
      'SCOREBOARD_SHOW_TIMER',
      'SCOREBOARD_GAME_TITLE_STYLE',
      'SCOREBOARD_MAX_SCORES',
      'SCOREBOARD_MIN_SCORES',
      'SCOREBOARD_CARD_SPACING',
      'SCOREBOARD_TITLE_FONT_SIZE',
    ],
  },
  {
    id: 'rankings',
    caption: 'Rankings',
    keys: [
      'SCOREBOARD_RANKINGS_POSITION',
      'SCOREBOARD_RANKINGS_STYLE',
      'SCOREBOARD_RANKINGS_STICKY',
    ],
  },
  {
    id: 'qr',
    // Style-system revamp P0 (item 11) — QR controls are inert on phones
    // (<=640px by design, v2.104.0); one caption instead of scattered.
    caption: 'QR codes — never show on phones',
    keys: [
      'SCOREBOARD_QR_MODE',
      'SCOREBOARD_QR_POSITION',
      'SCOREBOARD_QR_SIZE',
      'SCOREBOARD_QR_OFFSET_PX',
    ],
  },
  {
    id: 'mobile',
    caption: 'Mobile',
    keys: MOBILE_PREFS.map(d => d.key),
  },
];

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
  roomScoped = true,
  roomId,
  roomName,
}: ScoreboardPreferencesModalProps) {
  const [prefs, setPrefs] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [confirmResetAll, setConfirmResetAll] = useState(false);
  const { appearance, personalTheme, setPersonalTheme, roomThemeOverride, setRoomThemeOverride } = useTheme();
  const [device, setDevice] = useState<DeviceType>(window.innerWidth <= 640 ? 'mobile' : 'desktop');

  useEffect(() => {
    if (!open || !playerToken) return;
    // Off-room there is no "This room" section to fill, and posting from an
    // unloaded state would clear the stored overrides — so don't fetch and
    // don't offer Save (see `roomScoped` on the props).
    if (!roomScoped) { setPrefs({}); setLoaded(true); return; }
    setLoaded(false);
    setConfirmResetAll(false);
    fetch(`/api/me/scoreboard-preferences?device=${device}`, {
      headers: { Authorization: `Bearer ${playerToken}` },
    })
      .then(r => (r.ok ? r.json() : {}))
      .then((data: Record<string, string> | null) => {
        setPrefs(data || {});
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  }, [open, playerToken, device, roomScoped]);

  /**
   * v2.132.0 — the per-room theme is NOT a scoreboard pref any more: it is
   * keyed by room id in `scoreboard_prefs.roomThemes`, so it saves itself the
   * moment it changes (like Appearance and My theme) rather than riding the
   * Save button's per-device payload. `setRoomThemeOverride` repaints
   * immediately; the PUT is best-effort on top.
   */
  const handleRoomThemeChange = (next: ThemeId | null) => {
    setRoomThemeOverride(next);
    if (roomId) void saveRoomTheme(roomId, next);
  };

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

  /**
   * `source` exists for Reset All: React state updates are not synchronous, so
   * a reset that called `setPrefs({})` and then this would save the PREVIOUS
   * prefs. The empty object is passed straight in instead.
   */
  const handleSave = async (source: Record<string, string> = prefs) => {
    setSaving(true);
    try {
      // Build the payload: explicitly set keys with values, clear removed keys by sending null
      const payload: Record<string, string | null> = {};

      // v2.132.0 — `UI_THEME` is posted as null unconditionally and is never
      // read back. It is the retired per-device room-theme key: the override
      // now lives in `scoreboard_prefs.roomThemes[roomId]` and saves itself
      // on change. Posting null keeps sweeping the legacy key out of the
      // per-device blob for anyone the server-side lift hasn't reached.
      payload['UI_THEME'] = null;
      // Style + theme
      payload['SCOREBOARD_STYLE'] = source['SCOREBOARD_STYLE'] ?? null;
      payload['SCOREBOARD_THEME'] = source['SCOREBOARD_THEME'] ?? null;

      // All toggle prefs
      for (const { key } of TOGGLE_PREFS) {
        payload[key] = source[key] ?? null;
      }
      // All select prefs
      for (const { key } of SELECT_PREFS) {
        payload[key] = source[key] ?? null;
      }
      // Advanced number prefs
      for (const { key } of ADVANCED_NUMBER_PREFS) {
        payload[key] = source[key] ?? null;
      }
      // Mobile prefs
      for (const { key } of MOBILE_PREFS) {
        payload[key] = source[key] ?? null;
      }
      // Zoom
      payload[ZOOM_PREF.key] = source[ZOOM_PREF.key] ?? null;

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

  /**
   * Owner ask, 2026-08-19 — one action that hands the whole view back to the
   * room's defaults. It has to go through `handleSave`, which enumerates EVERY
   * key and posts the unset ones as null: the backend deletes keys posted as
   * null and leaves absent keys alone, so posting a bare `{}` would clear
   * nothing at all.
   */
  const handleResetAll = async () => {
    setConfirmResetAll(false);
    setPrefs({});
    // v2.132.0 — the per-room theme saves itself, so it is not in the payload
    // `handleSave` builds. "Go back to the room's defaults" plainly includes
    // the theme, so clear it here too.
    handleRoomThemeChange(null);
    await handleSave({});
  };

  if (!open) return null;

  const getEffective = (key: string) => prefs[key] ?? roomConfig[key] ?? '';
  const hasOverride = (key: string) => key in prefs && prefs[key] !== undefined;

  const currentStyle = (getEffective('SCOREBOARD_STYLE') || 'banner') as ScoreboardStyle;
  const rankingsIsTicker = getEffective('SCOREBOARD_RANKINGS_STYLE') === 'ticker';

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
    // Default-ON keys read `!== 'false'`; everything else reads `=== 'true'`.
    // These MUST match `deriveScoreboardConfig` — when they drift, the modal
    // shows a switch in the opposite position to the behaviour the viewer is
    // actually getting. SCOREBOARD_MOBILE_VERTICAL was exactly that bug
    // (owner report, 2026-08-15): the renderer has always defaulted it on,
    // while this modal drew it off until a viewer toggled it twice.
    const stored = TOGGLE_DEFAULT_ON.has(def.key) ? val !== 'false' : val === 'true';
    const isOn = def.invert ? !stored : stored;
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
          onClick={() => handleChange(def.key, def.invert ? (isOn ? 'true' : 'false') : (isOn ? 'false' : 'true'))}
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

  const renderPref = (def: PrefDef) => {
    if (def.type === 'toggle') return renderToggle(def);
    if (def.type === 'select') return renderSelect(def);
    return renderNumber(def);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-surface border border-border rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}
      >
        {/* Header with device toggle */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-lg font-display font-bold text-primary">Display settings</h2>
          <div className="flex items-center gap-2">
            {/* Device toggle — scoreboard prefs are stored per device, so it
                only means anything while the "This room" section is shown. */}
            <div className={`flex items-center bg-raised border border-border rounded-lg p-0.5 ${roomScoped ? '' : 'hidden'}`}>
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
            {/* ══ 1. Appearance (v2.130.0) ═══════════════════════════════
                Site-wide, NOT a scoreboard override: it lives in the viewer's
                own preferences (localStorage + /me/preferences), so it is
                saved the instant it is clicked and is untouched by Save /
                Reset All below. First because it outranks every setting under
                it — both theme pickers included. */}
            <section className="pb-3 border-b border-border mb-3">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">Appearance</h3>
              <AppearanceControl />
              <p className="text-xs text-muted mt-2">
                Applies everywhere on Arcaid, on this and every other page. Auto follows each room's theme
                and your device setting on global pages.
              </p>
            </section>

            {/* ══ 2. My theme (v2.132.0) ═════════════════════════════════
                The personal theme — one picker for every game room AND the
                admin pages, replacing the old "Admin Theme" field that lived
                (misfiled) in room settings. Saved instantly through
                `setPersonalTheme`, like Appearance above; the Save button
                below belongs to the scoreboard prefs only. */}
            <section className="pb-3 border-b border-border mb-3">
              <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">My theme</h3>
              <ThemePicker
                value={personalTheme}
                onChange={setPersonalTheme}
                nullLabel="Use each room's default"
                aria-label="My theme"
                data-testid="personal-theme-picker"
                className={selectClass}
              />
              <p className="text-xs text-muted mt-2">
                Applies to every game room and your admin pages. Appearance (above) still wins on
                light/dark.
              </p>
            </section>

            {/* ══ 3. This room ═══════════════════════════════════════════
                Everything below is a per-device override of THIS room's
                scoreboard defaults, saved together by the Save button. */}
            {roomScoped && (
            <section>
            <h3 className="text-xs font-semibold text-muted uppercase tracking-wider mb-2">This room</h3>
            <div className="flex items-start justify-between gap-3 mb-3">
              {/* The section now mixes scopes: the theme is per ROOM (every
                  device), everything under it is per room AND per device.
                  Say so here rather than letting the old "for your {device}
                  view" line imply the theme is a device setting too. */}
              <p className="text-xs text-muted">
                Your own settings for {roomName ?? 'this room'}. The theme applies on every device; the
                scoreboard settings below are for {device}, and reset to the room admin's default.
              </p>
              {!confirmResetAll && (
                <button
                  onClick={() => setConfirmResetAll(true)}
                  className="shrink-0 text-xs text-muted hover:text-neon-cyan flex items-center gap-1 cursor-pointer"
                  title={`Clear every ${device} preference override`}
                >
                  <RotateCcw size={12} /> Reset All
                </button>
              )}
            </div>
            {confirmResetAll && (
              <div className="mb-3 rounded border border-border bg-raised px-3 py-2 flex items-center justify-between gap-3">
                <span className="text-xs text-muted">
                  Clear every {device} preference and go back to the room's defaults?
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setConfirmResetAll(false)}
                    className="text-xs text-muted hover:text-primary cursor-pointer"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleResetAll}
                    disabled={saving}
                    className="text-xs font-medium text-neon-cyan hover:brightness-110 disabled:opacity-50 cursor-pointer"
                  >
                    Reset everything
                  </button>
                </div>
              </div>
            )}

            {/* ── Theme for this room only (v2.132.0: was "UI Theme") ──
                First in the section, and one of the three theme controls that
                save the instant they change — it is stored per ROOM, not in
                the per-device payload the Save button posts. */}
            <div className="py-2">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-medium text-primary">Theme for this room only</span>
              </div>
              <ThemePicker
                value={roomThemeOverride}
                onChange={handleRoomThemeChange}
                nullLabel={personalTheme ? 'Use my theme' : 'Use the room default'}
                aria-label="Theme for this room only"
                data-testid="room-theme-picker"
                className={selectClass}
              />
              <p className="text-xs text-muted mt-1">
                Applies in {roomName ?? 'this room'} only, on every device. Beats “My theme” above
                while you are here.
                {appearance !== 'auto' && (
                  <> Appearance is set to {appearance === 'light' ? 'Light' : 'Dark'}, so a theme only
                  shows while Appearance is Auto.</>
                )}
              </p>
            </div>

            {/* ── Card Style ───────────────────────────────────────── */}
            <div className="py-2 border-t border-border mt-2 pt-3">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-primary">Card Style</span>
                <ResetBtn k="SCOREBOARD_STYLE" />
              </div>
              <div className="grid grid-cols-2 gap-2">
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

            {/* ── Card Layout ──────────────────────────────────────── */}
            <div className="border-t border-border pt-2 mt-2">
              {renderSelect(PREF_BY_KEY[TOP_LEVEL_SELECT_KEY])}
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
                  {ADVANCED_GROUPS.map((group, i) => (
                    <div key={group.id}>
                      <div className={i === 0 ? 'pt-1' : 'border-t border-border/50 pt-2 mt-2'}>
                        <span className="text-xs text-muted uppercase tracking-wider">{group.caption}</span>
                      </div>
                      {group.keys
                        // Ticker pins itself to the top of the scoreboard, so
                        // the position select has nothing to act on.
                        .filter(k => !(k === 'SCOREBOARD_RANKINGS_POSITION' && rankingsIsTicker))
                        .map(k => renderPref(PREF_BY_KEY[k]))}
                      {group.id === 'rankings' && rankingsIsTicker && (
                        <p className="text-[10px] text-faint py-1">Ticker pins to the top — position doesn't apply</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            </section>
            )}

            {!roomScoped && (
              <p className="text-xs text-faint">
                Open a game room to change its scoreboard layout, card style and per-room theme.
              </p>
            )}
          </div>
        )}

        {/* Footer. Appearance and My theme save themselves the moment they are
            clicked, so off-room there is nothing for a Save button to do —
            and pressing one would clear the scoreboard prefs (see
            `roomScoped`). Close is then the only action. */}
        <div className="px-5 py-4 border-t border-border flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-muted hover:text-primary rounded border border-border cursor-pointer"
          >
            {roomScoped ? 'Cancel' : 'Close'}
          </button>
          {roomScoped && (
            <button
              onClick={() => handleSave()}
              disabled={saving}
              className="px-4 py-2 text-sm bg-neon-cyan text-deep font-medium rounded hover:bg-neon-cyan/80 disabled:opacity-50 cursor-pointer"
            >
              {saving ? 'Saving...' : 'Save Preferences'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
