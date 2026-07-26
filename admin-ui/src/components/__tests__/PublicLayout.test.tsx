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

  // v2.39.0 — approval rooms (tmp/approval-rooms-contract.md, D1/D4). The
  // portal's join_policy/viewer_status drive a hard content swap: the gate
  // screen renders instead of <Outlet/>, so ChildProbe never mounts.
  describe('approval-room view gate', () => {
    it('guest on an approval room: gate screen renders, no login/no request button posted', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/portal')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              id: 'room-2', roomId: 'room-2', slug: 'approval_room', name: 'Approval Room',
              pick_award_enabled: false, join_policy: 'approval', viewer_status: 'none',
            }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      renderAt('/approval_room/child');

      await waitFor(() => expect(screen.getByText('This room requires approval to join')).toBeInTheDocument());
      expect(screen.queryByTestId('roomId')).toBeNull();
      expect(screen.getByText('Sign in to request to join.')).toBeInTheDocument();
    });

    it('signed-in non-member: shows "Request to join" and posts to the join-request endpoint', async () => {
      signInAs('user-2', 'Justin');
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/portal')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              id: 'room-2', roomId: 'room-2', slug: 'approval_room', name: 'Approval Room',
              pick_award_enabled: false, join_policy: 'approval', viewer_status: 'none',
            }),
          });
        }
        if (init?.method === 'POST' && url.includes('join-request')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'pending' }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      renderAt('/approval_room/child');
      const btn = await screen.findByText('Request to join');
      fireEvent.click(btn);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        '/api/me/rooms/room-2/join-request',
        expect.objectContaining({ method: 'POST' }),
      ));
      await waitFor(() => expect(screen.getByText('Request pending')).toBeInTheDocument());
    });

    it('a member sees the room normally, not the gate', async () => {
      // Distinct slug from the other two tests in this block — lib/portal.ts
      // caches settled portal promises per-slug for the SPA session, so
      // reusing 'approval_room' here would silently replay an earlier test's
      // (different) viewer_status instead of hitting this test's fetch mock.
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/portal')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              id: 'room-3', roomId: 'room-3', slug: 'approval_room_member', name: 'Approval Room',
              pick_award_enabled: false, join_policy: 'approval', viewer_status: 'member',
            }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      renderAt('/approval_room_member/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-3'));
      expect(screen.queryByText('This room requires approval to join')).toBeNull();
    });
  });

  // S22 Phase 2 (v2.44.0) — suspended-room minimal portal shape renders a
  // centered "suspended" shell instead of the normal room content/gate, and
  // never mounts the child route (no roomId ships in the minimal response).
  describe('suspended-room shell', () => {
    it('renders the suspended message and never mounts the child route', async () => {
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/portal')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ suspended: true, name: 'Suspended Room', slug: 'suspended_room' }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      renderAt('/suspended_room/child');

      await waitFor(() => expect(screen.getByText('This room has been suspended')).toBeInTheDocument());
      // Room name renders both in the nav bar and the shell heading.
      expect(screen.getAllByText('Suspended Room').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByTestId('roomId')).toBeNull();
      // No approval-gate copy — suspension is a distinct message, not the join gate.
      expect(screen.queryByText('This room requires approval to join')).toBeNull();
    });
  });
});
