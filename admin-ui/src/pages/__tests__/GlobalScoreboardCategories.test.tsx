import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalScoreboard from '../GlobalScoreboard';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

/**
 * v2.59.0 (ADR 0016 P4) — one card per `(game, fidelity category)`.
 *
 * The behaviour these lock is the one that is easy to break by "tidying up":
 * that a game with two boards renders TWO cards and neither one disappears.
 * Two specific traps have a test each:
 *
 *   • The **Unspecified** card. 38 of 67 production global scores have
 *     `engine='unknown'`; if the page ever stops rendering that bucket, the
 *     majority of the site's scores silently leave the page.
 *   • The **hero de-duplication**. The hero renders one of its game's cards;
 *     filtering the grid by GAME id (rather than by card) would delete that
 *     game's other boards from the page entirely.
 */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

function makeScore(n: number) {
  return {
    iscored_username: `player${n}`,
    display_name: null,
    score: 1_000_000 - n * 1000,
    avatar_hash: null,
    discord_user_id: `discord-${n}`,
    origin_room_slug: null,
    origin_room_logo_url: null,
    origin_room_short_tag: null,
  };
}

function makeCard(
  gameId: string,
  name: string,
  category: string | null,
  scoreCount: number,
  overrides: Record<string, unknown> = {},
) {
  const top = Array.from({ length: Math.min(scoreCount, 6) }, (_, i) => makeScore(i + 1));
  return {
    global_game_id: gameId,
    card_id: `${gameId}::${category ?? 'none'}`,
    category,
    name,
    display_name: null,
    manufacturer: 'Williams',
    year: 1997,
    type: 'pinball',
    image_url: null,
    local_image_path: null,
    wheel_image_path: null,
    platforms: JSON.stringify(['vpx']),
    score_count: scoreCount,
    top_score: top[0]?.score ?? null,
    last_submitted_at: null,
    avg_rating: 0,
    rating_count: 0,
    top_scores: top,
    ...overrides,
  };
}

let scoreboardRequests: string[] = [];

