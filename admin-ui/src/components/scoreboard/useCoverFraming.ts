import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { bgTransformStyle, coverFramingStyle, type BgFraming, type CoverFramingGeometry } from '../../lib/bgFraming';

/**
 * v2.122.1 — the render half of the cover-framing model (the maths lives in
 * `lib/bgFraming.ts`, pure and unit-tested).
 *
 * The model needs two things CSS alone can't give a `background-size` string:
 * the image's INTRINSIC size and the layer's own box. This hook supplies both.
 *
 *  - the image is loaded once per URL and cached module-wide, so a board of 12
 *    cards sharing one art pack decodes its header exactly once and a re-render
 *    never re-measures;
 *  - the box is measured with a `ResizeObserver` on the layer itself. The layer
 *    is `absolute inset-0` inside the card's clipping box, so its own border
 *    box IS the card's fill area — no separate container ref to thread through
 *    four card components, and no `getBoundingClientRect` (which would be
 *    wrong: the fallback path below still applies a `transform`, and a scaled
 *    rect is not a layout box). `offsetWidth/Height` are transform-free.
 *
 * Until BOTH are known it returns the legacy `cover` + transform style, which
 * is what the card renders today — so nothing flashes, nothing jumps, and a
 * jsdom test that never fires an image load keeps the old behaviour.
 *
 * The measured geometry is also published on the layer as data attributes, and
 * that is deliberate: the admin drag overlay is rendered by a DIFFERENT
 * component (the Leaderboard page, as a sibling of the card) and needs the live
 * numbers on pointerdown to get the drag's SIGN right. A DOM read of the layer
 * it is dragging is the smallest coupling that works for all four card types.
 */

const naturalCache = new Map<string, { w: number; h: number }>();

export const BG_FRAMING_LAYER_ATTR = 'data-bg-framing-layer';

export interface CoverFramingLayer {
  /** Attach to the fill layer itself. */
  ref: (el: HTMLElement | null) => void;
  /** Spread AFTER `backgroundImage` on the layer's style. */
  style: CSSProperties;
  /** Spread on the layer: marks it findable and publishes the live geometry. */
  data: Record<string, string | number>;
  /** Null until the image and the box have both been measured. */
  geometry: CoverFramingGeometry | null;
}

/**
 * Reads the geometry a `useCoverFraming` layer published, for a component that
 * only has the DOM (the admin drag overlay). Returns null when the layer has
 * not been measured yet — the caller then falls back to its own estimate.
 */
export function readLayerGeometry(layer: Element | null | undefined): CoverFramingGeometry | null {
  if (!layer) return null;
  const num = (name: string) => Number((layer as HTMLElement).getAttribute(name));
  const cardW = num('data-bg-card-w');
  const cardH = num('data-bg-card-h');
  const dispW = num('data-bg-disp-w');
  const dispH = num('data-bg-disp-h');
  if (![cardW, cardH, dispW, dispH].every(n => Number.isFinite(n) && n > 0)) return null;
  return { cardW, cardH, dispW, dispH };
}

export function useCoverFraming(
  imageUrl: string | null | undefined,
  framing: BgFraming | null | undefined,
): CoverFramingLayer {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [box, setBox] = useState<{ w: number; h: number } | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(
    imageUrl ? naturalCache.get(imageUrl) ?? null : null,
  );

  // -- the layer's own box ------------------------------------------------
  useEffect(() => {
    if (!node) { setBox(null); return; }
    const read = () => {
      const w = node.offsetWidth;
      const h = node.offsetHeight;
      setBox(prev => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(read);
    ro.observe(node);
    return () => ro.disconnect();
  }, [node]);

  // -- the image's intrinsic size ----------------------------------------
  useEffect(() => {
    if (!imageUrl) { setNatural(null); return; }
    const cached = naturalCache.get(imageUrl);
    if (cached) { setNatural(cached); return; }
    if (typeof Image === 'undefined') return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      const dims = { w: img.naturalWidth, h: img.naturalHeight };
      if (!(dims.w > 0) || !(dims.h > 0)) return;
      naturalCache.set(imageUrl, dims);
      if (!cancelled) setNatural(dims);
    };
    // A broken URL simply never measures -> the legacy fallback keeps drawing.
    img.src = imageUrl;
    return () => { cancelled = true; };
  }, [imageUrl]);

  const measurable = !!(box && natural && box.w > 0 && box.h > 0);
  const resolved = measurable ? coverFramingStyle(box!.w, box!.h, natural!.w, natural!.h, framing) : null;

  const data: Record<string, string | number> = { [BG_FRAMING_LAYER_ATTR]: '' };
  if (resolved) {
    data['data-bg-card-w'] = Math.round(resolved.geometry.cardW * 100) / 100;
    data['data-bg-card-h'] = Math.round(resolved.geometry.cardH * 100) / 100;
    data['data-bg-disp-w'] = Math.round(resolved.geometry.dispW * 100) / 100;
    data['data-bg-disp-h'] = Math.round(resolved.geometry.dispH * 100) / 100;
  }

  return {
    ref: setNode,
    style: resolved
      ? resolved.style
      : { backgroundSize: 'cover', backgroundRepeat: 'no-repeat', ...bgTransformStyle(framing) },
    data,
    geometry: resolved ? resolved.geometry : null,
  };
}
