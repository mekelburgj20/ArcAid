import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronsLeft, History, Layers, Pin } from 'lucide-react';

/**
 * v2.236.0 (B23) — a tournament's live card with its finished games stacked
 * behind it (grouping rule: `lib/historyPiles.ts`).
 *
 * The slot is the card plus a fixed gutter on its RIGHT. The gutter has the
 * same width in both states, so expanding or folding never resizes the live
 * card:
 *
 *   collapsed   [ live card ]|||   the newest few finished cards peek out of
 *                                  the gutter, offset right and receding; the
 *                                  whole gutter is one button that opens them
 *   expanded    [ live card ]( )  [past 1] [past 2] …   the gutter becomes a
 *                                  spine: fold, keep open, count, all results
 *
 * In the expanded state the finished cards are ordinary board slots rendered
 * by the surface right after this one — this component only draws the spine.
 *
 * The stacked cards are real cards (so their art and frame show at the edge),
 * made `inert` + `aria-hidden`: nothing inside them can be clicked, tabbed to
 * or read out while they are folded.
 */

/** Gutter width: the visible part of the stack, and a 44px touch column. */
export const PILE_GUTTER_PX = 44;
/** Cards drawn in the stack; older ones are counted, not drawn. */
export const PILE_MAX_EDGES = 4;

export interface HistoryPileProps {
  tournamentName: string;
  historyCount: number;
  expanded: boolean;
  pinned: boolean;
  /** Collapsed → open; expanded → fold (folding also unpins). */
  onToggle: () => void;
  /** Pin keeps the pile open next time; unpinning folds it. */
  onTogglePin: () => void;
  /** The tournament's page. */
  resultsHref?: string;
  /** The live card, including its submit button. */
  top: ReactNode;
  /** Collapsed only: the newest finished cards, newest first. */
  behind: ReactNode[];
}

const CHIP = 'inline-flex items-center justify-center rounded-full border backdrop-blur-sm transition-colors';
const CHIP_IDLE = 'bg-surface/90 border-neon-cyan/40 text-neon-cyan';

