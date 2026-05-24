import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  /** Class names applied to the scrollable container. The container has
   *  `overflow-x: auto` baked in and the scrollbar hidden via CSS. */
  className?: string;
  /** Hover-proximity threshold in pixels. Cursor within this distance from
   *  the wrapper's left/right edge reveals the corresponding arrow when
   *  there's more content to scroll to. Default 120px. */
  edgeHoverPx?: number;
  /** Pixels to scroll on a single click. Default 400. */
  clickScrollPx?: number;
  /** Pixels per frame when the user holds the arrow down (after a short
   *  delay so a quick click stays a clean chunk). Default 18. */
  holdScrollPxPerFrame?: number;
  /** Ms to wait after mousedown before continuous-hold scrolling kicks in.
   *  Default 280. */
  holdDelayMs?: number;
  /** Movement threshold (px) that turns a mousedown+mousemove on the card
   *  area into a drag-to-scroll instead of a regular click. Default 5. */
  dragThresholdPx?: number;
  children: ReactNode;
}

/**
 * v2.13.14 — replaces the horizontal scrollbar with edge-hover arrow
 * overlays.
 *
 * v2.13.15 — arrows now extend all the way to the viewport edge (rendered
 * via portal at `position: fixed` so they're not clipped by the wrapper or
 * any parent overflow). Hover detection moved to document-level so cursor
 * in the gap between the wrapper edge and the viewport edge still reveals
 * the arrow. Added click+hold drag-to-scroll on the card area itself: a
 * mousedown on a non-input element starts tracking, and once movement
 * exceeds `dragThresholdPx` it engages drag mode (cursor → grabbing, scroll
 * follows the cursor). Quick clicks under the threshold pass through
 * normally so card-title clicks still open the QuickView modal.
 *
 * Arrows appear iff:
 *   (1) cursor's viewport X is within `edgeHoverPx` of the wrapper's left
 *       edge (extending out to viewport x=0) or right edge (extending out
 *       to viewport x=innerWidth), AND
 *   (2) cursor's viewport Y is within the wrapper's vertical bounds, AND
 *   (3) there's more content to scroll in that direction.
 *
 * Touch / mobile: pointer events fire on touch, but since touch already
 * scrolls horizontally natively, we never bind mousedown→drag on touch.
 * Arrows stay hidden (no mousemove fires).
 */
