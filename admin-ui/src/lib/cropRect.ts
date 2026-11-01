import type { Area } from 'react-easy-crop';

/**
 * The part of the image inside the crop box, in natural pixels. `pct` is the
 * crop box relative to the image (x/y/width/height in %, may run past the
 * edges when zoomed out or dragged); the result is clipped to the image.
 */
export function visibleCropRect(pct: Area, naturalWidth: number, naturalHeight: number): Area {
  const left = Math.max(0, (pct.x / 100) * naturalWidth);
  const top = Math.max(0, (pct.y / 100) * naturalHeight);
  const right = Math.min(naturalWidth, ((pct.x + pct.width) / 100) * naturalWidth);
  const bottom = Math.min(naturalHeight, ((pct.y + pct.height) / 100) * naturalHeight);
  const x = Math.round(left);
  const y = Math.round(top);
  return {
    x,
    y,
    width: Math.max(1, Math.round(right) - x),
    height: Math.max(1, Math.round(bottom) - y),
  };
}
