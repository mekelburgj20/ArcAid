import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { ThemeProvider } from '../ThemeProvider';

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
});
