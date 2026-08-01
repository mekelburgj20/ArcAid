import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalScoreboard from '../GlobalScoreboard';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

// v2.50.0 (A2) — the rebuilt global-scoreboard card. These lock the four
// behaviours the redesign actually changed, all of which are easy to silently
// regress by "restoring" the old podium:
//   * rows are score-driven, never padded with `—` placeholders
//   * a scoreless game gets three claimable podium places (v2.67.0; it used
//     to get a single dashed "Claim 1st ->" box)
//   * the card renders at most CARD_ROWS (6) even though the API returns 10
//   * ranks 1-3 render lucide Medals wearing the A1 medal tokens
// Plus the two things that must NOT have been dropped in the rewrite: the
// Submit button still opens SubmissionSheet, and RoomTag (the cross-room
// provenance signal) still renders when origin_room_slug is set.

// The page opens a socket for the `score:new:global` toast; keep it inert
// under jsdom (same treatment as PublicLayout.test.tsx).
vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signInAs(discordId: string, username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

interface ScoreOverrides {
  origin_room_slug?: string | null;
  origin_room_short_tag?: string | null;
}

function makeScore(n: number, overrides: ScoreOverrides = {}) {
  return {
    iscored_username: `player${n}`,
    display_name: null,
    score: 1_000_000 - n * 1000,
    avatar_hash: null,
    discord_user_id: `discord-${n}`,
    origin_room_slug: null,
    origin_room_logo_url: null,
    origin_room_short_tag: null,
    ...overrides,
  };
}

function makeGame(
  id: string,
  name: string,
  topScores: ReturnType<typeof makeScore>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    global_game_id: id,
    name,
    display_name: null,
    manufacturer: 'Williams',
    year: 1997,
    type: 'pinball',
    image_url: null,
    local_image_path: null,
    wheel_image_path: null,
    platforms: JSON.stringify(['vpx']),
    score_count: topScores.length,
    top_score: topScores[0]?.score ?? null,
    last_submitted_at: null,
    avg_rating: 0,
    rating_count: 0,
    top_scores: topScores,
    ...overrides,
  };
}

