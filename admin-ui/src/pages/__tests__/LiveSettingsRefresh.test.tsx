import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Scoreboard from '../Scoreboard';
import KioskScoreboard from '../KioskScoreboard';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.116.0 (C1) — the kiosk-live loop.
 *
 * Both viewer surfaces fetched their scoreboard-config exactly ONCE, on mount:
 * their poll and their `leaderboard:updated` handler refresh scores, rankings
 * and the feed, never the look. So an admin saving the room's appearance from
 * a phone in the game room changed nothing on the TV until someone reloaded
 * the page. The settings POST now emits `settings:updated` (room-scoped, empty
 * payload) and both pages refetch the public config endpoint on it.
 *
 * These tests drive the socket handler directly and count config fetches — the
 * emit side is covered server-side in `settings-broadcast.test.ts`.
 */

const ROOM_ID = 'room-1';
const SLUG = 'test-room';

const socketHandlers: Record<string, ((data?: unknown) => void)[]> = {};
vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({
    emit: vi.fn(),
    on: (event: string, fn: (data?: unknown) => void) => { (socketHandlers[event] ||= []).push(fn); },
    off: (event: string, fn: (data?: unknown) => void) => {
      socketHandlers[event] = (socketHandlers[event] || []).filter(h => h !== fn);
    },
  }),
}));

vi.mock('../../lib/portal', () => ({
  getPortal: vi.fn().mockResolvedValue({
    roomId: 'room-1', slug: 'test-room', name: 'Test Room',
    public_theme: null, ui_theme: 'dark', join_policy: 'open', viewer_status: 'none',
  }),
}));

vi.mock('../../components/ThemeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ThemeProvider')>();
  return { ...actual, useTheme: () => ({ setPublicTheme: vi.fn() }) };
});

let configVersion = 0;

function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/scoreboard-config')) {
      configVersion += 1;
      return j({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_TITLE: `Title v${configVersion}` });
    }
    if (url.includes('/scoreboard-preferences')) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    if (url.includes('/portal')) return j({ roomId: ROOM_ID, slug: SLUG, name: 'Test Room', public_theme: null });
    if (url.includes('/rankings')) return j([]);
    if (url.includes('/lobby/feed')) return j([]);
    if (url.includes('/leaderboard')) return j([]);
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function configFetches(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(c => String(c[0]).includes('/scoreboard-config')).length;
}

describe('settings:updated live refresh', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    configVersion = 0;
    for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
  });

  it('the public Scoreboard refetches its config and re-renders the new title', async () => {
    const fetchMock = stubFetch();
    render(
      <MemoryRouter initialEntries={[`/${SLUG}`]}>
        <ToastProvider>
          <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: SLUG, roomName: 'Test Room' }}>
            <Routes>
              <Route path="/:slug" element={<Scoreboard />} />
            </Routes>
          </RoomContext.Provider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Title v1')).toBeInTheDocument());
    expect(socketHandlers['settings:updated']?.length).toBeGreaterThan(0);

    socketHandlers['settings:updated'].forEach(fn => fn());

    await waitFor(() => expect(screen.getByText('Title v2')).toBeInTheDocument());
    expect(configFetches(fetchMock)).toBe(2);
  });

  it('the kiosk refetches its config and re-renders the new title', async () => {
    const fetchMock = stubFetch();
    render(
      <MemoryRouter initialEntries={[`/${SLUG}/kiosk`]}>
        <Routes>
          <Route path="/:slug/kiosk" element={<KioskScoreboard />} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByText('Title v1')).toBeInTheDocument());
    expect(socketHandlers['settings:updated']?.length).toBeGreaterThan(0);

    socketHandlers['settings:updated'].forEach(fn => fn());

    await waitFor(() => expect(screen.getByText('Title v2')).toBeInTheDocument());
    expect(configFetches(fetchMock)).toBe(2);
  });

  it('both pages detach their handler on unmount (the socket is a shared singleton)', async () => {
    stubFetch();
    const view = render(
      <MemoryRouter initialEntries={[`/${SLUG}/kiosk`]}>
        <Routes>
          <Route path="/:slug/kiosk" element={<KioskScoreboard />} />
        </Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(socketHandlers['settings:updated']?.length).toBe(1));
    view.unmount();
    expect(socketHandlers['settings:updated']).toHaveLength(0);
  });
});