export default function HistoryPile({
  tournamentName, historyCount, expanded, pinned, onToggle, onTogglePin, resultsHref, top, behind,
}: HistoryPileProps) {
  const games = historyCount === 1 ? 'game' : 'games';
  const cardWidth = `calc(100% - ${PILE_GUTTER_PX}px)`;
  const drawn = behind.length;

  // The stack and the gutter take the live card's OWN height, not the slot's:
  // in a rail or grid row the slot stretches to the tallest card, while a
  // Showcase/Minimal card keeps its natural height. Past cards are clipped to
  // it, so a past game with more score rows cannot hang out below the pile.
  const topRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState(0);
  useLayoutEffect(() => {
    const wrap = topRef.current;
    if (!wrap || typeof ResizeObserver === 'undefined') return;
    let observed: Element | null = null;
    const sync = () => {
      const cardEl = wrap.lastElementChild as HTMLElement | null; // the card (the submit button comes first)
      if (cardEl !== observed) {
        if (observed) ro.unobserve(observed);
        if (cardEl) ro.observe(cardEl);
        observed = cardEl;
      }
      setTopHeight(cardEl ? cardEl.offsetHeight : 0);
    };
    const ro = new ResizeObserver(sync);
    ro.observe(wrap);
    sync();
    return () => ro.disconnect();
  }, []);
  const columnBox: CSSProperties = topHeight > 0 ? { top: 0, height: topHeight } : { top: 0, bottom: 0 };

  const toggleLabel = expanded
    ? (pinned ? `Fold and unpin past ${tournamentName} games` : `Fold past ${tournamentName} games`)
    : `Show ${historyCount} past ${tournamentName} ${games}`;

  return (
    <div className="sb-pile relative h-full" data-pile-state={expanded ? 'open' : 'folded'}>
      {!expanded && drawn > 0 && (
        // z-index 0 makes this its own stacking context, so the layers'
        // z-indexes order them among themselves and never above the live card.
        <div
          className="absolute left-0 pointer-events-none"
          style={{ ...columnBox, width: cardWidth, zIndex: 0 }}
          aria-hidden="true"
          inert
          data-testid="pile-stack"
        >
          {behind.map((card, i) => {
            const k = i + 1;
            const layer = {
              '--pile-dx': `${Math.round((k * PILE_GUTTER_PX) / drawn)}px`,
              '--pile-fan': `${(k * 1.5).toFixed(1)}px`,
              '--pile-scale': (1 - k * 0.035).toFixed(3),
              '--pile-dim': Math.max(0.35, 0.8 - (k - 1) * 0.12).toFixed(2),
              zIndex: drawn - k,
            } as CSSProperties;
            return <div key={k} className="sb-pile-layer absolute inset-0 overflow-hidden rounded-[10px]" style={layer}>{card}</div>;
          })}
        </div>
      )}

      <div ref={topRef} className="relative h-full" style={{ width: cardWidth, zIndex: 1 }}>
        {top}
      </div>

      <div
        className="absolute right-0 z-[2] flex flex-col items-center pt-2 gap-1"
        style={{ ...columnBox, width: PILE_GUTTER_PX }}
      >
        {/* The spine's backing — expanded only. */}
        {expanded && (
          <span aria-hidden="true" className="absolute top-1 bottom-1 left-1/2 -translate-x-1/2 w-9 rounded-full bg-surface/70 border border-border/50 backdrop-blur-sm" />
        )}
        {/* Child positions are stable across states, so this button keeps
            keyboard focus when it flips between "open" and "fold". */}
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={toggleLabel}
          title={expanded ? 'Fold past games' : `${historyCount} past ${games} — click to show`}
          className={`sb-pile-toggle cursor-pointer bg-transparent border-0 p-0 flex justify-center focus:outline-none group/pile ${
            expanded ? 'relative w-11 h-11 items-center' : 'absolute inset-0 items-start pt-2'
          }`}
        >
          {expanded ? (
            <span className={`${CHIP} ${CHIP_IDLE} w-8 h-8 group-hover/pile:bg-neon-cyan/20 group-focus-visible/pile:ring-2 group-focus-visible/pile:ring-neon-cyan`}>
              <ChevronsLeft size={16} />
            </span>
          ) : (
            <span className={`${CHIP} ${CHIP_IDLE} flex-col gap-0.5 w-8 py-1.5 font-mono text-[11px] font-bold leading-none group-hover/pile:bg-neon-cyan/20 group-focus-visible/pile:ring-2 group-focus-visible/pile:ring-neon-cyan`}>
              <Layers size={14} />
              {historyCount}
            </span>
          )}
        </button>
        {expanded && (
          <button
            type="button"
            onClick={onTogglePin}
            aria-pressed={pinned}
            aria-label={pinned ? `Unpin and fold past ${tournamentName} games` : `Keep past ${tournamentName} games open`}
            title={pinned ? 'Kept open — click to fold' : 'Keep open — remembered next time'}
            className="relative w-11 h-11 inline-flex items-center justify-center cursor-pointer bg-transparent border-0 p-0 focus:outline-none group/pin"
          >
            <span className={`${CHIP} w-8 h-8 group-focus-visible/pin:ring-2 group-focus-visible/pin:ring-neon-cyan ${
              pinned ? 'bg-neon-cyan/25 border-neon-cyan text-neon-cyan' : `${CHIP_IDLE} group-hover/pin:bg-neon-cyan/20`
            }`}>
              <Pin size={15} fill={pinned ? 'currentColor' : 'none'} />
            </span>
          </button>
        )}
        {expanded && (
          <span
            className="relative mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-muted whitespace-nowrap select-none"
            style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
          >
            {historyCount} past {games}
          </span>
        )}
        {expanded && resultsHref && (
          <Link
            to={resultsHref}
            aria-label={`All ${tournamentName} results`}
            title={`All ${tournamentName} results`}
            className="relative mt-1 w-11 h-11 inline-flex items-center justify-center focus:outline-none group/res"
          >
            <span className={`${CHIP} ${CHIP_IDLE} w-8 h-8 group-hover/res:bg-neon-cyan/20 group-focus-visible/res:ring-2 group-focus-visible/res:ring-neon-cyan`}>
              <History size={15} />
            </span>
          </Link>
        )}
      </div>
    </div>
  );
}
