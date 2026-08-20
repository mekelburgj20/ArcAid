import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import HorizontalScrollNav from '../HorizontalScrollNav';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * Owner field report (2026-08-15): in the Settings preview's Phone view, a
 * full-height dark "click here to scroll" gradient overlay appeared and did
 * not belong to the phone frame at all.
 *
 * Two causes, both covered here:
 *   1. The arrows are a desktop mouse-hover affordance. On a phone you swipe
 *      the row; a full-height overlay just covers the cards it claims to help
 *      you reach. They must not render at <=640px.
 *   2. They are `position: fixed` and were portalled to the TOP-LEVEL
 *      `document.body`, so inside the preview iframe they escaped the frame
 *      and painted over the admin page, sized to the wrong viewport. They
 *      must portal into the document that owns the component.
 */
function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  window.matchMedia = ((query: string) => ({
    matches: /max-width:\s*640px/.test(query) ? width <= 640 : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

/** Makes the scroller report overflow so `canRight` becomes true. */
function makeScrollable(container: HTMLElement) {
  const scroller = container.querySelector('[role="region"]') as HTMLElement;
  Object.defineProperty(scroller, 'scrollWidth', { value: 3000, configurable: true });
  Object.defineProperty(scroller, 'clientWidth', { value: 800, configurable: true });
  Object.defineProperty(scroller, 'scrollLeft', { value: 0, configurable: true, writable: true });
  const wrapper = scroller.parentElement as HTMLElement;
  wrapper.getBoundingClientRect = () => ({
    top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  return { scroller, wrapper };
}

/** Hovers the right edge, which is what reveals the right-hand arrow. */
function hoverRightEdge() {
  act(() => {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX: 799, clientY: 200, bubbles: true }));
  });
}

const originalMatchMedia = window.matchMedia;
const originalWidth = window.innerWidth;

describe('HorizontalScrollNav', () => {
  beforeEach(() => setViewport(1280));
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
    Object.defineProperty(window, 'innerWidth', { value: originalWidth, configurable: true, writable: true });
  });

  it('shows the scroll arrow on a desktop-width viewport', () => {
    const { container } = render(<HorizontalScrollNav><div style={{ width: 3000 }}>cards</div></HorizontalScrollNav>);
    makeScrollable(container);
    fireEvent.scroll(container.querySelector('[role="region"]')!);
    hoverRightEdge();

    expect(screen.getByRole('button', { name: 'Scroll right' })).toBeInTheDocument();
  });

  it('renders NO arrows at phone width, however much there is to scroll', () => {
    setViewport(390);
    const { container } = render(<HorizontalScrollNav><div style={{ width: 3000 }}>cards</div></HorizontalScrollNav>);
    makeScrollable(container);
    fireEvent.scroll(container.querySelector('[role="region"]')!);
    hoverRightEdge();

    expect(screen.queryByRole('button', { name: 'Scroll right' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll left' })).not.toBeInTheDocument();
  });

  it('portals the arrow into the document that owns the component', () => {
    const { container } = render(<HorizontalScrollNav><div style={{ width: 3000 }}>cards</div></HorizontalScrollNav>);
    const { wrapper } = makeScrollable(container);
    fireEvent.scroll(container.querySelector('[role="region"]')!);
    hoverRightEdge();

    const arrow = screen.getByRole('button', { name: 'Scroll right' });
    // Same document as the component — in the Settings preview this is the
    // iframe's document, not the admin page's.
    expect(arrow.ownerDocument).toBe(wrapper.ownerDocument);
    expect(arrow.parentElement).toBe(wrapper.ownerDocument.body);
  });

  /**
   * v2.118.0 — the admin Leaderboard page turns the arrows OFF. The right-hand
   * arrow is sized `viewportWidth - wrapper.right + zone`, i.e. it covers
   * everything to the right of the cards, which on that page is the
   * display-settings rail: the overlay sat on top of the rail and ate its
   * clicks. Default (public page, kiosk) is unchanged.
   */
  it('renders NO arrows with showArrows={false}, even overflowing and hovered', () => {
    const { container } = render(
      <HorizontalScrollNav showArrows={false}><div style={{ width: 3000 }}>cards</div></HorizontalScrollNav>,
    );
    makeScrollable(container);
    fireEvent.scroll(container.querySelector('[role="region"]')!);
    hoverRightEdge();

    expect(screen.queryByRole('button', { name: 'Scroll right' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scroll left' })).not.toBeInTheDocument();
    // The scroll region itself is untouched — drag-to-scroll and the keyboard
    // path are the same as ever.
    expect(screen.getByRole('region')).toBeInTheDocument();
  });

  it('reports scroller geometry through onScrollMetrics', () => {
    const onScrollMetrics = vi.fn();
    const { container } = render(
      <HorizontalScrollNav onScrollMetrics={onScrollMetrics}><div style={{ width: 3000 }}>cards</div></HorizontalScrollNav>,
    );
    const { scroller } = makeScrollable(container);
    fireEvent.scroll(scroller);

    expect(onScrollMetrics).toHaveBeenCalled();
    const last = onScrollMetrics.mock.calls.at(-1)![0];
    // left/width describe the WRAPPER, not the negatively-margined scroll
    // element — a scrollbar drawn from them must not run under the rail.
    expect(last).toMatchObject({ scrollLeft: 0, scrollWidth: 3000, clientWidth: 800, left: 0, width: 800 });

    Object.defineProperty(scroller, 'scrollLeft', { value: 250, configurable: true, writable: true });
    fireEvent.scroll(scroller);
    expect(onScrollMetrics.mock.calls.at(-1)![0].scrollLeft).toBe(250);
  });

  it('still renders its children and keeps the scroll region accessible', () => {
    render(<HorizontalScrollNav ariaLabel="Game cards"><div>cards</div></HorizontalScrollNav>);
    expect(screen.getByText('cards')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Game cards' })).toBeInTheDocument();
  });
});
