import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';

/**
 * v2.241.1 (D19) — the game page in an `approval` room (owner 2026-11-10:
 * "Full Leaderboard" on Game Of Dog in Mox's Game Room opened a page with
 * only "No community scores yet"). The server refuses a room read that
 * carries no login there, so the stub below does the same: a member's page
 * must send the token on its reads and get its board and Leaderboard tab.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signInAs(discordId: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64url({ alg: 'none' })}.${b64url({ discordId, username: 'Member', avatar: null, exp, role: 'player', gameRoomIds: [] })}.sig`;
  localStorage.setItem('arcaid_player_token', token);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Member', avatar: null }));
}

const RANKINGS = [
  { rank: 1, discord_user_id: 'disc-ada', iscored_username: 'Ada', score: 4200, history_id: 11, source: 'tournament' },
];
const BOARD = {
  gameId: 'game-1', gameName: 'Game Of Dog', tournamentName: 'Daily Grind', tournamentId: 't-1',
  imageUrl: null, rankings: RANKINGS, gameStatus: 'ACTIVE', globalGameId: null,
};

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
let refused: string[];

/** The server in an approval room: room reads need a Bearer token. */
function stubApprovalRoom() {
  refused = [];
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
    const gated = url.startsWith('/api/rooms/room-1/') && !/\/(scoreboard-config|portal)$/.test(url);
    if (gated && !new Headers(init?.headers).get('Authorization')) {
      refused.push(url);
      return Promise.resolve({ ok: false, status: 403, json: () => Promise.resolve({ code: 'APPROVAL_REQUIRED' }) });
    }
    if (/\/leaderboard\/game-1(\?|$)/.test(url)) return ok({ rankings: RANKINGS, distinctEngines: [] });
    if (url.endsWith('/leaderboard')) return ok([BOARD]);
    if (url.includes('/score-counts')) return ok({});
    if (/\/stats\/game\/[^/]+$/.test(url)) {
      return ok({ gameName: 'Game Of Dog', timesPlayed: 1, avgScore: 4200, uniquePlayers: 1, allTimeHigh: 4200, allTimeHighPlayer: 'Ada', recentResults: [] });
    }
    return ok([]);
  }) as unknown as typeof fetch);
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/mox_s_game_room/games/Game%20Of%20Dog']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'mox_s_game_room', roomName: "Mox's Game Room" }}>
            <Routes>
              <Route path="/:slug/games/:name" element={<GameDetail />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('GameDetail in an approval room', () => {
  beforeEach(() => { localStorage.clear(); stubApprovalRoom(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('a member sees the board: every room read carries their login', async () => {
    signInAs('disc-member');
    renderPage();

    expect(await screen.findByRole('button', { name: 'Leaderboard' })).toBeInTheDocument();
    expect((await screen.findAllByText('4,200')).length).toBeGreaterThan(0);
    expect(refused).toEqual([]);
  });
});
