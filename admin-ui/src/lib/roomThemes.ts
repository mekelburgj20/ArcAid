import type { ThemeId } from './themeIds';

/**
 * Client for the per-room "Theme for this room only" overrides (v2.132.0).
 *
 * These are keyed by ROOM ID and are NOT per device — they used to be a
 * `UI_THEME` key inside the per-device scoreboard prefs, i.e. one setting
 * labelled "this room" that actually applied to every room on one device.
 * The server lifts that legacy value onto the current room the first time
 * `GET /me/room-themes?roomId=…` is called for it; nothing here has to.
 *
 * Raw `fetch` with the player token rather than `lib/api.ts`, which only ever
 * sends the ADMIN token — the same reason `ThemeProvider` and the display
 * sheet talk to `/me/*` directly.
 */

const PLAYER_TOKEN_KEY = 'arcaid_player_token';

export type RoomThemeMap = Record<string, ThemeId>;

function playerToken(): string | null {
  try { return localStorage.getItem(PLAYER_TOKEN_KEY); } catch { return null; }
}

/**
 * Every room override this viewer has. `roomId` opts into the one-shot
 * legacy lift for that room. Returns null when there is nobody signed in or
 * the request fails — callers keep whatever localStorage told them.
 */
export async function fetchRoomThemes(roomId?: string): Promise<RoomThemeMap | null> {
  const token = playerToken();
  if (!token) return null;
  try {
    const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
    const res = await fetch(`/api/me/room-themes${query}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const body = await res.json() as { roomThemes?: RoomThemeMap };
    return body?.roomThemes ?? {};
  } catch {
    return null;
  }
}

/** Set (or, with `null`, clear) this viewer's override for one room. */
export async function saveRoomTheme(roomId: string, theme: ThemeId | null): Promise<boolean> {
  const token = playerToken();
  if (!token) return false;
  try {
    const res = await fetch(`/api/me/room-themes/${encodeURIComponent(roomId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ theme }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
