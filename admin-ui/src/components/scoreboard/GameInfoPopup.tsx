import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Info, ExternalLink } from 'lucide-react';

interface GameInfoPopupProps {
  externalUrl?: string | null;
  notes?: string | null;
  size?: number;
  className?: string;
}

// v2.34.0 (D2) — hover-intent timing. A short open-delay avoids flicker on
// fast pointer pass-through; the close grace period is long enough for the
// user to move from the icon into the bubble and click the link inside
// (the explicit requirement driving this feature).
const HOVER_OPEN_DELAY_MS = 100;
const HOVER_CLOSE_GRACE_MS = 300;

// Touch devices can synthesize mouseenter/mouseleave around taps in some
// browsers, which would fight with tap-to-toggle. Gate the hover-intent
// behavior behind the same `(hover: hover)` media feature the S20
// `[@media(hover:none)]` CSS idiom already uses elsewhere in the app so
// touch-only devices keep tap-to-toggle exclusively. `matchMedia` isn't
// implemented in jsdom, hence the defensive typeof/try guard — falls back
// to "hover-capable" (desktop-like) when the API is unavailable.
function supportsHover(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  try {
    return window.matchMedia('(hover: hover)').matches;
  } catch {
    return true;
  }
}

/**
 * Small "i" icon next to a game title that shows a tooltip-style bubble
 * with notes + an external URL.
 *
 * v2.13.13 — bubble now portals to document.body with fixed positioning
 * computed from the trigger button's bounding rect. Pre-fix the bubble was
 * absolutely-positioned inside the trigger's wrapper, which lived inside a
 * card with `overflow: hidden`, so the bubble was clipped at the card's
 * top edge and invisible to users. The click handler also now calls
 * preventDefault + stopPropagation to fully isolate from the parent <Link>'s
 * onClick (which would otherwise fire the GameQuickView modal in v2.13.12+).
 *
 * v2.34.0 (D2) — mouse/pointer users get hover-intent open (hovering the
 * icon OR the bubble keeps it open) with a close grace period so they can
 * travel from icon to bubble and click the link inside. Touch keeps the
 * pre-existing tap-to-toggle untouched — the hover handlers no-op on
 * devices without real hover (see `supportsHover()`). Keyboard access
 * (native <button> Enter/Space + the existing Escape handler) is
 * unchanged.
 */
export default function GameInfoPopup({ externalUrl, notes, size = 14, className = '' }: GameInfoPopupProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = () => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  };
  const clearCloseTimer = () => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  };

  // Clean up any pending hover timers on unmount.
  useEffect(() => {
    return () => {
      clearOpenTimer();
      clearCloseTimer();
    };
  }, []);

  // Position the bubble above the button when opening. useLayoutEffect so
  // coords are set before paint (no flicker at the wrong position).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setCoords({
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
    });
  }, [open]);

  // Close on outside click, ESC, or scroll.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        bubbleRef.current && !bubbleRef.current.contains(target) &&
        buttonRef.current && !buttonRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    // capture phase so scrolls inside any ancestor close the bubble.
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [open]);

  // Hover-intent: entering the icon OR the bubble cancels any pending close
  // and (if not already open) schedules an open after HOVER_OPEN_DELAY_MS.
  // No-ops on devices without real hover so touch's tap-to-toggle (onClick,
  // below) is the sole trigger there.
  const handleHoverEnter = () => {
    if (!supportsHover()) return;
    clearCloseTimer();
    if (open) return;
    clearOpenTimer();
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setOpen(true);
    }, HOVER_OPEN_DELAY_MS);
  };

  // Leaving the icon OR the bubble cancels any pending open and schedules a
  // close after the grace period — re-entering either element before the
  // grace period elapses cancels it via handleHoverEnter above.
  const handleHoverLeave = () => {
    if (!supportsHover()) return;
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, HOVER_CLOSE_GRACE_MS);
  };

  if (!externalUrl && !notes) return null;

  return (
    <span className={`relative inline-flex ${className}`}>
      <button
        ref={buttonRef}
        onClick={(e) => {
          // preventDefault + stopPropagation isolates this from the parent
          // <Link>'s onClick, which would otherwise also fire (opening the
          // GameQuickView modal as of v2.13.12).
          e.preventDefault();
          e.stopPropagation();
          // Own the open state outright on an explicit tap/click — don't
          // let a stray hover timer flip it back shortly after.
          clearOpenTimer();
          clearCloseTimer();
          setOpen(!open);
        }}
        onMouseEnter={handleHoverEnter}
        onMouseLeave={handleHoverLeave}
        className="text-muted hover:text-primary transition-colors cursor-pointer"
        title="Game info"
      >
        <Info size={size} />
      </button>
      {open && coords && createPortal(
        <div
          ref={bubbleRef}
          className="fixed z-[60] bg-surface border border-border rounded-lg shadow-lg p-3 min-w-[200px] max-w-[300px]"
          style={{
            left: coords.left,
            top: coords.top,
            transform: 'translate(-50%, -100%)',
          }}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseEnter={handleHoverEnter}
          onMouseLeave={handleHoverLeave}
        >
          {notes && (
            <p className="text-xs text-muted mb-2 whitespace-pre-wrap">{notes}</p>
          )}
          {externalUrl && (
            <a
              href={externalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-neon-cyan hover:underline break-all"
            >
              <ExternalLink size={12} className="flex-shrink-0" />
              {externalUrl}
            </a>
          )}
          {/* Caret pointing down to the trigger. */}
          <div
            className="absolute left-1/2 top-full -translate-x-1/2 w-2 h-2 bg-surface border-r border-b border-border rotate-45 -translate-y-1"
            aria-hidden="true"
          />
        </div>,
        document.body
      )}
    </span>
  );
}
