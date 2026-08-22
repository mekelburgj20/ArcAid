import { THEMES, type ThemeId } from './ThemeProvider';

/**
 * The one theme `<select>` (v2.132.0).
 *
 * Before this release the same control was hand-rolled in four places — room
 * Settings (twice: "Public Theme" + "Admin Theme"), GlobalSettings, and the
 * viewer prefs sheet — and they had already drifted: two rendered
 * `label — description`, one rendered the bare label, and only one of them
 * offered a null option. Every mount now renders the same `THEMES` list in
 * the same order with the same copy.
 *
 * `nullLabel` opts a mount into a leading "no choice" option (value `''`).
 * The personal picker uses it for "Use each room's default"; the room-default
 * picker does not, because a room ALWAYS resolves to some theme.
 */
export interface ThemePickerProps {
  /** Current selection; `null` selects the `nullLabel` option. */
  value: ThemeId | null;
  onChange: (theme: ThemeId | null) => void;
  /** When set, a first option with this label maps to `null`. */
  nullLabel?: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
  'data-testid'?: string;
}

const DEFAULT_CLASS =
  'w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors';

export default function ThemePicker({
  value,
  onChange,
  nullLabel,
  id,
  className,
  'aria-label': ariaLabel,
  'data-testid': testId,
}: ThemePickerProps) {
  return (
    <select
      id={id}
      aria-label={ariaLabel}
      data-testid={testId}
      value={value ?? ''}
      onChange={e => onChange((e.target.value || null) as ThemeId | null)}
      className={className ?? DEFAULT_CLASS}
    >
      {nullLabel !== undefined && <option value="">{nullLabel}</option>}
      {Object.entries(THEMES).map(([themeId, { label, description }]) => (
        <option key={themeId} value={themeId}>{label} — {description}</option>
      ))}
    </select>
  );
}
