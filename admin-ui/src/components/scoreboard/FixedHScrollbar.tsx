import { useRef, useState } from 'react';
import type { HScrollMetrics } from '../HorizontalScrollNav';

/** Minimum thumb size, so a very long board still leaves something grabbable. */
const MIN_THUMB_PX = 44;
/** Track height. The hit area is padded out to 16px around it. */
const TRACK_H = 10;

interface Props {
  /** Geometry from `HorizontalScrollNav`'s `onScrollMetrics`. Null → nothing
   *  is reporting (no horizontal-scroll layout mounted) → render nothing. */
  metrics: HScrollMetrics | null;
  /** Sets the scroller's `scrollLeft`. */
  onScrollTo: (scrollLeft: number) => void;
  /** Suppresses the bar entirely — the admin page hides it while the mobile
   *  bottom sheet is up, which owns the bottom of the screen. */
  hidden?: boolean;
}

/**
 * v2.118.0 — a viewport-fixed horizontal scrollbar for the card strip.
 *
 * The card strip's own scrollbar is hidden by design (`scoreboard-hscroll-nobar`)
 * and the affordance that replaced it — edge-hover arrow overlays — had to go
 * on the admin Leaderboard page, because the right-hand overlay is sized to
 * reach the viewport edge and therefore covered the display-settings rail and
 * swallowed its clicks.
 *
 * So: a real scrollbar, pinned to the bottom of the VIEWPORT (the card strip
 * can be taller than the screen, so a scrollbar under the strip would be
 * off-screen exactly when it is needed) but spanning only the WRAPPER's
 * horizontal extent, which is the surface column and never the rail.
 *
 * Pointer events throughout, so the thumb drags with mouse, pen and touch
 * alike; `setPointerCapture` keeps the drag alive outside the thumb.
 */
export default function FixedHScrollbar({ metrics, onScrollTo, hidden }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startScrollLeft: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  if (hidden || !metrics) return null;
  const { scrollLeft, scrollWidth, clientWidth, left, width } = metrics;
  // Same -1 tolerance as the nav's overflow test (fractional pixels).
  if (!(scrollWidth > clientWidth + 1) || width <= 0) return null;

  const maxScroll = scrollWidth - clientWidth;
  const thumbW = Math.max(MIN_THUMB_PX, Math.round((clientWidth / scrollWidth) * width));
  const travel = Math.max(0, width - thumbW);
  const thumbX = maxScroll > 0 ? Math.round((scrollLeft / maxScroll) * travel) : 0;

  /** Places the thumb's CENTRE at a viewport x. */
  const scrollToPointer = (clientX: number) => {
    if (travel <= 0) return;
    const x = clientX - left - thumbW / 2;
    const clamped = Math.min(travel, Math.max(0, x));
    onScrollTo((clamped / travel) * maxScroll);
  };

  return (
    <div
      ref={trackRef}
      data-testid="fixed-hscrollbar"
      role="scrollbar"
      aria-orientation="horizontal"
      aria-label="Scoreboard card strip scrollbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={maxScroll > 0 ? Math.round((scrollLeft / maxScroll) * 100) : 0}
      // Click anywhere on the track jumps there. The thumb's own pointerdown
      // stops propagation, so a grab never double-handles as a jump.
      onPointerDown={e => { e.preventDefault(); scrollToPointer(e.clientX); }}
      className="fixed z-30 flex items-center bg-surface/80 border-t border-border backdrop-blur-sm"
      style={{ bottom: 0, left, width, height: 16, touchAction: 'none' }}
    >
      <div
        data-testid="fixed-hscrollbar-thumb"
        onPointerDown={e => {
          e.preventDefault();
          e.stopPropagation();
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          dragRef.current = { pointerId: e.pointerId, startX: e.clientX, startScrollLeft: scrollLeft };
          setDragging(true);
        }}
        onPointerMove={e => {
          const s = dragRef.current;
          if (!s || s.pointerId !== e.pointerId || travel <= 0) return;
          const delta = e.clientX - s.startX;
          const next = s.startScrollLeft + (delta / travel) * maxScroll;
          onScrollTo(Math.min(maxScroll, Math.max(0, next)));
        }}
        onPointerUp={e => {
          dragRef.current = null;
          setDragging(false);
          (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
        }}
        onPointerCancel={() => { dragRef.current = null; setDragging(false); }}
        className={`rounded-full transition-colors ${dragging ? 'bg-neon-cyan' : 'bg-neon-cyan/60 hover:bg-neon-cyan'}`}
        style={{ height: TRACK_H, width: thumbW, marginLeft: thumbX, cursor: 'grab' }}
      />
    </div>
  );
}
