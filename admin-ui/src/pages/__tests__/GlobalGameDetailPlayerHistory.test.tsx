import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GlobalGameDetail from '../GlobalGameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

/**
 * v2.157.0 — the Global game page's per-player drill-in.
 *
 * The board shows each player's BEST only. Clicking a row expands every score
 * that player holds on the game (from the per-player endpoint, keyed on the
 * row's `player_key`); clicking the SCORE opens a score-over-time chart above
 * that list. Own rows carry the self-delete trash; other players' rows are
 * read-only.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signInAs(discordId: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({
    discordId, username: 'Tester', avatar: null, exp, role: 'player', gameRoomIds: [],
  }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

function entry(name: string, score: number, rank: number, playerKey: string) {
  return {
    rank,
    discord_user_id: `d-${name}`,
    iscored_username: name,
    display_name: null,
    score,
    photo_url: null,
    submitted_at: '2026-09-03T00:00:00.000Z',
    origin_type: 'global',
    origin_game_room_id: null,
    origin_room_name: null,
    origin_room_slug: null,
    origin_room_logo_url: null,
    origin_room_short_tag: null,
    avatar_hash: null,
    score_id: `s-${name}`,
    platform: null,
    engine: 'vpx',
    device: 'pc',
    source: null,
    player_key: playerKey,
  };
}

function hist(id: string, score: number, date: string, isOwn: boolean, extra: Record<string, unknown> = {}) {
  return {
    id, score, submitted_at: date, platform: null, engine: 'vpx', device: 'pc', source: null,
    origin_type: 'global', origin_game_room_id: null, origin_room_name: null, origin_room_slug: null,
    photo_url: null, is_own: isOwn, ...extra,
  };
}

const GAME = {
  id: 'g1', name: 'Attack from Mars', display_name: null, manufacturer: 'Bally', year: 1995,
  type: 'pinball', subtype: null, platforms: ['vpx'], themes: [], designers: [], players: null,
  image_url: null, local_image_path: null, wheel_image_path: null, opdb_id: null, vps_id: null,
  igdb_id: null, ipdb_url: null, external_url: null, description: null, features: [],
  table_authors: [], table_download_urls: [], tutorial_urls: [], rules_urls: [],
};

const HISTORY: Record<string, unknown[]> = {
  'd-Alice': [
    hist('a3', 900, '2026-09-03T00:00:00.000Z', true, { source: 'vpx' }),
    hist('a2', 700, '2026-09-02T00:00:00.000Z', true, { origin_type: 'room', origin_room_name: 'Fun Room', origin_room_slug: 'fun' }),
    hist('a1', 500, '2026-09-01T00:00:00.000Z', true),
  ],
  'd-Bob': [
    hist('b2', 800, '2026-09-02T00:00:00.000Z', false),
    hist('b1', 600, '2026-09-01T00:00:00.000Z', false),
  ],
};

let historyRequests: Array<{ url: string; auth: string | null }> = [];

function mockFetch() {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const players = url.match(/^\/api\/global\/scoreboard\/g1\/players\/([^/]+)\/scores/);
    if (players) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      historyRequests.push({ url, auth: headers['Authorization'] ?? null });
      const key = decodeURIComponent(players[1]!);
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ player: null, scores: HISTORY[key] ?? [] }) });
    }
    if (url.startsWith('/api/global/scoreboard/')) {
      const data = [entry('Alice', 900, 1, 'd-Alice'), entry('Bob', 800, 2, 'd-Bob')];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          game: { id: 'g1', name: 'Attack from Mars' },
          categories: [{ category: 'simulation', score_count: 5 }],
          category: 'simulation', data, total: data.length, hasMore: false,
        }),
      });
    }
    if (url.startsWith('/api/global/games/g1/comments')) return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    if (url.startsWith('/api/global/games/g1/rating')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ avg_rating: 0, rating_count: 0, user_rating: null }) });
    }
    if (url.startsWith('/api/global/games/g1')) return Promise.resolve({ ok: true, json: () => Promise.resolve(GAME) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderDetail() {
  return render(
    <MemoryRouter initialEntries={['/games/g1']}>
      <ThemeProvider>
        <ViewerAuthProvider>
          <Routes>
            <Route path="/games/:globalGameId" element={<GlobalGameDetail />} />
          </Routes>
        </ViewerAuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('GlobalGameDetail — per-player history drill-in (v2.157.0)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    historyRequests = [];
    document.documentElement.className = '';
  });

  it('expands a player\'s full history on row click and collapses on a second click', async () => {
    mockFetch();
    renderDetail();

    fireEvent.click(await screen.findByText('Alice'));
    const panel = await screen.findByTestId('player-history');
    await within(panel).findByText('500');
    expect(within(panel).getByText('700')).toBeInTheDocument();
    expect(within(panel).getByText('Fun Room')).toBeInTheDocument();
    expect(within(panel).getAllByText('Global').length).toBeGreaterThan(0);
    // The cabinet-reported row renders the shared AW chip, not the raw word.
    expect(within(panel).getByText('AW')).toBeInTheDocument();
    expect(historyRequests[0]!.url).toContain('/players/d-Alice/scores');

    fireEvent.click(screen.getByText('Alice'));
    await waitFor(() => expect(screen.queryByTestId('player-history')).not.toBeInTheDocument());
  });

  it('shows only one player at a time', async () => {
    mockFetch();
    renderDetail();

    fireEvent.click(await screen.findByText('Alice'));
    await within(await screen.findByTestId('player-history')).findByText('500');
    fireEvent.click(screen.getByText('Bob'));
    const panel = await screen.findByTestId('player-history');
    await within(panel).findByText('600');
    expect(screen.getAllByTestId('player-history')).toHaveLength(1);
    expect(within(panel).queryByText('500')).not.toBeInTheDocument();
  });

  it('offers delete on the viewer\'s own history rows only', async () => {
    signInAs('d-Alice');
    mockFetch();
    renderDetail();

    fireEvent.click(await screen.findByText('Alice'));
    let panel = await screen.findByTestId('player-history');
    await within(panel).findByText('500');
    expect(within(panel).getAllByRole('button', { name: /Delete this score/ })).toHaveLength(3);
    // The token rides along so the server can mark own rows.
    expect(historyRequests[0]!.auth).toMatch(/^Bearer /);

    fireEvent.click(screen.getByText('Bob'));
    panel = await screen.findByTestId('player-history');
    await within(panel).findByText('600');
    expect(within(panel).queryByRole('button', { name: /Delete this score/ })).not.toBeInTheDocument();
  });

  it('opens the confirm dialog from a history row\'s delete', async () => {
    signInAs('d-Alice');
    mockFetch();
    renderDetail();

    fireEvent.click(await screen.findByText('Alice'));
    const panel = await screen.findByTestId('player-history');
    await within(panel).findByText('500');
    fireEvent.click(within(panel).getByRole('button', { name: 'Delete this score (500)' }));
    expect(await screen.findByText(/Delete this score\?/)).toBeInTheDocument();
  });

  it('clicking a score toggles the score-history chart, sharing one fetch', async () => {
    mockFetch();
    renderDetail();

    const scoreButton = await screen.findByRole('button', { name: /900 — show Alice's score history chart/ });
    fireEvent.click(scoreButton);
    const chart = await screen.findByTestId('score-history-chart');
    // One dot per score; the best is the highlighted one.
    expect(within(chart).getAllByTestId('chart-point')).toHaveLength(2);
    expect(within(chart).getAllByTestId('chart-point-best')).toHaveLength(1);
    // The list is rendered beneath it from the same rows.
    const panel = screen.getByTestId('player-history');
    expect(within(panel).getByRole('button', { name: /^500 — hide the score history chart/ })).toBeInTheDocument();
    expect(historyRequests).toHaveLength(1);

    fireEvent.click(scoreButton);
    await waitFor(() => expect(screen.queryByTestId('score-history-chart')).not.toBeInTheDocument());
    // The history stays open; only the chart hid.
    expect(screen.getByTestId('player-history')).toBeInTheDocument();

    // A history row's score re-opens it, still without a second request.
    fireEvent.click(within(panel).getByRole('button', { name: /^500 — show the score history chart/ }));
    expect(await screen.findByTestId('score-history-chart')).toBeInTheDocument();
    expect(historyRequests).toHaveLength(1);

    // Collapsing the row hides the chart with it.
    fireEvent.click(screen.getByText('Alice'));
    await waitFor(() => expect(screen.queryByTestId('score-history-chart')).not.toBeInTheDocument());
  });
});
