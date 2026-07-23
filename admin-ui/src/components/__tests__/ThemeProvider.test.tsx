import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider, useTheme } from '../ThemeProvider';

// s20 — regression coverage for the ThemeProvider re-theme bug: `globalTheme`
// used to read `window.location.pathname` directly, so navigating between
// admin/public (or between two rooms) never re-rendered with the new theme.
// Also covers the per-slug theme key (`arcaid-theme-public-<slug>`), which was
// write-only before this sprint.

function Harness() {
  const navigate = useNavigate();
  return (
    <div>
      <button onClick={() => navigate('/admin/dashboard')}>go-admin</button>
      <button onClick={() => navigate('/rooma')}>go-rooma</button>
      <button onClick={() => navigate('/roomb')}>go-roomb</button>
    </div>
  );
}

function renderHarness(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <Harness />
        <Routes>
          <Route path="/admin/dashboard" element={<div>admin-page</div>} />
          <Route path="/:slug" element={<div>public-page</div>} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** No portal in this test suite ever returns a server-side theme override —
 *  every assertion is about localStorage-driven resolution, so the async
 *  hydrate should be a no-op past that point. */
function stubPortalFetch() {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/portal')) {
      const slug = new URL(url, 'http://localhost').searchParams.get('slug') || '';
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: slug, roomId: slug, slug, name: slug, public_theme: null, ui_theme: null }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/** Stubbed portal that DOES return a server-side theme override (e.g. a room
 *  configured for 'ocean'), used by the M1 regression test below. */
function stubPortalFetchWithServerTheme(theme: string) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/portal')) {
      const slug = new URL(url, 'http://localhost').searchParams.get('slug') || '';
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: slug, roomId: slug, slug, name: slug, public_theme: theme, ui_theme: theme }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

/** Probe that exposes setPublicTheme via a clickable button, plus buttons to
 *  navigate between two same-room public pages (scoreboard <-> lobby). */
function SameRoomHarness() {
  const navigate = useNavigate();
  const { setPublicTheme } = useTheme();
  return (
    <div>
      <button onClick={() => setPublicTheme('cyberpunk')}>set-cyberpunk</button>
      <button onClick={() => navigate('/roomx/lobby')}>go-lobby</button>
      <button onClick={() => navigate('/roomx/scoreboard')}>go-scoreboard</button>
    </div>
  );
}

function renderSameRoomHarness(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <SameRoomHarness />
        <Routes>
          <Route path="/:slug/scoreboard" element={<div>scoreboard-page</div>} />
          <Route path="/:slug/lobby" element={<div>lobby-page</div>} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('re-themes on navigation: admin -> public swaps the documentElement class', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-admin', 'retro');

    renderHarness('/admin/dashboard');

    await waitFor(() => expect(document.documentElement.classList.contains('theme-retro')).toBe(true));

    fireEvent.click(screen.getByText('go-rooma'));

    await waitFor(() => expect(document.documentElement.classList.contains('theme-retro')).toBe(false));
  });

  it('per-slug isolation: room A keeps its saved theme, room B (no saved theme) does not inherit it', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-public-rooma', 'ocean');

    renderHarness('/rooma');

    await waitFor(() => expect(document.documentElement.classList.contains('theme-ocean')).toBe(true));

    fireEvent.click(screen.getByText('go-roomb'));

    await waitFor(() => expect(document.documentElement.classList.contains('theme-ocean')).toBe(false));
  });

  it('reads the per-slug key at entry (no navigation needed)', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-public-rooma', 'cyberpunk');

    renderHarness('/rooma');

    await waitFor(() => expect(document.documentElement.classList.contains('theme-cyberpunk')).toBe(true));
  });

  // s20 M1 regression: hydrate effect must be dep'd on [adminRoute, roomSlug],
  // NOT [pathname, roomSlug]. If `pathname` were reinstated as a dep, this
  // test fails — the hydrate effect re-fires on the scoreboard -> lobby
  // navigation (same room, different pathname), refetches the portal, and
  // `setPublicThemeState(serverPublicTheme)` reverts the viewer's just-set
  // 'cyberpunk' personal theme back to the room's configured 'ocean' theme.
  it('does not revert a viewer-set personal theme on same-room navigation (M1)', async () => {
    stubPortalFetchWithServerTheme('ocean');

    renderSameRoomHarness('/roomx/scoreboard');

    // Hydrate resolves the room's configured server theme first.
    await waitFor(() => expect(document.documentElement.classList.contains('theme-ocean')).toBe(true));

    // Viewer picks a personal theme via Scoreboard prefs (setPublicTheme).
    fireEvent.click(screen.getByText('set-cyberpunk'));
    await waitFor(() => expect(document.documentElement.classList.contains('theme-cyberpunk')).toBe(true));

    // Navigate within the SAME room (scoreboard -> lobby) — must NOT
    // re-hydrate and clobber the viewer's chosen theme back to 'ocean'.
    fireEvent.click(screen.getByText('go-lobby'));
    await screen.findByText('lobby-page');

    // Give any (incorrectly) re-fired async hydrate a chance to resolve.
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(document.documentElement.classList.contains('theme-cyberpunk')).toBe(true);
    expect(document.documentElement.classList.contains('theme-ocean')).toBe(false);
  });
});
