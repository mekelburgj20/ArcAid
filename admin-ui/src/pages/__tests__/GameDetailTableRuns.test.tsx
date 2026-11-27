import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';

/** B31.3: the table's runs panel on the game page; hidden until the table has a finished run. */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

const STATS = { gameName: 'Game Of Dog', timesPlayed: 7, avgScore: 4200, uniquePlayers: 3, allTimeHigh: 9999, allTimeHighPlayer: 'Ada', recentResults: [] };
const player = { key: 'k', iscored_username: 'Ada', display_name: null, discord_user_id: null, avatar_hash: null, avatar_url: null };
const SUMMARY = {
  game_name: 'Game Of Dog', runs: 3, typical_winning_score: 92_000_000, median_game: 41_000_000,
  most_games_in_run: { player, games: 122, game_id: 'g1', tournament_id: 't1' },
  recent: [{ game_id: 'g1', tournament_id: 't1', tournament_name: 'Season 6', end_date: '2026-11-05T00:00:00.000Z', winner: player, winning_score: 95_000_000, players: 9, witness_games: 300 }],
};

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function stub(runs: unknown) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.endsWith('/runs')) return ok(runs);
    if (/\/stats\/game\/[^/]+$/.test(url)) return ok(STATS);
    return ok([]);
  }) as unknown as typeof fetch);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/rtx/games/Game%20Of%20Dog']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx', roomName: 'RTX' }}>
            <Routes>
              <Route path="/:slug/games/:name" element={<GameDetail />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('GameDetail table runs panel', () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows the tiles and the recent runs', async () => {
    stub(SUMMARY);
    renderPage();
    expect(await screen.findByTestId('table-runs')).toBeInTheDocument();
    expect(screen.getByText('92.0M')).toBeInTheDocument();
    expect(screen.getByText('Typical winning score')).toBeInTheDocument();
    expect(screen.getByText(/Most games in one run: Ada, 122/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Season 6/ }).getAttribute('href')).toContain('recap=1');
  });

  it('renders nothing for a table with no finished run', async () => {
    stub({ ...SUMMARY, runs: 0, recent: [], most_games_in_run: null });
    renderPage();
    await screen.findByText('Game Of Dog');
    expect(screen.queryByTestId('table-runs')).toBeNull();
  });
});
