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

/**
 * All card roots currently on screen.
 *
 * Was "the art <a>'s parent", walked up from the category chip. v2.67.0 moved
 * the title and the chip out of the art link into a header row of their own, so
 * that walk no longer lands on the card — the card root carries its own
 * `data-testid` instead, which is what a test should have been asking for.
 */
function allCards(): HTMLElement[] {
  return screen.queryAllByTestId('global-game-card');
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

  it('renders a zero-score game as ONE uncategorised card with an all-empty podium', async () => {
    mockFetch([makeCard('g0', 'Untouched Game', null, 0)]);

    renderScoreboard();

    await screen.findByText('Untouched Game');
    // No chip: a game with no scores has no board to name, and "Unspecified"
    // would claim scores of unrecorded provenance that do not exist.
    expect(screen.queryByTestId('category-chip')).not.toBeInTheDocument();
    // v2.67.0: the dashed "Claim 1st ->" box is gone; an empty board renders
    // the three podium places, each offering itself.
    expect(screen.getByRole('button', { name: 'Claim 1st place' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim 2nd place' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim 3rd place' })).toBeInTheDocument();
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
      .toEqual(['Arcade-Style', 'Real Machine', 'Simulation']);
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

    for (const label of ['All', 'Real Machine', 'Simulation', 'Arcade-Style', 'Video Games', 'Unspecified']) {
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

    // v2.65.0 — the label is "Real Machine"; the id it sends is still `real`.
    fireEvent.click(screen.getByRole('button', { name: 'Real Machine' }));
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

  it('links every card of a game to the same detail page, deep-linked to its own board', async () => {
    mockFetch([
      makeCard('g1', 'Twin Boards', 'simulation', 1),
      makeCard('g1', 'Twin Boards', 'arcade_style', 1),
    ]);

    renderScoreboard();

    await waitFor(() => expect(allCards()).toHaveLength(2));
    const hrefs = allCards().map(
      card => within(card).getAllByRole('link')[0].getAttribute('href'),
    );
    // Same page — a game has one detail page, however many boards it has…
    expect(hrefs.every(h => h?.startsWith('/games/g1'))).toBe(true);
    // …but v2.63.0 each card carries its own category, so the page opens on the
    // board the player actually clicked instead of defaulting to the biggest.
    expect(hrefs).toEqual([
      '/games/g1?category=simulation',
      '/games/g1?category=arcade_style',
    ]);
  });
});

/**
 * v2.64.0 — cards carry the category chip and nothing else.
 *
 * The engine pill they used to render came from the game's CATALOGUE, so every
 * card of a game showed the same one. With per-category cards that reads as a
 * claim about the scores on the board underneath it (the field report: both of
 * Creature from the Black Lagoon's cards said FUTURE PINBALL), which is exactly
 * what the category chip is there to say — and says correctly.
 */
describe('GlobalScoreboard — cards show the category chip only (v2.64.0)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    scoreboardRequests = [];
    document.documentElement.className = '';
  });

  it('renders no engine chip beside the category chip', async () => {
    mockFetch([
      makeCard('g1', 'Creature', 'simulation', 3, { platforms: JSON.stringify(['bam']) }),
      makeCard('g1', 'Creature', 'arcade_style', 2, { platforms: JSON.stringify(['bam']) }),
    ]);

    renderScoreboard();

    await waitFor(() => expect(screen.getAllByText('Creature')).toHaveLength(2));
    const cards = allCards();
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      // The board's own name survives…
      expect(within(card).getByTestId('category-chip')).toBeInTheDocument();
      // …the catalogue engine that used to sit next to it does not.
      expect(within(card).queryByText('Future Pinball')).not.toBeInTheDocument();
    }
    // Both cards still name their OWN band, which is the point.
    expect(cards.map(c => within(c).getByTestId('category-chip').textContent))
      .toEqual(['Simulation', 'Arcade-Style']);
  });

  it('keeps the full deduped engine list reachable as the art tooltip', async () => {
    mockFetch([
      makeCard('g1', 'Creature', 'simulation', 3, {
        // `vpx` and `vpxs` are one engine — the tooltip must say it once.
        platforms: JSON.stringify(['vpx', 'vpxs', 'bam']),
      }),
    ]);

    renderScoreboard();
    await screen.findByText('Creature');

    // v2.67.0: the art block is the only thing left inside the art <a>, and it
    // is reached by its own label rather than by walking up from the chip.
    const art = screen.getByLabelText('Creature details');
    expect(art.getAttribute('title')).toBe('Available on: Visual Pinball X · Future Pinball');
  });
});

describe('GlobalScoreboard — the zero-score card names its prospective board (v2.63.0)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    scoreboardRequests = [];
    document.documentElement.className = '';
  });

  it('shows the band chip when the catalogue is unambiguous', async () => {
    mockFetch([
      makeCard('g0', 'Unplayed Sim', null, 0, { prospective_category: 'simulation' }),
    ]);

    renderScoreboard();
    await screen.findByText('Unplayed Sim');

    const chip = screen.getByTestId('category-chip');
    expect(chip).toHaveTextContent('Simulation');
    // The copy must not claim scores that don't exist.
    expect(chip.getAttribute('title')).toMatch(/No scores yet/i);
    expect(chip).toHaveAttribute('data-prospective', 'true');
    // Still the claim card, and still keyed as the uncategorised one.
    // v2.67.0: the dashed "Claim 1st ->" box is gone; an empty board renders
    // the three podium places, each offering itself.
    expect(screen.getByRole('button', { name: 'Claim 1st place' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim 2nd place' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claim 3rd place' })).toBeInTheDocument();
    expect(screen.getByText('0 scores')).toBeInTheDocument();
  });

  it('links BARE — a prospective band is not a board to preselect', async () => {
    mockFetch([
      makeCard('g0', 'Unplayed Sim', null, 0, { prospective_category: 'simulation' }),
    ]);

    renderScoreboard();
    await screen.findByText('Unplayed Sim');

    const card = screen.getByTestId('global-game-card');
    expect(within(card).getAllByRole('link')[0]).toHaveAttribute('href', '/games/g0');
  });

  it('shows no chip when the catalogue spans two bands', async () => {
    mockFetch([makeCard('g0', 'Unplayed Both', null, 0)]);

    renderScoreboard();
    await screen.findByText('Unplayed Both');

    expect(screen.queryByTestId('category-chip')).not.toBeInTheDocument();
  });
});
