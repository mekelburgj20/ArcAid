import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Lobby from '../Lobby';
import { RoomContext } from '../../contexts/RoomContext';
import { ViewerAuthContext } from '../../contexts/ViewerAuthContext';

/**
 * G32 — the Lobby's activity feed used to draw a failed load (429, a deploy
 * restart) as "No activity yet" and never asked again. It must say the load
 * failed, try again by itself, keep "No activity yet" for a room that answered
 * with nothing, merge a quiet reload without dropping what is shown, and keep
 * "Load more" when a page fails.
 */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

vi.mock('../../components/SeasonPollCard', () => ({ default: () => null }));

const ev = (id: number, title = `Event ${id}`) => ({
  id, type: 'admin_message', source: 'admin', icon: null, title, subtitle: null, player_id: null,
  game_name: null, tournament_id: null, metadata: {}, created_at: `2026-11-24T10:${String(59 - (id % 60)).padStart(2, '0')}:00.000Z`,
});

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const refused = () => Promise.resolve({
  ok: false, status: 429, headers: { get: () => null }, json: () => Promise.resolve({}),
});

let limited = false;
let feedPage: unknown[] = [];
let olderPage: () => Promise<unknown> = () => ok([]);
const fetchMock = vi.fn();

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    if (url.includes('/lobby/config')) return ok({ socialLinks: [], pinnedMessage: null });
    if (url.includes('/lobby/feed')) {
      if (url.includes('before=')) return olderPage();
      return limited ? refused() : ok(feedPage);
    }
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
    <MemoryRouter initialEntries={['/mox/lobby']}>
      <ViewerAuthContext.Provider value={viewer}>
        <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'mox', roomName: 'Mox' }}>
          <Routes>
            <Route path="/:slug/lobby" element={<Lobby />} />
          </Routes>
        </RoomContext.Provider>
      </ViewerAuthContext.Provider>
    </MemoryRouter>,
  );
}

const feedCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/lobby/feed')).length;
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('the Lobby when its feed fails for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    fetchMock.mockReset();
    limited = false;
    feedPage = [];
    olderPage = () => ok([]);
    stubFetch();
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('says the load failed, not "No activity yet"', async () => {
    limited = true;
    renderPage();
    await settle();

    expect(screen.getByTestId('lobby-load-failed')).toHaveTextContent("Couldn't load the activity");
    expect(screen.queryByText('No activity yet')).not.toBeInTheDocument();
  });

  it('asks again by itself and draws the events when requests get through', async () => {
    limited = true;
    feedPage = [ev(1, 'Wyo posted a score')];
    renderPage();
    await settle();
    expect(feedCalls()).toBe(1);

    limited = false;
    await advance(1_000);
    expect(screen.queryByTestId('lobby-load-failed')).not.toBeInTheDocument();
    expect(screen.getByText('Wyo posted a score')).toBeInTheDocument();
  });

  it('"Try now" asks at once', async () => {
    limited = true;
    feedPage = [ev(1, 'Wyo posted a score')];
    renderPage();
    await settle();
    limited = false;

    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await settle();
    expect(screen.getByText('Wyo posted a score')).toBeInTheDocument();
    expect(feedCalls()).toBe(2);
  });

  it('a room that answered with no events says so and schedules nothing', async () => {
    renderPage();
    await settle();
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
    expect(screen.queryByTestId('lobby-load-failed')).not.toBeInTheDocument();

    await advance(30_000);
    expect(feedCalls()).toBe(1);
  });

  it('a quiet reload merges new events and keeps the ones already shown', async () => {
    feedPage = [ev(2, 'Second'), ev(1, 'First')];
    renderPage();
    await settle();
    expect(screen.getByText('First')).toBeInTheDocument();

    feedPage = [ev(3, 'Third'), ev(2, 'Second')];
    await advance(6_000);
    act(() => { window.dispatchEvent(new Event('focus')); });
    await settle();

    expect(screen.getByText('Third')).toBeInTheDocument();
    expect(screen.getByText('Second')).toBeInTheDocument();
    expect(screen.getByText('First')).toBeInTheDocument();
  });

  it('a failed "Load more" keeps the button', async () => {
    feedPage = Array.from({ length: 20 }, (_, i) => ev(100 - i));
    olderPage = () => refused();
    renderPage();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: /Load more/ }));
    await settle();
    expect(screen.getByRole('button', { name: /Load more/ })).toBeEnabled();
    expect(screen.getByText('Event 100')).toBeInTheDocument();
  });

  // The page stays mounted when the visitor switches rooms. A room that
  // refuses the feed outright (a definite answer) must not keep showing the
  // last room's activity.
  it('a move to a room that refuses the feed does not keep the last room\'s events', async () => {
    feedPage = [ev(1, 'Wyo posted a score')];
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/lobby/feed')) {
        return url.includes('/room-2/')
          ? Promise.resolve({ ok: false, status: 403, headers: { get: () => null }, json: () => Promise.resolve({}) })
          : ok(feedPage);
      }
      return ok([]);
    });
    const page = (roomId: string) => (
      <MemoryRouter initialEntries={['/mox/lobby']}>
        <ViewerAuthContext.Provider value={viewer}>
          <RoomContext.Provider value={{ roomId, roomSlug: 'mox', roomName: 'Mox' }}>
            <Routes>
              <Route path="/:slug/lobby" element={<Lobby />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthContext.Provider>
      </MemoryRouter>
    );
    const view = render(page('room-1'));
    await settle();
    expect(screen.getByText('Wyo posted a score')).toBeInTheDocument();

    view.rerender(page('room-2'));
    await settle();
    expect(screen.queryByText('Wyo posted a score')).not.toBeInTheDocument();
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
    expect(screen.queryByTestId('lobby-load-failed')).not.toBeInTheDocument();
  });
});
