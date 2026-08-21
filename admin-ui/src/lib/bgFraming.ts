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

/**
 * v2.119.0 (C2) — the floor dropped 100 → 50 so an admin can zoom OUT.
 * Below 100 the card's own background shows through around the art. That is
 * deliberate: the editor previews on the REAL card, so the gaps are visible
 * truth and the owner's eye decides per game.
 *
 * v2.122.1 — 50 → 10. With the cover model (below) zoom-out finally REVEALS the
 * source, and 50 was not enough range to reach "the whole picture" for the art
 * that needs it most: a 3:1 strip on a 1:2 card fits at ~16%, so a floor of 50
 * capped the feature well short of its own purpose. Storage is unchanged
 * (migration 154's three columns); only the bounds moved, and every stored row
 * is >= 50, so nothing existing re-clamps.
 */
export const BG_ZOOM_MIN = 10;
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

/* ────────────────────────────────────────────────────────────────────────────
 * v2.122.1 — the COVER-FRAMING model, replacing the transform above.
 *
 * The transform model sized the layer `cover` and then scaled the LAYER. That
 * is right for zoom >= 100 and wrong below it: the browser clips the background
 * to the layer's own box first, so `scale(0.5)` shrank the CROP — the same
 * slice of art, smaller, with the card showing around it. What the owner asked
 * for (and what every image editor does) is the opposite: zooming out reveals
 * MORE of the source image.
 *
 * So the displayed image size is computed instead of transformed:
 *
 *     dispW x dispH = coverSize(card, image) * zoom/100
 *
 * and it is placed with a plain CSS background-position percentage, whose
 * definition is exactly the formula we want and which is valid whether the
 * image overflows the card or sits inside it:
 *
 *     left = (cardW - dispW) * posX/100        top = (cardH - dispH) * posY/100
 *
 * At zoom >= 100 this renders IDENTICALLY to the transform model (proved in
 * `bgFramingCover.test.ts`): both put the image's left edge at
 * posX/100 * (cardW - coverW*zoom) at width coverW*zoom. So every stored
 * framing keeps its meaning and no room's cards move. Below 100 the short axis
 * gets honest bars and the whole source is visible.
 *
 * Needs the image's intrinsic size and the card's box, so the render path is a
 * hook (`components/scoreboard/useCoverFraming.ts`) and this is the pure core
 * it calls once both are known.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface CoverFramingGeometry {
  /** The layer's own box — the card's fill area. */
  cardW: number;
  cardH: number;
  /** The image as displayed, after cover-fit and zoom. */
  dispW: number;
  dispH: number;
}

export interface CoverFramingResult {
  style: CSSProperties;
  geometry: CoverFramingGeometry;
}

/** `background-size: cover` in numbers: the smallest scale that covers the box. */
export function coverScale(cardW: number, cardH: number, imgW: number, imgH: number): number {
  if (!(imgW > 0) || !(imgH > 0)) return 1;
  return Math.max(cardW / imgW, cardH / imgH);
}

/**
 * The fill layer's style for a KNOWN card box and image size. Pure, so the
 * model is unit-testable without a DOM.
 */
export function coverFramingStyle(
  cardW: number,
  cardH: number,
  imgW: number,
  imgH: number,
  f: BgFraming | null | undefined,
): CoverFramingResult {
  const { zoom, posX, posY } = resolveFraming(f);
  const scale = coverScale(cardW, cardH, imgW, imgH) * (zoom / 100);
  const dispW = imgW * scale;
  const dispH = imgH * scale;
  const px = (n: number) => `${Math.round(n * 100) / 100}px`;
  return {
    style: {
      backgroundSize: `${px(dispW)} ${px(dispH)}`,
      // The percentage IS the placement formula — no manual left/top, and no
      // transform, so the layer's own box stays the card's box and stays
      // measurable.
      backgroundPosition: `${posX}% ${posY}%`,
      backgroundRepeat: 'no-repeat',
    },
    geometry: { cardW, cardH, dispW, dispH },
  };
}

/**
 * One axis of the on-card drag: where `startPos` (a background-position
 * percentage) must move for the PICTURE to follow the pointer by `deltaPx`.
 *
 * Differentiating `offset = (cardSize - dispSize) * pos/100` gives
 * `dPos = deltaPx / (cardSize - dispSize) * 100`. The denominator is NEGATIVE
 * when the image overflows the card and POSITIVE when it sits inside it, so
 * the sign flips on its own — which is the whole bug: v1 hard-coded the
 * overflow sign (subtraction), so every zoomed-OUT drag ran backwards.
 *
 * On an axis where the image exactly fits there is nothing to move, and the
 * formula would divide by zero, so it is a no-op.
 */
export function dragFramingPos(startPos: number, deltaPx: number, cardSize: number, dispSize: number): number {
  const denom = cardSize - dispSize;
  if (!Number.isFinite(denom) || Math.abs(denom) < 0.5) return startPos;
  return clamp(startPos + (deltaPx / denom) * 100, 0, 100);
}

export interface FitWholeImage {
  /** The zoom to store: snapped to `step`, never above `exact`, clamped to the bounds. */
  zoom: number;
  /** The unrounded ratio, for honesty about whether it was reachable. */
  exact: number;
  /** True when the floor stopped us short — the picture still overflows. */
  clamped: boolean;
}

/**
 * v2.122.1 — "Fit whole image": the zoom at which the ENTIRE source is inside
 * the card, letterboxed on the short axis.
 *
 * Zoom is expressed relative to the COVER fit (100 = cover), so the contain fit
 * is simply the ratio between the two scales:
 *
 *     fit% = 100 * min(cardW/imgW, cardH/imgH) / max(cardW/imgW, cardH/imgH)
 *
 * which is 100 whenever the image and the card share an aspect ratio (cover IS
 * contain), and drops as they diverge — ~16 for a 3:1 strip on a 1:2 card.
 * Only the two ASPECTS matter, so any proportional image size works, which is
 * what lets the caller pass the displayed size straight off the layer.
 *
 * Snapped DOWN to the slider step: a value a hair above the exact ratio would
 * clip a sliver of the picture, and "fit" that clips is not a fit.
 */
export function fitWholeImageZoom(
  cardW: number, cardH: number, imgW: number, imgH: number, step = 1,
): FitWholeImage | null {
  if (![cardW, cardH, imgW, imgH].every(n => Number.isFinite(n) && n > 0)) return null;
  const sx = cardW / imgW;
  const sy = cardH / imgH;
  const exact = (Math.min(sx, sy) / Math.max(sx, sy)) * 100;
  const snapped = Math.floor(exact / step) * step;
  const zoom = clamp(snapped, BG_ZOOM_MIN, BG_ZOOM_MAX);
  return { zoom, exact, clamped: zoom > exact };
}
