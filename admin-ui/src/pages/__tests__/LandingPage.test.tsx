import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import LandingPage from '../LandingPage';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

// D1/D2 (v2.37.0) — landing page login + "My Game Rooms". Regression coverage:
// the logged-out layout is unchanged (no My Game Rooms section, LoginButtons
// shown), and signed-in users see a deduped My Game Rooms section above the
// public grid, degrading gracefully for rooms /api/me/rooms returns that
// aren't in the public /api/rooms listing.

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signInAs(discordId: string, username: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

const PUBLIC_ROOM_1 = {
  id: 'room-1',
  slug: 'rtx_pinball',
  name: 'RTX Pinball',
  description: '',
  is_public: true,
  logo_url: null,
  activeGames: 3,
  activePlayers: 10,
  discordInviteUrl: null,
};

const PUBLIC_ROOM_2 = {
  id: 'room-2',
  slug: 'other_room',
  name: 'Other Room',
  description: '',
  is_public: true,
  logo_url: null,
  activeGames: 1,
  activePlayers: 2,
  discordInviteUrl: null,
};

function mockFetch(opts: { rooms?: unknown[]; meRooms?: unknown[] }) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.rooms ?? []) });
    }
    if (url.startsWith('/api/global/recent-scores')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.startsWith('/api/me/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(opts.meRooms ?? []) });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ViewerAuthProvider>
        <LandingPage />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('LandingPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('logged-out: shows the public grid and login buttons, no My Game Rooms section', async () => {
    mockFetch({ rooms: [PUBLIC_ROOM_1, PUBLIC_ROOM_2] });

    renderLanding();

    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());
    expect(screen.getByText('Other Room')).toBeInTheDocument();
    expect(screen.queryByText('My Game Rooms')).not.toBeInTheDocument();
    // LoginButtons rendered (Discord + Google), not UserMenu.
    expect(screen.getAllByText('Login').length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('User menu')).not.toBeInTheDocument();
    // Admin link still present.
    expect(screen.getByText('Admin')).toBeInTheDocument();
  });

  it('signed-in: My Game Rooms is deduped from the public grid and shows the UserMenu', async () => {
    signInAs('user-1', 'Justin');
    mockFetch({
      rooms: [PUBLIC_ROOM_1, PUBLIC_ROOM_2],
      meRooms: [
        { roomId: 'room-1', name: 'RTX Pinball', slug: 'rtx_pinball', logoUrl: null, joinedAt: '2026-01-01', source: 'submission', lastActivityAt: null },
      ],
    });

    renderLanding();

    await waitFor(() => expect(screen.getByText('My Game Rooms')).toBeInTheDocument());
    // room-1 renders once (in My Game Rooms), not duplicated in the public grid below.
    expect(screen.getAllByText('RTX Pinball')).toHaveLength(1);
    // room-2 remains in the public grid since the user isn't a member.
    expect(screen.getByText('Other Room')).toBeInTheDocument();
    // Signed-in header shows the UserMenu, not LoginButtons.
    expect(screen.getByLabelText('User menu')).toBeInTheDocument();
  });

  it('signed-in: gracefully degrades a member room absent from the public listing (no stats row)', async () => {
    signInAs('user-1', 'Justin');
    mockFetch({
      rooms: [PUBLIC_ROOM_1],
      meRooms: [
        { roomId: 'private-room', name: 'Private Room', slug: 'private_room', logoUrl: null, joinedAt: '2026-01-01', source: 'admin_invite', lastActivityAt: null },
      ],
    });

    renderLanding();

    await waitFor(() => expect(screen.getByText('Private Room')).toBeInTheDocument());
    const myRoomsHeading = screen.getByText('My Game Rooms');
    const section = myRoomsHeading.closest('div')?.parentElement as HTMLElement;
    // Degraded card has no stats — "Active Games" label shouldn't render for it.
    expect(within(section).queryByText('Active Games')).not.toBeInTheDocument();
    // The still-public, non-member room remains untouched with its stats.
    expect(screen.getByText('RTX Pinball')).toBeInTheDocument();
  });
});
