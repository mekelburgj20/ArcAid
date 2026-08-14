/**
 * Viewer JWT claim decoding — one definition, v2.108.0 (F1).
 *
 * The public pages need three things off the viewer's player token: what role
 * the user actually has (public-page tokens carry `player`, `room_admin`, or
 * `super_admin`), which rooms they administer, and their Discord id. Three
 * copies of this decoder had drifted apart (GameDetail.tsx typed the role
 * union and returned `discordId`; RoomScoresView.tsx typed `role` as a bare
 * string and dropped `discordId`; PlayerDetail.tsx had a third copy), each
 * with a comment pointing at the others. This is the single source.
 *
 * NOT a security boundary. Nothing here is verified — the signature isn't
 * checked and can't be client-side. It decides what to RENDER; every action it
 * gates is re-authorized server-side against the same claims in the signed
 * token.
 */

export type ViewerRole = 'player' | 'room_admin' | 'super_admin';

export interface ViewerClaims {
  role: ViewerRole;
  gameRoomIds: string[];
  discordId: string | null;
}

/** Decode a player JWT's payload. Returns null on a missing/malformed token. */
export function decodeViewerClaims(token: string | null | undefined): ViewerClaims | null {
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    return {
      role: (payload.role as ViewerRole) || 'player',
      gameRoomIds: Array.isArray(payload.gameRoomIds) ? payload.gameRoomIds : [],
      discordId: (payload.discordId as string) || null,
    };
  } catch {
    return null;
  }
}

/** True when these claims administer `roomId` (super-admins administer all). */
export function isRoomAdminFor(claims: ViewerClaims | null, roomId: string | undefined): boolean {
  if (!claims) return false;
  if (claims.role === 'super_admin') return true;
  return claims.role === 'room_admin' && !!roomId && claims.gameRoomIds.includes(roomId);
}
