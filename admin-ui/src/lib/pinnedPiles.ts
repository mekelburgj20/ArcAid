/**
 * v2.236.0 (B23) — which tournaments' "past games" piles this viewer keeps
 * pinned OPEN on room scoreboards (see `lib/historyPiles.ts`).
 *
 * Remembered for the USER: a signed-in player's list lives on the server
 * (`scoreboard_prefs.pinnedPiles`, `GET`/`PUT /api/me/pinned-piles`) so it
 * follows them across devices. localStorage holds a mirror for a flash-free
 * first paint and is the only store a guest has.
 *
 * Raw `fetch` with the player token rather than `lib/api.ts`, which only ever
 * sends the ADMIN token — the same reason `lib/roomThemes.ts` does.
 */

const STORAGE_KEY = 'arcaid-pinned-piles';

export function readLocalPinnedPiles(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string' && x.length > 0) : [];
  } catch {
    return [];
  }
}

export function writeLocalPinnedPiles(ids: string[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids)); } catch { /* private mode / quota */ }
}

/** The server's list, or null when the request fails (keep the local one). */
export async function fetchPinnedPiles(playerToken: string): Promise<string[] | null> {
  try {
    const res = await fetch('/api/me/pinned-piles', { headers: { Authorization: `Bearer ${playerToken}` } });
    if (!res.ok) return null;
    const body = await res.json() as { pinnedPiles?: unknown };
    return Array.isArray(body?.pinnedPiles) ? body.pinnedPiles.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return null;
  }
}

export async function savePilePinned(playerToken: string, tournamentId: string, pinned: boolean): Promise<boolean> {
  try {
    const res = await fetch(`/api/me/pinned-piles/${encodeURIComponent(tournamentId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${playerToken}` },
      body: JSON.stringify({ pinned }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
