/**
 * G34a - the live link between the Display settings panel and the page.
 *
 * The panel (`components/displaySettings/`) keeps the viewer's card settings
 * for THIS device and saves them as they change. Every change also goes out at
 * once as a window event carrying the viewer's whole override map for that
 * device, and the room scoreboard (`pages/Scoreboard.tsx`) draws the room's
 * config with that map over it, so the board changes while the panel is open.
 * A key the viewer clears is absent from the map, so the board falls back to
 * the room's value for it.
 *
 * Main bundle, kept tiny: the scoreboard imports it, the panel is a chunk.
 */

/** The two stored sets of card settings (ADR 0001): one per kind of device. */
export type DisplayPrefsDevice = 'desktop' | 'mobile';

/** Which set this window reads and writes: the one rule, shared by the scoreboard and the panel. */
export function prefsDevice(): DisplayPrefsDevice {
  return window.innerWidth <= 640 ? 'mobile' : 'desktop';
}

/** A change in the panel, before or while it saves. */
export const DISPLAY_SETTINGS_LIVE_EVENT = 'display-settings-live';

/** The panel closed after saving: the scoreboard reads the stored settings again. */
export const DISPLAY_SETTINGS_SAVED_EVENT = 'display-settings-saved';

export interface DisplaySettingsLiveDetail {
  device: DisplayPrefsDevice;
  /** The viewer's whole override map for `device`; an unset key is absent. */
  prefs: Record<string, string>;
}

export function dispatchDisplaySettingsLive(detail: DisplaySettingsLiveDetail): void {
  window.dispatchEvent(new CustomEvent<DisplaySettingsLiveDetail>(DISPLAY_SETTINGS_LIVE_EVENT, { detail }));
}
