import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { TourStep } from '../lib/tourSteps';

/**
 * v2.48.0 — first-login player tutorial overlay
 * (docs/contracts/first-login-tutorial-contract.md). Spotlight-cutout technique (a
 * fixed-position div sized to the target's getBoundingClientRect() with a
 * giant box-shadow, no SVG mask) + an adjacent tooltip bubble. Portal to
 * document.body at z-[100] — above the z-50 modals/toasts, following the
 * Tooltip.tsx portal precedent. Focus trap + restore mirrors
 * GameQuickView.tsx's hand-rolled Tab-loop pattern.
 *
 * Owns step navigation AND the finish/skip persistence writes (POST
 * /me/tutorial-status, or the sessionStorage-only dismissal) — the caller
 * (TourController) only decides whether to render this at all.
 */

const DISMISSED_KEY = 'arcaid_tutorial_dismissed';
const SPOTLIGHT_PADDING = 8;
const TOOLTIP_WIDTH = 320;
const TOOLTIP_GAP = 12;

async function postTutorialSeen(playerToken: string): Promise<void> {
  try {
    await fetch('/api/me/tutorial-status', {
      method: 'POST',
      headers: { Authorization: `Bearer ${playerToken}` },
    });
  } catch {
    // Best effort — a failed mark-seen just means the tour may resurface
    // on a later visit. Never block dismissal on this call.
  }
}

interface TourOverlayProps {
  steps: TourStep[];
  playerToken: string;
  /** Called once the tour is done being shown, for any reason (finish, skip). */
  onClose: () => void;
}

