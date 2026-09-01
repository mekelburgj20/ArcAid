import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GameQuickView from '../GameQuickView';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import type { RankedEntry } from '../ScoreboardComponents';

/**
 * v2.150.1 — score correction inside the game quick popup.
 *
 * This popup opens straight off a scoreboard card, which makes it the surface
 * a host actually looks at a score in — and it was the LAST one still carrying
 * a delete with no correction beside it. v2.149.1 and v2.150.0 both missed it
 * (owner: "why is this so difficult?"). These tests exist so a future
 * score-row affordance can't be added to some surfaces and not others without
 * a red suite.
 *
 * Mirrors `GameQuickView.delete.test.tsx`'s harness deliberately — the two
 * affordances sit on the same rows under the same gates.
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

function stubFetch() {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (url.includes('/score-counts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ counts: { 'game-1': {} } }) });
    }
    if (init?.method === 'PATCH') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, score: 5000, previousScore: 4200, suppressedAt: null }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPopup(props: Partial<React.ComponentProps<typeof GameQuickView>> = {}, gameStatus = 'ACTIVE') {
  return render(
    <MemoryRouter>
      <ViewerAuthProvider>
        <GameQuickView
          lb={{ gameName: 'Whirlwind', gameId: 'game-1', rankings: RANKINGS, gameStatus }}
          slug="rtx_pinball"
          onClose={() => {}}
          {...props}
        />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('GameQuickView — per-row score correction', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows the pencil on the viewer\'s OWN row while the card is unlocked', async () => {
    signInAs('disc-ada');
    renderPopup({ roomId: 'room-1' });

    await waitFor(() => {
      expect(screen.getByLabelText('Correct this score (4,200)')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Correct this score (3,100)')).not.toBeInTheDocument();
  });

  it('hides it on their own row once the card is LOCKED, keeping the delete', async () => {
    signInAs('disc-ada');
    renderPopup({ roomId: 'room-1' }, 'COMPLETED');

    await waitFor(() => {
      expect(screen.getByLabelText('Delete this score (4,200)')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Correct this score (4,200)')).not.toBeInTheDocument();
  });

  it('shows it on EVERY row for an admin, locked or not', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    renderPopup({ roomId: 'room-1' }, 'COMPLETED');

    await waitFor(() => {
      expect(screen.getByLabelText('Correct this score (4,200)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Correct this score (3,100)')).toBeInTheDocument();
  });

  it('renders nothing extra without a roomId (the Global tab and Picks)', async () => {
    signInAs('disc-admin', { role: 'super_admin', gameRoomIds: [] });
    renderPopup({});

    await screen.findByText('Ada');
    expect(screen.queryByLabelText('Correct this score (4,200)')).not.toBeInTheDocument();
  });

  it('a signed-out viewer sees no pencil', async () => {
    renderPopup({ roomId: 'room-1' });
    await screen.findByText('Ada');
    expect(screen.queryByLabelText('Correct this score (4,200)')).not.toBeInTheDocument();
  });

  it('PATCHes the corrected value and tells the owning page to refetch', async () => {
    signInAs('disc-ada');
    const fetchMock = stubFetch();
    const onScoreDeleted = vi.fn();
    renderPopup({ roomId: 'room-1', onScoreDeleted });

    fireEvent.click(await screen.findByLabelText('Correct this score (4,200)'));

    const input = await screen.findByLabelText('Corrected score') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '5000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(call).toBeTruthy();
      expect(String(call![0])).toBe('/api/rooms/room-1/score-history/11/score');
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ score: 5000 });
    });
    await waitFor(() => expect(onScoreDeleted).toHaveBeenCalled());
  });
});
