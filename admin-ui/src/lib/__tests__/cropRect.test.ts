import { describe, it, expect } from 'vitest';
import { visibleCropRect } from '../../lib/cropRect';

// A 1200x400 logo (3:1) under a 1:1 crop box. react-easy-crop's own
// croppedAreaPixels would be a 400x400 square whatever the zoom; the saved
// image must instead be what the box shows.
describe('visibleCropRect', () => {
  it('zoomed out past the edges keeps the whole image at its own shape', () => {
    // Box is 150% of the image width, centred: x = -25%, width = 150%; and
    // 450% of its height.
    const r = visibleCropRect({ x: -25, y: -175, width: 150, height: 450 }, 1200, 400);
    expect(r).toEqual({ x: 0, y: 0, width: 1200, height: 400 });
  });

  it('zoomed in inside the image is the aspect-true square as before', () => {
    const r = visibleCropRect({ x: 33.333333, y: 0, width: 33.333333, height: 100 }, 1200, 400);
    expect(r).toEqual({ x: 400, y: 0, width: 400, height: 400 });
  });

  it('a box hanging off one edge saves only the part over the image', () => {
    const r = visibleCropRect({ x: 83.333333, y: 0, width: 33.333333, height: 100 }, 1200, 400);
    expect(r).toEqual({ x: 1000, y: 0, width: 200, height: 400 });
  });

  it('never returns an empty rectangle', () => {
    const r = visibleCropRect({ x: 150, y: 150, width: 10, height: 10 }, 1200, 400);
    expect(r.width).toBeGreaterThanOrEqual(1);
    expect(r.height).toBeGreaterThanOrEqual(1);
  });
});
