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
/** The Runs view's week (the shared RunFeed draws it; RunFeed.test.tsx pins its behaviour). */
const WEEK = {
  results: [{
    game_id: 'g-who-2', tournament_id: 't-1', game_name: 'WHO dunnit', tournament_name: 'Daily Grind', tournament_type: 'DG',
    start_date: '2026-01-10T00:00:00.000Z', end_date: '2026-01-11T00:00:00.000Z', image_url: null,
    winner_name: 'Pixel', winner_username: 'PixelWizard', winner_score: 100, players: 1,
    standings: [{ rank: 1, iscored_username: 'PixelWizard', display_name: 'Pixel', score: 100 }],
  }],
  total: 1, week: 0,
  window: { from: '2026-01-04T00:00:00.000Z', to: '2026-01-11T00:00:00.000Z' },
  has_newer: false, has_older: false,
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
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    const j = (body: unknown, status = 200) => Promise.resolve({
      ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body),
    });
    if (url.includes('/scores')) return j(scores.body, scores.status);
    if (url.includes('/history?')) return j(WEEK);
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
    it('shows this tournament\'s latest week of runs as cards, without repeating the tournament on each', async () => {
      renderPage();
      const [card] = await screen.findAllByTestId('run-card');
      const q = new URL(fetched('/history?')[0]!, 'http://x');
      expect(Object.fromEntries(q.searchParams)).toEqual({ week: '0', standings: '1', tournament_id: 't-1' });
      expect(within(card!).getByRole('link', { name: 'WHO dunnit' })).toBeInTheDocument();
      expect(within(card!).queryByRole('link', { name: 'Daily Grind' })).toBeNull();
      expect(within(card!).getByTestId('run-board')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Runs' })).toHaveAttribute('aria-pressed', 'true');
    });

    it('a ?run= deep link reaches the feed', async () => {
      renderPage('?run=g-who-2');
      await screen.findAllByTestId('run-card');
      expect(new URL(fetched('/history?')[0]!, 'http://x').searchParams.get('run')).toBe('g-who-2');
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

    it('switching views drops the other view\'s run and week', async () => {
      renderPage('?run=g-who-2&week=1');
      await screen.findAllByTestId('run-card');
      fireEvent.click(screen.getByRole('button', { name: 'By table' }));
      expect(location()).toBe('/test-room/tournaments/t-1?view=tables');
      fireEvent.click(screen.getByRole('button', { name: 'Runs' }));
      expect(location()).toBe('/test-room/tournaments/t-1');
    });
  });
});

/** v2.240.0 (B25) — table art and player avatars on the tournament page. */
describe('TournamentDetail — By table art and avatars', () => {
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
    stubFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('each board leads with its table art, and rows carry avatars', async () => {
    renderPage('?view=tables');
    await waitFor(() => expect(screen.getByRole('link', { name: 'WHO dunnit' })).toBeInTheDocument());
    const art = screen.getAllByTestId('game-art')[0]!;
    expect(art).toHaveAttribute('src', '/api/catalogue-images/who.png');
    expect(art).toHaveAttribute('width', '80');
    expect(screen.getByAltText('Pixel').getAttribute('src')).toContain('pixhash');
  });
});
