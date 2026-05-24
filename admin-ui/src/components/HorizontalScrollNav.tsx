import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

interface Props {
  /** Class names applied to the scrollable wrapper. The container has
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
  children: ReactNode;
}

/**
 * v2.13.14 — replaces the horizontal scrollbar on the public scoreboard with
 * edge-hover arrow overlays. Arrows only appear when:
 *   (1) the cursor is within `edgeHoverPx` of the wrapper's left/right edge,
 *   AND
 *   (2) there's more content to scroll in that direction (scrollLeft > 0 for
 *       the left arrow; scrollLeft + clientWidth < scrollWidth for right).
 * Clicking scrolls by `clickScrollPx`; holding the button starts continuous
 * scrolling after `holdDelayMs` so a clean click doesn't accidentally fire
 * both behaviors. Cleans up on mouseup/mouseleave/unmount.
 *
 * Touch / mobile: mousemove + mousedown don't fire on touch, so the arrows
 * stay hidden. Native horizontal swipe still works because the underlying
 * container keeps `overflow-x: auto` — just with the scrollbar visually
 * removed.
 */
export default function HorizontalScrollNav({
  className = '',
  edgeHoverPx = 120,
  clickScrollPx = 400,
  holdScrollPxPerFrame = 18,
  holdDelayMs = 280,
  children,
}: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const [hoverLeft, setHoverLeft] = useState(false);
  const [hoverRight, setHoverRight] = useState(false);

  // Hold-state refs (mutable; never trigger re-render).
  const holdIntervalRef = useRef<number | null>(null);
  const holdTimeoutRef = useRef<number | null>(null);

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

  useEffect(() => {
    updateCanScroll();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener('scroll', updateCanScroll, { passive: true });
    // ResizeObserver catches content changes (cards added/removed) +
    // container width changes (sidebar collapse, window resize).
    const ro = new ResizeObserver(updateCanScroll);
    ro.observe(el);
    window.addEventListener('resize', updateCanScroll);
    return () => {
      el.removeEventListener('scroll', updateCanScroll);
      ro.disconnect();
      window.removeEventListener('resize', updateCanScroll);
      stopHold();
    };
  }, []);

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!wrapperRef.current) return;
    const rect = wrapperRef.current.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const zone = Math.min(edgeHoverPx, rect.width * 0.15);
    setHoverLeft(x < zone);
    setHoverRight(x > rect.width - zone);
  };

  const handleMouseLeave = () => {
    setHoverLeft(false);
    setHoverRight(false);
    stopHold();
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

  const showLeft = canLeft && hoverLeft;
  const showRight = canRight && hoverRight;

  return (
    <div
      ref={wrapperRef}
      className="relative"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
    >
      <div
        ref={scrollRef}
        className={`overflow-x-auto scoreboard-hscroll-nobar ${className}`}
      >
        {children}
      </div>
      <button
        type="button"
        aria-label="Scroll left"
        tabIndex={showLeft ? 0 : -1}
        onMouseDown={(e) => { e.preventDefault(); startHold('left'); }}
        onMouseUp={stopHold}
        onMouseLeave={stopHold}
        className={`absolute left-0 top-0 bottom-0 w-14 sm:w-16 flex items-center justify-start pl-2 z-30 transition-opacity duration-150 cursor-pointer border-0 ${
          showLeft ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{
          background: 'linear-gradient(90deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, transparent 100%)',
        }}
      >
        <ChevronLeft size={36} className="text-white drop-shadow-lg" />
      </button>
      <button
        type="button"
        aria-label="Scroll right"
        tabIndex={showRight ? 0 : -1}
        onMouseDown={(e) => { e.preventDefault(); startHold('right'); }}
        onMouseUp={stopHold}
        onMouseLeave={stopHold}
        className={`absolute right-0 top-0 bottom-0 w-14 sm:w-16 flex items-center justify-end pr-2 z-30 transition-opacity duration-150 cursor-pointer border-0 ${
          showRight ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
        style={{
          background: 'linear-gradient(270deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.25) 60%, transparent 100%)',
        }}
      >
        <ChevronRight size={36} className="text-white drop-shadow-lg" />
      </button>
    </div>
  );
}
