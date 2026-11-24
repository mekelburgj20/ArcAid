import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';

/**
 * G32 - the game page's per-game stats read (feeds the Leaderboard tab and
 * the stat cards) was asked once; a 429 or a deploy 503 left them missing
 * until a reload. It must say so, ask again, and still treat a 404 as an answer.
 */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

const RANKINGS = [
  { rank: 1, discord_user_id: 'disc-ada', iscored_username: 'Ada', score: 4200, history_id: 11, source: 'tournament' },
  { rank: 2, discord_user_id: 'disc-bo', iscored_username: 'Bo', score: 3111, history_id: 12, source: 'tournament' },
];
const BOARD = {
  gameId: 'game-1', gameName: 'Game Of Dog', tournamentName: 'Daily Grind', tournamentId: 't-1',
  imageUrl: null, rankings: RANKINGS, gameStatus: 'ACTIVE', globalGameId: null,
};
const STATS = { gameName: 'Game Of Dog', timesPlayed: 7, avgScore: 4200, uniquePlayers: 3, allTimeHigh: 9999, allTimeHighPlayer: 'Ada', recentResults: [] };

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const answer = (status: number) => Promise.resolve({ ok: false, status, headers: { get: () => null }, json: () => Promise.resolve({}) });

/** What `stats/game` answers: a status code, or 200. */
let statsStatus = 200;
/** What the room's board list (`/leaderboard`) answers: a status code, or 200. */
let boardStatus = 200;
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (/\/stats\/game\/[^/]+$/.test(url)) return statsStatus === 200 ? ok(STATS) : answer(statsStatus);
    if (/\/leaderboard\/game-1(\?|$)/.test(url)) return ok({ rankings: RANKINGS, distinctEngines: [] });
    if (url.endsWith('/leaderboard')) return boardStatus === 200 ? ok([BOARD]) : answer(boardStatus);
    if (url.includes('/score-counts')) return ok({});
    return ok([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
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

const statsCalls = () => fetchMock.mock.calls.filter(([u]) => /\/stats\/game\/[^/]+$/.test(String(u))).length;
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('GameDetail when its stats read fails for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    fetchMock.mockReset();
    statsStatus = 200;
    boardStatus = 200;
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('says the leaderboard failed to load instead of showing no stat cards', async () => {
    statsStatus = 429;
    renderPage();
    await settle();
    expect(screen.getByTestId('game-load-failed')).toHaveTextContent("Couldn't load the leaderboard");
    expect(screen.queryByText('Times Featured')).not.toBeInTheDocument();
  });

  it('asks again by itself and shows the stat cards and the Leaderboard tab', async () => {
    statsStatus = 503;
    renderPage();
    await settle();
    expect(statsCalls()).toBe(1);
    await advance(1_000);
    expect(statsCalls()).toBe(2);
    expect(screen.getByTestId('game-load-failed')).toBeInTheDocument();

    statsStatus = 200;
    await advance(2_000);
    expect(screen.queryByTestId('game-load-failed')).not.toBeInTheDocument();
    expect(screen.getByText('Times Featured')).toBeInTheDocument();
    expect(screen.getByText('9,999')).toBeInTheDocument();
    expect(screen.getAllByText('4,200').length).toBeGreaterThan(0);
  });

  it('"Try now" asks at once', async () => {
    statsStatus = 429;
    renderPage();
    await settle();
    statsStatus = 200;
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await settle();
    expect(screen.queryByTestId('game-load-failed')).not.toBeInTheDocument();
    expect(screen.getByText('Times Featured')).toBeInTheDocument();
  });

  // The board rows come from the room's board list, a separate read: it used
  // to be asked once, so the rows stayed missing until the next live refresh.
  it('the board rows come back by themselves when the board list fails for now', async () => {
    boardStatus = 503;
    renderPage();
    await settle();
    const boardCalls = () => fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/leaderboard')).length;
    expect(boardCalls()).toBe(1);
    expect(screen.queryByText('3,111')).not.toBeInTheDocument();

    boardStatus = 200;
    await advance(1_000);
    expect(boardCalls()).toBe(2);
    expect(screen.getByText('3,111')).toBeInTheDocument();
  });

  it('a 404 is an answer: no notice, no retry', async () => {
    statsStatus = 404;
    renderPage();
    await settle();
    expect(screen.queryByTestId('game-load-failed')).not.toBeInTheDocument();
    await advance(45_000);
    expect(statsCalls()).toBe(1);
  });
});
