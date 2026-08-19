import type { CSSProperties } from 'react';

/**
 * Per-game background framing (v2.115.0).
 *
 * An admin zooms into a game's card background and drags it into place; the
 * result rides on the leaderboard row as three numbers rather than a recropped
 * image. NULL on any axis means "not framed" and renders at the default, which
 * is byte-identical to the pre-v2.115 `cover` + `center` look — so a room that
 * never touches the control sees no change at all.
 *
 * ONE helper for all four cards on purpose: `transformOrigin` has to track
 * `backgroundPosition` or zooming walks the image off its own anchor, and that
 * is exactly the kind of rule that rots when it is copied four times.
 */

export interface BgFraming {
  bgZoom?: number | null;
  bgPosX?: number | null;
  bgPosY?: number | null;
}

export const DEFAULT_BG_ZOOM = 100;
export const DEFAULT_BG_POS = 50;

export const BG_ZOOM_MIN = 100;
export const BG_ZOOM_MAX = 300;

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

/** Stored value → the number to render with, defaults applied. */
export function resolveFraming(f: BgFraming | null | undefined): { zoom: number; posX: number; posY: number } {
  const num = (v: number | null | undefined, fallback: number) =>
    typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return {
    zoom: clamp(num(f?.bgZoom, DEFAULT_BG_ZOOM), BG_ZOOM_MIN, BG_ZOOM_MAX),
    posX: clamp(num(f?.bgPosX, DEFAULT_BG_POS), 0, 100),
    posY: clamp(num(f?.bgPosY, DEFAULT_BG_POS), 0, 100),
  };
}

/** True when the framing differs from the untouched default. */
export function hasFraming(f: BgFraming | null | undefined): boolean {
  const { zoom, posX, posY } = resolveFraming(f);
  return zoom !== DEFAULT_BG_ZOOM || posX !== DEFAULT_BG_POS || posY !== DEFAULT_BG_POS;
}

/**
 * The style fragment a card's background LAYER spreads over its own
 * `backgroundImage` / `backgroundSize: cover`. The layer's parent must clip
 * (`overflow: hidden`) — a scaled layer paints outside its box otherwise.
 */
export function bgTransformStyle(f: BgFraming | null | undefined): CSSProperties {
  const { zoom, posX, posY } = resolveFraming(f);
  const style: CSSProperties = { backgroundPosition: `${posX}% ${posY}%` };
  if (zoom !== DEFAULT_BG_ZOOM) {
    style.transform = `scale(${zoom / 100})`;
    // Anchored at the same point the background is positioned from, so zoom
    // magnifies what the admin dragged into view rather than the centre.
    style.transformOrigin = `${posX}% ${posY}%`;
  }
  return style;
}
