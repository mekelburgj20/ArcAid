import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import TournamentDetail from '../TournamentDetail';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * `/:slug/tournaments/:tournamentId` — one tournament's results.
 *
 * v2.76 built it as the per-table boards reached from a History row; v2.238.0
 * (B24) made those boards the "By table" view and put the tournament's RUNS
 * first (newest first, each opening its own final standings), with `?run=`
 * deep links and a tournament switcher.
 */

const PAYLOAD = {
  tournament: {
    id: 't-1',
    name: 'Daily Grind',
    type: 'DG',
    is_active: true,
    first_start: '2026-01-01T00:00:00.000Z',
    last_end: '2026-01-11T00:00:00.000Z',
  },
  boards: [
    {
      game_key: 'who dunnit',
      game_name: 'WHO dunnit',
      slot_count: 2,
      start_date: '2026-01-10T00:00:00.000Z',
      end_date: '2026-01-11T00:00:00.000Z',
      status: 'COMPLETED',
      winner: null,
      scores: [
        { rank: 1, discord_user_id: 'd-1', iscored_username: 'PixelWizard', display_name: 'Pixel', score: 1_234_567_890_123, created_at: '2026-01-10T01:00:00.000Z' },
        { rank: 2, discord_user_id: 'd-2', iscored_username: 'FlipperFrenzy', display_name: null, score: 21_000_000, created_at: '2026-01-10T02:00:00.000Z' },
        { rank: 3, discord_user_id: 'd-4', iscored_username: 'TiltMonster', display_name: null, score: 9_450_000, created_at: '2026-01-10T03:00:00.000Z' },
        { rank: 4, discord_user_id: 'd-5', iscored_username: 'BumperBandit', display_name: null, score: 777_000, created_at: '2026-01-10T04:00:00.000Z' },
      ],
    },
    {
      // Competition tie for first — two rank-1 rows, and no rank 2.
      game_key: 'medieval madness',
      game_name: 'Medieval Madness',
      slot_count: 0,
      start_date: null,
      end_date: null,
      status: null,
      winner: null,
      scores: [
        { rank: 1, discord_user_id: 'd-3', iscored_username: 'NudgeNinja', display_name: null, score: 1_250_000, created_at: '2026-01-05T01:00:00.000Z' },
        { rank: 1, discord_user_id: 'd-6', iscored_username: 'GhostRider', display_name: null, score: 1_250_000, created_at: '2026-01-05T02:00:00.000Z' },
      ],
    },
  ],
};
PAYLOAD.boards[0]!.winner = PAYLOAD.boards[0]!.scores[0]! as never;
PAYLOAD.boards[1]!.winner = PAYLOAD.boards[1]!.scores[0]! as never;

/** Two runs of one table plus one empty run, newest first (the server's order). */
const RUNS = [
  {
    game_id: 'g-who-2', tournament_id: 't-1', game_name: 'WHO dunnit',
    start_date: '2026-01-10T00:00:00.000Z', end_date: '2026-01-11T00:00:00.000Z',
    winner_name: 'Pixel', winner_username: 'PixelWizard', winner_score: 1_234_567_890_123, players: 4,
  },
  {
    game_id: 'g-mm', tournament_id: 't-1', game_name: 'Medieval Madness',
    start_date: '2026-01-04T00:00:00.000Z', end_date: '2026-01-05T00:00:00.000Z',
    winner_name: null, winner_username: null, winner_score: null, players: 0,
  },
  {
    game_id: 'g-who-1', tournament_id: 't-1', game_name: 'WHO dunnit',
    start_date: '2026-01-01T00:00:00.000Z', end_date: '2026-01-02T00:00:00.000Z',
    winner_name: 'Flipper', winner_username: 'FlipperFrenzy', winner_score: 500, players: 1,
  },
];

const RUN_BOARDS: Record<string, unknown[]> = {
  'g-who-2': [
    { rank: 1, iscored_username: 'PixelWizard', display_name: 'Pixel', score: 1_234_567_890_123 },
    { rank: 2, iscored_username: 'TiltMonster', display_name: null, score: 9_450_000 },
  ],
  'g-who-1': [
    { rank: 1, iscored_username: 'FlipperFrenzy', display_name: 'Flipper', score: 500 },
  ],
};