function mockFetch(games: unknown[]) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/global/scoreboard')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: games, total: games.length, hasMore: false }),
      });
    }
    if (url.startsWith('/api/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.startsWith('/api/submit/platforms')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ platforms: ['vpx'], submittable: ['vpx'], tournamentRules: null }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

// GlobalThemeToggle in the header calls useTheme(), which throws outside a
// provider; App.tsx supplies one in production.
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

/** The card element for a given game title — the <a> art block's parent. */
async function findCard(title: string): Promise<HTMLElement> {
  // v2.67.0 moved the title out of the art <a> into the card's own header row,
  // so the old `heading.closest('a').parentElement` walk stopped landing on the
  // card. The root carries a `data-testid`, which is the thing to ask for.
  const heading = await screen.findByText(title);
  const card = heading.closest('[data-testid="global-game-card"]');
  if (!card) throw new Error(`No card found for "${title}"`);
  return card as HTMLElement;
}

describe('GlobalScoreboard card (v2.50.0 A2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('a 1-score game renders exactly one row and no placeholder dashes', async () => {
    mockFetch([makeGame('g1', 'Solo Score Game', [makeScore(1)])]);

    renderScoreboard();

    const card = await findCard('Solo Score Game');
    // One row: the rank-1 medal, and nothing for ranks 2/3.
    expect(within(card).getByLabelText('1st place')).toBeInTheDocument();
    expect(within(card).queryByLabelText('2nd place')).not.toBeInTheDocument();
    expect(within(card).queryByLabelText('3rd place')).not.toBeInTheDocument();
    expect(within(card).getByText('player1')).toBeInTheDocument();
    // The old podium padded missing places with em-dashes; the rebuild must not.
    expect(within(card).queryByText('—')).not.toBeInTheDocument();
    // Footer count is singular for one score.
    expect(within(card).getByText('1 score')).toBeInTheDocument();
  });

  it('a 0-score game renders three empty podium places, each claimable', async () => {
    mockFetch([makeGame('g0', 'Untouched Game', [])]);

    renderScoreboard();

    const card = await findCard('Untouched Game');
    // v2.67.0 replaced the single dashed "Claim 1st ->" box with the podium
    // itself: the medals are drawn whether or not anyone holds them.
    for (const place of ['1st', '2nd', '3rd']) {
      expect(within(card).getByRole('button', { name: `Claim ${place} place` })).toBeInTheDocument();
    }
    expect(within(card).getAllByText('Claim this spot')).toHaveLength(3);
    // An empty place is NOT held by anybody: the "Nth place" label — which is
    // how every other test asserts "somebody is here" — must not appear.
    expect(within(card).queryByLabelText('1st place')).not.toBeInTheDocument();
    // The old podium padded missing places with em-dashes; this one does not.
    expect(within(card).queryByText('—')).not.toBeInTheDocument();
    expect(within(card).getByText('0 scores')).toBeInTheDocument();
  });

  it('a partially-filled podium keeps the taken places and offers the rest', async () => {
    mockFetch([makeGame('g1', 'Lonely Leader', [makeScore(1)])]);

    renderScoreboard();

    const card = await findCard('Lonely Leader');
    expect(within(card).getByLabelText('1st place')).toBeInTheDocument();
    expect(within(card).getByText('player1')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Claim 1st place' })).not.toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Claim 2nd place' })).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: 'Claim 3rd place' })).toBeInTheDocument();
  });

  it('a claim place opens the same submit flow the footer button does', async () => {
    signInAs('discord-me');
    mockFetch([makeGame('g0', 'Claimable Game', [])]);

    renderScoreboard();

    const card = await findCard('Claimable Game');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(within(card).getByRole('button', { name: 'Claim 1st place' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Claimable Game')).toBeInTheDocument();
  });

  it('renders at most 6 rows for a 10-score payload', async () => {
    const scores = Array.from({ length: 10 }, (_, i) => makeScore(i + 1));
    mockFetch([makeGame('g10', 'Deep Field Game', scores, { score_count: 10 })]);

    renderScoreboard();

    const card = await findCard('Deep Field Game');
    // Ranks 1-3 are medals; 4-6 are `#n` cells; 7+ must not render at all.
    expect(within(card).getByLabelText('1st place')).toBeInTheDocument();
    expect(within(card).getByText('#4')).toBeInTheDocument();
    expect(within(card).getByText('#6')).toBeInTheDocument();
    expect(within(card).queryByText('#7')).not.toBeInTheDocument();
    expect(within(card).getByText('player6')).toBeInTheDocument();
    expect(within(card).queryByText('player7')).not.toBeInTheDocument();
    expect(within(card).queryByText('player10')).not.toBeInTheDocument();
  });

  it('ranks 1-3 render medals wearing the A1 medal tokens', async () => {
    mockFetch([makeGame('g3', 'Podium Game', [makeScore(1), makeScore(2), makeScore(3)])]);

    renderScoreboard();

    const card = await findCard('Podium Game');
    // Gold reuses the (already theme-aware) amber; silver/bronze are the new
    // --color-medal-* tokens. Literal hex here would be the regression.
    expect(within(card).getByLabelText('1st place')).toHaveClass('text-neon-amber');
    expect(within(card).getByLabelText('2nd place')).toHaveClass('text-medal-silver');
    expect(within(card).getByLabelText('3rd place')).toHaveClass('text-medal-bronze');
    // Rank 4+ has no medal — it renders a plain `#n` cell.
    expect(within(card).queryByLabelText('4th place')).not.toBeInTheDocument();
  });

  it('the footer Submit button opens SubmissionSheet for a signed-in viewer', async () => {
    signInAs('discord-me');
    mockFetch([makeGame('g1', 'Submittable Game', [makeScore(1)])]);

    renderScoreboard();

    const card = await findCard('Submittable Game');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    // Exact name, not /Submit/: A4's pin hotspot is labelled "Pin {game}",
    // and this fixture's game is called "Submittable Game" — the loose regex
    // matched both buttons.
    fireEvent.click(within(card).getByRole('button', { name: 'Submit' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Submittable Game')).toBeInTheDocument();
  });

  it('renders RoomTag on a row whose score has an origin_room_slug', async () => {
    mockFetch([
      makeGame('g1', 'Provenance Game', [
        makeScore(1, { origin_room_slug: 'rtx_pinball', origin_room_short_tag: 'RTX' }),
        makeScore(2),
      ]),
    ]);

    renderScoreboard();

    const card = await findCard('Provenance Game');
    await waitFor(() => expect(within(card).getByLabelText('RTX')).toBeInTheDocument());
    // Only the row that carries provenance gets a tag — the second score has
    // origin_room_slug null, so exactly one tag renders on the whole card.
    expect(within(card).getAllByLabelText('RTX')).toHaveLength(1);
    const tagLinks = within(card).getAllByRole('link', { name: 'RTX' });
    expect(tagLinks).toHaveLength(1);
    expect(tagLinks[0]).toHaveAttribute('href', '/scoreboard?room=rtx_pinball');
  });
});
