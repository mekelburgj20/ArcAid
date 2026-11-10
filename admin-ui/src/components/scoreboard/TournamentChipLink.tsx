import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { GameLeaderboard } from '../ScoreboardComponents';
import { tournamentChipLinkLabel } from './tournamentChip';

/**
 * v2.238.0 (B24) — the tournament chip as a link to the tournament's results.
 * `to` comes from `tournamentChipLink` (the tournament page, or the run itself
 * on a finished card). Without it (kiosk, previews, pinned boards) the chip
 * renders exactly as before.
 *
 * The wrapper adds no box of its own, so each card style keeps its chip's
 * look: it inherits the chip's colour, brightens on hover and draws a focus
 * ring. The chip only shows the tag ("DG"), so the link carries the
 * tournament's name as its accessible name and tooltip.
 */
export default function TournamentChipLink({ to, lb, children }: {
  to?: string;
  lb: Pick<GameLeaderboard, 'tournamentName' | 'tournamentType' | 'gameStatus' | 'displayName' | 'gameName'>;
  children: ReactNode;
}) {
  if (!to) return <>{children}</>;
  const label = tournamentChipLinkLabel(lb);
  return (
    <Link
      to={to}
      aria-label={label}
      title={label}
      data-testid="tournament-chip-link"
      className="pointer-events-auto inline-flex text-inherit no-underline rounded-[4px] transition-[filter] hover:brightness-125 hover:underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-neon-cyan"
    >
      {children}
    </Link>
  );
}
