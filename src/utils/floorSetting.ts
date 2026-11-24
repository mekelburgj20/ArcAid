/**
 * The carpet floor switch (G29, v2.264.0).
 *
 * An optional faint arcade-carpet pattern behind a themed page, drawn in the
 * theme's own colours by the front end (`admin-ui/src/components/ThemeFloor.tsx`).
 * Two stored choices decide whether it shows:
 *
 *   - the room's: `game_room_settings.UI_FLOOR`, `'on'` or `'off'`. Absent
 *     means on, so every existing room gets the floor without a migration.
 *   - the viewer's: `user_preferences.ui_floor`, `'on'`, `'off'` or NULL.
 *     NULL means the viewer has not chosen, so the room's choice applies.
 *
 * The front end resolves them (the viewer's choice, else the room's, else on);
 * the server only stores and ships them. These two readers are the only way a
 * stored value is read, so a junk value can never reach the page.
 */

export const UI_FLOOR_KEY = 'UI_FLOOR';

export const FLOOR_CHOICES = ['on', 'off'] as const;

export type FloorChoice = typeof FLOOR_CHOICES[number];

export function isFloorChoice(value: unknown): value is FloorChoice {
    return value === 'on' || value === 'off';
}

/** A room's stored `UI_FLOOR`: only an explicit `'off'` turns the floor off. */
export function roomFloorSetting(raw: unknown): FloorChoice {
    return raw === 'off' ? 'off' : 'on';
}

/** A viewer's stored `ui_floor`: `'on'` or `'off'`, anything else means "no choice". */
export function viewerFloorChoice(raw: unknown): FloorChoice | null {
    return isFloorChoice(raw) ? raw : null;
}
