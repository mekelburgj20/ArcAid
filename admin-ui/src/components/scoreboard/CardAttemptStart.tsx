import { useContext } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { GameLeaderboard } from '../ScoreboardComponents';
import { CardAttemptStartContext } from './cardAttemptStartContext';

/**
 * W56 (ADR 0033 §4) — the "Start attempts" control on a room scoreboard card.
 *
 * Field test 2026-10-28: plays went to the Global Scoreboard as `not_started`
 * because the button lived only on the game page (room → card → full info →
 * the box under the board). This puts the same press on the card itself.
 *
 * Renders only on an ACTIVE card whose game is in the viewer's list (a
 * Limited-attempts tournament that requires the press, that the viewer is
 * allowed in), and only under the Scoreboard page's provider — so a guest, the
 * admin preview and the kiosk see nothing. Each card style places it directly
 * above its footer, the card's action strip. It wraps rather than truncates,
 * so it holds at phone width.
 */
export default function CardAttemptStart({
  lb, className = '', style,
}: { lb: GameLeaderboard; className?: string; style?: React.CSSProperties }) {
  const ctx = useContext(CardAttemptStartContext);
  if (!ctx || lb.gameStatus !== 'ACTIVE') return null;
  const item = ctx.byGameId[lb.gameId];
  if (!item) return null;
  const pending = ctx.pendingGameId === item.gameId;

  return (
    <div
      className={`relative z-[2] flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/30 px-3 py-2 ${className}`}
      style={style}
      data-testid="card-attempt-start"
    >
      {item.started ? (
        <span className="sb-art-text inline-flex items-center gap-1 text-[11px] text-muted" data-testid="card-attempts-started">
          <CheckCircle2 size={12} aria-hidden="true" className="shrink-0 text-neon-green" />
          Attempts started
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); ctx.start(item); }}
            disabled={pending}
            className="min-h-8 rounded border border-neon-cyan px-2.5 py-1 text-[11px] font-display uppercase tracking-wider text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-50 cursor-pointer"
            aria-label={`Start attempts on ${lb.displayName || lb.gameName}`}
          >
            {pending ? 'Starting…' : 'Start attempts'}
          </button>
          <span className="sb-art-text text-[11px] text-muted">
            Your plays here count once you press it
          </span>
        </>
      )}
    </div>
  );
}
