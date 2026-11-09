import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomContext } from '../../contexts/RoomContext';
import { ViewerAuthContext } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';
import Scoreboard from '../Scoreboard';
import Leaderboard from '../Leaderboard';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.236.0 (B23) — the public board folds a tournament's retained finished
 * cards into one pile behind its live card (owner, 2026-11-09: the RTX Daily
 * Grind board was one live card and four locked ones).
 *
 * Cards are mocked to markers carrying the game name (same approach as
 * ScoreboardWysiwygParity): this tests which cards the board lays out, folded
 * or open, and what the pile remembers — not any card's internals.
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
const DG = 'tournament-dg';

function card(gameId: string, gameName: string, status: 'ACTIVE' | 'COMPLETED', tournamentId: string, endedAt: string | null = null) {
  return {
    gameId, gameName, displayName: null, tournamentName: tournamentId === DG ? 'Daily Grind' : 'DG-VPX',
    tournamentType: 'DG', tournamentId, endedAt, imageUrl: null, gameStatus: status,
    catalogueStyleId: null, logoStyleId: null, bgStyleId: null, styleHeaderDisabled: false, notes: null,
    rankings: [],
  };
}

const BOARD = [
  card('g-monster', 'Monster Bash', 'ACTIVE', DG),
  card('g-godzilla', 'Godzilla', 'COMPLETED', DG, '2026-11-08T03:00:00.000Z'),
  card('g-darius', 'Darius', 'COMPLETED', DG, '2026-11-07T03:00:00.000Z'),
  card('g-afm', 'Attack from Mars', 'COMPLETED', DG, '2026-11-06T03:00:00.000Z'),
  card('g-elevator', 'Elevator Action', 'COMPLETED', DG, '2026-11-05T03:00:00.000Z'),
  card('g-bk', 'Black Knight 2000', 'ACTIVE', 'tournament-vpx'),
];

let serverPins: string[] = [];
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/pinned-piles')) {
      if (init?.method === 'PUT') {
        const tid = decodeURIComponent(url.split('/pinned-piles/')[1]!);
        const { pinned } = JSON.parse(String(init.body)) as { pinned: boolean };
        serverPins = serverPins.filter(id => id !== tid);
        if (pinned) serverPins.push(tid);
      }
      return j({ pinnedPiles: serverPins });
    }
    if (url.includes('/card-order')) return j({ active: false, savedAt: null });
    if (url.includes('/scoreboard-config')) return j({ SCOREBOARD_STYLE: 'showcase' });
    if (url.includes('/scoreboard-preferences')) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    if (url.includes('/rankings')) return j([]);
    if (url.includes('/leaderboard')) return j(BOARD);
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

const viewer = (playerToken: string | null) => ({
  token: null, discordUser: null, playerToken,
  loginWithDiscord: () => {}, loginWithGoogle: () => {}, logoutPlayer: () => {}, setViewerAvatar: () => {},
});

