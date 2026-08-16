import { Layout, Sparkles, Type, Joystick, ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import type { ScoreboardStyle } from '../../lib/scoreboardThemes';
import { SHOWCASE_THEMES, DEFAULT_SHOWCASE_THEME } from '../../lib/scoreboardThemes';
import { LOOK_DEFINITIONS, computeActiveLook } from '../../lib/scoreboardLooks';

const STYLE_ICONS: Record<ScoreboardStyle, typeof Layout> = {
  arcade: Joystick,
  banner: Layout,
  showcase: Sparkles,
  minimal: Type,
};

interface StyleThemePickerProps {
  settings: Record<string, string>;
  onChange: (key: string, value: string) => void;
}

export default function StyleThemePicker({ settings, onChange }: StyleThemePickerProps) {
  // Style-system revamp P0 (honesty fix): an unset SCOREBOARD_STYLE means this
  // room is still on the legacy GameCard render path (see ScoreboardSurface's
  // `useNewCards = !!config.SCOREBOARD_STYLE`) — falling back to 'banner' here
  // for display purposes previously made the Banner tile look active/selected
  // when nothing had actually been chosen. Only pre-existing rooms (created
  // before the P0 create-room seed fix) can hit this state now.
  const styleIsUnset = !settings.SCOREBOARD_STYLE;
  const currentStyle = (settings.SCOREBOARD_STYLE || 'banner') as ScoreboardStyle;
  const currentTheme = settings.SCOREBOARD_THEME || DEFAULT_SHOWCASE_THEME;
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const rankingsIsTicker = settings.SCOREBOARD_RANKINGS_STYLE === 'ticker';
  const activeLook = computeActiveLook(settings);

  /**
   * Style-system revamp P1 — picking a Look applies its WHOLE bundle, not just
   * `SCOREBOARD_STYLE`. Previously a style switch left card height, spacing
   * and layout on whatever the last look wanted, so the new family rendered
   * half-dressed — most visibly `SCOREBOARD_MIN_SCORES`, whose default of 20
   * makes every card reserve twenty rows of height regardless of how few
   * scores it shows. See lib/scoreboardLooks.ts for what a bundle covers and,
   * more importantly, what it deliberately leaves alone.
   */
  const handleLookSelect = (id: ScoreboardStyle) => {
    const look = LOOK_DEFINITIONS.find(l => l.id === id);
    if (!look) return;
    for (const [key, value] of Object.entries(look.settings)) {
      onChange(key, value);
    }
  };

  const handleThemeSelect = (themeId: string) => {
    onChange('SCOREBOARD_THEME', themeId);
  };

  return (
    <div className="space-y-4">
      {styleIsUnset && (
        <div className="px-3 py-2 rounded border border-neon-amber/30 bg-neon-amber/10 text-xs text-neon-amber">
          This room is on the legacy card system — pick a card style to switch to the current one.
        </div>
      )}

      {/* Looks — one click applies a complete, coherent scoreboard */}
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <label className="text-xs text-muted">Look</label>
          {activeLook === 'custom' && (
            <span className="flex items-center gap-1 text-[10px] font-display uppercase tracking-wider text-neon-amber">
              <SlidersHorizontal size={11} />
              Customised
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {LOOK_DEFINITIONS.map(look => {
            // Highlight tracks the room's card family, exactly as it did
            // before Looks existed. Hand-tuning is reported by the
            // "Customised" chip above, NOT by dimming the tile — a room that
            // changed one number is still on that Look.
            const isActive = !styleIsUnset && currentStyle === look.id;
            const Icon = STYLE_ICONS[look.id];
            return (
              <button
                key={look.id}
                onClick={() => handleLookSelect(look.id)}
                aria-pressed={isActive}
                className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-all cursor-pointer ${
                  isActive
                    ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                    : 'border-border bg-raised text-muted hover:border-neon-cyan/30 hover:text-primary'
                }`}
              >
                <Icon size={20} />
                <span className="text-xs font-bold font-display">{look.label}</span>
                <span className="text-[10px] text-center leading-tight opacity-70">{look.description}</span>
              </button>
            );
          })}
        </div>
        {activeLook === 'custom' && (
          <p className="mt-1.5 text-[10px] text-faint">
            You've tuned settings away from the stock {LOOK_DEFINITIONS.find(l => l.id === currentStyle)?.label ?? 'chosen'} look.
            Clicking a Look resets its card height, spacing and layout — your title styles, QR and mobile settings are left alone.
          </p>
        )}
      </div>

      {/* Theme selector — only for showcase */}
      {currentStyle === 'showcase' && (
        <div>
          <label className="text-xs text-muted block mb-2">Theme</label>
          <div className="grid grid-cols-2 gap-2">
            {Object.values(SHOWCASE_THEMES).map(theme => {
              const isActive = currentTheme === theme.id;
              return (
                <button
                  key={theme.id}
                  onClick={() => handleThemeSelect(theme.id)}
                  className={`flex flex-col items-start gap-1 p-3 rounded-lg border-2 transition-all cursor-pointer text-left ${
                    isActive
                      ? 'border-neon-cyan bg-neon-cyan/10'
                      : 'border-border bg-raised hover:border-neon-cyan/30'
                  }`}
                >
                  {/* Mini preview swatch */}
                  <div
                    className="w-full h-8 rounded mb-1"
                    style={{
                      background: theme.cardBg,
                      border: theme.cardBorder,
                    }}
                  >
                    <div style={{ height: 2, background: theme.accentBar }} />
                  </div>
                  <span className={`text-xs font-bold font-display ${isActive ? 'text-neon-cyan' : 'text-primary'}`}>
                    {theme.name}
                  </span>
                  <span className="text-[10px] text-muted leading-tight">{theme.description}</span>
                </button>
              );
            })}
          </div>

          {/* Podium look — Holo Steps (owner redesign, 2026-08-13) is the
              default; Pyramid/Chip stay selectable rather than deleted. */}
          <div className="flex items-center gap-3 mt-3">
            <label className="w-48 shrink-0 text-sm text-muted">Podium</label>
            <select
              value={settings.SCOREBOARD_PODIUM_VARIANT || 'holo-steps'}
              onChange={e => onChange('SCOREBOARD_PODIUM_VARIANT', e.target.value)}
              className="flex-1 px-3 py-1.5 bg-raised text-primary border border-border rounded text-sm"
            >
              <option value="holo-steps">Holo Steps (default)</option>
              <option value="pyramid">Pyramid (classic)</option>
              <option value="chip">Chip (classic)</option>
            </select>
          </div>
        </div>
      )}

      {/* Advanced toggle */}
      <button
        onClick={() => setAdvancedOpen(!advancedOpen)}
        className="flex items-center gap-2 mt-2 text-sm text-muted hover:text-primary cursor-pointer bg-transparent border-none"
      >
        {advancedOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        <span className="font-display text-xs uppercase tracking-wider">Display options</span>
      </button>

      {advancedOpen && (
        <div className="space-y-3 pt-2 border-t border-border/30">
          {/* Max scores per card */}
          <div className="flex items-center gap-3">
            <label className="w-48 shrink-0 text-sm text-muted">Scores per card</label>
            <select
              value={settings.SCOREBOARD_MAX_SCORES || '5'}
              onChange={e => onChange('SCOREBOARD_MAX_SCORES', e.target.value)}
              className="flex-1 px-3 py-1.5 bg-raised text-primary border border-border rounded text-sm"
            >
              {[5, 10, 15, 20].map(n => (
                <option key={n} value={String(n)}>{n}</option>
              ))}
            </select>
          </div>

          {/* Show timer */}
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium text-primary">Show countdown timer</p>
              <p className="text-xs text-muted">Display time remaining until next rotation</p>
            </div>
            <button
              onClick={() => onChange('SCOREBOARD_SHOW_TIMER', settings.SCOREBOARD_SHOW_TIMER === 'false' ? 'true' : 'false')}
              className={`relative w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
                settings.SCOREBOARD_SHOW_TIMER !== 'false' ? 'bg-neon-cyan' : 'bg-raised border border-border'
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${
                settings.SCOREBOARD_SHOW_TIMER !== 'false' ? 'translate-x-6' : ''
              }`} />
            </button>
          </div>

          {/* Layout (grid/scroll/vertical) */}
          <div className="flex items-center gap-3">
            <label className="w-48 shrink-0 text-sm text-muted">Card layout</label>
            <select
              value={settings.SCOREBOARD_LAYOUT || (currentStyle === 'showcase' || currentStyle === 'minimal' ? 'vertical' : 'scroll')}
              onChange={e => onChange('SCOREBOARD_LAYOUT', e.target.value)}
              className="flex-1 px-3 py-1.5 bg-raised text-primary border border-border rounded text-sm"
            >
              <option value="scroll">Horizontal scroll</option>
              <option value="vertical">Vertical scroll</option>
              <option value="grid">Grid</option>
            </select>
          </div>

          {/* QR codes — grouped: QR never shows on phones (inert <=640px by design, v2.104.0) */}
          <div>
            <p className="text-[10px] text-faint uppercase tracking-wider mb-1">QR codes — never show on phones</p>
            <div className="flex items-center gap-3">
              <label className="w-48 shrink-0 text-sm text-muted">QR codes</label>
              <select
                value={settings.SCOREBOARD_QR_MODE || 'disabled'}
                onChange={e => onChange('SCOREBOARD_QR_MODE', e.target.value)}
                className="flex-1 px-3 py-1.5 bg-raised text-primary border border-border rounded text-sm"
              >
                <option value="disabled">Disabled</option>
                <option value="kiosk-only">Kiosk only</option>
                <option value="all">All scoreboards</option>
              </select>
            </div>
          </div>

          {/* Rankings position — inert when rankings style is 'ticker' (pins to top) */}
          {!rankingsIsTicker && (
            <div className="flex items-center gap-3">
              <label className="w-48 shrink-0 text-sm text-muted">Rankings position</label>
              <select
                value={settings.SCOREBOARD_RANKINGS_POSITION || 'left'}
                onChange={e => onChange('SCOREBOARD_RANKINGS_POSITION', e.target.value)}
                className="flex-1 px-3 py-1.5 bg-raised text-primary border border-border rounded text-sm"
              >
                <option value="left">Left sidebar</option>
                <option value="right">Right sidebar</option>
                <option value="top">Above cards</option>
                <option value="bottom">Below cards</option>
              </select>
            </div>
          )}
          {rankingsIsTicker && (
            <p className="text-[10px] text-faint">Ticker pins to the top — position doesn't apply</p>
          )}

          {/* Zoom */}
          <div className="flex items-center gap-3">
            <label className="w-48 shrink-0 text-sm text-muted">Zoom</label>
            <div className="flex items-center gap-2 flex-1">
              <input
                type="range" min="50" max="150" step="10"
                value={parseInt(settings.SCOREBOARD_ZOOM || '100', 10)}
                onChange={e => onChange('SCOREBOARD_ZOOM', e.target.value)}
                className="flex-1 accent-neon-cyan cursor-pointer"
              />
              <span className="text-sm text-muted w-12 text-right">
                {parseInt(settings.SCOREBOARD_ZOOM || '100', 10)}%
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
