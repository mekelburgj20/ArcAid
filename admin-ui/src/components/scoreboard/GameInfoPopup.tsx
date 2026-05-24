import { useState, useRef, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Info, ExternalLink } from 'lucide-react';

interface GameInfoPopupProps {
  externalUrl?: string | null;
  notes?: string | null;
  size?: number;
  className?: string;
}

/**
 * Small "i" icon next to a game title that toggles a tooltip-style bubble
 * showing notes + an external URL.
 *
 * v2.13.13 — bubble now portals to document.body with fixed positioning
 * computed from the trigger button's bounding rect. Pre-fix the bubble was
 * absolutely-positioned inside the trigger's wrapper, which lived inside a
 * card with `overflow: hidden`, so the bubble was clipped at the card's
 * top edge and invisible to users. The click handler also now calls
 * preventDefault + stopPropagation to fully isolate from the parent <Link>'s
 * onClick (which would otherwise fire the GameQuickView modal in v2.13.12+).
 */
export default function GameInfoPopup({ externalUrl, notes, size = 14, className = '' }: GameInfoPopupProps) {
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);

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
          setOpen(!open);
        }}
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
