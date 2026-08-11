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

/** Field report fix (v2.9x.0) — signs in as a player whose token ALSO carries
 * an admin role claim, mirroring what a real room_admin/super_admin login
 * mints. Returns the token so callers can assert it (or its replacement)
 * ends up seeded into the admin slot. */
function signInAsAdmin(discordId: string, role: 'room_admin' | 'super_admin', gameRoomIds: string[], username = 'Admin') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = fakeJwt({ discordId, username, avatar: null, role, gameRoomIds, exp });
  localStorage.setItem('arcaid_player_token', token);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
  return token;
}

function expiredAdminSlotToken(): string {
  const exp = Math.floor(Date.now() / 1000) - 3600;
  return fakeJwt({ discordId: 'stale-admin', role: 'room_admin', gameRoomIds: [], exp });
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

    // v2.80.0 — AUTO_APPROVE_GUILD_MEMBERS can resolve a join-request straight
    // to 'member' instead of 'pending'. The portal's viewer_status is cached
    // per-slug (lib/portal.ts), so PublicLayout must invalidate + re-fetch it
    // after an auto-approve — otherwise the gate would stay up until reload.
    it('signed-in non-member, auto-approved: gate drops and room renders without a page reload', async () => {
      signInAs('user-4', 'Justin');
      let portalCalls = 0;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (url.startsWith('/api/portal')) {
          portalCalls += 1;
          const viewer_status = portalCalls === 1 ? 'none' : 'member';
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              id: 'room-4', roomId: 'room-4', slug: 'approval_room_auto', name: 'Approval Room',
              pick_award_enabled: false, join_policy: 'approval', viewer_status,
            }),
          });
        }
        if (init?.method === 'POST' && url.includes('join-request')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'member' }) });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      renderAt('/approval_room_auto/child');
      const btn = await screen.findByText('Request to join');
      fireEvent.click(btn);

      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
        '/api/me/rooms/room-4/join-request',
        expect.objectContaining({ method: 'POST' }),
      ));
      // Gate drops and the child route mounts — no manual reload needed.
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-4'));
      expect(screen.queryByText('This room requires approval to join')).toBeNull();
      expect(portalCalls).toBeGreaterThanOrEqual(2);
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

  // Field report: the Stats icon went dark on Stats → History. The unit-level
  // truth table lives in navSectionForPath.test.tsx; this is the wiring check
  // that the render site actually consults the predicate.
  describe('nav active state on sibling sub-pages', () => {
    function renderNavAt(path: string) {
      const fetchMock = vi.fn((url: string) => {
        if (url.startsWith('/api/portal')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: 'room-1', roomId: 'room-1', slug: 'rtx_pinball', name: 'RTX Pinball', pick_award_enabled: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

      return render(
        <MemoryRouter initialEntries={[path]}>
          <ViewerAuthProvider>
            <Routes>
              <Route path="/:slug" element={<PublicLayout />}>
                <Route index element={<div />} />
                <Route path="history" element={<div />} />
                <Route path="players/:name" element={<div />} />
              </Route>
            </Routes>
          </ViewerAuthProvider>
        </MemoryRouter>,
      );
    }

    /** The lit nav item is the one carrying aria-current="page". */
    async function activeNavLabel(): Promise<string | null> {
      const nav = await screen.findByLabelText('Room navigation');
      const current = nav.querySelector('[aria-current="page"]');
      return current?.getAttribute('aria-label') ?? null;
    }

    it('keeps Stats lit on /:slug/history (the reported bug)', async () => {
      renderNavAt('/rtx_pinball/history');
      await waitFor(async () => expect(await activeNavLabel()).toBe('Stats'));
    });

    it('lights Players on /:slug/players/:name', async () => {
      renderNavAt('/rtx_pinball/players/Krobs');
      await waitFor(async () => expect(await activeNavLabel()).toBe('Players'));
    });

    it('lights Scores on the room root', async () => {
      renderNavAt('/rtx_pinball');
      await waitFor(async () => expect(await activeNavLabel()).toBe('Scores'));
    });
  });

  // Field report fix (v2.9x.0) — the "Room admin" UserMenu item must derive
  // from the CURRENT login (admin slot OR an admin-y player token for THIS
  // room), not just presence of whatever token happens to sit in the admin
  // slot. See PublicLayout.tsx's `hasAdminToken` computation.
  describe('admin affordance derives from the current login', () => {
    function fetchPortal(roomId: string, slug: string) {
      return vi.fn((url: string) => {
        if (url.startsWith('/api/portal')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ id: roomId, roomId, slug, name: 'RTX Pinball', pick_award_enabled: false }),
          });
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
    }

    it('guest: no "Room admin" item (LoginButtons render instead of UserMenu)', async () => {
      vi.stubGlobal('fetch', fetchPortal('room-1', 'rtx_pinball'));
      renderAt('/rtx_pinball/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));
      expect(screen.queryByLabelText('User menu')).toBeNull();
      expect(screen.queryByText('Room admin')).toBeNull();
    });

    it('plain player (non-admin role): signed in, but no "Room admin" item', async () => {
      signInAs('user-1', 'Justin');
      vi.stubGlobal('fetch', fetchPortal('room-1', 'rtx_pinball'));
      renderAt('/rtx_pinball/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

      fireEvent.click(screen.getByLabelText('User menu'));
      expect(screen.queryByText('Room admin')).toBeNull();
      // Nothing was seeded into the admin slot for a non-admin role.
      expect(localStorage.getItem('arcaid_token')).toBeNull();
    });

    it('admin-y player token, empty admin slot: "Room admin" shows and the slot is seeded', async () => {
      const token = signInAsAdmin('admin-1', 'room_admin', ['room-1']);
      vi.stubGlobal('fetch', fetchPortal('room-1', 'rtx_pinball'));
      renderAt('/rtx_pinball/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

      fireEvent.click(screen.getByLabelText('User menu'));
      await screen.findByText('Room admin');
      await waitFor(() => expect(localStorage.getItem('arcaid_token')).toBe(token));
    });

    it('admin-y player token, EXPIRED admin slot: "Room admin" shows and the stale slot is reseeded', async () => {
      localStorage.setItem('arcaid_token', expiredAdminSlotToken());
      const token = signInAsAdmin('admin-2', 'room_admin', ['room-1']);
      vi.stubGlobal('fetch', fetchPortal('room-1', 'rtx_pinball'));
      renderAt('/rtx_pinball/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

      fireEvent.click(screen.getByLabelText('User menu'));
      await screen.findByText('Room admin');
      await waitFor(() => expect(localStorage.getItem('arcaid_token')).toBe(token));
    });

    it('room_admin token for a DIFFERENT room: no affordance here, nothing seeded', async () => {
      signInAsAdmin('admin-3', 'room_admin', ['some-other-room']);
      vi.stubGlobal('fetch', fetchPortal('room-1', 'rtx_pinball'));
      renderAt('/rtx_pinball/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

      fireEvent.click(screen.getByLabelText('User menu'));
      expect(screen.queryByText('Room admin')).toBeNull();
      expect(localStorage.getItem('arcaid_token')).toBeNull();
    });

    it('super_admin player token qualifies regardless of gameRoomIds', async () => {
      const token = signInAsAdmin('admin-4', 'super_admin', []);
      vi.stubGlobal('fetch', fetchPortal('room-1', 'rtx_pinball'));
      renderAt('/rtx_pinball/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

      fireEvent.click(screen.getByLabelText('User menu'));
      await screen.findByText('Room admin');
      await waitFor(() => expect(localStorage.getItem('arcaid_token')).toBe(token));
    });

    it('a live, unexpired admin slot for an UNRELATED admin is never overwritten by a non-admin player token', async () => {
      const existingAdminToken = fakeJwt({ discordId: 'other-admin', role: 'room_admin', gameRoomIds: ['room-1'], exp: Math.floor(Date.now() / 1000) + 3600 });
      localStorage.setItem('arcaid_token', existingAdminToken);
      signInAs('user-5', 'Justin'); // plain player, not admin-y
      vi.stubGlobal('fetch', fetchPortal('room-1', 'rtx_pinball'));
      renderAt('/rtx_pinball/child');
      await waitFor(() => expect(screen.getByTestId('roomId')).toHaveTextContent('room-1'));

      // The admin slot itself is live, so the affordance still shows...
      fireEvent.click(screen.getByLabelText('User menu'));
      await screen.findByText('Room admin');
      // ...and the untouched existing admin token is still the one seated.
      expect(localStorage.getItem('arcaid_token')).toBe(existingAdminToken);
    });
  });
});
