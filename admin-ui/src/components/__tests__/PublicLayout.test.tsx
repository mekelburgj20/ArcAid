import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PublicLayout from '../PublicLayout';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { useRoom } from '../../contexts/RoomContext';

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signInAs(discordId: string, username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

// s21 — the ticker (mounted by PublicLayout on the scoreboard route) joins a
// lobby socket channel; keep that inert under jsdom.
vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

// S18 — PublicLayout owns the single portal fetch for its whole subtree and
// provides RoomContext to every child route. This is the regression test for
// both halves of that contract: exactly one /api/portal request no matter how
// many consumers (nav's usePickAwardEnabled + the layout itself) need it, and
// the child route sees the resolved room via useRoom() with no fetch of its own.
function ChildProbe() {
  const { roomId, roomSlug, roomName } = useRoom();
  return (
    <div>
      <span data-testid="roomId">{roomId}</span>
      <span data-testid="roomSlug">{roomSlug}</span>
      <span data-testid="roomName">{roomName}</span>
    </div>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ViewerAuthProvider>
        <Routes>
          <Route path="/:slug" element={<PublicLayout />}>
            <Route path="child" element={<ChildProbe />} />
          </Route>
        </Routes>
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('PublicLayout', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('makes exactly one /api/portal request and provides the resolved room to children', async () => {
    const portalCalls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/portal')) {
        portalCalls.push(url);
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'room-1', roomId: 'room-1', slug: 'rtx_pinball', name: 'RTX Pinball', pick_award_enabled: false }),
        });
      }
      // lobby-feed activity-dot poll — respond with an empty feed.
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball/child');

    await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));
    expect(screen.getByTestId('roomSlug')).toHaveTextContent('rtx_pinball');
    expect(screen.getByTestId('roomName')).toHaveTextContent('RTX Pinball');

    expect(portalCalls).toHaveLength(1);
  });

  // s21 — the activity ticker used to be a fixed-bottom overlay inside
  // Scoreboard.tsx that painted over the Privacy/Terms footer. It now mounts
  // in-flow in PublicLayout (scoreboard route only), above the footer.
  it('mounts the activity ticker in-flow on the scoreboard route, not as a fixed overlay', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/portal')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'room-1', roomId: 'room-1', slug: 'rtx_pinball', name: 'RTX Pinball', pick_award_enabled: false }),
        });
      }
      if (url.includes('/lobby/feed')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { id: 1, type: 'new_high_score', title: 'Justin hit 1M on Fire Mountain', created_at: new Date().toISOString() },
          ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball');

    const item = await screen.findAllByText(/Fire Mountain/);
    expect(item.length).toBeGreaterThan(0);
    // In-flow: no `fixed`-positioned ancestor (the old overlay regression).
    expect(item[0].closest('div.fixed')).toBeNull();
    // Footer links remain in the layout below it.
    expect(screen.getByText('Privacy')).toBeInTheDocument();
    expect(screen.getByText('Terms')).toBeInTheDocument();
  });

  it('renders a friendly not-found state when the portal 404s', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/portal')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/no-such-room/child');

    await waitFor(() => expect(screen.getByText('Room not found')).toBeInTheDocument());
  });

  // D2.2 (v2.38.0) — room-page join/leave affordance placed as a UserMenu
  // contextual item (over a header button — mobile header space is already
  // tight per s20/s21; see PublicLayout.tsx comment at the hook call site).
  it('signed-in, non-member: UserMenu shows "Add <room> to My Rooms" and POSTs on click', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/portal')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'room-1', roomId: 'room-1', slug: 'rtx_pinball', name: 'RTX Pinball', pick_award_enabled: false }),
        });
      }
      if (init?.method === 'POST' && url.startsWith('/api/me/rooms/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      if (url.startsWith('/api/me/rooms')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball/child');
    await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

    fireEvent.click(screen.getByLabelText('User menu'));
    const joinItem = await screen.findByText('Add RTX Pinball to My Rooms');

    fireEvent.click(joinItem);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/rooms/room-1',
      expect.objectContaining({ method: 'POST' }),
    ));
  });

  it('signed-in, member: UserMenu shows "Leave <room>" and DELETEs on click', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.startsWith('/api/portal')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ id: 'room-1', roomId: 'room-1', slug: 'rtx_pinball', name: 'RTX Pinball', pick_award_enabled: false }),
        });
      }
      if (init?.method === 'DELETE' && url.startsWith('/api/me/rooms/')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      if (url.startsWith('/api/me/rooms')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { roomId: 'room-1', name: 'RTX Pinball', slug: 'rtx_pinball', logoUrl: null, joinedAt: '2026-01-01', source: 'submission', lastActivityAt: null },
          ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderAt('/rtx_pinball/child');
    await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

    fireEvent.click(screen.getByLabelText('User menu'));
    const leaveItem = await screen.findByText('Leave RTX Pinball');

    fireEvent.click(leaveItem);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/rooms/room-1',
      expect.objectContaining({ method: 'DELETE' }),
    ));
  });
});
