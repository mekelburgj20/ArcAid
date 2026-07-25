import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MyRooms from '../MyRooms';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

// v2.38.0 — join-leave contract. MyRooms now backs onto the shared
// useMyRooms hook (was its own local fetch) and gained a per-row leave
// affordance that must not trigger the row-wide Link's navigation.

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

function renderMyRooms() {
  return render(
    <MemoryRouter initialEntries={['/my-rooms']}>
      <ViewerAuthProvider>
        <MyRooms />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('MyRooms', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('logged-out: prompts to log in, no room list', () => {
    renderMyRooms();
    expect(screen.getByText('Log in to see the rooms you belong to')).toBeInTheDocument();
  });

  it('signed-in: lists rooms and leaving removes the row via DELETE', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
      }
      if (url.startsWith('/api/me/rooms')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve([
            { roomId: 'room-1', name: 'RTX Pinball', slug: 'rtx_pinball', logoUrl: null, joinedAt: '2026-01-01', source: 'self_join', lastActivityAt: null },
          ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderMyRooms();
    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());

    const leaveBtn = screen.getByLabelText('Leave RTX Pinball');
    fireEvent.click(leaveBtn);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/rooms/room-1', expect.objectContaining({ method: 'DELETE' })));
    await waitFor(() => expect(screen.queryByText('RTX Pinball')).not.toBeInTheDocument());
    // Empty-state copy shown once the last room is left.
    expect(screen.getByText("You haven't joined any rooms yet.")).toBeInTheDocument();
  });
});
