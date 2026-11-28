import { useContext } from 'react';
import { CheckCircle2, PauseCircle } from 'lucide-react';
import type { GameLeaderboard } from '../ScoreboardComponents';
import { CardAttemptStartContext } from './cardAttemptStartContext';
import { PRACTICE_ON_TEXT, canPausePractice, isPracticing, practiceLeftText } from '../../lib/attemptStarts';

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
 *
 * W126 (ADR 0043) — the same strip carries Practice mode, on a tournament
 * whose host allows it: "Pause to practice" once attempts are counting, and,
 * while paused, an amber line saying plays do not count with "Resume
 * attempts" beside it. The paused state is the loud one on purpose: a player
 * who forgets to resume plays their real games as practice.
 */
export default function CardAttemptStart({
  lb, className = '', style,
}: { lb: GameLeaderboard; className?: string; style?: React.CSSProperties }) {
  const ctx = useContext(CardAttemptStartContext);
  if (!ctx || lb.gameStatus !== 'ACTIVE') return null;
  const item = ctx.byGameId[lb.gameId];
  if (!item) return null;
  const practicing = isPracticing(item);
  const mayPause = canPausePractice(item);
  // W82 — the list also carries limited tables that do not need the press
  // (for the "N attempts left" badge); those get no strip unless practice
  // mode has something to offer or say.
  if (!item.requireStart && !practicing && !mayPause) return null;
  const pending = ctx.pendingGameId === item.gameId;
  const name = lb.displayName || lb.gameName;
  const press = (fn: () => void) => (e: React.MouseEvent) => { e.preventDefault(); e.stopPropagation(); fn(); };

  return (
    <div
      className={`relative z-[2] flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border/30 px-3 py-2 ${className}`}
      style={style}
      data-testid="card-attempt-start"
    >
      {item.requireStart && !item.started ? (
        <>
          <button
            type="button"
            onClick={press(() => ctx.start(item))}
            disabled={pending}
            className="min-h-8 rounded border border-neon-cyan px-2.5 py-1 text-[11px] font-display uppercase tracking-wider text-neon-cyan transition-colors hover:bg-neon-cyan/10 disabled:opacity-50 cursor-pointer"
            aria-label={`Start attempts on ${name}`}
          >
            {pending ? 'Starting…' : 'Start attempts'}
          </button>
          <span className="sb-art-text text-[11px] text-muted">
            Your plays here count once you press it
          </span>
        </>
      ) : practicing ? (
        <>
          <span className="sb-art-text inline-flex items-start gap-1 text-xs text-neon-amber" data-testid="card-practice-on">
            <PauseCircle size={14} aria-hidden="true" className="mt-px shrink-0" />
            <span>{PRACTICE_ON_TEXT} · {practiceLeftText(item.practice!)}</span>
          </span>
          <button
            type="button"
            onClick={press(() => ctx.resume(item))}
            disabled={pending}
            className="min-h-8 rounded border border-neon-amber px-2.5 py-1 text-xs font-display uppercase tracking-wider text-neon-amber transition-colors hover:bg-neon-amber/10 disabled:opacity-50 cursor-pointer"
            aria-label={`Resume attempts on ${name}`}
            data-testid="card-practice-resume"
          >
            {pending ? 'Resuming…' : 'Resume attempts'}
          </button>
        </>
      ) : (
        <>
          {item.requireStart && (
            <span className="sb-art-text inline-flex items-center gap-1 text-[11px] text-muted" data-testid="card-attempts-started">
              <CheckCircle2 size={12} aria-hidden="true" className="shrink-0 text-neon-green" />
              Attempts started
            </span>
          )}
          {mayPause && (
            <>
              <button
                type="button"
                onClick={press(() => ctx.pause(item))}
                disabled={pending}
                className="min-h-8 rounded border border-neon-magenta px-2.5 py-1 text-xs font-display uppercase tracking-wider text-neon-magenta transition-colors hover:bg-neon-magenta/10 disabled:opacity-50 cursor-pointer"
                aria-label={`Pause attempts on ${name} to practice`}
                data-testid="card-practice-pause"
              >
                {pending ? 'Pausing…' : 'Pause to practice'}
              </button>
              <span className="sb-art-text text-xs text-muted" data-testid="card-practice-left">
                {practiceLeftText(item.practice!)}
              </span>
            </>
          )}
        </>
      )}
    </div>
  );
}
