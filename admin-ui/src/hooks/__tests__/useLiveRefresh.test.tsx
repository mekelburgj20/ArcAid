import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { useLiveRefresh, LIVE_REFRESH_INTERVAL_MS, LIVE_REFRESH_THROTTLE_MS } from '../useLiveRefresh';

/**
 * Owner report 2026-09-01: "the scoreboard doesn't auto refresh for mobile or
 * desktop. You have to manually refresh."
 *
 * The socket wiring was never missing — what was missing is the recovery
 * around a socket that is not currently delivering. These pin the three
 * triggers and, just as importantly, the two cases that must NOT fire: the
 * first connect (which would duplicate the page's own initial load) and a poll
 * tick while the tab is hidden (which would burn a phone's battery and the
 * server's cache for a screen nobody is looking at).
 */

const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
const socket = {
  on: vi.fn((ev: string, fn: (...a: unknown[]) => void) => {
    (handlers[ev] ??= []).push(fn);
  }),
  off: vi.fn((ev: string, fn: (...a: unknown[]) => void) => {
    handlers[ev] = (handlers[ev] ?? []).filter(h => h !== fn);
  }),
};
vi.mock('../../lib/websocket', () => ({ getSocket: () => socket }));

function emit(ev: string) {
  act(() => { (handlers[ev] ?? []).forEach(h => h()); });
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

function Probe({ refresh, enabled = true }: { refresh: () => void; enabled?: boolean }) {
  useLiveRefresh(refresh, { enabled });
  return null;
}

describe('useLiveRefresh', () => {
  beforeEach(() => {
    for (const k of Object.keys(handlers)) delete handlers[k];
    vi.useFakeTimers();
    setHidden(false);
  });
  afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

  it('does NOT refresh on the FIRST connect — that would duplicate the initial load', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    emit('connect');
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes on a RE-connect, because events during the gap were missed', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    emit('disconnect');
    emit('connect');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the tab becomes visible (the mobile case)', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh on a visibilitychange that HID the tab', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    setHidden(true);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('refreshes on pageshow — iOS bfcache fires nothing else', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    act(() => { window.dispatchEvent(new Event('pageshow')); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes on window focus — desktop alt-tab fires no visibility change', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('polls as a backstop for a socket that died without saying so', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    act(() => { vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS + 1); });
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS + 1); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('never polls while the document is hidden', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    setHidden(true);
    act(() => { vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS * 3); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('throttles triggers that land together (reconnect + focus is the common pair)', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} />);
    emit('disconnect');
    emit('connect');
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(refresh).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(LIVE_REFRESH_THROTTLE_MS + 1); });
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('does nothing at all when disabled (a page with no room yet)', () => {
    const refresh = vi.fn();
    render(<Probe refresh={refresh} enabled={false} />);
    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS * 2); });
    expect(refresh).not.toHaveBeenCalled();
  });

  it('always calls the LATEST callback, so an inline arrow does not go stale', () => {
    const first = vi.fn();
    const second = vi.fn();
    const { rerender } = render(<Probe refresh={first} />);
    rerender(<Probe refresh={second} />);
    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('removes every listener on unmount', () => {
    const refresh = vi.fn();
    const { unmount } = render(<Probe refresh={refresh} />);
    unmount();
    emit('disconnect');
    emit('connect');
    act(() => { window.dispatchEvent(new Event('focus')); });
    act(() => { vi.advanceTimersByTime(LIVE_REFRESH_INTERVAL_MS * 2); });
    expect(refresh).not.toHaveBeenCalled();
  });
});
