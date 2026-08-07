import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MyStats from '../MyStats';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

// v2.82.0 — My Stats v1 (Identity arc Phase 3). Modeled on MyRooms.test.tsx:
// logged-out gate + return-path login idiom, signed-in fetch, and (new here)
// the scope selector refetching /api/me/stats on switch.

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

const MEMBER_ROOMS = [
  { roomId: 'room-1', name: 'RTX Pinball', slug: 'rtx_pinball', logoUrl: null, joinedAt: '2026-01-01', source: 'submission', lastActivityAt: null },
  { roomId: 'room-2', name: 'Arcade Alley', slug: 'arcade_alley', logoUrl: null, joinedAt: '2026-01-01', source: 'self_join', lastActivityAt: null },
];

const ALL_SCOPE_RESPONSE = {
  scope: 'all',
  overview: { gamesWithBest: 3, memberRooms: 2, totalScores: 41 },
  personalBests: [
    { source: 'room', game_name: 'Fire!', best_score: 500_000, rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z', room_id: 'room-1', room_slug: 'rtx_pinball', room_name: 'RTX Pinball', room_logo_url: 'https://example.com/rtx-logo.png' },
    { source: 'room', game_name: 'Whirlwind', best_score: 250_000, rank: 3, total_players: 8, achieved_at: '2026-05-02T00:00:00.000Z', room_id: 'room-2', room_slug: 'arcade_alley', room_name: 'Arcade Alley', room_logo_url: null },
    { source: 'global', game_name: 'Cosmic Cart Racing', best_score: 999, rank: 1, total_players: 12, achieved_at: '2026-05-03T00:00:00.000Z', global_game_id: 'gg-1' },
  ],
};

const ROOM_1_SCOPE_RESPONSE = {
  scope: 'room-1',
  overview: { gamesWithBest: 1, memberRooms: 2, totalScores: 10 },
  personalBests: [
    { source: 'room', game_name: 'Fire!', best_score: 500_000, rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z', room_id: 'room-1', room_slug: 'rtx_pinball', room_name: 'RTX Pinball' },
  ],
};

function renderMyStats() {
  return render(
    <MemoryRouter initialEntries={['/my-stats']}>
      <ViewerAuthProvider>
        <MyStats />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('MyStats', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('logged-out: prompts to log in, no stats fetched', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderMyStats();
    expect(screen.getByText('Log in to see your stats')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('signed-in: fetches /api/me/stats?scope=all by default and renders overview tiles + bests', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/me/stats')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(ALL_SCOPE_RESPONSE) });
      }
      if (url.startsWith('/api/me/rooms')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MEMBER_ROOMS) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderMyStats();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/stats?scope=all',
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: expect.stringContaining('Bearer') }) }),
    ));

    // Overview tiles.
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('Games with a best')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('Member rooms')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();
    expect(screen.getByText('Scores posted')).toBeInTheDocument();

    // Personal Bests section, with the "Global Scoreboard" chip on the
    // direct-Global row (not bare "Global" — owner revision).
    expect(screen.getByText('Personal Bests')).toBeInTheDocument();
    expect(screen.getByText('Fire!')).toBeInTheDocument();
    expect(screen.getByText('Cosmic Cart Racing')).toBeInTheDocument();
    expect(screen.getByText('Global Scoreboard')).toBeInTheDocument();

    // Rank header says "Rank", not PlayerDetail's "Room Rank".
    expect(screen.getByText('Rank')).toBeInTheDocument();
    expect(screen.queryByText('Room Rank')).toBeNull();

    // Cross-room identity shown in the "All" scope. RTX Pinball's row has a
    // room_logo_url — rendered as a logo image (alt = room name), not text,
    // so it appears only once as text (the scope pill). Arcade Alley's row
    // has no logo — falls back to the text caption, so it appears twice
    // (scope pill + row caption).
    expect(screen.getAllByText('RTX Pinball')).toHaveLength(1);
    expect(screen.getByAltText('RTX Pinball')).toBeInTheDocument();
    expect(screen.getAllByText('Arcade Alley').length).toBeGreaterThanOrEqual(2);

    // Owner revision — My Stats wraps titles instead of ellipsizing; the
    // truncating class must be absent from the rendered title link.
    const fireLink = screen.getByText('Fire!');
    expect(fireLink).toHaveClass('break-words');
    expect(fireLink).not.toHaveClass('truncate');
  });

  it('scope pills render one per member room and switching refetches with ?scope=<roomId>', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = vi.fn((url: string) => {
      if (url === '/api/me/stats?scope=all') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(ALL_SCOPE_RESPONSE) });
      }
      if (url === '/api/me/stats?scope=room-1') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(ROOM_1_SCOPE_RESPONSE) });
      }
      if (url.startsWith('/api/me/rooms')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(MEMBER_ROOMS) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderMyStats();
    await screen.findByText('Cosmic Cart Racing');

    const roomTab = await screen.findByRole('tab', { name: 'RTX Pinball' });
    fireEvent.click(roomTab);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/me/stats?scope=room-1',
      expect.anything(),
    ));
    await waitFor(() => expect(screen.queryByText('Cosmic Cart Racing')).not.toBeInTheDocument());
    expect(screen.getByText('Fire!')).toBeInTheDocument();
  });

  it('renders an empty state when there are no personal bests', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/me/stats')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ scope: 'all', overview: { gamesWithBest: 0, memberRooms: 0, totalScores: 0 }, personalBests: [] }),
        });
      }
      if (url.startsWith('/api/me/rooms')) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderMyStats();
    expect(await screen.findByText('No personal bests yet.')).toBeInTheDocument();
    // No member rooms -> no scope pills.
    expect(screen.queryByRole('tab')).toBeNull();
  });

  it('renders an error state when the stats fetch fails', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = vi.fn((url: string) => {
      if (url.startsWith('/api/me/stats')) {
        return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    renderMyStats();
    expect(await screen.findByText('Could not load your stats.')).toBeInTheDocument();
  });
});
