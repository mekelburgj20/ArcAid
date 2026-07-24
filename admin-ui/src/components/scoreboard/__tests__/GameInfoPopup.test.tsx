import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import GameInfoPopup from '../GameInfoPopup';

// D2 (v2.34.0) — hover-intent open with a close grace period. Mouse/pointer
// users should be able to hover the "i" icon, see the bubble open, travel
// into the bubble, and click its link before it closes. jsdom doesn't
// implement matchMedia, so GameInfoPopup's `supportsHover()` guard falls
// back to "hover-capable" — exactly the desktop-like environment this
// suite wants to exercise.
describe('GameInfoPopup hover-intent (D2)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens after the open-delay, stays open through the close grace period, then closes', () => {
    render(<GameInfoPopup notes="Some info" />);
    const icon = screen.getByTitle('Game info');

    fireEvent.mouseEnter(icon);
    // Not open yet — the 100ms open-delay hasn't elapsed.
    expect(screen.queryByText('Some info')).not.toBeInTheDocument();

    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByText('Some info')).toBeInTheDocument();

    // Leave the icon — still open at +200ms (close grace is 300ms).
    fireEvent.mouseLeave(icon);
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.getByText('Some info')).toBeInTheDocument();

    // Closed once the full 300ms grace period has elapsed since leaving
    // (400ms total advanced past the leave — well past the 300ms grace).
    act(() => { vi.advanceTimersByTime(200); });
    expect(screen.queryByText('Some info')).not.toBeInTheDocument();
  });

  it('re-entering the bubble within the grace period cancels the close and keeps it open', () => {
    render(<GameInfoPopup notes="Some info" />);
    const icon = screen.getByTitle('Game info');

    fireEvent.mouseEnter(icon);
    act(() => { vi.advanceTimersByTime(100); });
    expect(screen.getByText('Some info')).toBeInTheDocument();

    fireEvent.mouseLeave(icon);
    act(() => { vi.advanceTimersByTime(200); }); // within the 300ms grace

    const bubble = screen.getByText('Some info').closest('div')!;
    fireEvent.mouseEnter(bubble);

    // Advance well past when the original close timer would have fired —
    // re-entering the bubble should have cancelled it.
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.getByText('Some info')).toBeInTheDocument();

    // Leaving the bubble now re-arms the close grace period.
    fireEvent.mouseLeave(bubble);
    act(() => { vi.advanceTimersByTime(300); });
    expect(screen.queryByText('Some info')).not.toBeInTheDocument();
  });

  it('click still tap-to-toggles instantly, isolated from timers', () => {
    render(<GameInfoPopup notes="Some info" />);
    const icon = screen.getByTitle('Game info');

    fireEvent.click(icon);
    expect(screen.getByText('Some info')).toBeInTheDocument();

    fireEvent.click(icon);
    expect(screen.queryByText('Some info')).not.toBeInTheDocument();
  });
});
