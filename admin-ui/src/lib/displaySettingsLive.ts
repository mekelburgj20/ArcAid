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

/**
 * G34c - a signed-out visitor's card settings live in this browser, one JSON
 * object per device set under `arcaid-scoreboard-prefs-<device>` (the same
 * keys a signed-in viewer's set holds; an unset key is absent). Blocked or
 * private storage never throws out of here: a read gives nothing, a write
 * reports false and the change applies for the session only.
 */
export const GUEST_PREFS_KEY_PREFIX = 'arcaid-scoreboard-prefs-';

export function readGuestPrefs(device: DisplayPrefsDevice): Record<string, string> {
  try {
    const raw = localStorage.getItem(GUEST_PREFS_KEY_PREFIX + device);
    const data: unknown = raw ? JSON.parse(raw) : null;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function writeGuestPrefs(device: DisplayPrefsDevice, prefs: Record<string, string>): boolean {
  try {
    const key = GUEST_PREFS_KEY_PREFIX + device;
    if (Object.keys(prefs).length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}
