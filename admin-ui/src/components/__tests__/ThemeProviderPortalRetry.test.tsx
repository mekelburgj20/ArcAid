import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../ThemeProvider';

/**
 * G32 — a first-time visitor whose room lookup failed once (a refused or
 * restarting server) used to keep the default theme for the whole visit,
 * because the provider asked once. It now waits the failure out.
 */

const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('ThemeProvider room lookup that fails for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('applies the room theme once the lookup answers, without a remount', async () => {
    let portalTries = 0;
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/portal')) {
        portalTries += 1;
        if (portalTries === 1) {
          return Promise.resolve({ ok: false, status: 503, headers: { get: () => null }, json: () => Promise.resolve({}) });
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ id: 'rx', roomId: 'rx', slug: 'retrytheme', name: 'x', public_theme: 'graphite', ui_theme: 'graphite' }),
        });
      }
      return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve(null) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    render(
      <MemoryRouter initialEntries={['/retrytheme']}>
        <ThemeProvider><div>page</div></ThemeProvider>
      </MemoryRouter>,
    );
    await settle();

    expect(portalTries).toBe(1);
    expect(document.documentElement.classList.contains('theme-graphite')).toBe(false);

    await advance(2_000);
    expect(portalTries).toBe(2);
    expect(document.documentElement.classList.contains('theme-graphite')).toBe(true);
  });
});
