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
 * G34a - the room scoreboard draws the viewer's Display settings as they
 * change in the open panel (`display-settings-live`): the room's own config
 * with the viewer's whole override map over it. A key the viewer cleared is
 * absent from the map, so the room's value shows again; a change for the
 * other device's set (the panel edits the device in hand) is ignored.
 */

vi.mock('../../components/scoreboard/CardRouter', () => ({
  default: (props: { lb: { gameName: string }; style: string; maxScores: number }) => (
    <div data-testid="card" data-style={props.style} data-max={props.maxScores}>{props.lb.gameName}</div>
  ),
}));

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
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

/** The viewer's stored card settings for this device. */
let stored: Record<string, string> = {};

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.includes('/pinned-piles')) return ok({ pinnedPiles: [] });
    if (url.includes('/scoreboard-preferences')) return ok(stored);
    if (url.includes('/scoreboard-config')) return ok({ SCOREBOARD_STYLE: 'arcade', SCOREBOARD_MAX_SCORES: '5' });
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

const card = () => screen.getByTestId('card');
const innerWidth = window.innerWidth;

describe('Scoreboard - a signed-out visitor\'s Display settings (G34c)', () => {
  const guestViewer = { ...viewer, playerToken: null };
  const renderGuest = () => render(
    <MemoryRouter initialEntries={['/rtx']}>
      <ToastProvider>
        <ViewerAuthContext.Provider value={guestViewer}>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx', roomName: 'RTX Pinball' }}>
            <Routes>
              <Route path="/:slug" element={<Scoreboard />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
  beforeEach(() => {
    localStorage.clear();
    stubFetch();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });

  it('merges the browser key over the room config, and asks the account for nothing', async () => {
    localStorage.setItem('arcaid-scoreboard-prefs-desktop', JSON.stringify({ SCOREBOARD_MAX_SCORES: '9' }));
    renderGuest();
    await waitFor(() => expect(card()).toHaveAttribute('data-max', '9'));
    expect(card()).toHaveAttribute('data-style', 'arcade');
    const asked = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));
    expect(asked.some(u => u.includes('/scoreboard-preferences'))).toBe(false);
  });

  it('a live event changes it, and a saved event re-reads the key (a cleared key falls back to the room)', async () => {
    localStorage.setItem('arcaid-scoreboard-prefs-desktop', JSON.stringify({ SCOREBOARD_MAX_SCORES: '9' }));
    renderGuest();
    await waitFor(() => expect(card()).toHaveAttribute('data-max', '9'));
    act(() => dispatchDisplaySettingsLive({ device: 'desktop', prefs: { SCOREBOARD_STYLE: 'banner' } }));
    expect(card()).toHaveAttribute('data-style', 'banner');
    expect(card()).toHaveAttribute('data-max', '5');
    localStorage.removeItem('arcaid-scoreboard-prefs-desktop');
    act(() => { window.dispatchEvent(new Event('display-settings-saved')); });
    await waitFor(() => expect(card()).toHaveAttribute('data-style', 'arcade'));
    expect(card()).toHaveAttribute('data-max', '5');
  });
});

describe('Scoreboard - the Display settings panel, live', () => {
  beforeEach(() => {
    stored = { SCOREBOARD_MAX_SCORES: '8' };
    stubFetch();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });

  it('draws the room config with the stored overrides over it', async () => {
    renderPage();
    await waitFor(() => expect(card()).toHaveAttribute('data-max', '8'));
    expect(card()).toHaveAttribute('data-style', 'arcade');
  });

  it('a live event changes the rendered config at once', async () => {
    renderPage();
    await waitFor(() => expect(card()).toHaveAttribute('data-max', '8'));
    act(() => dispatchDisplaySettingsLive({ device: 'desktop', prefs: { SCOREBOARD_MAX_SCORES: '8', SCOREBOARD_STYLE: 'banner' } }));
    expect(card()).toHaveAttribute('data-style', 'banner');
    expect(card()).toHaveAttribute('data-max', '8');
  });

  it('a key cleared in the panel falls back to the room\'s value', async () => {
    renderPage();
    await waitFor(() => expect(card()).toHaveAttribute('data-max', '8'));
    act(() => dispatchDisplaySettingsLive({ device: 'desktop', prefs: {} }));
    expect(card()).toHaveAttribute('data-max', '5');
    expect(card()).toHaveAttribute('data-style', 'arcade');
  });

  it('an event for the other device is ignored', async () => {
    renderPage();
    await waitFor(() => expect(card()).toHaveAttribute('data-max', '8'));
    act(() => dispatchDisplaySettingsLive({ device: 'mobile', prefs: { SCOREBOARD_STYLE: 'minimal' } }));
    expect(card()).toHaveAttribute('data-style', 'arcade');
    expect(card()).toHaveAttribute('data-max', '8');
  });

  it('on a phone-width window the mobile set is the one that applies', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderPage();
    await waitFor(() => expect(card()).toHaveAttribute('data-max', '8'));
    act(() => dispatchDisplaySettingsLive({ device: 'desktop', prefs: { SCOREBOARD_STYLE: 'minimal' } }));
    expect(card()).toHaveAttribute('data-style', 'arcade');
    act(() => dispatchDisplaySettingsLive({ device: 'mobile', prefs: { SCOREBOARD_STYLE: 'minimal' } }));
    expect(card()).toHaveAttribute('data-style', 'minimal');
  });
});
