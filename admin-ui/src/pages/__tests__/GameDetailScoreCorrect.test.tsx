import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';

/**
 * v2.149.1 — score correction on the CURRENT LEADERBOARD row.
 *
 * v2.149.0 shipped the pencil only inside the per-player history expand, which
 * broke two ways the owner found the next day:
 *
 *   1. The board row's expand is gated on `hasMultiple` (more than one score
 *      for that player on that game), so a player with a SINGLE score had no
 *      expand and therefore no reachable correction at all — the commonest
 *      case in the app.
 *   2. The trash lives on the board row and is always visible, so the
 *      DESTRUCTIVE action was one hover away while the safe one was two clicks
 *      deep. Backwards.
 *
 * `score-counts` is stubbed empty below, which is exactly case 1: no player has
 * multiple scores, so nothing here can expand.
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

interface StubOpts {
  /** 'COMPLETED' is a LOCKED card (the default here — it is the incident's shape). */
  gameStatus?: string;
  /** Admin-verified rows are closed to their owner. */
  verified?: boolean;
}

function rankings(opts: StubOpts = {}) {
  return [
    {
      rank: 1, discord_user_id: 'disc-nudge', iscored_username: 'StopNudgingMe', score: 66661589860,
      history_id: 496, source: 'community', submitted_by_user_id: 'disc-nudge',
      verified: opts.verified ?? false,
    },
  ];
}

function stubFetch(opts: StubOpts = {}) {
  const RANKINGS = rankings(opts);
  const BOARD = {
    gameId: 'game-1', gameName: 'World Cup Soccer', tournamentName: 'Daily Grind',
    imageUrl: null, rankings: RANKINGS, gameStatus: opts.gameStatus ?? 'COMPLETED', globalGameId: null,
  };
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ success: true, score: 6666158980, previousScore: 66661589860, suppressedAt: null }),
      });
    }
    if (/\/leaderboard\/game-1(\?|$)/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ rankings: RANKINGS, distinctEngines: [] }) });
    }
    if (url.endsWith('/leaderboard')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([BOARD]) });
    }
    // Empty score-counts => no player has multiple scores => no expand exists.
    if (url.includes('/score-counts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    }
    if (/\/stats\/game\/[^/]+$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        gameName: 'World Cup Soccer', timesPlayed: 1, avgScore: 1, uniquePlayers: 1,
        allTimeHigh: 66661589860, allTimeHighPlayer: 'StopNudgingMe', recentResults: [],
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/rtx_pinball/games/World Cup Soccer']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'rtx_pinball', roomName: 'RTX Pinball' }}>
            <Routes>
              <Route path="/:slug/games/:name" element={<GameDetail />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const correctLabel = /Correct this score/;

describe('GameDetail — leaderboard-row score correction', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });

  it('a room admin sees the pencil on a single-score row (the v2.149.0 gap)', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    renderPage();
    expect(await screen.findByRole('button', { name: correctLabel })).toBeInTheDocument();
  });

  it('a super admin sees it too', async () => {
    signInAs('disc-super', { role: 'super_admin', gameRoomIds: [] });
    renderPage();
    expect(await screen.findByRole('button', { name: correctLabel })).toBeInTheDocument();
  });

  /**
   * Owner tier (ruling 2026-08-31): "I want players to be able to edit their
   * own scores just as easily, unless the card is locked — in which case they
   * will need an admin." Locked == the game is no longer ACTIVE, the same line
   * `isCooldownLocked` draws for submissions.
   */
  it('the SUBMITTER sees the pencil while the card is unlocked', async () => {
    signInAs('disc-nudge');
    stubFetch({ gameStatus: 'ACTIVE' });
    renderPage();
    expect(await screen.findByRole('button', { name: correctLabel })).toBeInTheDocument();
  });

  it('the submitter LOSES it once the card locks — that is the admin-only case', async () => {
    signInAs('disc-nudge');
    stubFetch({ gameStatus: 'COMPLETED' });
    renderPage();
    // Delete is still theirs; only the correction closes.
    await screen.findByRole('button', { name: /Delete this score/ });
    expect(screen.queryByRole('button', { name: correctLabel })).not.toBeInTheDocument();
  });

  it('an admin-VERIFIED row is closed to its owner even while unlocked', async () => {
    signInAs('disc-nudge');
    stubFetch({ gameStatus: 'ACTIVE', verified: true });
    renderPage();
    await screen.findByRole('button', { name: /Delete this score/ });
    expect(screen.queryByRole('button', { name: correctLabel })).not.toBeInTheDocument();
  });

  it('an admin keeps it on a verified row on a locked card', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    stubFetch({ gameStatus: 'COMPLETED', verified: true });
    renderPage();
    expect(await screen.findByRole('button', { name: correctLabel })).toBeInTheDocument();
  });

  it('a DIFFERENT player never sees it on someone else’s row', async () => {
    signInAs('disc-someone-else');
    stubFetch({ gameStatus: 'ACTIVE' });
    renderPage();
    await screen.findByText('66,661,589,860');
    expect(screen.queryByRole('button', { name: correctLabel })).not.toBeInTheDocument();
  });

  it('a signed-out viewer sees neither', async () => {
    renderPage();
    // Anchor on the score, which renders as a plain span — the player name is
    // a <Link> and does not resolve by text here.
    await screen.findByText('66,661,589,860');
    expect(screen.queryByRole('button', { name: correctLabel })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete this score/ })).not.toBeInTheDocument();
  });

  it('opens a dialog naming the old value and its magnitude', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: correctLabel }));

    await screen.findByText('Correct score');
    // The before/after magnitude pair is the whole point of the dialog.
    expect(screen.getByText(/was 66,661,589,860 \(66\.66 billion\)/)).toBeInTheDocument();
  });

  it('groups as you type and PATCHes the UNGROUPED number', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    const fetchMock = stubFetch();
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: correctLabel }));

    const input = await screen.findByLabelText('Corrected score') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '6666158980' } });
    expect(input.value).toBe('6,666,158,980');
    await screen.findByText('6.66 billion');

    fireEvent.click(screen.getByRole('button', { name: 'Save correction' }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'PATCH');
      expect(call).toBeTruthy();
      expect(String(call![0])).toBe('/api/rooms/room-1/score-history/496/score');
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ score: 6666158980 });
    });
  });

  it('refuses to save a no-op edit', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: correctLabel }));

    await screen.findByLabelText('Corrected score');
    // The field opens pre-filled with the current score.
    expect(screen.getByRole('button', { name: 'Save correction' })).toBeDisabled();
    expect(screen.getByText('That is already the recorded score.')).toBeInTheDocument();
  });
});
