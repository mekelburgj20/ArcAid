import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';

/**
 * W81 (v2.208.0) — attempts LEFT on the public game page of a Limited-attempts
 * tournament: each board row reads "N of M attempts · L left", and a strip
 * under the banner names the players who used attempts but have no row on
 * the board (power-off, zero-point restart, over the limit). A player the
 * server could not name is left out, never shown as a raw id.
 */

const BOARD = {
  gameId: 'g-mb', gameName: 'Monster Bash', tournamentName: 'Five Shots', tournamentId: 't-1',
  imageUrl: null, gameStatus: 'ACTIVE', globalGameId: null,
  rankings: [
    { rank: 1, discord_user_id: 'disc-bee', iscored_username: 'Bee', score: 700, history_id: 103, source: 'vpx', submitted_by_user_id: 'disc-bee' },
    { rank: 2, discord_user_id: 'disc-tom', iscored_username: 'TomatoGrass', score: 500, history_id: 102, source: 'vpx', submitted_by_user_id: 'disc-tom' },
  ],
};

function stubFetch(integrity: Record<string, unknown>) {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/integrity')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(integrity) });
    }
    if (/\/leaderboard\/g-mb(\?|$)/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...BOARD, distinctEngines: [] }) });
    }
    if (url.endsWith('/leaderboard')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([BOARD]) });
    }
    if (url.includes('/score-counts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ bee: 1, tomatograss: 1 }) });
    }
    if (/\/stats\/game\/[^/]+$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        gameName: 'Monster Bash', timesPlayed: 1, avgScore: 600, uniquePlayers: 2,
        allTimeHigh: 700, allTimeHighPlayer: 'Bee', recentResults: [],
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/fff/games/Monster%20Bash']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'fff', roomName: 'FFF' }}>
            <Routes>
              <Route path="/:slug/games/:name" element={<GameDetail />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const INTEGRITY = {
  mode: 'open', verdicts: {}, quits: {}, signed: {},
  maxAttempts: 5,
  attempts: {
    'g-mb': {
      'disc-bee': 2,
      'disc-tom': 5,
      // No board row: one power-off, one over the limit, one the server cannot name.
      'disc-mox': 1,
      'disc-abe': 6,
      '987654321098765432': 3,
    },
  },
  attemptPlayers: { 'disc-bee': 'Bee', 'disc-tom': 'TomatoGrass', 'disc-mox': 'Mox', 'disc-abe': 'Abe' },
};

describe('GameDetail — attempts left (W81)', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('each board row reads used of max and how many are left', async () => {
    stubFetch(INTEGRITY);
    renderPage();
    await screen.findByTestId('attempts-banner');
    const used = await screen.findAllByTestId('attempts-used');
    expect(used.map(el => el.textContent)).toEqual([
      '2 of 5 attempts · 3 left',
      '5 of 5 attempts · 0 left',
    ]);
  });

  it('names the players with attempts but no board row, fewest left first, and never a raw id', async () => {
    stubFetch(INTEGRITY);
    renderPage();
    const strip = await screen.findByTestId('attempts-off-board');
    const players = within(strip).getAllByTestId('attempts-off-board-player').map(el => el.textContent);
    expect(players).toEqual(['Abe 0 left', 'Mox 4 left']);
    expect(strip.textContent).not.toMatch(/\d{17,}/);
    expect(strip.textContent).not.toMatch(/Bee|TomatoGrass/);
  });

  it('hides the strip when every player with attempts is on the board', async () => {
    stubFetch({ ...INTEGRITY, attempts: { 'g-mb': { 'disc-bee': 2, 'disc-tom': 5 } } });
    renderPage();
    await screen.findAllByTestId('attempts-used');
    expect(screen.queryByTestId('attempts-off-board')).not.toBeInTheDocument();
  });

  it('an older server with no attemptPlayers shows no strip (no ids printed)', async () => {
    const { attemptPlayers: _omit, ...older } = INTEGRITY;
    void _omit;
    stubFetch(older);
    renderPage();
    await screen.findAllByTestId('attempts-used');
    expect(screen.queryByTestId('attempts-off-board')).not.toBeInTheDocument();
  });
});
