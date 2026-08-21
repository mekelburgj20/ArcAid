import { describe, it, expect } from 'vitest';
import {
  coverFramingStyle, coverScale, dragFramingPos, bgTransformStyle, resolveFraming,
  fitWholeImageZoom, BG_ZOOM_MIN,
} from '../bgFraming';

/**
 * v2.122.1 — the cover-framing model.
 *
 * Two owner-reported defects live entirely in this maths:
 *
 *  1. zoom-out shrank the CROP instead of revealing the source. The transform
 *     model scaled a cover-sized layer, and the browser clips the background to
 *     the layer's box before the transform, so `scale(0.5)` shrank exactly what
 *     was already visible. The cover model computes the displayed size instead.
 *  2. the drag was inverted. v1 hard-coded the sign for an overflowing image;
 *     below 100% the image sits INSIDE the card and the sign flips.
 *
 * The load-bearing claim is that fixing (1) changes nothing that already
 * shipped: at zoom >= 100 the new model must render byte-identically to the old
 * one, because ~every stored framing in prod is >= 100. That is `legacyGeometry`
 * below — an independent re-derivation of the transform model, compared against
 * the new one rather than against a hand-copied constant.
 */

/** A wide art-pack strip (3:1) on a tall banner card — the owner's case. */
const CARD_W = 280;
const CARD_H = 560;
const IMG_W = 1500;
const IMG_H = 500;

/**
 * What the OLD model actually painted: a cover-sized background positioned at
 * posX/posY inside a card-sized layer, the whole layer then scaled about
 * `transform-origin: posX% posY%`.
 */
function legacyGeometry(cardW: number, cardH: number, imgW: number, imgH: number, f: Parameters<typeof resolveFraming>[0]) {
  const { zoom, posX, posY } = resolveFraming(f);
  const cover = Math.max(cardW / imgW, cardH / imgH);
  const coverW = imgW * cover;
  const coverH = imgH * cover;
  const z = zoom / 100;
  // Background-position percentage inside the untransformed layer.
  const left0 = (cardW - coverW) * (posX / 100);
  const top0 = (cardH - coverH) * (posY / 100);
  // transform-origin percentages are of the ELEMENT box (the layer = the card).
  const ox = cardW * (posX / 100);
  const oy = cardH * (posY / 100);
  return {
    left: ox + (left0 - ox) * z,
    top: oy + (top0 - oy) * z,
    width: coverW * z,
    height: coverH * z,
  };
}

/** The new model's placement, from the style it emits. */
function newGeometry(cardW: number, cardH: number, imgW: number, imgH: number, f: Parameters<typeof resolveFraming>[0]) {
  const { geometry } = coverFramingStyle(cardW, cardH, imgW, imgH, f);
  const { posX, posY } = resolveFraming(f);
  return {
    left: (geometry.cardW - geometry.dispW) * (posX / 100),
    top: (geometry.cardH - geometry.dispH) * (posY / 100),
    width: geometry.dispW,
    height: geometry.dispH,
  };
}

describe('coverFramingStyle — displayed size', () => {
  it('at zoom 100 is the cover fit: the card is exactly covered, the wide axis overflows', () => {
    const { geometry, style } = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 100, bgPosX: 50, bgPosY: 50 });
    // Cover on a 3:1 strip in a 1:2 card is driven by HEIGHT.
    expect(coverScale(CARD_W, CARD_H, IMG_W, IMG_H)).toBeCloseTo(CARD_H / IMG_H, 6);
    expect(geometry.dispH).toBeCloseTo(CARD_H, 6);
    expect(geometry.dispW).toBeCloseTo(IMG_W * (CARD_H / IMG_H), 6);
    expect(geometry.dispW).toBeGreaterThan(CARD_W);
    expect(style.backgroundPosition).toBe('50% 50%');
    expect(style.backgroundRepeat).toBe('no-repeat');
    expect(style.transform).toBeUndefined();
  });

  it('at zoom 50 twice as much of the source is visible, with honest bars on the short axis', () => {
    const full = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 100, bgPosX: 50, bgPosY: 50 }).geometry;
    const half = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 50, bgPosX: 50, bgPosY: 50 }).geometry;
    expect(half.dispW).toBeCloseTo(full.dispW * 0.5, 6);
    expect(half.dispH).toBeCloseTo(CARD_H * 0.5, 6);
    // THE FIX, stated as the owner stated it: the fraction of the SOURCE image
    // the card shows doubles. (It cannot reach 1 here — a 3:1 strip in a 1:2
    // card would need ~17% zoom, well under the 50 floor.)
    const visibleFractionAt = (g: typeof full) => Math.min(1, CARD_W / g.dispW);
    expect(visibleFractionAt(half)).toBeCloseTo(visibleFractionAt(full) * 2, 6);
    // ...and the short axis now shows the card through, top and bottom.
    expect(CARD_H - half.dispH).toBeCloseTo(CARD_H * 0.5, 6);
  });

  it('at zoom 150 both axes overflow — magnification, as before', () => {
    const { geometry } = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 150, bgPosX: 50, bgPosY: 50 });
    expect(geometry.dispW).toBeGreaterThan(CARD_W);
    expect(geometry.dispH).toBeGreaterThan(CARD_H);
    expect(geometry.dispH).toBeCloseTo(CARD_H * 1.5, 6);
  });

  it('emits a pixel background-size, never `cover`, once measured', () => {
    const { style } = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 120, bgPosX: 10, bgPosY: 90 });
    expect(String(style.backgroundSize)).toMatch(/^\d+(\.\d+)?px \d+(\.\d+)?px$/);
    expect(style.backgroundPosition).toBe('10% 90%');
  });
});

