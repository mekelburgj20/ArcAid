import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import FixedHScrollbar from '../FixedHScrollbar';
import type { HScrollMetrics } from '../../HorizontalScrollNav';

/**
 * v2.118.0 — the admin Leaderboard page's scroll affordance.
 *
 * The card strip hides its native scrollbar by design, and the edge-hover
 * arrows that replaced it had to be switched off on that page (the right-hand
 * one covered the display-settings rail and ate its clicks). This bar is what
 * is left, so its geometry has to be right: it spans the SURFACE column only,
 * and it disappears entirely when there is nothing to scroll.
 */

const metrics = (over: Partial<HScrollMetrics> = {}): HScrollMetrics => ({
  scrollLeft: 0, scrollWidth: 2000, clientWidth: 1000, left: 40, width: 1000, ...over,
});

describe('FixedHScrollbar', () => {
  it('renders nothing without metrics, when hidden, or with no overflow', () => {
    const { rerender } = render(<FixedHScrollbar metrics={null} onScrollTo={vi.fn()} />);
    expect(screen.queryByTestId('fixed-hscrollbar')).not.toBeInTheDocument();

    rerender(<FixedHScrollbar metrics={metrics()} onScrollTo={vi.fn()} hidden />);
    expect(screen.queryByTestId('fixed-hscrollbar')).not.toBeInTheDocument();

    // scrollWidth <= clientWidth + 1 → the strip fits, so no bar.
    rerender(<FixedHScrollbar metrics={metrics({ scrollWidth: 1000 })} onScrollTo={vi.fn()} />);
    expect(screen.queryByTestId('fixed-hscrollbar')).not.toBeInTheDocument();
  });

  it('spans only the surface column, never the full viewport', () => {
    render(<FixedHScrollbar metrics={metrics()} onScrollTo={vi.fn()} />);
    const track = screen.getByTestId('fixed-hscrollbar');
    expect(track.style.left).toBe('40px');
    expect(track.style.width).toBe('1000px');
    expect(track.style.bottom).toBe('0px');
  });

  it('sizes and positions the thumb from the scroll geometry', () => {
    const { rerender } = render(<FixedHScrollbar metrics={metrics()} onScrollTo={vi.fn()} />);
    const thumb = () => screen.getByTestId('fixed-hscrollbar-thumb');
    // half the content is visible → half-width thumb, parked at the left.
    expect(thumb().style.width).toBe('500px');
    expect(thumb().style.marginLeft).toBe('0px');

    // Scrolled to the end → thumb at the end of its travel (1000 - 500).
    rerender(<FixedHScrollbar metrics={metrics({ scrollLeft: 1000 })} onScrollTo={vi.fn()} />);
    expect(thumb().style.marginLeft).toBe('500px');

    // A very long strip still leaves a grabbable thumb.
    rerender(<FixedHScrollbar metrics={metrics({ scrollWidth: 100000 })} onScrollTo={vi.fn()} />);
    expect(parseInt(thumb().style.width, 10)).toBeGreaterThanOrEqual(44);
  });

  it('reports the exposed scroll percentage to assistive tech', () => {
    render(<FixedHScrollbar metrics={metrics({ scrollLeft: 500 })} onScrollTo={vi.fn()} />);
    const track = screen.getByTestId('fixed-hscrollbar');
    expect(track).toHaveAttribute('role', 'scrollbar');
    expect(track).toHaveAttribute('aria-valuenow', '50');
  });

  it('scrolls the strip when the thumb is dragged', () => {
    const onScrollTo = vi.fn();
    render(<FixedHScrollbar metrics={metrics()} onScrollTo={onScrollTo} />);
    const thumb = screen.getByTestId('fixed-hscrollbar-thumb');

    fireEvent.pointerDown(thumb, { pointerId: 1, clientX: 100 });
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 350 });
    // 250px of a 500px travel → half of the 1000px scrollable range.
    expect(onScrollTo).toHaveBeenLastCalledWith(500);

    // Past the end clamps rather than overscrolling.
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 5000 });
    expect(onScrollTo).toHaveBeenLastCalledWith(1000);

    fireEvent.pointerUp(thumb, { pointerId: 1 });
    onScrollTo.mockClear();
    fireEvent.pointerMove(thumb, { pointerId: 1, clientX: 120 });
    expect(onScrollTo).not.toHaveBeenCalled();
  });

  it('page-jumps on a track click', () => {
    const onScrollTo = vi.fn();
    render(<FixedHScrollbar metrics={metrics()} onScrollTo={onScrollTo} />);
    // Click at viewport x=790 → 790-40-250 = 500 of 500 travel → the far end.
    fireEvent.pointerDown(screen.getByTestId('fixed-hscrollbar'), { clientX: 790 });
    expect(onScrollTo).toHaveBeenLastCalledWith(1000);
  });

  it('does not page-jump when the grab starts on the thumb', () => {
    const onScrollTo = vi.fn();
    render(<FixedHScrollbar metrics={metrics()} onScrollTo={onScrollTo} />);
    fireEvent.pointerDown(screen.getByTestId('fixed-hscrollbar-thumb'), { pointerId: 1, clientX: 100, bubbles: true });
    expect(onScrollTo).not.toHaveBeenCalled();
  });
});
