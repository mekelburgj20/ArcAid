import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TournamentDetail from '../TournamentDetail';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * `/:slug/tournaments/:tournamentId` (v2.76) — the per-tournament board page
 * reached from a public History row.
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
      ],
    },
    {
      game_key: 'medieval madness',
      game_name: 'Medieval Madness',
      slot_count: 0,
      start_date: null,
      end_date: null,
      status: null,
      winner: null,
      scores: [
        { rank: 1, discord_user_id: 'd-3', iscored_username: 'NudgeNinja', display_name: null, score: 1_250_000, created_at: '2026-01-05T01:00:00.000Z' },
      ],
    },
  ],
};
PAYLOAD.boards[0]!.winner = PAYLOAD.boards[0]!.scores[0]! as never;
PAYLOAD.boards[1]!.winner = PAYLOAD.boards[1]!.scores[0]! as never;

/**
 * Mirrors the page's own `shortDate`. Asserting a literal would bind the suite
 * to the runner's timezone — an ISO instant at midnight UTC renders as the
 * previous day anywhere west of Greenwich.
 */
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function mockFetch(response: { status?: number; body?: unknown }) {
  const status = response.status ?? 200;
  const fetchMock = vi.fn(() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(response.body ?? null),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/test-room/tournaments/t-1']}>
      <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'test-room', roomName: 'Test Room' }}>
        <Routes>
          <Route path="/:slug/tournaments/:tournamentId" element={<TournamentDetail />} />
        </Routes>
      </RoomContext.Provider>
    </MemoryRouter>,
  );
}

describe('TournamentDetail', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('fetches the tournament-scoped endpoint and renders one card per board', async () => {
    const fetchMock = mockFetch({ body: PAYLOAD });
    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily Grind' })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith('/api/rooms/room-1/tournaments/t-1/scores');

    // Both boards render, each linking through to its room game detail page.
    expect(screen.getByRole('link', { name: 'WHO dunnit' })).toHaveAttribute(
      'href', '/test-room/games/WHO%20dunnit');
    expect(screen.getByRole('link', { name: 'Medieval Madness' })).toHaveAttribute(
      'href', '/test-room/games/Medieval%20Madness');

    // Type tag, LIVE indicator and the tournament date range.
    expect(screen.getByText('DG')).toBeInTheDocument();
    expect(screen.getByTestId('live-dot')).toBeInTheDocument();
    expect(screen.getByText(
      `${fmtDate('2026-01-01T00:00:00.000Z')} – ${fmtDate('2026-01-11T00:00:00.000Z')}`,
    )).toBeInTheDocument();

    // "Featured N×" only where the game ran more than one slot.
    expect(screen.getByText('Featured 2×')).toBeInTheDocument();
  });

  it('renders ranked rows with display_name, formatted score and player links', async () => {
    mockFetch({ body: PAYLOAD });
    renderPage();

    await waitFor(() => expect(screen.getByText('Pixel')).toBeInTheDocument());

    // display_name wins where present; iscored_username is the fallback AND
    // stays the routing key either way.
    const winnerLink = screen.getByRole('link', { name: 'Pixel' });
    expect(winnerLink).toHaveAttribute('href', '/test-room/players/PixelWizard');
    expect(screen.getByRole('link', { name: 'FlipperFrenzy' }))
      .toHaveAttribute('href', '/test-room/players/FlipperFrenzy');

    // ≥1T abbreviates with the full value in a tooltip; below 1T is exact.
    expect(screen.getByText('1.2T')).toHaveAttribute('title', '1,234,567,890,123');
    expect(screen.getByText('21,000,000')).toBeInTheDocument();
  });

  it('shows the back link to History', async () => {
    mockFetch({ body: PAYLOAD });
    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily Grind' })).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/test-room/history');
  });

  it('404 renders a friendly not-found with the back link intact', async () => {
    mockFetch({ status: 404 });
    renderPage();

    await waitFor(() => expect(screen.getByText('Tournament not found.')).toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'History' })).toHaveAttribute('href', '/test-room/history');
  });

  it('empty state when the tournament collected no scores', async () => {
    mockFetch({ body: { ...PAYLOAD, boards: [] } });
    renderPage();

    await waitFor(() => expect(
      screen.getByText('No scores were submitted during this tournament.')).toBeInTheDocument());
  });

  it('omits the LIVE indicator on a finished tournament', async () => {
    mockFetch({ body: { ...PAYLOAD, tournament: { ...PAYLOAD.tournament, is_active: false } } });
    renderPage();

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Daily Grind' })).toBeInTheDocument());
    expect(screen.queryByTestId('live-dot')).not.toBeInTheDocument();
  });
});
