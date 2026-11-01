import { useContext } from 'react';
import type { GameLeaderboard } from '../ScoreboardComponents';
import { CardAttemptStartContext } from './cardAttemptStartContext';

/**
 * W82 (owner 2026-10-31) — the LOGGED-IN viewer's own attempts left on a
 * Limited-attempts card: "3 attempts left", "1 attempt left", "No attempts
 * left". Top-left of the card, in every card style.
 *
 * Reads the same room-level list as the W56 "Start attempts" strip
 * (`useRoomAttemptStarts` → `CardAttemptStartContext`), which carries every
 * open limited-attempts table the viewer is allowed in with their own
 * `limit`/`used`/`left` (the W81 rule — void attempts give one back). So it
 * renders only under the public Scoreboard page's provider: a guest, the
 * kiosk and the admin Leaderboard preview show nothing. Other players' counts
 * live on the W81 surfaces, never here.
 *
 * Shown whether or not the table still needs Start attempts pressed — the
 * strip above the footer handles the press; the count is true either way.
 *
 * `variant`: `tab` sits flush in the card's top-left corner (rounded only on
 * its inner corner) — short enough to clear the title / art that starts
 * below it; `pill` is a free-standing chip, for a corner that already holds
 * another control (Banner's header-art "i"). The card positions it.
 */
export default function CardAttemptsLeft({
  lb, variant = 'tab', className = '',
}: { lb: GameLeaderboard; variant?: 'tab' | 'pill'; className?: string }) {
  const ctx = useContext(CardAttemptStartContext);
  if (!ctx || lb.gameStatus !== 'ACTIVE') return null;
  const item = ctx.byGameId[lb.gameId];
  if (!item) return null;

  const { left, limit } = item;
  const text = left === 0 ? 'No attempts left' : `${left} attempt${left === 1 ? '' : 's'} left`;
  const label = `${left} of ${limit} attempts left on ${lb.displayName || lb.gameName}`;
  const tone = left === 0
    ? 'border-neon-amber/50 text-neon-amber'
    : 'border-neon-cyan/40 text-neon-cyan';
  const shape = variant === 'tab'
    ? 'rounded-br-md border-b border-r px-2 py-px'
    : 'rounded border px-1.5 py-[2px]';

  return (
    <span
      className={`sb-fs-10 inline-flex items-center whitespace-nowrap bg-surface/90 font-semibold leading-none text-[10px] backdrop-blur-sm ${shape} ${tone} ${className}`}
      title={label}
      aria-label={label}
      data-testid="card-attempts-left"
    >
      {text}
    </span>
  );
}
