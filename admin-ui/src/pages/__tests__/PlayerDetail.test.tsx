import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import PlayerDetail from '../PlayerDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * Unlinked-player affordances (ROADMAP, S14 field-testing follow-up), parts
 * (a) disabled Follow + (c) admin hint. Mirrors PublicLayout.test.tsx's
 * fakeJwt/signInAs pattern (jwt payload → localStorage, no real auth call).
 */
function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signInAs(discordId: string, claims: Record<string, unknown> = {}) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem(
    'arcaid_player_token',
    fakeJwt({ discordId, username: 'Tester', avatar: null, exp, role: 'player', gameRoomIds: [], ...claims }),
  );
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

const STATS_BASE = {
  iscoredUsername: 'TargetAlias',
  totalGamesPlayed: 3,
  totalWins: 1,
  winPercentage: 33,
  avg_finish_position: 2.0,
  top5_rate: 1,
  champion_streak: 0,
  bestGame: null,
  recentScores: [],
};

function stubFetch(discordUserId: string | null) {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/stats/enhanced/player/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...STATS_BASE, discordUserId }) });
    }
    if (url.includes('/api/me/friends')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ViewerAuthProvider>
        <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx_pinball', roomName: 'RTX Pinball' }}>
          <Routes>
            <Route path="/:slug/players/:id" element={<PlayerDetail />} />
          </Routes>
        </RoomContext.Provider>
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('PlayerDetail — unlinked-player Follow affordance (a)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('shows a disabled Follow button with an explanatory tooltip when the player has no Discord identity', async () => {
    signInAs('viewer-1');
    stubFetch(null);

    renderAt('/rtx_pinball/players/TargetAlias');

    const btn = await screen.findByRole('button', { name: /Follow — unavailable/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', "This player hasn't linked Discord yet");
    // The active, clickable Follow button must NOT also be present.
    expect(screen.queryByRole('button', { name: /^Follow$/ })).toBeNull();
  });

  it('shows an active Follow button when the player has a linked Discord identity (non-regression)', async () => {
    signInAs('viewer-2');
    stubFetch('target-1');

    renderAt('/rtx_pinball/players/TargetAlias');

    const btn = await screen.findByRole('button', { name: /^Follow$/ });
    expect(btn).not.toBeDisabled();
    expect(screen.queryByRole('button', { name: /Follow — unavailable/i })).toBeNull();
  });

  it('renders no Follow affordance at all for a logged-out viewer, linked or not', async () => {
    stubFetch(null);

    renderAt('/rtx_pinball/players/TargetAlias');

    await waitFor(() => expect(screen.getByText('TargetAlias')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Follow/i })).toBeNull();
  });
});

describe('PlayerDetail — admin hint for unlinked players (c)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('shows the admin hint to a room_admin scoped to this room when the player is unlinked', async () => {
    signInAs('admin-1', { role: 'room_admin', gameRoomIds: ['room-1'] });
    stubFetch(null);

    renderAt('/rtx_pinball/players/TargetAlias');

    expect(await screen.findByText(/link this player's alias/i)).toBeInTheDocument();
  });

  it('shows the admin hint to a super_admin regardless of gameRoomIds', async () => {
    signInAs('admin-2', { role: 'super_admin', gameRoomIds: [] });
    stubFetch(null);

    renderAt('/rtx_pinball/players/TargetAlias');

    expect(await screen.findByText(/link this player's alias/i)).toBeInTheDocument();
  });

  it('does not show the admin hint when the player IS linked, even for an admin', async () => {
    signInAs('admin-3', { role: 'room_admin', gameRoomIds: ['room-1'] });
    stubFetch('target-1');

    renderAt('/rtx_pinball/players/TargetAlias');

    await waitFor(() => expect(screen.getByText('TargetAlias')).toBeInTheDocument());
    expect(screen.queryByText(/link this player's alias/i)).toBeNull();
  });

  it('does not show the admin hint to a plain player viewer', async () => {
    signInAs('viewer-3', { role: 'player', gameRoomIds: [] });
    stubFetch(null);

    renderAt('/rtx_pinball/players/TargetAlias');

    await waitFor(() => expect(screen.getByText('TargetAlias')).toBeInTheDocument());
    expect(screen.queryByText(/link this player's alias/i)).toBeNull();
  });

  it('does not show the admin hint to a room_admin of a DIFFERENT room (no cross-room leakage)', async () => {
    signInAs('admin-4', { role: 'room_admin', gameRoomIds: ['some-other-room'] });
    stubFetch(null);

    renderAt('/rtx_pinball/players/TargetAlias');

    await waitFor(() => expect(screen.getByText('TargetAlias')).toBeInTheDocument());
    expect(screen.queryByText(/link this player's alias/i)).toBeNull();
  });
});
