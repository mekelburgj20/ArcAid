/**
 * Centralized copy + role-aware browse link for the room Scoreboard's
 * Tournaments | Room Scores | Global tab unification (WP2 consumes these).
 */

export const TAB_LABELS = {
  tournaments: 'Tournaments',
  room: 'Room Scores',
  global: 'Global',
} as const;

export function tabSubtitle(tab: 'tournaments' | 'room' | 'global', roomName: string): string {
  switch (tab) {
    case 'tournaments':
      return 'Active competitions';
    case 'room':
      return `Every score set in ${roomName}`;
    case 'global':
      return 'Top scores across every Arcaid room';
  }
}

export const ROOM_SCORES_SEARCH_PLACEHOLDER = "Search this room's games";

export const ROOM_SORT_LABELS = {
  recent: 'Recent',
  alpha: 'A–Z',
  most_played: 'Most played',
} as const;

export function roomScoresEmpty(o: { roomName: string }): { title: string; body: string } {
  return {
    title: 'No scores here yet',
    body: `Be the first to put a score on the board in ${o.roomName}.`,
  };
}

export function roomScoresSearchEmpty(q: string): string {
  return `No games match "${q}".`;
}

export const GLOBAL_BANNER_TEXT = 'Global Scoreboard — top scores across every Arcaid room';

export const GLOBAL_SEE_FULL_LABEL = 'See the full Global Scoreboard →';

export const GLOBAL_SEARCH_PLACEHOLDER = 'Search all games';

export function globalEmpty(): { title: string; body: string } {
  return {
    title: 'No global scores yet',
    body: "Once players submit scores that fan out to the global board, they'll show here.",
  };
}

export function globalSearchEmpty(q: string): string {
  return `No games with global scores match "${q}".`;
}

export const LOAD_MORE_LABEL = 'Load more games';

export function browseLink(o: { isRoomAdmin: boolean; slug: string }): { href: string; label: string } {
  if (o.isRoomAdmin) {
    return { href: `/${o.slug}/admin/library`, label: 'Manage the game library →' };
  }
  // No public catalogue route exists yet — the standalone Global Scoreboard is
  // the public browse surface (searchable, all scored catalogue games).
  return { href: '/scoreboard', label: 'Browse all games →' };
}
