/**
 * The carpet floor switch (G29, v2.264.0): an optional faint arcade-carpet
 * pattern behind themed pages, in the theme's own colours
 * (`components/ThemeFloor.tsx`).
 *
 * Two stored choices, the same two the server keeps (`src/utils/floorSetting.ts`):
 *   - the room's `UI_FLOOR` setting, shipped as the portal's `ui_floor`;
 *     absent means on;
 *   - the viewer's `user_preferences.ui_floor`; null means "no choice".
 *
 * `ThemeProvider` resolves them with `resolveFloor` and mirrors both into
 * localStorage for the first paint. These readers are the only way a stored
 * value is read back, so junk never decides anything.
 */

export type FloorChoice = 'on' | 'off';

/** The room setting key (`game_room_settings`). */
export const UI_FLOOR_KEY = 'UI_FLOOR';

/** The viewer's choice, mirrored for the first paint. Absent = no choice. */
export const STORAGE_FLOOR_KEY = 'arcaid-floor';

/**
 * A room's setting, mirrored per slug for the first paint of its pages.
 * Lower-cased because public slugs match case-insensitively, and the admin
 * Settings page writes it under the room's canonical slug.
 */
export const floorPublicSlugKey = (slug: string) => `arcaid-floor-public-${slug.toLowerCase()}`;

/** A viewer value: `'on'` or `'off'`, anything else is no choice. */
export function readFloorChoice(raw: unknown): FloorChoice | null {
  return raw === 'on' || raw === 'off' ? raw : null;
}

/** A room value: only an explicit `'off'` turns the floor off. */
export function roomFloorChoice(raw: unknown): FloorChoice {
  return raw === 'off' ? 'off' : 'on';
}

/**
 * Whether the floor shows: the viewer's choice, else the room's (passed only
 * on that room's public pages), else on. High contrast hides it regardless;
 * that rule lives where it is drawn.
 */
export function resolveFloor(viewer: FloorChoice | null, room: FloorChoice | null): boolean {
  return (viewer ?? room ?? 'on') === 'on';
}
