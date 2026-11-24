/**
 * The "Carpet floor" switch (G29, v2.264.0): one control for both places the
 * floor is chosen.
 *
 *   - scope `room`: under the room default theme in Room Settings. The room's
 *     choice for its visitors (`UI_FLOOR`).
 *   - scope `viewer`: under the personal theme picker (Display settings,
 *     Account Settings, Global Settings). The viewer's own choice, which wins
 *     for them. `MyFloorToggle` wires it to `ThemeProvider`: it shows the
 *     floor's effective state and writes an explicit on or off when flipped.
 *
 * Each page keeps the switch it already uses for its other on/off settings,
 * so `look` picks that page's control: `settings` is the room Settings pill
 * (also used on Global Settings, whose own on/off settings are selects),
 * `sheet` the Display settings sheet's, and `account` the Arcaid-look switch
 * of Account Settings' notification list. The whole row is the label, so a
 * tap anywhere on it flips the switch; the button is a keyboard-operable
 * `role="switch"` named "Carpet floor".
 */
import { useId } from 'react';
import { useTheme } from './ThemeProvider';

export type FloorToggleLook = 'settings' | 'sheet' | 'account';

const ROOM_HELP = "A faint arcade-carpet pattern behind this room's pages, in the theme's colours. Visitors can turn it off for themselves.";
const VIEWER_HELP = "A faint arcade-carpet pattern behind the page, in the theme's colours.";
const HIGH_CONTRAST_HELP = 'High contrast never shows it.';

interface LookClasses {
  row: string;
  text: string;
  label: string;
  help: string;
  track: (on: boolean) => string;
  knob: (on: boolean) => string;
  knobStyle?: React.CSSProperties;
}

const LOOKS: Record<FloorToggleLook, LookClasses> = {
  // pages/Settings.tsx, the Integrations toggles.
  settings: {
    row: 'flex items-center justify-between gap-4 cursor-pointer',
    text: 'min-w-0',
    label: 'block text-sm font-medium text-primary',
    help: 'block text-xs text-muted',
    track: on => `relative shrink-0 w-12 h-6 rounded-full transition-colors cursor-pointer border-none ${
      on ? 'bg-neon-cyan' : 'bg-raised border border-border'
    }`,
    knob: on => `absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-primary transition-transform ${on ? 'translate-x-6' : ''}`,
  },
  // components/ScoreboardPreferencesModal.tsx, `renderToggle`.
  sheet: {
    row: 'flex items-center justify-between py-2 cursor-pointer',
    text: 'flex-1 mr-4',
    label: 'block text-sm font-medium text-primary',
    help: 'block text-xs text-muted mt-0.5',
    track: on => `relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer shrink-0 ${
      on ? 'bg-neon-cyan' : 'bg-raised border border-border'
    }`,
    knob: on => `inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${on ? 'translate-x-6' : 'translate-x-1'}`,
  },
  // pages/AccountSettings.tsx, the notification switches (the island maps
  // these site tokens onto the kit's colours).
  account: {
    row: 'flex items-start justify-between gap-3 py-2.5 cursor-pointer',
    text: 'min-w-0',
    label: 'block text-sm text-primary',
    help: 'block text-xs text-faint',
    track: on => `shrink-0 mt-0.5 w-9 h-5 rounded-full border transition-colors ${
      on ? 'bg-neon-cyan/30 border-neon-cyan/50' : 'bg-surface border-border'
    }`,
    knob: on => `block w-4 h-4 rounded-full bg-primary transition-transform ${on ? 'translate-x-4' : 'translate-x-0.5'}`,
    knobStyle: { marginTop: '1px' },
  },
};

export interface FloorToggleProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  scope: 'room' | 'viewer';
  look: FloorToggleLook;
  /** Viewer scope only: the applied theme is High contrast, so the floor never shows. */
  highContrast?: boolean;
  className?: string;
}

export function FloorToggle({ checked, onChange, scope, look, highContrast = false, className = '' }: FloorToggleProps) {
  const id = useId();
  const labelId = `${id}-label`;
  const helpId = `${id}-help`;
  const classes = LOOKS[look];
  const help = scope === 'room'
    ? ROOM_HELP
    : highContrast ? `${VIEWER_HELP} ${HIGH_CONTRAST_HELP}` : VIEWER_HELP;

  return (
    <label className={`${classes.row} ${className}`.trim()} data-testid={`floor-toggle-${scope}`}>
      <span className={classes.text}>
        <span id={labelId} className={classes.label}>Carpet floor</span>
        <span id={helpId} className={classes.help}>{help}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={helpId}
        onClick={() => onChange(!checked)}
        className={classes.track(checked)}
      >
        <span className={classes.knob(checked)} style={classes.knobStyle} />
      </button>
    </label>
  );
}

/**
 * The viewer's switch, wired to `ThemeProvider`: it shows whether the floor
 * is on here (their choice, else the room's on its pages, else on) and
 * records an explicit on or off, saved like their theme and appearance.
 */
export function MyFloorToggle({ look, className }: { look: FloorToggleLook; className?: string }) {
  const { floor, theme, setFloorChoice } = useTheme();
  return (
    <FloorToggle
      scope="viewer"
      look={look}
      checked={floor}
      highContrast={theme === 'contrast'}
      onChange={next => setFloorChoice(next ? 'on' : 'off')}
      className={className}
    />
  );
}