describe('backwards compatibility — zoom >= 100 renders exactly as the transform model did', () => {
  const CASES = [
    { bgZoom: 100, bgPosX: 50, bgPosY: 50 },
    { bgZoom: 100, bgPosX: 0, bgPosY: 100 },
    { bgZoom: 150, bgPosX: 25, bgPosY: 70 },
    { bgZoom: 300, bgPosX: 80, bgPosY: 10 },
    { bgZoom: null, bgPosX: null, bgPosY: null },   // unframed default = 100/50/50
  ];

  for (const f of CASES) {
    it(`matches for ${JSON.stringify(f)}`, () => {
      const legacy = legacyGeometry(CARD_W, CARD_H, IMG_W, IMG_H, f);
      const next = newGeometry(CARD_W, CARD_H, IMG_W, IMG_H, f);
      expect(next.width).toBeCloseTo(legacy.width, 6);
      expect(next.height).toBeCloseTo(legacy.height, 6);
      expect(next.left).toBeCloseTo(legacy.left, 6);
      expect(next.top).toBeCloseTo(legacy.top, 6);
    });
  }

  it('DIVERGES below 100 — that is the fix, not a regression', () => {
    const f = { bgZoom: 50, bgPosX: 50, bgPosY: 50 };
    const legacy = legacyGeometry(CARD_W, CARD_H, IMG_W, IMG_H, f);
    const next = newGeometry(CARD_W, CARD_H, IMG_W, IMG_H, f);
    // The painted SIZE agrees (same scale factor either way)...
    expect(next.width).toBeCloseTo(legacy.width, 6);
    expect(next.height).toBeCloseTo(legacy.height, 6);
    // ...but the old layer clipped the background to its own box BEFORE the
    // transform, so the visible art was the zoom-100 crop, shrunk. Its clipped
    // height is the card's own height scaled — never the image's.
    const legacyVisibleH = CARD_H * 0.5;
    expect(legacyVisibleH).toBeCloseTo(next.height, 6);   // coincidence on this axis...
    // ...and on X the difference is the whole point: the old model could only
    // ever show a card-width slice, the new one shows twice as much source.
    const legacyVisibleW = CARD_W * 0.5;
    expect(legacyVisibleW).toBeLessThan(Math.min(CARD_W, next.width));
  });

  it('the legacy style is still what the un-measured fallback emits', () => {
    // The hook renders this until the image and the box are both known.
    const fallback = bgTransformStyle({ bgZoom: 150, bgPosX: 25, bgPosY: 70 });
    expect(fallback.transform).toBe('scale(1.5)');
    expect(fallback.transformOrigin).toBe('25% 70%');
    expect(fallback.backgroundPosition).toBe('25% 70%');
  });
});

describe('dragFramingPos — the picture follows the pointer on both axes', () => {
  it('OVERFLOW axis: dragging right moves the image right, so the percentage falls', () => {
    // 3:1 strip at zoom 100 on the tall card: dispW ~ 1680 vs cardW 280.
    const { geometry } = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 100, bgPosX: 50, bgPosY: 50 });
    const next = dragFramingPos(50, +80, geometry.cardW, geometry.dispW);
    expect(next).toBeLessThan(50);
    // ...and the picture really did move right: left = (card - disp) * pos/100
    // with a negative factor, so a smaller pos is a larger left.
    const leftBefore = (geometry.cardW - geometry.dispW) * 0.5;
    const leftAfter = (geometry.cardW - geometry.dispW) * (next / 100);
    expect(leftAfter - leftBefore).toBeCloseTo(80, 6);
  });

  it('UNDERFLOW axis: the same drag raises the percentage — the sign is derived', () => {
    // At zoom 50 the image is INSIDE the card on both axes.
    const { geometry } = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 50, bgPosX: 50, bgPosY: 50 });
    const nextY = dragFramingPos(50, +40, geometry.cardH, geometry.dispH);
    expect(nextY).toBeGreaterThan(50);
    const topBefore = (geometry.cardH - geometry.dispH) * 0.5;
    const topAfter = (geometry.cardH - geometry.dispH) * (nextY / 100);
    expect(topAfter - topBefore).toBeCloseTo(40, 6);
  });

  it('is a NO-OP on an axis where the image exactly fits (no slack to slide)', () => {
    // Cover at zoom 100 makes the driving axis exactly the card's size.
    const { geometry } = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 100, bgPosX: 50, bgPosY: 50 });
    expect(geometry.dispH).toBeCloseTo(CARD_H, 6);
    expect(dragFramingPos(50, +120, geometry.cardH, geometry.dispH)).toBe(50);
  });

  it('clamps to 0..100 rather than running off the end', () => {
    expect(dragFramingPos(50, -100000, 280, 1680)).toBe(100);
    expect(dragFramingPos(50, +100000, 280, 1680)).toBe(0);
    expect(dragFramingPos(50, +100000, 280, 140)).toBe(100);
  });

  it('the v1 subtractive rule is what broke: it moves the WRONG way when zoomed out', () => {
    const { geometry } = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: 50, bgPosX: 50, bgPosY: 50 });
    const v1 = 50 - (40 / geometry.cardH) * 100;             // old maths, drag down
    const fixed = dragFramingPos(50, +40, geometry.cardH, geometry.dispH);
    expect(v1).toBeLessThan(50);      // image would go UP
    expect(fixed).toBeGreaterThan(50); // image goes DOWN, with the pointer
  });
});