export default function TourOverlay({ steps, playerToken, onClose }: TourOverlayProps) {
  // null = not yet resolved. Steps whose anchor doesn't exist in the DOM are
  // skipped entirely (contract: "skip this step entirely if no such element
  // exists ... do NOT navigate them"). Resolved in an *effect*, not during
  // render — an anchor mounted in the same commit as this component (e.g.
  // game-card-title on a freshly-mounted scoreboard page) isn't in the real
  // DOM yet during the render phase, only after commit.
  const [visibleSteps, setVisibleSteps] = useState<TourStep[] | null>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [dontShowAgain, setDontShowAgain] = useState(true);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const primaryBtnRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const hasFocusedRef = useRef(false);

  const handleFinish = () => {
    postTutorialSeen(playerToken).finally(onClose);
  };

  const handleSkip = () => {
    if (dontShowAgain) {
      postTutorialSeen(playerToken).finally(onClose);
    } else {
      sessionStorage.setItem(DISMISSED_KEY, '1');
      onClose();
    }
  };

  useEffect(() => {
    setVisibleSteps(steps.filter(s => typeof document !== 'undefined' && !!document.querySelector(s.selector)));
  }, [steps]);

  // Nothing to anchor to at all (e.g. every anchor missing) — treat as
  // finished so it doesn't nag on every subsequent visit.
  useEffect(() => {
    if (visibleSteps !== null && visibleSteps.length === 0) {
      postTutorialSeen(playerToken).finally(onClose);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSteps]);

  // Track the current step's target rect; recompute on step change + resize.
  // scrollIntoView first — the mobile nav strip scrolls horizontally, so a
  // target can be off-screen.
  useEffect(() => {
    if (!visibleSteps || visibleSteps.length === 0) return;
    const step = visibleSteps[stepIndex];
    if (!step) return;
    const el = document.querySelector<HTMLElement>(step.selector);
    if (!el) return;
    el.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    const update = () => setRect(el.getBoundingClientRect());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [stepIndex, visibleSteps]);

  // Initial focus into the dialog (once it first appears) + focus-return to
  // the trigger on close — GameQuickView.tsx's pattern.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  // Initial focus lands on the PRIMARY action (Next), not the first button in
  // DOM order (Skip) — focusing the bail-out first read as an ugly default
  // outline box in the screenshot pass, and Next is what most users press.
  useEffect(() => {
    if (!visibleSteps || visibleSteps.length === 0 || hasFocusedRef.current) return;
    hasFocusedRef.current = true;
    primaryBtnRef.current?.focus();
  }, [visibleSteps]);

  // Focus trap (Tab loop) + Esc = Skip (respecting the checkbox state).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleSkip();
        return;
      }
      if (e.key !== 'Tab' || !dialogRef.current) return;
      const focusables = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dontShowAgain, stepIndex, visibleSteps]);

  if (!visibleSteps || visibleSteps.length === 0) return null;

  const step = visibleSteps[stepIndex];
  const isLast = stepIndex === visibleSteps.length - 1;

  const handleNext = () => {
    if (isLast) handleFinish();
    else setStepIndex(i => i + 1);
  };
  const handleBack = () => setStepIndex(i => Math.max(0, i - 1));

  const spotlightStyle: CSSProperties = rect
    ? {
        top: rect.top - SPOTLIGHT_PADDING,
        left: rect.left - SPOTLIGHT_PADDING,
        width: rect.width + SPOTLIGHT_PADDING * 2,
        height: rect.height + SPOTLIGHT_PADDING * 2,
      }
    : { top: '50%', left: '50%', width: 0, height: 0 };

  // Placement: steps may prefer 'right' (game card — a bubble below would
  // cover the very card being spotlighted). Right placement needs horizontal
  // room; phones fall back to the below/above heuristic. Default: below the
  // target unless there's not enough room below AND more room above.
  const placeRight =
    !!rect &&
    step.placement === 'right' &&
    rect.right + SPOTLIGHT_PADDING + TOOLTIP_GAP + TOOLTIP_WIDTH <= window.innerWidth - 12;
  const spaceBelow = rect ? window.innerHeight - rect.bottom : 0;
  const spaceAbove = rect ? rect.top : 0;
  const placeAbove = !placeRight && !!rect && spaceBelow < 180 && spaceAbove > spaceBelow;
  const tooltipTop = rect
    ? placeRight
      ? Math.max(12, rect.top - SPOTLIGHT_PADDING)
      : placeAbove
        ? rect.top - TOOLTIP_GAP
        : rect.bottom + TOOLTIP_GAP
    : window.innerHeight / 2;
  const tooltipLeft = rect
    ? placeRight
      ? rect.right + SPOTLIGHT_PADDING + TOOLTIP_GAP
      : Math.min(Math.max(rect.left, 12), Math.max(12, window.innerWidth - TOOLTIP_WIDTH - 12))
    : 12;

  return createPortal(
    <>
      <div
        aria-hidden="true"
        className="tour-overlay-spotlight fixed pointer-events-none z-[100] rounded-lg"
        style={{ ...spotlightStyle, boxShadow: '0 0 0 9999px rgba(0,0,0,0.7)' }}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Welcome tour"
        className="tour-overlay-dialog fixed z-[100] w-80 max-w-[calc(100vw-24px)] bg-surface border border-border rounded-lg shadow-2xl p-4"
        style={{
          top: tooltipTop,
          left: tooltipLeft,
          transform: placeAbove ? 'translateY(-100%)' : undefined,
        }}
      >
        <p className="text-[10px] text-neon-cyan font-medium mb-1">
          Step {stepIndex + 1} of {visibleSteps.length}
        </p>
        <h3 className="font-display text-sm font-bold text-primary mb-1">{step.title}</h3>
        <p className="text-xs text-muted mb-3">{step.body}</p>

        <div className="flex items-center justify-center gap-1.5 mb-3">
          {visibleSteps.map((s, i) => (
            <span
              key={s.key}
              className={`w-1.5 h-1.5 rounded-full ${i === stepIndex ? 'bg-neon-cyan' : 'bg-border'}`}
            />
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-[11px] text-faint mb-3 cursor-pointer">
          <input
            type="checkbox"
            checked={dontShowAgain}
            onChange={e => setDontShowAgain(e.target.checked)}
            className="cursor-pointer"
          />
          Don't show this again
        </label>

        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={handleSkip}
            className="text-xs text-faint hover:text-neon-magenta transition-colors bg-transparent border-0 p-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60 rounded"
          >
            Skip tour
          </button>
          <div className="flex items-center gap-2">
            {stepIndex > 0 && (
              <button
                type="button"
                onClick={handleBack}
                className="px-3 py-1.5 text-xs rounded border border-border text-muted hover:text-primary transition-colors cursor-pointer bg-transparent focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60"
              >
                Back
              </button>
            )}
            <button
              ref={primaryBtnRef}
              type="button"
              onClick={handleNext}
              className="px-3 py-1.5 text-xs rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-neon-cyan/60"
            >
              {isLast ? 'Finish' : 'Next'}
            </button>
          </div>
        </div>
      </div>
      <style>{`
        .tour-overlay-spotlight, .tour-overlay-dialog {
          transition: top 0.2s ease, left 0.2s ease, width 0.2s ease, height 0.2s ease;
        }
        @media (prefers-reduced-motion: reduce) {
          .tour-overlay-spotlight, .tour-overlay-dialog {
            transition: none !important;
            animation: none !important;
          }
        }
      `}</style>
    </>,
    document.body,
  );
}