function mockFetch(cards: unknown[], extra: Record<string, unknown> = {}) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/global/scoreboard')) {
      scoreboardRequests.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: cards, total: cards.length, hasMore: false, ...extra }),
      });
    }
    if (url.startsWith('/api/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderScoreboard() {
  return render(
    <MemoryRouter initialEntries={['/scoreboard']}>
      <ThemeProvider>
        <ViewerAuthProvider>
          <GlobalScoreboard />
        </ViewerAuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** All card roots currently on screen (the art <a>'s parent). */
function allCards(): HTMLElement[] {
  return screen.queryAllByTestId('category-chip')
    .map(chip => chip.closest('a')?.parentElement)
    .filter(Boolean) as HTMLElement[];
}

describe('GlobalScoreboard — per-category cards (v2.59.0 P4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    scoreboardRequests = [];
    document.documentElement.className = '';
  });

  it('renders one card per category for a game with scores in two bands', async () => {
    mockFetch([
      makeCard('g1', 'Medieval Madness', 'simulation', 3),
      makeCard('g1', 'Medieval Madness', 'arcade_style', 2),
    ]);

    renderScoreboard();

    await waitFor(() => expect(screen.getAllByText('Medieval Madness')).toHaveLength(2));
    // By test id, not by text: the filter chips carry the same words.
    expect(screen.getAllByTestId('category-chip').map(c => c.textContent))
      .toEqual(['Simulation', 'Arcade-Style']);
    // Each card reports its OWN count, not the game's 5.
    expect(screen.getByText('3 scores')).toBeInTheDocument();
    expect(screen.getByText('2 scores')).toBeInTheDocument();
  });

  it('renders the Unspecified bucket, muted and with an explanatory tooltip', async () => {
    mockFetch([makeCard('g1', 'AtGames Only', 'unspecified', 4)]);

    renderScoreboard();

    const chip = await screen.findByTestId('category-chip');
    expect(chip).toHaveTextContent('Unspecified');
    expect(chip.getAttribute('style')).toContain('--sb-cat-muted-fg');
    // It must never read as a fidelity band; the tooltip says why.
    expect(chip.getAttribute('title')).toMatch(/can't be compared/i);
    // …and its scores are reachable, which is the whole point of the bucket.
    expect(screen.getByText('player1')).toBeInTheDocument();
  });

  it('styles a real fidelity band differently from Unspecified', async () => {
    mockFetch([
      makeCard('g1', 'Sim Game', 'simulation', 1),
      makeCard('g2', 'Unknown Game', 'unspecified', 1),
    ]);

    renderScoreboard();

    await waitFor(() => expect(screen.getAllByTestId('category-chip')).toHaveLength(2));
    const [sim, unspec] = screen.getAllByTestId('category-chip');
    expect(sim.getAttribute('style')).toContain('--sb-cat-fg');
    expect(unspec.getAttribute('style')).toContain('--sb-cat-muted-fg');
    // Tokens only — a literal colour here would be a light-mode bug.
    expect(sim.getAttribute('style')).not.toMatch(/rgba?\(/);
    expect(unspec.getAttribute('style')).not.toMatch(/rgba?\(/);
  });

  it('renders a zero-score game as ONE uncategorised card with the Claim 1st CTA', async () => {
    mockFetch([makeCard('g0', 'Untouched Game', null, 0)]);

    renderScoreboard();

    await screen.findByText('Untouched Game');
    // No chip: a game with no scores has no board to name, and "Unspecified"
    // would claim scores of unrecorded provenance that do not exist.
    expect(screen.queryByTestId('category-chip')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Claim 1st/ })).toBeInTheDocument();
    expect(screen.getByText('0 scores')).toBeInTheDocument();
  });

  it('keeps a game\'s OTHER boards when the hero renders one of them', async () => {
    const hero = { ...makeCard('g1', 'Hero Game', 'simulation', 3), is_hot: true, weekly_score_count: 9 };
    mockFetch(
      [
        makeCard('g1', 'Hero Game', 'simulation', 3),
        makeCard('g1', 'Hero Game', 'arcade_style', 2),
        makeCard('g2', 'Other Game', 'real', 1),
      ],
      { hero },
    );

    renderScoreboard();

    // The hero + the Arcade-Style grid card + Other Game. The Simulation grid
    // card is the hero's own and is filtered out; filtering by GAME instead
    // would have taken Arcade-Style with it.
    await waitFor(() => expect(screen.getAllByText('Hero Game')).toHaveLength(2));
    expect(screen.getAllByTestId('category-chip').map(c => c.textContent).sort())
      .toEqual(['Arcade-Style', 'Real', 'Simulation']);
  });

  it('counts leaderboards, not games, in the results summary', async () => {
    mockFetch([
      makeCard('g1', 'Medieval Madness', 'simulation', 3),
      makeCard('g1', 'Medieval Madness', 'arcade_style', 2),
    ]);

    renderScoreboard();

    // Two cards from one game — "2 games" would be a lie.
    await waitFor(() => expect(screen.getByText(/Showing 2 of 2 leaderboards/)).toBeInTheDocument());
  });
});

describe('GlobalScoreboard — category chips (v2.59.0 P4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    scoreboardRequests = [];
    document.documentElement.className = '';
  });

  it('offers every category from the shared taxonomy, plus All', async () => {
    mockFetch([makeCard('g1', 'Game', 'simulation', 1)]);
    renderScoreboard();
    await screen.findByText('Game');

    for (const label of ['All', 'Real', 'Simulation', 'Arcade-Style', 'Video Games', 'Unspecified']) {
      expect(screen.getByRole('button', { name: label }), label).toBeInTheDocument();
    }
    // The superseded platform-group chips are gone.
    expect(screen.queryByRole('button', { name: 'All platforms' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Virtual Pinball' })).not.toBeInTheDocument();
  });

  it('sends the category id — never the label — and marks the chip pressed', async () => {
    mockFetch([makeCard('g1', 'Game', 'arcade_style', 1)]);
    renderScoreboard();
    await screen.findByText('Game');

    scoreboardRequests = [];
    fireEvent.click(screen.getByRole('button', { name: 'Arcade-Style' }));

    await waitFor(() => expect(scoreboardRequests.length).toBeGreaterThan(0));
    expect(scoreboardRequests[0]).toContain('category=arcade_style');
    expect(screen.getByRole('button', { name: 'Arcade-Style' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('makes Unspecified a selectable chip like any other', async () => {
    mockFetch([makeCard('g1', 'Game', 'unspecified', 1)]);
    renderScoreboard();
    await screen.findByText('Game');

    scoreboardRequests = [];
    fireEvent.click(screen.getByRole('button', { name: 'Unspecified' }));

    await waitFor(() => expect(scoreboardRequests.length).toBeGreaterThan(0));
    expect(scoreboardRequests[0]).toContain('category=unspecified');
  });

  it('sends no category param at all for All', async () => {
    mockFetch([makeCard('g1', 'Game', 'simulation', 1)]);
    renderScoreboard();
    await screen.findByText('Game');

    fireEvent.click(screen.getByRole('button', { name: 'Real' }));
    await waitFor(() => expect(scoreboardRequests.some(u => u.includes('category=real'))).toBe(true));

    scoreboardRequests = [];
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    await waitFor(() => expect(scoreboardRequests.length).toBeGreaterThan(0));
    expect(scoreboardRequests[0]).not.toContain('category=');
  });
});

describe('GlobalScoreboard — pins stay keyed on the game (v2.59.0 P4)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    scoreboardRequests = [];
    document.documentElement.className = '';
  });

  function b64url(obj: object): string {
    return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function signIn(discordId = 'discord-me') {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const token = `${b64url({ alg: 'none' })}.${b64url({ discordId, username: 'Me', avatar: null, exp })}.sig`;
    localStorage.setItem('arcaid_player_token', token);
    localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Me', avatar: null }));
  }

  it('flips BOTH of a game\'s cards when either one is pinned', async () => {
    signIn();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/pin')) return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      if (url.startsWith('/api/global/pins')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ pins: [] }) });
      }
      if (url.startsWith('/api/global/scoreboard')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            data: [
              { ...makeCard('g1', 'Twin Boards', 'simulation', 2), is_pinned: false, my_rank: null, my_score: null, neighbors: [] },
              { ...makeCard('g1', 'Twin Boards', 'arcade_style', 2), is_pinned: false, my_rank: null, my_score: null, neighbors: [] },
            ],
            total: 2,
            hasMore: false,
          }),
        });
      }
      if (url.startsWith('/api/me/scoreboard-preferences')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderScoreboard();

    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Pin Twin Boards' })).toHaveLength(2));
    fireEvent.click(screen.getAllByRole('button', { name: 'Pin Twin Boards' })[0]);

    // A pin belongs to the GAME, so both of its boards must show pinned —
    // keying the optimistic update on card_id would have flipped only one.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Unpin Twin Boards' })).toHaveLength(2));
  });

  it('links every card of a game to the same detail page', async () => {
    mockFetch([
      makeCard('g1', 'Twin Boards', 'simulation', 1),
      makeCard('g1', 'Twin Boards', 'arcade_style', 1),
    ]);

    renderScoreboard();

    await waitFor(() => expect(allCards()).toHaveLength(2));
    for (const card of allCards()) {
      expect(within(card).getAllByRole('link')[0]).toHaveAttribute('href', '/games/g1');
    }
  });
});
