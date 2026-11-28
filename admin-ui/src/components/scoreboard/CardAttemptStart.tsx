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
 * attempts" under it. The paused state is the loud one on purpose: a player
 * who forgets to resume plays their real games as practice.
 */
/**
 * The strip's three buttons (Start attempts, Pause to practice, Resume
 * attempts): a dark tile under a 15% tint of the button's colour, so card art
 * never shows through (owner 2026-11-28). The tint is a gradient layered over
 * the `bg-deep` colour; each tone is spelled out in full so Tailwind sees it.
 */
const TILE_BUTTON = 'min-h-8 shrink-0 rounded border bg-deep/85 px-2.5 py-1 text-xs font-display uppercase tracking-wider disabled:opacity-50 cursor-pointer';
const TILE_TONE = {
  cyan: 'border-neon-cyan text-neon-cyan bg-[linear-gradient(color-mix(in_oklab,var(--color-neon-cyan)_15%,transparent),color-mix(in_oklab,var(--color-neon-cyan)_15%,transparent))] hover:bg-[linear-gradient(color-mix(in_oklab,var(--color-neon-cyan)_22%,transparent),color-mix(in_oklab,var(--color-neon-cyan)_22%,transparent))]',
  magenta: 'border-neon-magenta text-neon-magenta bg-[linear-gradient(color-mix(in_oklab,var(--color-neon-magenta)_15%,transparent),color-mix(in_oklab,var(--color-neon-magenta)_15%,transparent))] hover:bg-[linear-gradient(color-mix(in_oklab,var(--color-neon-magenta)_22%,transparent),color-mix(in_oklab,var(--color-neon-magenta)_22%,transparent))]',
  amber: 'border-neon-amber text-neon-amber bg-[linear-gradient(color-mix(in_oklab,var(--color-neon-amber)_15%,transparent),color-mix(in_oklab,var(--color-neon-amber)_15%,transparent))] hover:bg-[linear-gradient(color-mix(in_oklab,var(--color-neon-amber)_22%,transparent),color-mix(in_oklab,var(--color-neon-amber)_22%,transparent))]',
} as const;

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
            className={`${TILE_BUTTON} ${TILE_TONE.cyan}`}
            aria-label={`Start attempts on ${name}`}
          >
            {pending ? 'Starting…' : 'Start attempts'}
          </button>
          <span className="sb-art-text min-w-0 flex-1 basis-32 text-xs text-muted">
            Your plays here count once you press it
          </span>
        </>
      ) : practicing ? (
        // The warning across the card first (the loud line), then the
        // button with what is left beside it, every left edge aligned.
        <div className="flex w-full flex-col items-start gap-1.5" data-testid="card-practice-on">
          <span className="sb-art-text inline-flex items-start gap-1 text-xs text-neon-amber">
            <PauseCircle size={14} aria-hidden="true" className="mt-px shrink-0" />
            <span>{PRACTICE_ON_TEXT}</span>
          </span>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <button
              type="button"
              onClick={press(() => ctx.resume(item))}
              disabled={pending}
              className={`${TILE_BUTTON} ${TILE_TONE.amber}`}
              aria-label={`Resume attempts on ${name}`}
              data-testid="card-practice-resume"
            >
              {pending ? 'Resuming…' : 'Resume attempts'}
            </button>
            <span className="sb-art-text text-xs text-neon-amber">{practiceLeftText(item.practice!)}</span>
          </div>
        </div>
      ) : (
        <>
          {/* The action first, its two status lines stacked beside it (left
              edges aligned), so nothing wraps under the button at card width. */}
          {mayPause && (
            <button
              type="button"
              onClick={press(() => ctx.pause(item))}
              disabled={pending}
              className={`${TILE_BUTTON} ${TILE_TONE.magenta}`}
              aria-label={`Pause attempts on ${name} to practice`}
              data-testid="card-practice-pause"
            >
              {pending ? 'Pausing…' : 'Pause to practice'}
            </button>
          )}
          <span className="flex min-w-0 flex-col items-start gap-0.5">
            {item.requireStart && (
              <span className="sb-art-text inline-flex items-center gap-1 text-xs text-muted" data-testid="card-attempts-started">
                <CheckCircle2 size={12} aria-hidden="true" className="shrink-0 text-neon-green" />
                Attempts started
              </span>
            )}
            {mayPause && (
              <span className="sb-art-text text-xs text-muted" data-testid="card-practice-left">
                {practiceLeftText(item.practice!)}
              </span>
            )}
          </span>
        </>
      )}
    </div>
  );
}
