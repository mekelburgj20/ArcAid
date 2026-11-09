import { useContext } from 'react';
import { CheckCircle2 } from 'lucide-react';
import type { GameLeaderboard } from '../ScoreboardComponents';
import { CardAtGamesJoinContext } from './cardAtGamesJoinContext';

/**
 * v2.234.0 (A36) — "Join on AtGames" on a room scoreboard card, in the same
 * strip as "Start attempts" (directly above the footer, the card's action
 * strip; owner 2026-11-08). The two never meet: a limited-attempts event cannot
 * be fed by AtGames (ADR 0029), so no card needs both.
 *
 * Renders only on an ACTIVE card that the page's joinable list names, and only
 * under the Scoreboard page's provider. Wraps rather than truncates, so it
 * holds at phone width.
 */
export default function CardAtGamesJoin({
  lb, className = '', style,
}: { lb: GameLeaderboard; className?: string; style?: React.CSSProperties }) {
  const ctx = useContext(CardAtGamesJoinContext);
  if (!ctx || lb.gameStatus !== 'ACTIVE') return null;
  const item = ctx.byGameId[lb.gameId];
  if (!item) return null;

  return (
    <div
      className={`relative z-[2] flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/30 px-3 py-2 ${className}`}
      style={style}
      data-testid="card-atgames-join"
    >
      {ctx.joined.has(item.tournamentId) ? (
        <span className="sb-art-text inline-flex items-center gap-1 text-[11px] text-muted">
          <CheckCircle2 size={12} aria-hidden="true" className="shrink-0 text-neon-green" />
          Joined on AtGames
        </span>
      ) : (
        <>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); ctx.open(item); }}
            className="min-h-8 rounded border border-neon-cyan px-2.5 py-1 text-[11px] font-display uppercase tracking-wider text-neon-cyan transition-colors hover:bg-neon-cyan/10 cursor-pointer"
            aria-label={`Join ${item.tournamentName} on AtGames`}
          >
            Join on AtGames
          </button>
          <span className="sb-art-text text-[11px] text-muted">
            Your cabinet scores come in on their own
          </span>
        </>
      )}
    </div>
  );
}
