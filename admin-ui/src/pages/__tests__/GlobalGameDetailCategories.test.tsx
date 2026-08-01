import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import GlobalGameDetail from '../GlobalGameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

/**
 * v2.63.0 (ADR 0016) — the global game detail page shows ONE board per
 * fidelity category.
 *
 * Cards for different categories share a game page; their scores do not share
 * a table. Before this, clicking either card of a mixed game landed on a single
 * combined list that ranked a VPX run against a Pinball FX run 1..n — the exact
 * comparability claim ADR 0016 exists to forbid, made on the page a player
 * actually reads.
 *
 * The server owns the resolution rule (requested board if the game has it, else
 * the biggest). These lock the page's half: that it ASKS for the deep-linked
 * board, RENDERS what came back, and never invents a combined view.
 */

function entry(name: string, score: number, engine: string, rank: number) {
  return {
    rank,
    discord_user_id: `d-${name}`,
    iscored_username: name,
    display_name: null,
    score,
    photo_url: null,
    submitted_at: '2026-07-01T00:00:00.000Z',
    origin_type: 'room',
    origin_game_room_id: null,
    origin_room_name: null,
    origin_room_slug: null,
    origin_room_logo_url: null,
    origin_room_short_tag: null,
    avatar_hash: null,
    score_id: `s-${name}`,
    platform: null,
    engine,
    device: 'unknown',
  };
}

const GAME = {
  id: 'g1',
  name: 'Twin Boards',
  display_name: null,
  manufacturer: 'Williams',
  year: 1997,
  type: 'pinball',
  subtype: null,
  platforms: ['vpx', 'fx'],
  themes: [],
  designers: [],
  players: null,
  image_url: null,
  local_image_path: null,
  wheel_image_path: null,
  opdb_id: null,
  vps_id: null,
  igdb_id: null,
  ipdb_url: null,
  external_url: null,
  description: null,
  features: [],
  table_authors: [],
  table_download_urls: [],
  tutorial_urls: [],
  rules_urls: [],
};

const BOARDS: Record<string, unknown[]> = {
  simulation: [entry('SimAce', 900, 'vpx', 1), entry('SimTwo', 800, 'vpx', 2)],
  arcade_style: [entry('FxAce', 100, 'fx', 1), entry('SimAce', 50, 'fx', 2)],
};

let boardRequests: string[] = [];

/**
 * Stands in for the endpoint's resolution rule: serve the requested board when
 * the game has it, else the biggest (`categories[0]`).
 */
function mockFetch(categories: Array<{ category: string; score_count: number }>) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/global/scoreboard/')) {
      boardRequests.push(url);
      const requested = new URL(url, 'http://x').searchParams.get('category');
      const resolved = categories.some(c => c.category === requested)
        ? requested!
        : (categories[0]?.category ?? null);
      const data = resolved ? BOARDS[resolved] ?? [] : [];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          game: { id: 'g1', name: 'Twin Boards', manufacturer: 'Williams', year: 1997, type: 'pinball', image_url: null },
          categories,
          category: resolved,
          data,
          total: data.length,
          hasMore: false,
        }),
      });
    }
    if (url.startsWith('/api/global/games/g1/comments')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.startsWith('/api/global/games/g1/rating')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ avg_rating: 0, rating_count: 0, user_rating: null }) });
    }
    if (url.startsWith('/api/global/games/g1')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(GAME) });
    }
    if (url.startsWith('/api/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderDetail(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/games/g1${search}`]}>
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

const TWO_BOARDS = [
  { category: 'simulation', score_count: 2 },
  { category: 'arcade_style', score_count: 2 },
];

describe('GlobalGameDetail — per-category boards (v2.63.0)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    boardRequests = [];
    document.documentElement.className = '';
  });

  it('renders a tab per board and shows only the selected one', async () => {
    mockFetch(TWO_BOARDS);
    renderDetail();

    await screen.findByRole('button', { name: 'Simulation' });
    expect(screen.getByRole('button', { name: 'Arcade-Style' })).toBeInTheDocument();

    // Default board is the server's choice — the first/biggest.
    expect(screen.getByRole('button', { name: 'Simulation' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('SimTwo')).toBeInTheDocument();
    // The other board's exclusive player is NOT on this table. A combined list
    // is exactly what this page must never render again.
    expect(screen.queryByText('FxAce')).not.toBeInTheDocument();
  });

  it('switches boards on click, and no player carries a rank across both', async () => {
    mockFetch(TWO_BOARDS);
    renderDetail();

    await screen.findByText('SimTwo');
    fireEvent.click(screen.getByRole('button', { name: 'Arcade-Style' }));

    await screen.findByText('FxAce');
    expect(screen.queryByText('SimTwo')).not.toBeInTheDocument();
    // SimAce holds a score on BOTH boards, and is rank 1 on one and rank 2 on
    // the other. Only the current board's row may be on screen.
    expect(screen.getByText('SimAce')).toBeInTheDocument();
    expect(screen.getAllByText('SimAce')).toHaveLength(1);
  });

  it('preselects the deep-linked board', async () => {
    mockFetch(TWO_BOARDS);
    renderDetail('?category=arcade_style');

    await screen.findByText('FxAce');
    expect(screen.getByRole('button', { name: 'Arcade-Style' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Simulation' })).toHaveAttribute('aria-pressed', 'false');
    expect(boardRequests[0]).toContain('category=arcade_style');
  });

  it('falls back gracefully when the deep link names a board that is not there', async () => {
    mockFetch(TWO_BOARDS);
    renderDetail('?category=not_a_band');

    // The strip reflects what is SHOWN, not what was asked for — a stale
    // bookmark must render a leaderboard, not an empty table under a dead tab.
    await screen.findByText('SimTwo');
    expect(screen.getByRole('button', { name: 'Simulation' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Arcade-Style' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('renders one named board, and no selector, for a single-category game', async () => {
    mockFetch([{ category: 'simulation', score_count: 2 }]);
    renderDetail();

    await screen.findByText('SimTwo');
    // No tab strip — there is nothing to choose between…
    expect(screen.queryByRole('button', { name: 'Arcade-Style' })).not.toBeInTheDocument();
    // …but the board still says what it ranks.
    expect(screen.getByTestId('single-category-label')).toHaveTextContent('Simulation scores');
  });

  it('treats Unspecified as a board like any other', async () => {
    mockFetch([
      { category: 'unspecified', score_count: 5 },
      { category: 'simulation', score_count: 2 },
    ]);
    renderDetail();

    const tab = await screen.findByRole('button', { name: 'Unspecified' });
    // It leads the strip because it is the biggest — room-level surfaces still
    // produce unknown-engine scores, and they are the majority in production.
    expect(tab).toHaveAttribute('aria-pressed', 'true');
    expect(tab.getAttribute('title')).toMatch(/can't be compared/i);
  });

  it('keeps the empty claim state for a zero-score game', async () => {
    mockFetch([]);
    renderDetail();

    await screen.findByText(/No scores yet/);
    expect(screen.queryByTestId('single-category-label')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Simulation' })).not.toBeInTheDocument();
  });

  it('does not refetch in a loop once settled', async () => {
    mockFetch(TWO_BOARDS);
    renderDetail();

    await screen.findByText('SimTwo');
    const settled = boardRequests.length;
    await waitFor(() => expect(boardRequests.length).toBe(settled));
    // The page stores the response's `category` but never writes it back to the
    // URL — doing so would make the fetch its own trigger.
    expect(settled).toBeLessThanOrEqual(2);
  });
});
