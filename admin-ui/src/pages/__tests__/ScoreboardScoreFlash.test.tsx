import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomContext } from '../../contexts/RoomContext';
import { ViewerAuthContext } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';
import Scoreboard from '../Scoreboard';
import { stubResizeObserver } from '../../test/stubResizeObserver';
import { dispatchDisplaySettingsLive } from '../../lib/displaySettingsLive';

stubResizeObserver();

/**
 * G34b - the full-screen new-score flash: it follows the viewer's
 * "Flash on new scores" switch (SCOREBOARD_SCORE_FLASH, unset = on), and it
 * never pulses for a viewer whose device asks for reduced motion.
 */

const handlers = vi.hoisted(() => ({ map: {} as Record<string, (data?: unknown) => void> }));

vi.mock('../../components/scoreboard/CardRouter', () => ({
  default: (props: { lb: { gameName: string } }) => <div data-testid="card">{props.lb.gameName}</div>,
}));

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({
    emit: vi.fn(),
    on: (event: string, fn: (data?: unknown) => void) => { handlers.map[event] = fn; },
    off: vi.fn(),
  }),
}));

vi.mock('../../components/ThemeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ThemeProvider')>();
  return { ...actual, useTheme: () => ({ setPublicTheme: vi.fn() }) };
});

const BOARD = [{
  gameId: 'g-monster', gameName: 'Monster Bash', displayName: null, tournamentName: 'Daily Grind',
  tournamentType: 'DG', tournamentId: 't-dg', endedAt: null, imageUrl: null, gameStatus: 'ACTIVE',
  catalogueStyleId: null, logoStyleId: null, bgStyleId: null, styleHeaderDisabled: false, notes: null,
  rankings: [],
}];

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
let stored: Record<string, string> = {};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/pinned-piles')) return ok({ pinnedPiles: [] });
    if (url.includes('/scoreboard-preferences')) return ok(stored);
    if (url.includes('/scoreboard-config')) return ok({ SCOREBOARD_STYLE: 'arcade' });
    if (url.includes('/rankings')) return ok([]);
    if (url.includes('/leaderboard')) return ok(BOARD);
    return ok([]);
  }) as unknown as typeof fetch);
}

const viewer = {
  token: null, discordUser: null, playerToken: 'player.jwt.token',
  loginWithDiscord: () => {}, loginWithGoogle: () => {}, logoutPlayer: () => {}, setViewerAvatar: () => {},
};

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/rtx']}>
      <ToastProvider>
        <ViewerAuthContext.Provider value={viewer}>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx', roomName: 'RTX Pinball' }}>
            <Routes>
              <Route path="/:slug" element={<Scoreboard />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const newScore = () => act(() => handlers.map['score:new']?.({ playerName: 'Ann', score: 10, gameName: 'Monster Bash' }));

describe('Scoreboard - the new-score flash', () => {
  beforeEach(() => {
    handlers.map = {};
    stored = {};
    stubFetch();
  });
  afterEach(() => vi.unstubAllGlobals());

  it('shows on a new score when the switch is unset, and respects reduced motion', async () => {
    renderPage();
    await waitFor(() => expect(screen.getByTestId('card')).toBeInTheDocument());
    await waitFor(() => expect(handlers.map['score:new']).toBeDefined());
    newScore();
    const flash = screen.getByTestId('score-flash');
    expect(flash.className).toContain('motion-safe:animate-pulse');
    expect(flash.className).toContain('motion-reduce:hidden');
    expect(flash.className).not.toMatch(/(^|\s)animate-pulse/);
    // The toast is unchanged.
    expect(screen.getByText('Ann')).toBeInTheDocument();
  });

  it('sets no flash when the viewer turned it off, and a live change applies at once', async () => {
    stored = { SCOREBOARD_SCORE_FLASH: 'false' };
    renderPage();
    await waitFor(() => expect(screen.getByTestId('card')).toBeInTheDocument());
    await waitFor(() => expect(handlers.map['score:new']).toBeDefined());
    // The stored preference arrives with the config load.
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledWith(expect.stringContaining('/scoreboard-preferences'), expect.anything()));
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });
    newScore();
    expect(screen.queryByTestId('score-flash')).toBeNull();
    expect(screen.getByText('Ann')).toBeInTheDocument();
    act(() => dispatchDisplaySettingsLive({ device: 'desktop', prefs: {} }));
    newScore();
    expect(screen.getByTestId('score-flash')).toBeInTheDocument();
  });
});
