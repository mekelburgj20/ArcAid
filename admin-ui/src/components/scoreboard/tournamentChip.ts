import type { GameLeaderboard } from '../ScoreboardComponents';
import { tournamentResultsPath } from '../../lib/tournamentLinks';

/**
 * The tournament chip on score cards names the tournament's **Tag**
 * (`tournamentType`, e.g. `DG`, `WG-VPXS`, `WG-VPX`, `WG-VR`, `MG`) exactly
 * as configured on the Tournaments page — not an invented English label
 * ("Weekly Grind"), and not the free-text tournament NAME. The tag is what
 * distinguishes same-cadence tournaments from each other (e.g. "Weekly
 * Grind - VPXS" vs "Weekly Grind - VPX" both used to collapse to "Weekly
 * Grind"). Falls back to `tournamentName` only when the tag is empty.
 *
 * One rule, shared by all card styles (Arcade/Showcase/Banner/Minimal) plus
 * the legacy `GameCard`. Pinned / COMPLETED handling is NOT this helper's
 * job — each card already has its own "Pinned" chip override and COMPLETED
 * lock icon; call this only for the non-pinned tournament case.
 */
export function tournamentChipLabel(lb: Pick<GameLeaderboard, 'tournamentType' | 'tournamentName'>): string | null {
  return lb.tournamentType || lb.tournamentName || null;
}

/**
 * v2.238.0 (B24) — where the chip leads: the tournament's results page. A
 * finished card opens its own run there (`?run=`), a live card the page's
 * list of runs. Undefined for a pinned board or a card with no tournament, so
 * that chip stays plain text. Pages that want the link (public board, admin
 * Leaderboard) pass `tournamentChipLink(slug)` to the surface; the kiosk does
 * not, so a wall display has no links.
 */
export function tournamentChipLink(slug: string) {
  return (lb: Pick<GameLeaderboard, 'isPinned' | 'tournamentId' | 'gameStatus' | 'gameId'>): string | undefined => {
    if (!slug || lb.isPinned || !lb.tournamentId) return undefined;
    return tournamentResultsPath(slug, lb.tournamentId, lb.gameStatus === 'COMPLETED' ? lb.gameId : null);
  };
}

/** The chip link's accessible name: the chip itself only shows the tag. */
export function tournamentChipLinkLabel(
  lb: Pick<GameLeaderboard, 'tournamentName' | 'tournamentType' | 'gameStatus' | 'displayName' | 'gameName'>,
): string {
  const name = lb.tournamentName || lb.tournamentType || 'Tournament';
  return lb.gameStatus === 'COMPLETED'
    ? `${name}: ${lb.displayName || lb.gameName} final standings`
    : `${name} results`;
}