const TOURNAMENTS = [
  { id: 't-old', name: 'Spring Cup', is_active: 0 },
  { id: 't-1', name: 'Daily Grind', is_active: 1 },
  { id: 't-2', name: 'Weekly Grind', is_active: 1 },
];

/**
 * Mirrors the page's own `shortDate`. Asserting a literal would bind the suite
 * to the runner's timezone — an ISO instant at midnight UTC renders as the
 * previous day anywhere west of Greenwich.
 */
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

let scores: { status: number; body: unknown };
let runs: { results: unknown[]; total: number; page: number; limit: number };
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    const j = (body: unknown, status = 200) => Promise.resolve({
      ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body),
    });
    if (url.includes('/scores')) return j(scores.body, scores.status);
    if (url.includes('/history?')) return j(runs);
    const board = url.match(/\/leaderboard\/([^?]+)/);
    if (board) return j({ rankings: RUN_BOARDS[decodeURIComponent(board[1]!)] ?? [] });
    if (url.endsWith('/tournaments')) return j(TOURNAMENTS);
    return j(null, 404);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function renderPage(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/test-room/tournaments/t-1${search}`]}>
      <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'test-room', roomName: 'Test Room' }}>
        <Routes>
          <Route path="/:slug/tournaments/:tournamentId" element={<><TournamentDetail /><LocationProbe /></>} />
        </Routes>
      </RoomContext.Provider>
    </MemoryRouter>,
  );
}

const fetched = (part: string) => fetchMock.mock.calls.map(([u]) => String(u)).filter(u => u.includes(part));
const location = () => screen.getByTestId('location').textContent;

describe('TournamentDetail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    scores = { status: 200, body: PAYLOAD };
    runs = { results: RUNS, total: RUNS.length, page: 1, limit: 20 };
    stubFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  describe('header', () => {
    it('names the tournament, its tag, LIVE and its date range', async () => {
      renderPage();
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily Grind' })).toBeInTheDocument());
      expect(fetched('/scores')).toEqual(['/api/rooms/room-1/tournaments/t-1/scores']);
      expect(screen.getByText('DG')).toBeInTheDocument();
      expect(screen.getByTestId('live-dot')).toBeInTheDocument();
      expect(screen.getByText(
        `${fmtDate('2026-01-01T00:00:00.000Z')} – ${fmtDate('2026-01-11T00:00:00.000Z')}`,
      )).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/test-room/history');
    });

    it('omits the LIVE indicator on a finished tournament', async () => {
      scores = { status: 200, body: { ...PAYLOAD, tournament: { ...PAYLOAD.tournament, is_active: false } } };
      renderPage();
      await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily Grind' })).toBeInTheDocument());
      expect(screen.queryByTestId('live-dot')).not.toBeInTheDocument();
    });

    it('404 renders a friendly not-found with the back link intact', async () => {
      scores = { status: 404, body: null };
      renderPage();
      await waitFor(() => expect(screen.getByText('Tournament not found.')).toBeInTheDocument());
      expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/test-room/history');
    });

    it('the switcher lists the room\'s tournaments (running first) and moves between them', async () => {
      renderPage('?view=tables');
      const select = await screen.findByRole('combobox', { name: 'Tournament' });
      expect(within(select).getAllByRole('option').map(o => o.textContent))
        .toEqual(['Daily Grind', 'Weekly Grind', 'Spring Cup']);
      expect(select).toHaveValue('t-1');

      fireEvent.change(select, { target: { value: 't-2' } });
      // The view is kept; the other tournament's results load.
      await waitFor(() => expect(location()).toBe('/test-room/tournaments/t-2?view=tables'));
      await waitFor(() => expect(fetched('/tournaments/t-2/scores')).toHaveLength(1));
    });
  });

  describe('Runs (the default view)', () => {
    it('lists the tournament\'s runs newest first: table, date, winner, players', async () => {
      renderPage();
      const list = await screen.findByRole('list', { name: 'Runs, newest first' });
      expect(fetched('/history?')).toEqual(['/api/rooms/room-1/history?tournament_id=t-1&limit=20&page=1']);

      const rows = within(list).getAllByRole('button');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toHaveTextContent('WHO dunnit');
      expect(rows[0]).toHaveTextContent('Pixel');
      expect(rows[0]).toHaveTextContent('1.2T');
      expect(rows[0]).toHaveTextContent('4 players');
      expect(rows[1]).toHaveTextContent('No scores');
      expect(rows[1]).toHaveTextContent('0 players');
      expect(rows[2]).toHaveTextContent('1 player');
      for (const row of rows) expect(row).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('a row opens that run\'s final standings from the run\'s own board, and closes again', async () => {
      renderPage();
      const list = await screen.findByRole('list', { name: 'Runs, newest first' });
      const older = within(list).getAllByRole('button')[2]!;
      fireEvent.click(older);

      expect(older).toHaveAttribute('aria-expanded', 'true');
      const board = await screen.findByTestId('run-board');
      expect(fetched('/leaderboard/')).toEqual(['/api/rooms/room-1/leaderboard/g-who-1']);
      expect(within(board).getByRole('link', { name: 'Flipper' }))
        .toHaveAttribute('href', '/test-room/players/FlipperFrenzy');
      expect(location()).toBe('/test-room/tournaments/t-1?run=g-who-1&page=1');

      fireEvent.click(older);
      expect(older).toHaveAttribute('aria-expanded', 'false');
      expect(screen.queryByTestId('run-board')).toBeNull();
      expect(location()).toBe('/test-room/tournaments/t-1?page=1');
    });

    it('?run= deep-links one run: the server answers its page and the run is open', async () => {
      runs = { results: [RUNS[2]], total: 21, page: 2, limit: 20 };
      renderPage('?run=g-who-1');

      const board = await screen.findByTestId('run-board');
      expect(fetched('/history?')[0]).toBe('/api/rooms/room-1/history?tournament_id=t-1&limit=20&page=1&run=g-who-1');
      expect(screen.getByRole('button', { expanded: true })).toHaveTextContent('WHO dunnit');
      expect(within(board).getByText('Flipper')).toBeInTheDocument();
      expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    });

    it('paging asks for an explicit page and never jumps back to the open run', async () => {
      runs = { results: [RUNS[2]], total: 21, page: 2, limit: 20 };
      renderPage('?run=g-who-1');
      await screen.findByTestId('run-board');

      runs = { results: RUNS.slice(0, 2), total: 21, page: 1, limit: 20 };
      fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
      await waitFor(() => expect(location()).toBe('/test-room/tournaments/t-1?run=g-who-1&page=1'));
      await waitFor(() => expect(fetched('/history?').at(-1))
        .toBe('/api/rooms/room-1/history?tournament_id=t-1&limit=20&page=1'));
    });

    it('a tournament with no finished runs says so', async () => {
      runs = { results: [], total: 0, page: 1, limit: 20 };
      renderPage();
      await waitFor(() => expect(screen.getByText('No finished runs yet.')).toBeInTheDocument());
    });
  });

  describe('By table (?view=tables)', () => {
    it('renders one card per board, each linking to its game page', async () => {
      renderPage('?view=tables');
      await waitFor(() => expect(screen.getByRole('link', { name: 'WHO dunnit' })).toBeInTheDocument());
      expect(screen.getByRole('link', { name: 'WHO dunnit' })).toHaveAttribute('href', '/test-room/games/WHO%20dunnit');
      expect(screen.getByRole('link', { name: 'Medieval Madness' }))
        .toHaveAttribute('href', '/test-room/games/Medieval%20Madness');
      // "Featured N×" only where the game ran more than one slot.
      expect(screen.getByText('Featured 2×')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'By table' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('renders ranked rows with display_name, formatted score and player links', async () => {
      renderPage('?view=tables');
      await waitFor(() => expect(screen.getByText('Pixel')).toBeInTheDocument());

      // display_name wins where present; iscored_username is the fallback AND
      // stays the routing key either way.
      expect(screen.getByRole('link', { name: 'Pixel' })).toHaveAttribute('href', '/test-room/players/PixelWizard');
      expect(screen.getByRole('link', { name: 'FlipperFrenzy' }))
        .toHaveAttribute('href', '/test-room/players/FlipperFrenzy');

      // ≥1T abbreviates with the full value in a tooltip; below 1T is exact.
      expect(screen.getByText('1.2T')).toHaveAttribute('title', '1,234,567,890,123');
      expect(screen.getByText('21,000,000')).toBeInTheDocument();
    });

    it('renders no trophy icons — the rank number carries the podium on stats surfaces', async () => {
      renderPage('?view=tables');
      await waitFor(() => expect(screen.getByText('Pixel')).toBeInTheDocument());
      // Owner call 2026-08-02: trophies are for score cards, not stats pages.
      expect(screen.queryByLabelText(/place$/)).not.toBeInTheDocument();
    });

    it('empty state when the tournament collected no scores', async () => {
      scores = { status: 200, body: { ...PAYLOAD, boards: [] } };
      renderPage('?view=tables');
      await waitFor(() => expect(
        screen.getByText('No scores were submitted during this tournament.')).toBeInTheDocument());
    });

    it('switching views drops the other view\'s run and page', async () => {
      renderPage('?run=g-who-1&page=1');
      await screen.findByTestId('run-board');
      fireEvent.click(screen.getByRole('button', { name: 'By table' }));
      expect(location()).toBe('/test-room/tournaments/t-1?view=tables');
      fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
      expect(location()).toBe('/test-room/tournaments/t-1');
    });
  });
});

/** v2.240.0 (B25) — table art and player avatars on the tournament page. */
describe('TournamentDetail — table art and avatars', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    scores = {
      status: 200,
      body: {
        ...PAYLOAD,
        boards: PAYLOAD.boards.map((b, i) => ({
          ...b,
          image_url: i === 0 ? '/api/catalogue-images/who.png' : null,
          scores: b.scores.map(r => ({ ...r, avatar_hash: r.iscored_username === 'PixelWizard' ? 'pixhash' : null })),
        })),
      },
    };
    runs = {
      results: RUNS.map((r, i) => ({
        ...r,
        image_url: i === 0 ? '/api/catalogue-images/who.png' : null,
        winner_discord_user_id: r.winner_name ? '111111111111111111' : null,
        winner_avatar_hash: r.winner_name ? 'winhash' : null,
      })),
      total: RUNS.length, page: 1, limit: 20,
    };
    stubFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('each run shows its table art and the winner\'s avatar', async () => {
    renderPage();
    const list = await screen.findByRole('list', { name: 'Runs, newest first' });
    const rows = within(list).getAllByRole('button');
    expect(within(rows[0]!).getByTestId('game-art')).toHaveAttribute('src', '/api/catalogue-images/who.png');
    expect(within(rows[0]!).getByAltText('Pixel').getAttribute('src')).toContain('winhash');
    // No art: initials. No winner: no avatar.
    expect(within(rows[1]!).getByTestId('game-art-fallback')).toHaveTextContent('MM');
    expect(within(rows[1]!).queryAllByRole('img')).toHaveLength(0);
  });

  it('a run\'s final standings show each player\'s avatar', async () => {
    RUN_BOARDS['g-who-1'] = [
      { rank: 1, iscored_username: 'FlipperFrenzy', display_name: 'Flipper', score: 500, discord_user_id: '222222222222222222', avatar_hash: 'fliphash' },
    ];
    renderPage('?run=g-who-1&page=1');
    const board = await screen.findByTestId('run-board');
    expect(within(board).getByAltText('Flipper').getAttribute('src')).toContain('fliphash');
  });

  it('By table: each board leads with its table art, and rows carry avatars', async () => {
    renderPage('?view=tables');
    await waitFor(() => expect(screen.getByRole('link', { name: 'WHO dunnit' })).toBeInTheDocument());
    expect(screen.getAllByTestId('game-art')[0]).toHaveAttribute('src', '/api/catalogue-images/who.png');
    expect(screen.getByAltText('Pixel').getAttribute('src')).toContain('pixhash');
  });
});
