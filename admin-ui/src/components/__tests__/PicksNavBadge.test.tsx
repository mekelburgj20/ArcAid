import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PublicLayout from '../PublicLayout';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

// ---------------------------------------------------------------------------
// Picks nav badge.
//
// Counts come straight from /pick-alerts (the server owns the a/b/c logic and
// is tested separately) — what matters here is that the nav only badges a
// signed-in player, shows the right count, styles the urgent case differently,
// and clears when the server says zero.
// ---------------------------------------------------------------------------

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signIn(discordId = '123', username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

/**
 * @param alerts  what /pick-alerts returns, or null to fail the call
 */
function stubFetch(alerts: object | null, pickAwardEnabled = true, slug = 'rtx_pinball') {
  const calls: string[] = [];
  const fetchMock = vi.fn((url: string) => {
    calls.push(url);
    if (url.startsWith('/api/portal')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          id: 'room-1', roomId: 'room-1', slug,
          name: 'RTX Pinball', pick_award_enabled: pickAwardEnabled,
        }),
      });
    }
    if (url.includes('/pick-alerts')) {
      if (!alerts) return Promise.resolve({ ok: false, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(alerts) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

function renderLayout(path = '/rtx_pinball/stats') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ViewerAuthProvider>
        <Routes>
          <Route path="/:slug" element={<PublicLayout />}>
            <Route path="stats" element={<div>stats</div>} />
          </Route>
        </Routes>
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('Picks nav badge', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('shows a count badge when the player has pick alerts', async () => {
    signIn();
    stubFetch({ count: 3, urgent: false });

    renderLayout();

    const badge = await screen.findByTestId('nav-badge-count-picks');
    expect(badge).toHaveTextContent('3');
  });

  it('styles the urgent case (a pending pick with a running clock) differently', async () => {
    signIn();
    stubFetch({ count: 1, urgent: true });

    renderLayout();

    const badge = await screen.findByTestId('nav-badge-count-picks');
    expect(badge.className).toContain('bg-neon-magenta');
  });

  it('uses the softer cyan for non-urgent nudges', async () => {
    signIn();
    stubFetch({ count: 2, urgent: false });

    renderLayout();

    const badge = await screen.findByTestId('nav-badge-count-picks');
    expect(badge.className).toContain('bg-neon-cyan');
    expect(badge.className).not.toContain('bg-neon-magenta');
  });

  it('caps the displayed count at 9+', async () => {
    signIn();
    stubFetch({ count: 14, urgent: true });

    renderLayout();

    const badge = await screen.findByTestId('nav-badge-count-picks');
    expect(badge).toHaveTextContent('9+');
  });

  it('renders no badge when there is nothing to act on', async () => {
    signIn();
    stubFetch({ count: 0, urgent: false });

    renderLayout();

    // Wait for the Picks nav item itself so the assertion isn't a race.
    await screen.findByText('Picks');
    await waitFor(() => {
      expect(screen.queryByTestId('nav-badge-count-picks')).not.toBeInTheDocument();
    });
  });

  it('never badges a guest, and does not even probe the endpoint', async () => {
    // No signIn() — no player token.
    const calls = stubFetch({ count: 5, urgent: true });

    renderLayout();

    await screen.findByText('Picks');
    await waitFor(() => {
      expect(screen.queryByTestId('nav-badge-count-picks')).not.toBeInTheDocument();
    });
    expect(calls.some(u => u.includes('/pick-alerts'))).toBe(false);
  });

  it('stays silent when the probe fails — the badge is decoration, not a page', async () => {
    signIn();
    stubFetch(null);

    renderLayout();

    await screen.findByText('Picks');
    await waitFor(() => {
      expect(screen.queryByTestId('nav-badge-count-picks')).not.toBeInTheDocument();
    });
  });

  it('re-probes when the Picks page reports a write', async () => {
    signIn();
    const calls = stubFetch({ count: 1, urgent: true });

    renderLayout();

    await screen.findByTestId('nav-badge-count-picks');
    const before = calls.filter(u => u.includes('/pick-alerts')).length;

    act(() => { window.dispatchEvent(new Event('arcaid_pick_alerts_changed')); });

    await waitFor(() => {
      expect(calls.filter(u => u.includes('/pick-alerts')).length).toBeGreaterThan(before);
    });
  });

  it('shows no Picks tab (and so no badge) when the room has winner-picks off', async () => {
    signIn();
    // Distinct slug: usePickAwardEnabled memoizes per slug in a module-level
    // cache that outlives a single test.
    stubFetch({ count: 4, urgent: true }, false, 'no_picks_room');

    renderLayout('/no_picks_room/stats');

    await screen.findByText('Scores');
    expect(screen.queryByText('Picks')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-badge-count-picks')).not.toBeInTheDocument();
  });
});
