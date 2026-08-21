import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { dragFramingPos, type CoverFramingGeometry } from '../../lib/bgFraming';
import type { CardFraming } from './CardStyleEditor';
import { readLayerGeometry, BG_FRAMING_LAYER_ATTR } from './useCoverFraming';

/**
 * v2.124.0 (C3) — the on-card framing drag, lifted verbatim out of
 * `pages/Leaderboard.tsx` so the synthetic card in `CardStyleEditorSheet`
 * drags with exactly the same maths (and the same DOM contract) as a real card
 * on the admin board. Two implementations of "drag the art" is precisely the
 * divergence C2 existed to end.
 *
 * The drag needs the LIVE geometry, not just a box: how far a
 * background-position percentage moves the picture depends on the signed slack
 * between the card and the displayed image, which flips sign when the image is
 * smaller than the card (zoom < 100). The card publishes both on its fill layer
 * (`useCoverFraming`), so the overlay reads them off the DOM of the card it is
 * sitting on — the one coupling that works for all four card types without
 * threading a ref through public card components.
 */

export const CARD_EDIT_OVERLAY_TESTID = 'card-edit-overlay';

/**
 * Fallback when the layer hasn't measured yet (image still loading, or a mocked
 * card in jsdom): the CARD's own box, with the image assumed to overflow —
 * which is what the layer is still drawing in that window.
 */
function framingGeometry(overlay: HTMLElement): CoverFramingGeometry | null {
  const slot = overlay.parentElement;
  const measured = readLayerGeometry(slot?.querySelector(`[${BG_FRAMING_LAYER_ATTR}]`));
  if (measured) return measured;
  const card = slot?.firstElementChild as HTMLElement | null;
  let rect = card?.getBoundingClientRect();
  if (!rect || !rect.width || !rect.height) rect = overlay.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  return { cardW: rect.width, cardH: rect.height, dispW: rect.width * 2, dispH: rect.height * 2 };
}

export interface CardFramingDragOverlayProps {
  framing: CardFraming;
  /** Receives the new position pair; zoom is the slider's business. */
  onFramingPos: (posX: number, posY: number) => void;
  /** Named for the card it sits on, e.g. the game's display name. */
  cardLabel: string;
  /** Extra ref work the host wants on the same element (Leaderboard scrolls
   *  the spotlighted card into view exactly once). */
  elementRef?: (el: HTMLDivElement | null) => void;
  className?: string;
  style?: CSSProperties;
}

export default function CardFramingDragOverlay({
  framing,
  onFramingPos,
  cardLabel,
  elementRef,
  className = 'absolute inset-0 rounded-lg cursor-move touch-none ring-2 ring-neon-cyan ring-offset-2 ring-offset-transparent',
  style,
}: CardFramingDragOverlayProps) {
  const dragRef = useRef<
    { clientX: number; clientY: number; posX: number; posY: number } & CoverFramingGeometry | null
  >(null);

  const begin = (e: React.PointerEvent<HTMLDivElement>) => {
    // The strip lives inside HorizontalScrollNav, which drags to scroll on
    // pointerdown - the same reason the reorder grip stops propagation.
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const g = framingGeometry(e.currentTarget);
    if (!g) return;
    dragRef.current = {
      clientX: e.clientX, clientY: e.clientY,
      posX: framing.posX, posY: framing.posY,
      ...g,
    };
  };

  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    // The picture follows the pointer in BOTH axes; `dragFramingPos` derives
    // the sign from the geometry instead of assuming overflow, and no-ops the
    // axis where the image exactly fits (nothing to slide).
    const posX = dragFramingPos(start.posX, e.clientX - start.clientX, start.cardW, start.dispW);
    const posY = dragFramingPos(start.posY, e.clientY - start.clientY, start.cardH, start.dispH);
    onFramingPos(posX, posY);
  };

  const end = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      data-testid={CARD_EDIT_OVERLAY_TESTID}
      ref={elementRef}
      role="application"
      aria-label={`Drag to reposition the background art for ${cardLabel}`}
      title="Drag to reposition the background art"
      onPointerDown={begin}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onMouseDown={e => e.stopPropagation()}
      style={style}
      className={className}
    />
  );
}

/**
 * The edited card's LIVE fill geometry, mirrored into state so the editor can
 * offer "Fit whole image" with a real number on it.
 *
 * The card publishes it as data attributes (`useCoverFraming`) because the
 * measurement belongs to the card, not the panel; a MutationObserver is how a
 * sibling learns it changed. Scoped to `root` and to an open session,
 * coalesced into one animation frame, and torn down with the session — it
 * observes nothing when `sessionKey` is null.
 */
export function useFramingGeometry(
  sessionKey: string | null,
  root: RefObject<HTMLElement | null>,
): CoverFramingGeometry | null {
  const [geom, setGeom] = useState<CoverFramingGeometry | null>(null);
  useEffect(() => {
    if (!sessionKey) { setGeom(null); return; }
    let raf = 0;
    const read = () => {
      const overlay = document.querySelector(`[data-testid="${CARD_EDIT_OVERLAY_TESTID}"]`);
      const next = readLayerGeometry(overlay?.parentElement?.querySelector(`[${BG_FRAMING_LAYER_ATTR}]`));
      setGeom(prev => (
        prev && next && prev.cardW === next.cardW && prev.cardH === next.cardH
          && prev.dispW === next.dispW && prev.dispH === next.dispH ? prev : next
      ));
    };
    read();
    if (typeof MutationObserver === 'undefined') return;
    const obs = new MutationObserver(() => {
      if (typeof requestAnimationFrame === 'undefined') { read(); return; }
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(read);
    });
    obs.observe(root.current ?? document.body, {
      subtree: true, childList: true, attributes: true,
      attributeFilter: ['data-bg-card-w', 'data-bg-card-h', 'data-bg-disp-w', 'data-bg-disp-h'],
    });
    return () => {
      obs.disconnect();
      if (typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionKey]);
  return geom;
}
