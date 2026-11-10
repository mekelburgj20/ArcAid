/**
 * `fetch` for a room-scoped read from a public room page (v2.241.1, D19).
 *
 * In an `approval` room the server's `roomVisibilityGate` answers a room
 * request only when it carries the viewer's login, and every public page
 * reads with `r.ok ? r.json() : []`, so a tokenless read in such a room is a
 * silently empty page (owner 2026-11-10: "Full Leaderboard" on a Mox's Game
 * Room card opened a game page with nothing on it). Page-by-page fixes kept
 * missing reads (Picks v2.98.0, Players v2.99.1); this is the one place.
 *
 * Attaches the signed-in player's token when there is one and the call did
 * not set its own `Authorization`. The token is read from storage at call
 * time, like `getPortal`, so the call never needs a hook or an effect
 * dependency, and always sends the token `ViewerAuthContext` last refreshed.
 * Signed out, the call is exactly the bare `fetch` it replaces. Sending a
 * stale token is harmless: the optional-auth middleware never blocks, and an
 * unreadable token is a guest.
 *
 * Only `/portal` and `/scoreboard-config` answer before the gate; every other
 * `/api/rooms/:roomId/...` read goes through here
 * (`lib/__tests__/roomFetchGuard.test.ts`).
 */
const PLAYER_TOKEN_KEY = 'arcaid_player_token';

function storedPlayerToken(): string | null {
  try {
    return localStorage.getItem(PLAYER_TOKEN_KEY);
  } catch {
    return null;
  }
}

export function roomFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = storedPlayerToken();
  if (!token) return init === undefined ? fetch(input) : fetch(input, init);

  const headers = new Headers(init?.headers);
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${token}`);
  return fetch(input, { ...init, headers });
}
