import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { useMyRooms } from '../useMyRooms';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

// v2.38.0 — join-leave contract (tmp/join-leave-contract.md). Pure logic
// coverage for the hook shared between LandingPage's bookmark toggle and
// PublicLayout's room-page affordance: guest no-ops, load, optimistic
// join/leave with revert-on-failure.

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

function wrapper({ children }: { children: ReactNode }) {
  return createElement(ViewerAuthProvider, null, children);
}

describe('useMyRooms', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('guest: empty list, no fetch, join/leave are no-ops', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMyRooms(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.rooms).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();

    const joinOk = await act(() => result.current.join('room-1'));
    const leaveOk = await act(() => result.current.leave('room-1'));
    expect(joinOk).toBe(false);
    expect(leaveOk).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signed-in: loads /api/me/rooms with the auth header', async () => {
    signInAs('discord-1');
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([
        { roomId: 'room-1', name: 'Room 1', slug: 'room_1', logoUrl: null, joinedAt: '2026-01-01', source: 'submission', lastActivityAt: null },
      ]),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMyRooms(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.rooms).toHaveLength(1);
    expect(result.current.isMember('room-1')).toBe(true);
    expect(result.current.isMember('room-2')).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith('/api/me/rooms', { headers: { Authorization: 'Bearer ' + localStorage.getItem('arcaid_player_token') } });
  });

  it('join: optimistically adds the room, keeps it on success', async () => {
    signInAs('discord-2');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMyRooms(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isMember('room-9')).toBe(false);

    let ok = false;
    await act(async () => { ok = await result.current.join('room-9', { name: 'Room 9', slug: 'room_9', logoUrl: null }); });

    expect(ok).toBe(true);
    expect(result.current.isMember('room-9')).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/me/rooms/room-9', expect.objectContaining({ method: 'POST' }));
  });

  it('join: reverts the optimistic add when the request fails', async () => {
    signInAs('discord-3');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMyRooms(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let ok = true;
    await act(async () => { ok = await result.current.join('room-9'); });

    expect(ok).toBe(false);
    expect(result.current.isMember('room-9')).toBe(false);
  });

  it('leave: optimistically removes the room, stays gone on success', async () => {
    signInAs('discord-4');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { roomId: 'room-1', name: 'Room 1', slug: 'room_1', logoUrl: null, joinedAt: '2026-01-01', source: 'self_join', lastActivityAt: null },
        ]),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMyRooms(), { wrapper });
    await waitFor(() => expect(result.current.isMember('room-1')).toBe(true));

    let ok = false;
    await act(async () => { ok = await result.current.leave('room-1'); });

    expect(ok).toBe(true);
    expect(result.current.isMember('room-1')).toBe(false);
  });

  it('leave: restores the room when the request fails', async () => {
    signInAs('discord-5');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { roomId: 'room-1', name: 'Room 1', slug: 'room_1', logoUrl: null, joinedAt: '2026-01-01', source: 'admin_invite', lastActivityAt: null },
        ]),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useMyRooms(), { wrapper });
    await waitFor(() => expect(result.current.isMember('room-1')).toBe(true));

    let ok = true;
    await act(async () => { ok = await result.current.leave('room-1'); });

    expect(ok).toBe(false);
    // Reverted — still a member.
    expect(result.current.isMember('room-1')).toBe(true);
  });

  // v2.39.0 — approval rooms (tmp/approval-rooms-contract.md, D2/D4).
  describe('requestJoin', () => {
    it('guest: no-op, returns null, no fetch', async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useMyRooms(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let status: string | null = 'unset';
      await act(async () => { status = await result.current.requestJoin('room-1'); });
      expect(status).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('posts to the join-request endpoint and returns "pending"', async () => {
      signInAs('discord-6');
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'pending' }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useMyRooms(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let status: string | null = null;
      await act(async () => { status = await result.current.requestJoin('room-approval-1'); });
      expect(status).toBe('pending');
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/me/rooms/room-approval-1/join-request',
        expect.objectContaining({ method: 'POST' }),
      );
      // Not optimistic — no membership row added for a pending request.
      expect(result.current.isMember('room-approval-1')).toBe(false);
    });

    it('refetches membership when the server reports "member" (already a member, or policy flipped back to open)', async () => {
      signInAs('discord-7');
      let listCallCount = 0;
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({ status: 'member' }) });
        listCallCount += 1;
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(
            listCallCount > 1
              ? [{ roomId: 'room-2', name: 'Room 2', slug: 'room_2', logoUrl: null, joinedAt: '2026-01-01', source: 'self_join', lastActivityAt: null }]
              : [],
          ),
        });
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useMyRooms(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.isMember('room-2')).toBe(false);

      let status: string | null = null;
      await act(async () => { status = await result.current.requestJoin('room-2'); });
      expect(status).toBe('member');
      await waitFor(() => expect(result.current.isMember('room-2')).toBe(true));
    });

    it('returns null on a failed request', async () => {
      signInAs('discord-8');
      const fetchMock = vi.fn((url: string, init?: RequestInit) => {
        if (init?.method === 'POST') return Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'nope' }) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      });
      vi.stubGlobal('fetch', fetchMock);

      const { result } = renderHook(() => useMyRooms(), { wrapper });
      await waitFor(() => expect(result.current.loading).toBe(false));

      let status: string | null = 'unset';
      await act(async () => { status = await result.current.requestJoin('room-3'); });
      expect(status).toBeNull();
    });
  });
});
