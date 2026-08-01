import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Info, ExternalLink } from 'lucide-react';
import {
    allowedDevicesForEngines,
    allowedEngines,
    parseSubmitPlatformsResponse,
    type SubmitPlatformsResolution,
} from '../../lib/allowedProvenance';
import { getDeviceDisplay, getEngineDisplay } from '../../lib/scoreProvenance';

interface GameInfoPopupProps {
  externalUrl?: string | null;
  notes?: string | null;
  /**
   * Icon glyph size. The button is sized off this (see `BUTTON_MIN_PX`) — the
   * trigger is a circular chip, not a bare glyph, as of the "What's allowed"
   * work: it is now the documented place to look for a tournament's engine and
   * hardware rules, so it has to be findable at a glance.
   */
  size?: number;
  className?: string;
  /**
   * Fetch target for the "What's allowed" section. Room scope needs
   * `roomId` + `gameName`; the global scoreboard passes `globalGameId`.
   * Omit both and the section is simply absent (the popup still renders its
   * notes/link exactly as before).
   */
  roomId?: string | null;
  gameName?: string | null;
  globalGameId?: string | null;
}

// v2.34.0 (D2) — hover-intent timing. A short open-delay avoids flicker on
// fast pointer pass-through; the close grace period is long enough for the
// user to move from the icon into the bubble and click the link inside
// (the explicit requirement driving this feature).
const HOVER_OPEN_DELAY_MS = 100;
const HOVER_CLOSE_GRACE_MS = 300;

/**
 * Visual diameter of the trigger chip, and the invisible square centered on it
 * that actually takes the pointer.
 *
 * Two numbers rather than one because the constraints disagree: the chip has to
 * sit inside a 14px card title without dominating it (32px), while a tap target
 * has to clear the 44px accessibility floor. An absolutely-positioned overlay
 * inside the button gives the second without inflating the first — the overlay
 * is a child, so a pointer landing on it still fires the button.
 */
const BUTTON_MIN_PX = 32;
const HIT_TARGET_PX = 44;

/** Viewport margin the bubble is clamped inside on small screens. */
const VIEWPORT_MARGIN_PX = 8;

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

/** Small pill listing one engine or one device. */
function AllowedChip({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-border/70 bg-raised/60 px-2 py-0.5 text-[10px] leading-4 text-secondary whitespace-nowrap">
      {label}
    </span>
  );
}

/**
 * Small "i" icon next to a game title that shows a tooltip-style bubble
 * with notes, an external URL, and — when a fetch target is supplied — the
 * engines and hardware a score may be submitted on.
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
 *
 * "What's allowed" — the bubble is now where a player finds out which engines
 * and hardware a tournament accepts, WITHOUT opening the submit sheet (the
 * stated requirement). Data comes from `GET /api/submit/platforms`, the same
 * resolver `SubmissionSheet` uses, fetched LAZILY on first open and cached for
 * the life of the component: a scoreboard renders N cards, and eager-fetching
 * would mean N requests for a panel almost nobody opens. Loading and error
 * states are quiet — the notes/link content renders regardless, so a failed
 * fetch degrades to exactly the pre-existing popup.
 */