describe('fitWholeImageZoom - the "Fit whole image" button', () => {
  it('a 3:1 strip on a 1:2 card fits at ~17%, snapped down to the step', () => {
    const fit = fitWholeImageZoom(CARD_W, CARD_H, IMG_W, IMG_H)!;
    // min(280/1500, 560/500) / max(...) = 0.1867 / 1.12 = 16.67%
    expect(fit.exact).toBeCloseTo(16.666, 2);
    expect(fit.zoom).toBe(16);          // DOWN, never up: 17 would clip a sliver
    expect(fit.clamped).toBe(false);
    // The whole picture really is inside the card at that zoom.
    const g = coverFramingStyle(CARD_W, CARD_H, IMG_W, IMG_H, { bgZoom: fit.zoom, bgPosX: 50, bgPosY: 50 }).geometry;
    expect(g.dispW).toBeLessThanOrEqual(CARD_W);
    expect(g.dispH).toBeLessThanOrEqual(CARD_H);
  });

  it('is 100 when the image and the card share an aspect - cover IS contain', () => {
    expect(fitWholeImageZoom(400, 400, 1000, 1000)!.zoom).toBe(100);   // square on square
    expect(fitWholeImageZoom(300, 600, 500, 1000)!.zoom).toBe(100);    // 1:2 art on a 1:2 card
  });

  it('a TALL image on a TALL card of the same shape needs no zoom-out', () => {
    const fit = fitWholeImageZoom(280, 560, 500, 1000)!;
    expect(fit.exact).toBeCloseTo(100, 6);
    expect(fit.zoom).toBe(100);
  });

  it('a tall image on a WIDE card zooms out by the same ratio, whichever way round', () => {
    const wideCard = fitWholeImageZoom(560, 280, 500, 1500)!;
    const tallCard = fitWholeImageZoom(280, 560, 1500, 500)!;
    expect(wideCard.exact).toBeCloseTo(tallCard.exact, 6);
  });

  it('reports `clamped` when the floor stops the fit short', () => {
    // A 12:1 banner on a 1:2 card wants ~4%, below the 10 floor.
    const fit = fitWholeImageZoom(280, 560, 2400, 200)!;
    expect(fit.exact).toBeLessThan(BG_ZOOM_MIN);
    expect(fit.zoom).toBe(BG_ZOOM_MIN);
    expect(fit.clamped).toBe(true);
  });

  it('takes the DISPLAYED size just as happily as the intrinsic one - only aspect matters', () => {
    const intrinsic = fitWholeImageZoom(CARD_W, CARD_H, IMG_W, IMG_H)!;
    // What the card publishes on its layer is the cover-scaled size (1680x560).
    const displayed = fitWholeImageZoom(CARD_W, CARD_H, 1680, 560)!;
    expect(displayed.exact).toBeCloseTo(intrinsic.exact, 6);
  });

  it('refuses nonsense rather than emitting NaN', () => {
    expect(fitWholeImageZoom(0, 560, 1500, 500)).toBeNull();
    expect(fitWholeImageZoom(280, 560, 1500, 0)).toBeNull();
  });
});

describe('the zoom floor', () => {
  it('is 10 as of v2.122.1 - 50 could not reach the fit it now offers', () => {
    expect(BG_ZOOM_MIN).toBe(10);
    // The owner's own case: a 3:1 strip on a 1:2 card fits at 16%, so a floor
    // of 50 capped "zoom out to see the picture" at a third of the way there.
    expect(fitWholeImageZoom(CARD_W, CARD_H, IMG_W, IMG_H)!.zoom).toBeLessThan(50);
  });

  it('resolveFraming clamps to it on read', () => {
    expect(resolveFraming({ bgZoom: 9, bgPosX: 50, bgPosY: 50 }).zoom).toBe(10);
    expect(resolveFraming({ bgZoom: 10, bgPosX: 50, bgPosY: 50 }).zoom).toBe(10);
  });
});
