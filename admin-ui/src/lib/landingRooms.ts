/**
 * v2.37.0 — landing-page "My Game Rooms" section.
 *
 * Pure merge/dedupe logic split out of LandingPage.tsx so it's unit-testable
 * without mounting the page. `/api/me/rooms` (RoomMembershipService, see
 * src/services/RoomMembershipService.ts) returns a much thinner shape than
 * the enriched `/api/rooms` public listing (no activeGames/activePlayers/
 * description/discordInviteUrl — that enrichment lives inline in the
 * `GET /api/rooms` route handler, not an extractable shared helper, so this
 * stays FE-only per the D2.3 trivial-reuse clause).
 *
 * Strategy: intersect the user's room ids against the already-fetched public
 * list for full card data; member rooms that AREN'T in the public list
 * (private/unlisted rooms the user belongs to) degrade gracefully to a
 * stats-less card built from whatever `/api/me/rooms` provided.
 */

/** Matches the enriched shape returned by `GET /api/rooms`. */
export interface PublicRoom {
  id: string;
  slug: string;
  name: string;
  description: string;
  is_public: boolean;
  logo_url: string | null;
  activeGames: number;
  activePlayers: number;
  discordInviteUrl: string | null;
  /** v2.39.0 (approval rooms) — 'open' (default) | 'approval'. */
  join_policy?: 'open' | 'approval';
}

/** Matches `RoomForUser` from `GET /api/me/rooms`. */
export interface MemberRoom {
  roomId: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  joinedAt: string;
  source: string;
  lastActivityAt: string | null;
}

/** Normalized shape the shared RoomCard renders. Stats fields are optional —
 * absent means "unlisted room, no enrichment available" and the card hides
 * the stats row instead of showing false zeros. */
export interface RoomCardData {
  id: string;
  slug: string;
  name: string;
  description: string;
  logoUrl: string | null;
  discordInviteUrl: string | null;
  activeGames?: number;
  activePlayers?: number;
  /** v2.39.0 (approval rooms) — 'open' (default) | 'approval'. Member rooms
   * (already-joined) don't carry this — a member's relationship to the room
   * is settled, the bookmark toggle there is always a plain "leave". */
  joinPolicy?: 'open' | 'approval';
}

export function normalizePublicRoom(room: PublicRoom): RoomCardData {
  return {
    id: room.id,
    slug: room.slug,
    name: room.name,
    description: room.description,
    logoUrl: room.logo_url,
    discordInviteUrl: room.discordInviteUrl,
    activeGames: room.activeGames,
    activePlayers: room.activePlayers,
    joinPolicy: room.join_policy,
  };
}

export function normalizeMemberRoom(room: MemberRoom): RoomCardData {
  return {
    id: room.roomId,
    slug: room.slug,
    name: room.name,
    description: '',
    logoUrl: room.logoUrl,
    discordInviteUrl: null,
  };
}

export interface SplitLandingRoomsResult {
  /** "My Game Rooms" section — one card per room the user belongs to,
   * enriched when the room also appears in the public list. */
  myRooms: RoomCardData[];
  /** Public "Game Rooms" grid, with the user's own rooms removed. */
  publicRooms: RoomCardData[];
}

/**
 * Splits the fetched public rooms + the signed-in user's rooms into the two
 * sections the landing page renders, deduping by room id (public rooms
 * already shown in "My Game Rooms" are excluded from the grid below).
 */
export function splitLandingRooms(publicRooms: PublicRoom[], myRooms: MemberRoom[]): SplitLandingRoomsResult {
  const publicById = new Map(publicRooms.map(r => [r.id, r]));
  const myIds = new Set(myRooms.map(r => r.roomId));

  return {
    myRooms: myRooms.map(mr => {
      const pub = publicById.get(mr.roomId);
      return pub ? normalizePublicRoom(pub) : normalizeMemberRoom(mr);
    }),
    publicRooms: publicRooms
      .filter(r => !myIds.has(r.id))
      .map(normalizePublicRoom),
  };
}