export default function GameInfoPopup({
  externalUrl,
  notes,
  size = 16,
  className = '',
  roomId,
  gameName,
  globalGameId,
}: GameInfoPopupProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number; below: boolean } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // "What's allowed" data. `requestedRef` is the once-per-instance latch —
  // reopening the bubble must not re-hit the endpoint.
  const [allowed, setAllowed] = useState<SubmitPlatformsResolution | null>(null);
  const [allowedError, setAllowedError] = useState(false);
  const [allowedLoading, setAllowedLoading] = useState(false);
  const requestedRef = useRef(false);

  const canFetchAllowed = !!((roomId && gameName) || globalGameId);

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

  // Lazy fetch on first open only. Deliberately NOT keyed on the target props:
  // a card's game identity doesn't change under it, and re-fetching on a
  // reference-unstable prop is how the S-era infinite-fetch loop happened.
  useEffect(() => {
    if (!open || !canFetchAllowed || requestedRef.current) return;
    requestedRef.current = true;
    let cancelled = false;
    setAllowedLoading(true);
    (async () => {
      try {
        const params = new URLSearchParams();
        if (roomId && gameName) {
          params.set('roomId', roomId);
          params.set('gameName', gameName);
        } else if (globalGameId) {
          params.set('globalGameId', globalGameId);
        }
        const res = await fetch(`/api/submit/platforms?${params.toString()}`);
        if (!res.ok) throw new Error(String(res.status));
        const data = await res.json();
        if (cancelled) return;
        setAllowed(parseSubmitPlatformsResponse(data));
      } catch {
        if (!cancelled) setAllowedError(true);
      } finally {
        if (!cancelled) setAllowedLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open, canFetchAllowed, roomId, gameName, globalGameId]);

  // Position the bubble above the button when opening. useLayoutEffect so
  // coords are set before paint (no flicker at the wrong position).
  useLayoutEffect(() => {
    if (!open || !buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    setCoords({
      left: rect.left + rect.width / 2,
      top: rect.top - 8,
      below: false,
    });
  }, [open]);

  /**
   * Second pass: keep the bubble on screen.
   *
   * The "What's allowed" section makes the bubble both taller and wider than
   * the notes-only version it replaces, so the old fixed "centered above the
   * trigger" placement can now run off the top of the viewport (a card in the
   * first row) or off the side (a narrow phone). Measure once per open and
   * clamp horizontally / flip below if it doesn't fit above. Runs after the
   * content-dependent render, hence a separate effect keyed on the resolved
   * data rather than folding into the effect above.
   */
  useLayoutEffect(() => {
    if (!open || !coords || !bubbleRef.current || !buttonRef.current) return;
    const bubble = bubbleRef.current.getBoundingClientRect();
    const button = buttonRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const half = bubble.width / 2;
    const min = VIEWPORT_MARGIN_PX + half;
    const max = vw - VIEWPORT_MARGIN_PX - half;
    // `min > max` means the bubble is wider than the viewport; centering is
    // then the least-bad answer and max-width CSS keeps it from overflowing.
    const clampedLeft = min > max ? vw / 2 : Math.min(Math.max(coords.left, min), max);
    const fitsAbove = button.top - bubble.height - VIEWPORT_MARGIN_PX >= 0;
    const below = !fitsAbove;
    const nextTop = below ? button.bottom + 8 : button.top - 8;
    if (Math.abs(clampedLeft - coords.left) > 0.5 || below !== coords.below || Math.abs(nextTop - coords.top) > 0.5) {
      setCoords({ left: clampedLeft, top: nextTop, below });
    }
  }, [open, coords, allowed, allowedLoading, allowedError]);

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

  if (!externalUrl && !notes && !canFetchAllowed) return null;

  // Derived through `lib/allowedProvenance` — the same module SubmissionSheet's
  // pickers derive from, so this list and that picker cannot disagree.
  const engines = allowed ? allowedEngines(allowed.submittable, allowed.exclusions.engines) : [];
  const devices = allowed
    ? allowedDevicesForEngines(engines, allowed.submittable, allowed.features, allowed.exclusions.devices)
    : [];
  // An ACTIVE tournament governs this game → the list is that tournament's
  // answer. Otherwise it is just the game's own availability.
  const allowedHeading = allowed?.hasTournament ? 'This tournament allows' : 'Available on';
  // The picker set is genuinely narrower than the game's own set — worth
  // saying out loud, because "Available on" would otherwise read as complete.
  const narrowed = !!allowed && allowed.submittable.length < allowed.platforms.length;
  const buttonPx = Math.max(BUTTON_MIN_PX, size * 2);

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
        className={`relative inline-flex flex-shrink-0 items-center justify-center rounded-full border align-middle transition-colors cursor-pointer ${
          open
            ? 'border-neon-cyan/70 bg-neon-cyan/15 text-neon-cyan'
            : 'border-border/70 bg-surface/70 text-secondary hover:border-neon-cyan/70 hover:bg-neon-cyan/10 hover:text-neon-cyan'
        }`}
        style={{ width: buttonPx, height: buttonPx }}
        aria-label="Game info"
        aria-expanded={open}
        title="Game info"
      >
        <Info size={size} />
        {/* Invisible ≥44px tap target centered on the chip. A child of the
            button, so a pointer landing here still activates the button. */}
        <span
          aria-hidden="true"
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ width: HIT_TARGET_PX, height: HIT_TARGET_PX }}
        />
      </button>
      {open && coords && createPortal(
        <div
          ref={bubbleRef}
          className="fixed z-[60] bg-surface border border-border rounded-lg shadow-lg p-3 min-w-[220px] max-w-[320px]"
          style={{
            left: coords.left,
            top: coords.top,
            transform: coords.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
            maxWidth: `min(320px, calc(100vw - ${VIEWPORT_MARGIN_PX * 2}px))`,
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
          {canFetchAllowed && (
            <div className={notes || externalUrl ? 'mt-2 pt-2 border-t border-border/60' : ''}>
              {allowedLoading && !allowed && (
                <p className="text-[10px] uppercase tracking-wider text-faint">Checking what's allowed…</p>
              )}
              {allowedError && !allowed && (
                <p className="text-[10px] text-faint">Couldn't load what's allowed.</p>
              )}
              {allowed && (engines.length > 0 || devices.length > 0) && (
                <>
                  <p className="text-[10px] uppercase tracking-wider text-faint mb-1.5">
                    {allowedHeading}
                  </p>
                  {allowed.restrictedText && (
                    <p className="text-[11px] text-neon-amber/90 mb-1.5 whitespace-pre-wrap">
                      {allowed.restrictedText}
                    </p>
                  )}
                  {engines.length > 0 && (
                    <div className="mb-1.5">
                      <p className="text-[10px] text-muted mb-1">Engines</p>
                      <div className="flex flex-wrap gap-1">
                        {engines.map(e => <AllowedChip key={e} label={getEngineDisplay(e)} />)}
                      </div>
                    </div>
                  )}
                  {devices.length > 0 && (
                    <div>
                      <p className="text-[10px] text-muted mb-1">Hardware</p>
                      <div className="flex flex-wrap gap-1">
                        {devices.map(d => <AllowedChip key={d} label={getDeviceDisplay(d)} />)}
                      </div>
                    </div>
                  )}
                  {narrowed && (
                    <p className="text-[10px] text-faint mt-1.5">Narrowed by this tournament's rules.</p>
                  )}
                </>
              )}
            </div>
          )}
          {/* Caret pointing at the trigger — flips with the bubble. */}
          <div
            className={`absolute left-1/2 -translate-x-1/2 w-2 h-2 bg-surface rotate-45 ${
              coords.below
                ? 'bottom-full border-l border-t border-border translate-y-1'
                : 'top-full border-r border-b border-border -translate-y-1'
            }`}
            aria-hidden="true"
          />
        </div>,
        document.body
      )}
    </span>
  );
}