export default function HorizontalScrollNav({
  className = '',
  edgeHoverPx = 120,
  clickScrollPx = 400,
  holdScrollPxPerFrame = 18,
  holdDelayMs = 280,
  dragThresholdPx = 5,
  children,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [hoverLeft, setHoverLeft] = useState(false);
  const [hoverRight, setHoverRight] = useState(false);
  const [wrapperRect, setWrapperRect] = useState<{ top: number; left: number; right: number; height: number } | null>(null);

  // Hold-state refs (mutable; never trigger re-render).
  const holdIntervalRef = useRef<number | null>(null);
  const holdTimeoutRef = useRef<number | null>(null);

  // Drag-to-scroll state.
  const dragRef = useRef<{ startX: number; startScrollLeft: number; engaged: boolean } | null>(null);

  const stopHold = () => {
    if (holdTimeoutRef.current != null) {
      window.clearTimeout(holdTimeoutRef.current);
      holdTimeoutRef.current = null;
    }
    if (holdIntervalRef.current != null) {
      window.clearInterval(holdIntervalRef.current);
      holdIntervalRef.current = null;
    }
  };

  const updateCanScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 0);
    // -1 tolerance: some browsers leave a fractional pixel at the end.
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  };

  const updateWrapperRect = () => {
    if (!wrapperRef.current) return;
    const r = wrapperRef.current.getBoundingClientRect();
    setWrapperRect({ top: r.top, left: r.left, right: r.right, height: r.height });
  };

  // Scroll-bounds tracking + wrapper-rect tracking.
  useEffect(() => {
    updateCanScroll();
    updateWrapperRect();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateCanScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      updateCanScroll();
      updateWrapperRect();
    });
    ro.observe(el);
    if (wrapperRef.current) ro.observe(wrapperRef.current);
    window.addEventListener('resize', updateWrapperRect);
    // Capture phase so any ancestor's scroll (e.g., page scroll) re-computes
    // the wrapper's top/left in viewport coords.
    window.addEventListener('scroll', updateWrapperRect, true);
    return () => {
      el.removeEventListener('scroll', updateCanScroll);
      ro.disconnect();
      window.removeEventListener('resize', updateWrapperRect);
      window.removeEventListener('scroll', updateWrapperRect, true);
      stopHold();
    };
  }, []);

  // Document-level mousemove so hover detection covers the area between the
  // wrapper edge and the viewport edge (where the fixed-positioned arrow
  // button extends to). Bound on mount; checks wrapperRef internally.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      const r = wrapperRef.current.getBoundingClientRect();
      const y = e.clientY;
      if (y < r.top || y > r.bottom) {
        setHoverLeft(false);
        setHoverRight(false);
        return;
      }
      const zone = Math.min(edgeHoverPx, r.width * 0.15);
      const x = e.clientX;
      // Left: from viewport left (x=0) all the way to wrapper.left + zone.
      setHoverLeft(x <= r.left + zone);
      // Right: from wrapper.right - zone to viewport right.
      setHoverRight(x >= r.right - zone);
    };
    document.addEventListener('mousemove', onMove);
    return () => document.removeEventListener('mousemove', onMove);
  }, [edgeHoverPx]);

  // Drag-to-scroll listeners. Bound globally so the drag continues even if
  // the cursor leaves the card area mid-drag.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const s = dragRef.current;
      if (!s || !scrollRef.current) return;
      const delta = e.clientX - s.startX;
      if (!s.engaged && Math.abs(delta) > dragThresholdPx) {
        s.engaged = true;
        document.body.style.cursor = 'grabbing';
        document.body.style.userSelect = 'none';
      }
      if (s.engaged) {
        scrollRef.current.scrollLeft = s.startScrollLeft - delta;
        e.preventDefault();
      }
    };
    const onUp = () => {
      const s = dragRef.current;
      dragRef.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      if (s?.engaged) {
        // Suppress the upcoming click event that would otherwise fire from
        // the mousedown→mouseup pair on a card title (which would open the
        // QuickView modal even though the user was dragging).
        const suppress = (ce: MouseEvent) => {
          ce.preventDefault();
          ce.stopPropagation();
          window.removeEventListener('click', suppress, true);
        };
        window.addEventListener('click', suppress, true);
        // Fallback: if no click fires within 100ms (e.g., target was a
        // non-clickable area), remove the listener to avoid suppressing a
        // later unrelated click.
        window.setTimeout(() => {
          window.removeEventListener('click', suppress, true);
        }, 100);
      }
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [dragThresholdPx]);

  const handleScrollMouseDown = (e: React.MouseEvent) => {
    // Left button only.
    if (e.button !== 0) return;
    // Don't hijack drag from text-edit fields.
    const target = e.target as HTMLElement;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
    if (!scrollRef.current) return;
    dragRef.current = {
      startX: e.clientX,
      startScrollLeft: scrollRef.current.scrollLeft,
      engaged: false,
    };
  };

  const scrollBy = (direction: 'left' | 'right', amount: number, smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({
      left: direction === 'left' ? -amount : amount,
      behavior: smooth ? 'smooth' : 'auto',
    });
  };

  const startHold = (direction: 'left' | 'right') => {
    stopHold();
    // Immediate chunk scroll — a quick click feels responsive.
    scrollBy(direction, clickScrollPx, true);
    // After a short delay, kick off continuous scrolling so a sustained hold
    // glides through the list. Quick click → only the chunk fires.
    holdTimeoutRef.current = window.setTimeout(() => {
      holdIntervalRef.current = window.setInterval(() => {
        scrollBy(direction, holdScrollPxPerFrame, false);
      }, 16);
    }, holdDelayMs);
  };

  const showLeft = canLeft && hoverLeft && wrapperRect != null;
  const showRight = canRight && hoverRight && wrapperRect != null;

  // Per-button geometry. zone = how far INTO the wrapper the hover/click
  // area extends past the wrapper edge.
  const zone = wrapperRect ? Math.min(edgeHoverPx, wrapperRect ? (wrapperRect.right - wrapperRect.left) * 0.15 : 0) : 0;
  const leftBtnWidth = wrapperRect ? Math.max(56, wrapperRect.left + zone) : 0;
  const rightBtnWidth = wrapperRect ? Math.max(56, (typeof window !== 'undefined' ? window.innerWidth : 0) - wrapperRect.right + zone) : 0;

  return (
    <div ref={wrapperRef} className="relative">
      <div
        ref={scrollRef}
        className={`overflow-x-auto scoreboard-hscroll-nobar ${className}`}
        onMouseDown={handleScrollMouseDown}
        style={{ cursor: 'grab' }}
      >
        {children}
      </div>
      {showLeft && createPortal(
        <button
          type="button"
          aria-label="Scroll left"
          onMouseDown={(e) => { e.preventDefault(); startHold('left'); }}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          className="fixed flex items-center justify-start pl-3 z-40 cursor-pointer border-0 transition-opacity duration-150"
          style={{
            left: 0,
            top: wrapperRect.top,
            height: wrapperRect.height,
            width: leftBtnWidth,
            background: 'linear-gradient(90deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, transparent 100%)',
          }}
        >
          <ChevronLeft size={36} className="text-white drop-shadow-lg" />
        </button>,
        document.body
      )}
      {showRight && createPortal(
        <button
          type="button"
          aria-label="Scroll right"
          onMouseDown={(e) => { e.preventDefault(); startHold('right'); }}
          onMouseUp={stopHold}
          onMouseLeave={stopHold}
          className="fixed flex items-center justify-end pr-3 z-40 cursor-pointer border-0 transition-opacity duration-150"
          style={{
            right: 0,
            top: wrapperRect.top,
            height: wrapperRect.height,
            width: rightBtnWidth,
            background: 'linear-gradient(270deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, transparent 100%)',
          }}
        >
          <ChevronRight size={36} className="text-white drop-shadow-lg" />
        </button>,
        document.body
      )}
    </div>
  );
}
