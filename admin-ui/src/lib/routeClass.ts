/**
 * Which CLASS of page a pathname is (v2.132.0).
 *
 * Extracted from `ThemeProvider` because it is no longer only the theme layer
 * that needs the answer: `DisplaySettingsHost` asks "am I on a room page?" to
 * decide whether the sheet shows its room-specific section. A second
 * hand-rolled copy would drift from `RESERVED_TOP_SEGMENTS` the next time a
 * global route is added, and the sheet would start offering "This room"
 * settings for `/friends`.
 *
 * The rules match App.tsx's route table — keep them in step with it.
 */

/** `/admin/*` = super admin, `/:slug/admin/*` = room admin. */
export function isAdminPath(pathname: string): boolean {
  const parts = pathname.split('/').filter(Boolean);
  return parts[0] === 'admin' || parts[1] === 'admin';
}

const GLOBAL_PAGE_PREFIXES = ['/scoreboard', '/catalogue', '/games/'];

/** Cross-room pages: the landing page, global scoreboard, catalogue, game detail. */
export function isGlobalPath(pathname: string): boolean {
  return pathname === '/' || GLOBAL_PAGE_PREFIXES.some(prefix => pathname.startsWith(prefix));
}

// s20: top-level path segments that are reserved global/utility routes, never
// a room slug. Without this guard, e.g. /friends or /my-rooms would be
// (mis)treated as a room whose slug is "friends"/"my-rooms" — fetching and
// writing that "room"'s public theme. See App.tsx's route table.
const RESERVED_TOP_SEGMENTS = new Set([
  'admin', 'login', 'auth', 'invite', 'privacy', 'terms',
  'friends', 'account', 'my-rooms', 'scoreboard', 'games',
]);

/**
 * Room slug for a room-scoped PUBLIC route only. Returns null for admin
 * routes, global pages, and other reserved top-level paths.
 */
export function getRoomSlugForPath(pathname: string): string | null {
  if (isAdminPath(pathname) || isGlobalPath(pathname)) return null;
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first || RESERVED_TOP_SEGMENTS.has(first)) return null;
  return first;
}
