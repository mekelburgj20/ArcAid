import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: () => {}, on: () => {}, off: () => {} }),
}));

import ScoreboardTicker from '../ScoreboardTicker';

/**
 * G32 — the ticker's seed read ran once in `.catch(() => {})`; if it failed the
 * ticker never appeared on that page view. It retries quietly now: nothing
 * shows while it fails, the items appear when a retry gets through.
 */
describe('ScoreboardTicker when its seed read fails for now', () => {
  let limited = true;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    limited = true;
    fetchMock.mockImplementation(() => limited
      ? Promise.resolve({ ok: false, status: 429, headers: { get: () => null }, json: async () => ({}) })
      : Promise.resolve({
        ok: true, status: 200,
        json: async () => [{ id: 1, type: 'score_posted', title: 'Wyo posted on Medieval Madness', created_at: new Date().toISOString() }],
      }));
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders nothing while it fails, then the items after the retry, with no remount', async () => {
    const { container } = render(<ScoreboardTicker roomId="room-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container).toBeEmptyDOMElement();

    limited = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(screen.getByText('Wyo posted on Medieval Madness')).toBeInTheDocument();
  });

  // The ticker lives in the room layout, so it stays mounted when the visitor
  // switches rooms: the next room's answer replaces the list, it never merges.
  it('a move to another room drops the last room\'s items', async () => {
    limited = false;
    fetchMock.mockImplementation((url: string) => Promise.resolve({
      ok: true, status: 200,
      json: async () => [url.includes('/room-2/')
        ? { id: 2, type: 'score_posted', title: 'Bo posted on Attack from Mars', created_at: new Date().toISOString() }
        : { id: 1, type: 'score_posted', title: 'Wyo posted on Medieval Madness', created_at: new Date().toISOString() }],
    }));
    const view = render(<ScoreboardTicker roomId="room-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Wyo posted on Medieval Madness')).toBeInTheDocument();

    view.rerender(<ScoreboardTicker roomId="room-2" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText('Bo posted on Attack from Mars')).toBeInTheDocument();
    expect(screen.queryByText('Wyo posted on Medieval Madness')).not.toBeInTheDocument();
  });

  it('a room that refuses the feed outright shows no ticker and is not asked again', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status: 403, headers: { get: () => null }, json: async () => ({}) }));
    const { container } = render(<ScoreboardTicker roomId="room-1" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
