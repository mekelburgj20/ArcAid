import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUpdateNudge } from '../useUpdateNudge';
import { UPDATE_NUDGE_DISMISS_KEY, UPDATE_NUDGE_POLL_INTERVAL_MS } from '../../lib/updateNudge';

function mockVersionFetch(version: string) {
  return vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ version, commit: 'abc123', builtAt: '2026-08-01T00:00:00Z' }),
  });
}

describe('useUpdateNudge', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never shows on first load — baseline fetch sets both baseline and latest', async () => {
    const fetchMock = mockVersionFetch('v2.90.0');
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.show).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('shows once the 15-minute backstop poll reports a new version', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.90.0' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.91.0' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.show).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPDATE_NUDGE_POLL_INTERVAL_MS);
    });

    expect(result.current.show).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-checks on visibilitychange when the tab becomes visible', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.90.0' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.91.0' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.show).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('stays silent when the version fetch fails (offline)', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network error'));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.show).toBe(false);
  });

  it('stays silent when the response is not ok', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    expect(result.current.show).toBe(false);
  });

  it('dismiss hides the banner and persists the dismissed version to localStorage', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.90.0' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.91.0' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_NUDGE_POLL_INTERVAL_MS); });
    expect(result.current.show).toBe(true);

    act(() => { result.current.dismiss(); });

    expect(result.current.show).toBe(false);
    expect(localStorage.getItem(UPDATE_NUDGE_DISMISS_KEY)).toBe('v2.91.0');
  });

  it('re-shows if a newer version lands after a dismissal of an older one', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.90.0' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.91.0' }) })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ version: 'v2.92.0' }) });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_NUDGE_POLL_INTERVAL_MS); });
    act(() => { result.current.dismiss(); });
    expect(result.current.show).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(UPDATE_NUDGE_POLL_INTERVAL_MS); });
    expect(result.current.show).toBe(true);
  });

  it('refresh triggers a full page reload', async () => {
    const fetchMock = mockVersionFetch('v2.90.0');
    vi.stubGlobal('fetch', fetchMock);
    const reloadMock = vi.fn();
    const originalLocation = window.location;
    // @ts-expect-error — jsdom location isn't writable by default
    delete window.location;
    // @ts-expect-error — partial stub, reload is all this test needs
    window.location = { ...originalLocation, reload: reloadMock };

    const { result } = renderHook(() => useUpdateNudge());
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });

    act(() => { result.current.refresh(); });
    expect(reloadMock).toHaveBeenCalledTimes(1);

    window.location = originalLocation;
  });
});
