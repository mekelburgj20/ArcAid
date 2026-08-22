import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider, useTheme, STORAGE_APPEARANCE_KEY } from '../ThemeProvider';

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

// ── v2.130.0: Appearance polarity override ─────────────────────────────────
//
// One preference, applied as the LAST step of resolution on every route
// class. `auto` must reproduce pre-v2.130 behaviour byte for byte; light/dark
// must beat the room's theme, the admin's theme, and the OS.

/** Probe that renders the resolved appearance plus setter buttons. */
function AppearanceHarness() {
  const { appearance, setAppearance } = useTheme();
  return (
    <div>
      <span data-testid="appearance">{appearance}</span>
      <button onClick={() => setAppearance('light')}>set-light</button>
      <button onClick={() => setAppearance('dark')}>set-dark</button>
      <button onClick={() => setAppearance('auto')}>set-auto</button>
    </div>
  );
}

function renderAppearance(initialPath: string) {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <ThemeProvider>
        <AppearanceHarness />
        <Routes>
          <Route path="/admin/dashboard" element={<div>admin-page</div>} />
          <Route path="/scoreboard" element={<div>global-page</div>} />
          <Route path="/:slug" element={<div>public-page</div>} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const hasClass = (cls: string) => document.documentElement.classList.contains(cls);

describe('ThemeProvider — appearance override (v2.130.0)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('room route + dark room theme + appearance=light -> theme-light', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-public-rooma', 'ocean');
    localStorage.setItem(STORAGE_APPEARANCE_KEY, 'light');

    renderAppearance('/rooma');

    await waitFor(() => expect(hasClass('theme-light')).toBe(true));
    expect(hasClass('theme-ocean')).toBe(false);
  });

  it('room route + LIGHT room theme + appearance=light keeps the room theme', async () => {
    // Coffee is light-polarity, so the override has nothing to correct — the
    // room keeps its own look rather than being flattened to theme-light.
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-public-rooma', 'coffee');
    localStorage.setItem(STORAGE_APPEARANCE_KEY, 'light');

    renderAppearance('/rooma');

    await waitFor(() => expect(hasClass('theme-coffee')).toBe(true));
    expect(hasClass('theme-light')).toBe(false);
  });

  it('room route + light room theme + appearance=dark -> the no-class dark default', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-public-rooma', 'coffee');
    localStorage.setItem(STORAGE_APPEARANCE_KEY, 'dark');

    renderAppearance('/rooma');

    await waitFor(() => expect(hasClass('theme-coffee')).toBe(false));
    expect(hasClass('theme-light')).toBe(false);
    expect(document.documentElement.className.trim()).toBe('');
  });

  it('appearance=auto leaves the room theme exactly as it was', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-public-rooma', 'ocean');
    localStorage.setItem(STORAGE_APPEARANCE_KEY, 'auto');

    renderAppearance('/rooma');

    await waitFor(() => expect(hasClass('theme-ocean')).toBe(true));
    expect(hasClass('theme-light')).toBe(false);
  });

  it('admin route: appearance=light beats the admin ui_theme', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-admin', 'retro');
    localStorage.setItem(STORAGE_APPEARANCE_KEY, 'light');

    renderAppearance('/admin/dashboard');

    await waitFor(() => expect(hasClass('theme-light')).toBe(true));
    expect(hasClass('theme-retro')).toBe(false);
  });

  it('global route: appearance=light wins over an OS dark preference', async () => {
    stubPortalFetch();
    vi.stubGlobal('matchMedia', vi.fn(() => ({
      matches: false, media: '', onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia);
    localStorage.setItem(STORAGE_APPEARANCE_KEY, 'light');

    renderAppearance('/scoreboard');

    await waitFor(() => expect(hasClass('theme-light')).toBe(true));
  });

  it('migrates the legacy arcaid-global-theme key into the appearance preference once', async () => {
    stubPortalFetch();
    // A visitor who used the v2.50.0 global-page toggle, now on a ROOM page:
    // the old key was global-pages-only, the migrated preference is not.
    localStorage.setItem('arcaid-global-theme', 'light');
    localStorage.setItem('arcaid-theme-public-rooma', 'ocean');

    renderAppearance('/rooma');

    await waitFor(() => expect(screen.getByTestId('appearance').textContent).toBe('light'));
    expect(localStorage.getItem(STORAGE_APPEARANCE_KEY)).toBe('light');
    expect(hasClass('theme-light')).toBe(true);
  });

  it('the new key wins over the legacy key (migration is one-time)', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-global-theme', 'light');
    localStorage.setItem(STORAGE_APPEARANCE_KEY, 'auto');
    localStorage.setItem('arcaid-theme-public-rooma', 'ocean');

    renderAppearance('/rooma');

    await waitFor(() => expect(hasClass('theme-ocean')).toBe(true));
    expect(screen.getByTestId('appearance').textContent).toBe('auto');
  });

  it('setAppearance persists to localStorage and re-themes immediately', async () => {
    stubPortalFetch();
    localStorage.setItem('arcaid-theme-public-rooma', 'ocean');

    renderAppearance('/rooma');
    await waitFor(() => expect(hasClass('theme-ocean')).toBe(true));

    fireEvent.click(screen.getByText('set-light'));

    await waitFor(() => expect(hasClass('theme-light')).toBe(true));
    expect(localStorage.getItem(STORAGE_APPEARANCE_KEY)).toBe('light');

    // ...and going back to Auto restores the room's own theme.
    fireEvent.click(screen.getByText('set-auto'));
    await waitFor(() => expect(hasClass('theme-ocean')).toBe(true));
    expect(localStorage.getItem(STORAGE_APPEARANCE_KEY)).toBe('auto');
  });

  it('hydrates the appearance from the server for a signed-in player', async () => {
    // Player tokens live in their own localStorage key and are never sent by
    // lib/api.ts — the provider must fetch /me/preferences with them directly.
    localStorage.setItem('arcaid_player_token', 'player.jwt.token');
    localStorage.setItem('arcaid-theme-public-rooma', 'ocean');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/me/preferences')) {
        expect((init?.headers as Record<string, string>)?.Authorization).toBe('Bearer player.jwt.token');
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ui_theme: null, appearance: 'light' }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ id: 'rooma', roomId: 'rooma', slug: 'rooma', name: 'rooma', public_theme: null, ui_theme: null }) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAppearance('/rooma');

    await waitFor(() => expect(hasClass('theme-light')).toBe(true));
    expect(localStorage.getItem(STORAGE_APPEARANCE_KEY)).toBe('light');
  });
});
