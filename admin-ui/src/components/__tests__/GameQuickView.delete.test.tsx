import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GameQuickView from '../GameQuickView';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import type { RankedEntry } from '../ScoreboardComponents';

/**
 * v2.108.0 (F4) — delete affordances inside the game quick popup.
 *
 * The popup is opened from three places: the two ROOM tabs (which pass
 * `roomId` and therefore get the delete controls) and the Global tab / Picks
 * (which do not, and must render exactly as they did in v2.107).
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signInAs(discordId: string, claims: Record<string, unknown> = {}) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({
    discordId, username: 'Tester', avatar: null, exp, role: 'player', gameRoomIds: [], ...claims,
  }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

const RANKINGS: RankedEntry[] = [
  {
    rank: 1, discord_user_id: 'disc-ada', iscored_username: 'Ada', score: 4200,
    history_id: 11, source: 'tournament', submitted_by_user_id: 'disc-ada',
  },
  {
    rank: 2, discord_user_id: 'disc-ben', iscored_username: 'Ben', score: 3100,
    history_id: 12, source: 'tournament', submitted_by_user_id: 'disc-ben',
  },
];

const HISTORY = [
  { id: 11, score: 4200, source: 'tournament', photo_url: null, created_at: '2026-08-01T00:00:00Z', submitted_by_user_id: 'disc-ada' },
  { id: 10, score: 900, source: 'tournament', photo_url: null, created_at: '2026-07-01T00:00:00Z', submitted_by_user_id: 'disc-ada' },
];

function stubFetch(over: (url: string) => unknown | undefined = () => undefined) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const custom = over(url);
    if (custom) return custom as Promise<Response>;
    if (url.includes('/score-counts')) {
      // Shape the `scoreCountsBatcher` expects: { counts: { [gameId]: {...} } }.
      return Promise.resolve({
        ok: true, json: () => Promise.resolve({ counts: { 'game-1': { ada: 2 } } }),
      });
    }
    if (url.includes('/score-history/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(HISTORY) });
    }
    if (init?.method === 'DELETE') {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPopup(props: Partial<React.ComponentProps<typeof GameQuickView>> = {}) {
  return render(
    <MemoryRouter>
      <ViewerAuthProvider>
        <GameQuickView
          lb={{ gameName: 'Whirlwind', gameId: 'game-1', rankings: RANKINGS }}
          slug="rtx_pinball"
          onClose={() => {}}
          {...props}
        />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('GameQuickView — per-row delete', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows a delete control on the viewer\'s OWN row only', async () => {
    signInAs('disc-ada');
    renderPopup({ roomId: 'room-1' });

    await waitFor(() => {
      expect(screen.getByLabelText('Delete this score (4,200)')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Delete this score (3,100)')).not.toBeInTheDocument();
  });

  it('shows delete on EVERY row for an admin of this room', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    renderPopup({ roomId: 'room-1' });

    await waitFor(() => {
      expect(screen.getByLabelText('Delete this score (4,200)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Delete this score (3,100)')).toBeInTheDocument();
  });

  it('renders NO delete affordance without a roomId (Global tab / Picks)', async () => {
    signInAs('disc-ada');
    renderPopup();

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    expect(screen.queryByLabelText(/Delete this score/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Show score history')).not.toBeInTheDocument();
  });

  it('renders NO delete affordance for a signed-out viewer', async () => {
    renderPopup({ roomId: 'room-1' });
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    expect(screen.queryByLabelText(/Delete this score/)).not.toBeInTheDocument();
  });

  it('confirms, DELETEs the backing history_id, drops the row and notifies the page', async () => {
    signInAs('disc-ada');
    const fetchMock = stubFetch();
    const onScoreDeleted = vi.fn();
    renderPopup({ roomId: 'room-1', onScoreDeleted });

    fireEvent.click(await screen.findByLabelText('Delete this score (4,200)'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(onScoreDeleted).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/rooms/room-1/score-history/11',
      expect.objectContaining({ method: 'DELETE' }),
    );
    // Optimistic removal — the deleted row is gone, the other one stays.
    await waitFor(() => expect(screen.queryByText('4,200')).not.toBeInTheDocument());
    expect(screen.getByText('3,100')).toBeInTheDocument();
  });

  it('surfaces a server refusal instead of pretending the row went away', async () => {
    signInAs('disc-ada');
    stubFetch((url) => url.includes('/score-history/11')
      ? Promise.resolve({ ok: false, json: () => Promise.resolve({ error: 'Nope' }) })
      : undefined);
    renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Delete this score (4,200)'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Nope'));
    expect(screen.getByText('4,200')).toBeInTheDocument();
  });
});

describe('GameQuickView — nested per-player history', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('expands a multi-score row and gives each history row its own delete', async () => {
    signInAs('disc-ada');
    renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Show score history'));

    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());
    expect(screen.getByLabelText('Delete this score (900)')).toBeInTheDocument();
  });

  it('deletes a nested history row by its own id', async () => {
    signInAs('disc-ada');
    const fetchMock = stubFetch();
    renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Show score history'));
    fireEvent.click(await screen.findByLabelText('Delete this score (900)'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      '/api/rooms/room-1/score-history/10',
      expect.objectContaining({ method: 'DELETE' }),
    ));
    await waitFor(() => expect(screen.queryByText('900')).not.toBeInTheDocument());
  });
});
