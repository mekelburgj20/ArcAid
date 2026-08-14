import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';

/**
 * v2.108.0 (F5) — own-row delete on the CURRENT LEADERBOARD table.
 *
 * The icon is ALWAYS visible (not hover-revealed): the owner ask is that
 * removing a score you just mis-entered takes no hunting. It acts on the row's
 * `history_id` (B3), so no history expand is needed first.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signInAs(discordId: string, claims: Record<string, unknown> = {}) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({
    discordId, username: 'Tester', avatar: null, exp, role: 'player', gameRoomIds: [], ...claims,
  }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

const RANKINGS = [
  {
    rank: 1, discord_user_id: 'disc-ada', iscored_username: 'Ada', score: 4200,
    history_id: 11, source: 'tournament', submitted_by_user_id: 'disc-ada',
  },
  {
    rank: 2, discord_user_id: 'disc-ben', iscored_username: 'Ben', score: 3100,
    history_id: 12, source: 'tournament', submitted_by_user_id: 'disc-ben',
  },
];

const BOARD = {
  gameId: 'game-1', gameName: 'Whirlwind', tournamentName: 'Daily Grind',
  imageUrl: null, rankings: RANKINGS, gameStatus: 'ACTIVE', globalGameId: null,
};

function stubFetch() {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    }
    if (/\/leaderboard\/game-1(\?|$)/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ rankings: RANKINGS, distinctEngines: [] }) });
    }
    if (url.endsWith('/leaderboard')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([BOARD]) });
    }
    if (url.includes('/score-counts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (/\/stats\/game\/[^/]+$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        gameName: 'Whirlwind', timesPlayed: 1, avgScore: 4200, uniquePlayers: 2,
        allTimeHigh: 4200, allTimeHighPlayer: 'Ada', recentResults: [],
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/rtx_pinball/games/Whirlwind']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx_pinball', roomName: 'RTX Pinball' }}>
            <Routes>
              <Route path="/:slug/games/:name" element={<GameDetail />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('GameDetail — leaderboard-row delete', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows an always-visible delete icon on the viewer\'s own row only', async () => {
    signInAs('disc-ada');
    renderPage();

    const btn = await screen.findByLabelText('Delete this score (4,200)');
    // Always visible — no hover-reveal opacity class on this control.
    expect(btn.className).not.toMatch(/opacity-0/);
    expect(screen.queryByLabelText('Delete this score (3,100)')).not.toBeInTheDocument();
  });

  it('shows it on every row for an admin of this room', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    renderPage();

    expect(await screen.findByLabelText('Delete this score (4,200)')).toBeInTheDocument();
    expect(screen.getByLabelText('Delete this score (3,100)')).toBeInTheDocument();
  });

  it('shows nothing for a signed-out viewer', async () => {
    renderPage();
    await waitFor(() => expect(screen.getAllByText('4,200').length).toBeGreaterThan(0));
    expect(screen.queryByLabelText(/Delete this score/)).not.toBeInTheDocument();
  });

  it('confirms, then DELETEs the row\'s backing history_id', async () => {
    signInAs('disc-ada');
    const fetchMock = stubFetch();
    renderPage();

    fireEvent.click(await screen.findByLabelText('Delete this score (4,200)'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/rooms/room-1/score-history/11',
      expect.objectContaining({ method: 'DELETE' }),
    ));
  });
});
