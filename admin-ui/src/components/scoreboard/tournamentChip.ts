import type { GameLeaderboard } from '../ScoreboardComponents';

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
