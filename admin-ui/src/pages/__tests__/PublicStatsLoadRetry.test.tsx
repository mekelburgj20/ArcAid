import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PublicStats from '../PublicStats';
import { RoomContext } from '../../contexts/RoomContext';

/** G32 - the Stats page drew "No players found." / "No game activity yet." for a read that failed for now. */

const PLAYERS = [
  { discord_user_id: '111111111111111111', iscored_username: 'PeteG', display_name: 'Pete', games_played: 4, wins: 2, avg_finish_position: 1.5, top5_rate: 1, champion_streak: 1, avatar_hash: null, avatar_url: null },
];
const GAMES = [
  { name: 'Godzilla', submissions: 9, players: 4, top_score: 1000, last_activity: null, image_url: null },
];

let limited = false;
let players: unknown[] = PLAYERS;
let games: unknown[] = GAMES;
const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const refused = () => Promise.resolve({ ok: false, status: 429, headers: { get: () => null }, json: () => Promise.resolve({}) });

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/stats/') && limited) return refused();
    if (url.includes('/stats/enhanced/players')) return ok(players);
    if (url.includes('/stats/games-activity')) return ok(games);
    if (url.includes('/stats/overview')) return ok(null);
    return ok([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

function renderStats(path = '/rtx/stats') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx', roomName: 'RTX' }}>
        <Routes>
          <Route path="/:slug/stats" element={<PublicStats />} />
        </Routes>
      </RoomContext.Provider>
    </MemoryRouter>,
  );
}

const calls = (part: string) => fetchMock.mock.calls.filter(([u]) => String(u).includes(part)).length;
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('PublicStats when its reads fail for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    fetchMock.mockReset();
    limited = false;
    players = PLAYERS;
    games = GAMES;
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('Players: says the load failed, not "No players found."', async () => {
    limited = true;
    renderStats();
    await settle();
    expect(screen.getByTestId('stats-players-load-failed')).toHaveTextContent("Couldn't load the players");
    expect(screen.queryByText('No players found.')).not.toBeInTheDocument();
  });

  it('Players: retries by itself and draws the players', async () => {
    limited = true;
    renderStats();
    await settle();
    expect(calls('/stats/enhanced/players')).toBe(1);
    limited = false;
    await advance(1_000);
    expect(screen.queryByTestId('stats-players-load-failed')).not.toBeInTheDocument();
    expect(screen.getByText('Pete')).toBeInTheDocument();
  });

  it('"Try now" asks for all three stats reads again at once', async () => {
    limited = true;
    renderStats();
    await settle();
    limited = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await settle();
    expect(screen.getByText('Pete')).toBeInTheDocument();
    expect(calls('/stats/games-activity')).toBe(2);
    expect(calls('/stats/overview')).toBe(2);
  });

  it('Players: a room with no players still reads "No players found." and schedules nothing', async () => {
    players = [];
    renderStats();
    await settle();
    expect(screen.getByText('No players found.')).toBeInTheDocument();
    expect(screen.queryByTestId('stats-players-load-failed')).not.toBeInTheDocument();
    await advance(45_000);
    expect(calls('/stats/enhanced/players')).toBe(1);
  });

  it('Games: failed read shows the notice, recovers by itself', async () => {
    limited = true;
    renderStats('/rtx/stats?view=games');
    await settle();
    expect(screen.getByTestId('stats-games-load-failed')).toHaveTextContent("Couldn't load the games");
    expect(screen.queryByText('No game activity yet.')).not.toBeInTheDocument();
    limited = false;
    await advance(1_000);
    expect(screen.getByText('Godzilla')).toBeInTheDocument();
  });

  it('Games: a room with no activity still reads "No game activity yet." and schedules nothing', async () => {
    games = [];
    renderStats('/rtx/stats?view=games');
    await settle();
    expect(screen.getByText('No game activity yet.')).toBeInTheDocument();
    await advance(45_000);
    expect(calls('/stats/games-activity')).toBe(1);
  });

  it('changing the filter after a failure asks with the new filter', async () => {
    limited = true;
    renderStats();
    await settle();
    limited = false;
    fireEvent.click(screen.getByRole('button', { name: 'Last week' }));
    await settle();
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).filter(u => u.includes('/stats/enhanced/players'));
    expect(urls[urls.length - 1]).toMatch(/\?.*from=/);
    expect(screen.getByText('Pete')).toBeInTheDocument();
  });
});