function renderPage(page: 'public' | 'admin', playerToken: string | null = null) {
  const path = page === 'public' ? `/${SLUG}` : `/${SLUG}/admin/leaderboard`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <ViewerAuthContext.Provider value={viewer(playerToken)}>
          <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: SLUG, roomName: 'RTX' }}>
            <Routes>
              <Route path="/:slug" element={<Scoreboard />} />
              <Route path="/:slug/admin/leaderboard" element={<Leaderboard />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Game names of the cards a player can reach (outside the inert stack). */
function reachableCards(): string[] {
  return screen.queryAllByTestId('card')
    .filter(el => !el.closest('[inert]'))
    .map(el => el.getAttribute('data-game')!);
}

describe('past-games pile on the public board', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    serverPins = [];
    fetchMock.mockReset();
    stubFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('folds the four finished Daily Grind cards behind the live one', async () => {
    renderPage('public');
    const toggle = await screen.findByRole('button', { name: 'Show 4 past Daily Grind games' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(reachableCards()).toEqual(['Monster Bash', 'Black Knight 2000']);

    // The stack draws the newest finished cards, inert and hidden from AT.
    const stack = screen.getByTestId('pile-stack');
    expect(stack).toHaveAttribute('aria-hidden', 'true');
    expect(stack.hasAttribute('inert')).toBe(true);
    expect(within(stack).getAllByTestId('card').map(el => el.getAttribute('data-game')))
      .toEqual(['Godzilla', 'Darius', 'Attack from Mars', 'Elevator Action']);
  });

  it('opens newest first right after the live card, and folds back', async () => {
    renderPage('public');
    fireEvent.click(await screen.findByRole('button', { name: 'Show 4 past Daily Grind games' }));

    expect(reachableCards()).toEqual(['Monster Bash', 'Godzilla', 'Darius', 'Attack from Mars', 'Elevator Action', 'Black Knight 2000']);
    expect(screen.queryByTestId('pile-stack')).toBeNull();
    expect(screen.getByRole('link', { name: 'All Daily Grind results' })).toHaveAttribute('href', `/${SLUG}/tournaments/${DG}`);

    fireEvent.click(screen.getByRole('button', { name: 'Fold past Daily Grind games' }));
    expect(reachableCards()).toEqual(['Monster Bash', 'Black Knight 2000']);
  });

  it('a pinned pile is remembered for a signed-in player and opens on the next visit', async () => {
    const first = renderPage('public', 'player-tok');
    fireEvent.click(await screen.findByRole('button', { name: 'Show 4 past Daily Grind games' }));
    const pin = screen.getByRole('button', { name: 'Keep past Daily Grind games open' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(pin);

    await waitFor(() => expect(serverPins).toEqual([DG]));
    const put = fetchMock.mock.calls.find(([u, i]) => String(u).includes('/pinned-piles/') && (i as RequestInit)?.method === 'PUT')!;
    expect((put[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer player-tok' });
    expect(screen.getByRole('button', { name: 'Unpin and fold past Daily Grind games' })).toHaveAttribute('aria-pressed', 'true');
    first.unmount();

    // A new device: nothing local, the server's list opens it.
    localStorage.clear();
    renderPage('public', 'player-tok');
    await screen.findByRole('button', { name: 'Unpin and fold past Daily Grind games' });
    expect(reachableCards()).toContain('Elevator Action');
  });

  it('clicking the pin again unpins and folds everything back', async () => {
    serverPins = [DG];
    renderPage('public', 'player-tok');
    fireEvent.click(await screen.findByRole('button', { name: 'Unpin and fold past Daily Grind games' }));

    expect(reachableCards()).toEqual(['Monster Bash', 'Black Knight 2000']);
    await waitFor(() => expect(serverPins).toEqual([]));
  });

  it('a guest\'s pin lives in localStorage', async () => {
    const first = renderPage('public');
    fireEvent.click(await screen.findByRole('button', { name: 'Show 4 past Daily Grind games' }));
    fireEvent.click(screen.getByRole('button', { name: 'Keep past Daily Grind games open' }));
    expect(JSON.parse(localStorage.getItem('arcaid-pinned-piles') || '[]')).toEqual([DG]);
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes('/pinned-piles'))).toBe(false);
    first.unmount();

    renderPage('public');
    await screen.findByRole('button', { name: 'Unpin and fold past Daily Grind games' });
  });

  it('a search lays the board flat so a match is never hidden in a pile', async () => {
    renderPage('public');
    await screen.findByRole('button', { name: 'Show 4 past Daily Grind games' });
    fireEvent.change(screen.getByLabelText('Search active games'), { target: { value: 'darius' } });

    expect(reachableCards()).toEqual(['Darius']);
    expect(screen.queryByRole('button', { name: /past Daily Grind games/ })).toBeNull();
  });

  it('the admin Leaderboard stays flat (every card keeps its controls strip)', async () => {
    renderPage('admin');
    await waitFor(() => expect(screen.getAllByTestId('card')).toHaveLength(6));
    expect(screen.queryByRole('button', { name: /past Daily Grind games/ })).toBeNull();
  });
});
