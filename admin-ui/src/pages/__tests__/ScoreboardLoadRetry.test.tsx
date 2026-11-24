import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomContext } from '../../contexts/RoomContext';
import { ViewerAuthContext } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';
import Scoreboard from '../Scoreboard';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * G31 (v2.265.4) — owner 2026-11-23: going from the Global Scoreboard to a
 * room, the room came up with no logo, no title and "Waiting for active
 * games"; every request after the room lookup had been refused (429) and
 * nothing asked again until a manual refresh.
 *
 * The page must (1) say the load failed instead of showing the empty-room
 * text, (2) ask again by itself, and (3) keep "Waiting for active games" for a
 * room that really has none.
 */

vi.mock('../../components/scoreboard/CardRouter', () => ({
  default: (props: { lb: { gameName: string } }) => (
    <div data-testid="card" data-game={props.lb.gameName}>{props.lb.gameName}</div>
  ),
}));

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

vi.mock('../../components/ThemeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ThemeProvider')>();
  return { ...actual, useTheme: () => ({ setPublicTheme: vi.fn() }) };
});

const ROOM_ID = 'room-1';
const SLUG = 'rtx';

const BOARD = [{
  gameId: 'g-monster', gameName: 'Monster Bash', displayName: null, tournamentName: 'Daily Grind',
  tournamentType: 'DG', tournamentId: 't-dg', endedAt: null, imageUrl: null, gameStatus: 'ACTIVE',
  catalogueStyleId: null, logoStyleId: null, bgStyleId: null, styleHeaderDisabled: false, notes: null,
  rankings: [],
}];

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const refused = () => Promise.resolve({
  ok: false,
  status: 429,
  headers: { get: () => null },
  json: () => Promise.resolve({ error: 'Too many requests. Please try again later.' }),
});

/** `limited` true = every room request is refused, as in the owner's report. */
let limited = false;
let board: unknown[] = BOARD;
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/pinned-piles')) return ok({ pinnedPiles: [] });
    if (url.startsWith('/api/rooms/') && limited) return refused();
    if (url.includes('/scoreboard-config')) return ok({ SCOREBOARD_STYLE: 'showcase', SCOREBOARD_TITLE: 'RTX PINBALL' });
    if (url.includes('/rankings')) return ok([]);
    if (url.includes('/leaderboard')) return ok(board);
    return ok([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

const viewer = {
  token: null, discordUser: null, playerToken: null,
  loginWithDiscord: () => {}, loginWithGoogle: () => {}, logoutPlayer: () => {}, setViewerAvatar: () => {},
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/${SLUG}`]}>
      <ToastProvider>
        <ViewerAuthContext.Provider value={viewer}>
          <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: SLUG, roomName: 'rtx_pinball' }}>
            <Routes>
              <Route path="/:slug" element={<Scoreboard />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part)).length;
/** Let resolved fetches and their state updates land, without moving the clock. */
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('the room page when its loads fail for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    fetchMock.mockReset();
    limited = false;
    board = BOARD;
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says the load failed, not that the room is empty', async () => {
    limited = true;
    renderPage();
    await settle();

    expect(screen.getByTestId('board-load-failed')).toHaveTextContent("Couldn't load the scores");
    expect(screen.getByTestId('board-load-failed')).toHaveTextContent('Trying again automatically.');
    expect(screen.queryByText('Waiting for active games...')).not.toBeInTheDocument();
  });

  it('asks again by itself and draws the room when the requests are let through', async () => {
    limited = true;
    renderPage();
    await settle();
    expect(calls('/leaderboard')).toBe(1);
    expect(calls('/scoreboard-config')).toBe(1);

    // Still refused on the first retry (1 s): the message stays.
    await advance(1_000);
    expect(calls('/leaderboard')).toBe(2);
    expect(screen.getByTestId('board-load-failed')).toBeInTheDocument();

    // Let through before the second retry (2 s later).
    limited = false;
    await advance(2_000);
    expect(screen.queryByTestId('board-load-failed')).not.toBeInTheDocument();
    expect(screen.getByTestId('card')).toHaveTextContent('Monster Bash');
    // The room's look came back too (it was the missing logo and title).
    expect(calls('/scoreboard-config')).toBe(3);
    expect(screen.getByText('RTX PINBALL')).toBeInTheDocument();
    // The rankings rode along.
    expect(calls('/rankings')).toBe(3);
  });

  it('"Try now" asks at once, without waiting for the next try', async () => {
    limited = true;
    renderPage();
    await settle();
    limited = false;

    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await settle();
    expect(screen.getByTestId('card')).toHaveTextContent('Monster Bash');
    expect(calls('/leaderboard')).toBe(2);
  });

  it('a room that really has no games still reads "Waiting for active games..."', async () => {
    board = [];
    renderPage();
    await settle();
    expect(screen.getByText('Waiting for active games...')).toBeInTheDocument();
    expect(screen.queryByTestId('board-load-failed')).not.toBeInTheDocument();
    // An answered load schedules nothing.
    await advance(45_000);
    expect(calls('/leaderboard')).toBe(1);
  });

  it('before the first answer it reads "Loading games...", never the empty-room text', async () => {
    renderPage();
    expect(screen.getByText('Loading games...')).toBeInTheDocument();
    expect(screen.queryByText('Waiting for active games...')).not.toBeInTheDocument();
    await settle();
    expect(screen.queryByText('Loading games...')).not.toBeInTheDocument();
  });
});
