import type { GameLeaderboard } from '../ScoreboardComponents';

/**
 * v2.238.0 (B24) — what a finished card shows where a live one shows its
 * countdown: "Ended Tue, Nov 3" (from the board's `endedAt`, COMPLETED cards
 * only). Null when there is no usable date.
 *
 * Its own module (like `tournamentChip.ts`) so the card files keep exporting
 * only components — see `react-refresh/only-export-components`.
 */
export function formatEndedLabel(endedAt: string | null | undefined): string | null {
  if (!endedAt) return null;
  const d = new Date(endedAt);
  if (Number.isNaN(d.getTime())) return null;
  return `Ended ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

/** The card's timer slot: the live countdown, or a finished card's end date. */
export function cardTimerText(lb: Pick<GameLeaderboard, 'gameStatus' | 'endedAt'>, countdown: string | null): string | null {
  if (countdown) return countdown;
  return lb.gameStatus === 'COMPLETED' ? formatEndedLabel(lb.endedAt) : null;
}
