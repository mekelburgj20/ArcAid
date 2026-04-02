import { Layout, Grid3X3, Maximize2, Circle, Columns2 } from 'lucide-react';

export interface PresetDefinition {
  key: string;
  label: string;
  description: string;
  icon: typeof Layout;
  settings: Record<string, string>;
}

export const PRESET_DEFINITIONS: PresetDefinition[] = [
  {
    key: 'classic',
    label: 'Classic',
    description: 'Banner header, medium cards',
    icon: Layout,
    settings: {
      SCOREBOARD_CARD_LAYOUT: 'banner',
      SCOREBOARD_BG_FILL: 'off',
      SCOREBOARD_BG_SIZE: 'cover',
      SCOREBOARD_SCORE_COLUMNS: '1',
      SCOREBOARD_CARD_SIZE: 'medium',
      SCOREBOARD_WHEEL_SCALE: '150',
    },
  },
  {
    key: 'compact',
    label: 'Compact',
    description: 'Small cards, thumbnail icons',
    icon: Grid3X3,
    settings: {
      SCOREBOARD_CARD_LAYOUT: 'compact',
      SCOREBOARD_BG_FILL: 'off',
      SCOREBOARD_BG_SIZE: 'cover',
      SCOREBOARD_SCORE_COLUMNS: '1',
      SCOREBOARD_CARD_SIZE: 'small',
      SCOREBOARD_WHEEL_SCALE: '150',
    },
  },
  {
    key: 'showcase',
    label: 'Showcase',
    description: 'Large cards, full background fill',
    icon: Maximize2,
    settings: {
      SCOREBOARD_CARD_LAYOUT: 'banner',
      SCOREBOARD_BG_FILL: 'fill',
      SCOREBOARD_BG_SIZE: 'cover',
      SCOREBOARD_SCORE_COLUMNS: '1',
      SCOREBOARD_CARD_SIZE: 'large',
      SCOREBOARD_WHEEL_SCALE: '150',
    },
  },
  {
    key: 'wheel',
    label: 'Arcade Wheel',
    description: 'Wheel icon above card border',
    icon: Circle,
    settings: {
      SCOREBOARD_CARD_LAYOUT: 'wheel',
      SCOREBOARD_BG_FILL: 'off',
      SCOREBOARD_BG_SIZE: 'cover',
      SCOREBOARD_SCORE_COLUMNS: '1',
      SCOREBOARD_CARD_SIZE: 'medium',
      SCOREBOARD_WHEEL_SCALE: '150',
    },
  },
  {
    key: 'tournament',
    label: 'Tournament',
    description: 'Sidebar layout, dual score columns',
    icon: Columns2,
    settings: {
      SCOREBOARD_CARD_LAYOUT: 'sidebar',
      SCOREBOARD_BG_FILL: 'fill',
      SCOREBOARD_BG_SIZE: 'cover',
      SCOREBOARD_SCORE_COLUMNS: '2',
      SCOREBOARD_CARD_SIZE: 'large',
      SCOREBOARD_WHEEL_SCALE: '150',
    },
  },
];

/** Determine which preset matches the current settings, or 'custom' */
export function computeActivePreset(settings: Record<string, string>): string {
  for (const preset of PRESET_DEFINITIONS) {
    const matches = Object.entries(preset.settings).every(
      ([key, value]) => (settings[key] || getDefault(key)) === value
    );
    if (matches) return preset.key;
  }
  return 'custom';
}

function getDefault(key: string): string {
  const defaults: Record<string, string> = {
    SCOREBOARD_CARD_LAYOUT: 'banner',
    SCOREBOARD_BG_FILL: 'off',
    SCOREBOARD_BG_SIZE: 'cover',
    SCOREBOARD_SCORE_COLUMNS: '1',
    SCOREBOARD_CARD_SIZE: 'medium',
    SCOREBOARD_WHEEL_SCALE: '150',
  };
  return defaults[key] || '';
}

interface PresetSelectorProps {
  settings: Record<string, string>;
  onPresetSelect: (preset: PresetDefinition) => void;
}

export default function PresetSelector({ settings, onPresetSelect }: PresetSelectorProps) {
  const activePreset = computeActivePreset(settings);

  return (
    <div>
      <label className="text-xs text-muted block mb-2">Layout Preset</label>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PRESET_DEFINITIONS.map(preset => {
          const isActive = activePreset === preset.key;
          const Icon = preset.icon;
          return (
            <button
              key={preset.key}
              onClick={() => onPresetSelect(preset)}
              className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border-2 transition-all cursor-pointer ${
                isActive
                  ? 'border-neon-cyan bg-neon-cyan/10 text-neon-cyan'
                  : 'border-border bg-raised text-muted hover:border-neon-cyan/30 hover:text-primary'
              }`}
            >
              <Icon size={20} />
              <span className="text-xs font-bold font-display">{preset.label}</span>
              <span className="text-[10px] text-center leading-tight opacity-70">{preset.description}</span>
            </button>
          );
        })}
        {/* Custom indicator */}
        {activePreset === 'custom' && (
          <div className="flex flex-col items-center justify-center gap-1.5 p-3 rounded-lg border-2 border-neon-amber/50 bg-neon-amber/5">
            <span className="text-xs font-bold font-display text-neon-amber">Custom</span>
            <span className="text-[10px] text-center leading-tight text-neon-amber/70">Modified settings</span>
          </div>
        )}
      </div>
    </div>
  );
}
