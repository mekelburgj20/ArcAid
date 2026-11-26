import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GameQuickView from '../GameQuickView';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import type { RankedEntry } from '../ScoreboardComponents';
import { waitForRealDialog } from '../../test/dialogTestUtils';

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

/**
 * G23c: the popup is the Arcaid dialog; wait until its real (base-ui) half has
 * replaced the stand-in, or a click found on the stand-in lands on a detached node.
 */
async function renderPopup(props: Partial<React.ComponentProps<typeof GameQuickView>> = {}) {
  const utils = render(
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
  await waitForRealDialog();
  return utils;
}

describe('GameQuickView — per-row delete', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('shows a delete control on the viewer\'s OWN row only', async () => {
    signInAs('disc-ada');
    await renderPopup({ roomId: 'room-1' });

    await waitFor(() => {
      expect(screen.getByLabelText('Delete this score (4,200)')).toBeInTheDocument();
    });
    expect(screen.queryByLabelText('Delete this score (3,100)')).not.toBeInTheDocument();
  });

  it('shows delete on EVERY row for an admin of this room', async () => {
    signInAs('disc-admin', { role: 'room_admin', gameRoomIds: ['room-1'] });
    await renderPopup({ roomId: 'room-1' });

    await waitFor(() => {
      expect(screen.getByLabelText('Delete this score (4,200)')).toBeInTheDocument();
    });
    expect(screen.getByLabelText('Delete this score (3,100)')).toBeInTheDocument();
  });

  it('renders NO delete affordance without a roomId (Global tab / Picks)', async () => {
    signInAs('disc-ada');
    await renderPopup();

    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    expect(screen.queryByLabelText(/Delete this score/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Show score history')).not.toBeInTheDocument();
  });

  it('renders NO delete affordance for a signed-out viewer', async () => {
    await renderPopup({ roomId: 'room-1' });
    await waitFor(() => expect(screen.getByText('Ada')).toBeInTheDocument());
    expect(screen.queryByLabelText(/Delete this score/)).not.toBeInTheDocument();
  });

  it('confirms, DELETEs the backing history_id, drops the row and notifies the page', async () => {
    signInAs('disc-ada');
    const fetchMock = stubFetch();
    const onScoreDeleted = vi.fn();
    await renderPopup({ roomId: 'room-1', onScoreDeleted });

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
    await renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Delete this score (4,200)'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Nope'));
    expect(screen.getByText('4,200')).toBeInTheDocument();
  });
});

describe('GameQuickView — auto-posted rows (v2.156.0, ADR 0024)', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const CABINET: RankedEntry[] = [
    {
      rank: 1, discord_user_id: 'disc-ada', iscored_username: 'Ada', score: 8366650,
      history_id: 21, source: 'vpx', submitted_by_user_id: 'disc-ada',
    },
    {
      rank: 2, discord_user_id: 'atgames:50177', iscored_username: 'CabHero', score: 5100,
      history_id: 22, source: 'atgames', submitted_by_user_id: null,
    },
  ];

  it('offers the owner the trash on their own cabinet score, and says the cabinet will not re-post it', async () => {
    signInAs('disc-ada');
    await renderPopup({ roomId: 'room-1', lb: { gameName: 'Bad Cats', gameId: 'game-1', rankings: CABINET } });

    fireEvent.click(await screen.findByLabelText('Delete this score (8,366,650)'));
    expect(screen.getByRole('dialog', { name: 'Delete score' })).toHaveTextContent(
      'Deleting it also stops the cabinet from posting this same score again.',
    );
    // An unlinked AtGames row belongs to nobody a player login can prove.
    expect(screen.queryByLabelText('Delete this score (5,100)')).not.toBeInTheDocument();
  });

  it('keeps a typed score\'s confirmation exactly as it was', async () => {
    signInAs('disc-ada');
    await renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Delete this score (4,200)'));
    expect(screen.getByRole('dialog', { name: 'Delete score' })).not.toHaveTextContent(/cabinet/);
  });
});

describe('GameQuickView — nested per-player history', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('expands a multi-score row and gives each history row its own delete', async () => {
    signInAs('disc-ada');
    await renderPopup({ roomId: 'room-1' });

    fireEvent.click(await screen.findByLabelText('Show score history'));

    await waitFor(() => expect(screen.getByText('900')).toBeInTheDocument());
    expect(screen.getByLabelText('Delete this score (900)')).toBeInTheDocument();
  });

  it('deletes a nested history row by its own id', async () => {
    signInAs('disc-ada');
    const fetchMock = stubFetch();
    await renderPopup({ roomId: 'room-1' });

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

/**
 * G23c — the delete confirm opens INSIDE the quick view's dialog, so base-ui
 * nests it: Escape, Cancel and a press inside the confirm touch the confirm
 * only; the quick view stays open behind it.
 */
describe('GameQuickView — the delete confirm is nested in the quick view', () => {
  beforeEach(() => { localStorage.clear(); stubFetch(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function openConfirm() {
    signInAs('disc-ada');
    const onClose = vi.fn();
    await renderPopup({ roomId: 'room-1', onClose });
    const trash = await screen.findByLabelText('Delete this score (4,200)');
    trash.focus();
    fireEvent.click(trash);
    const confirm = await screen.findByRole('dialog', { name: 'Delete score' });
    await waitFor(() => expect(within(confirm).getByRole('button', { name: 'Cancel' })).toHaveFocus());
    return { onClose, confirm, trash };
  }

  it('(a) Escape in the confirm closes only the confirm, and focus goes back to the trash button', async () => {
    const { onClose, trash } = await openConfirm();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete score' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Whirlwind' })).toBeInTheDocument();
    await waitFor(() => expect(trash).toHaveFocus());
  });

  it('(b) Cancel in the confirm leaves the quick view open', async () => {
    const { onClose, confirm } = await openConfirm();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete score' })).not.toBeInTheDocument());
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Whirlwind' })).toBeInTheDocument();
  });

  it('(c) a press inside the confirm closes neither dialog', async () => {
    const { onClose, confirm } = await openConfirm();
    const text = within(confirm).getByText(/Delete this score \(4,200\)\?/);
    fireEvent.pointerDown(text);
    fireEvent.mouseDown(text);
    fireEvent.pointerUp(text);
    fireEvent.mouseUp(text);
    fireEvent.click(text);
    await act(async () => { await Promise.resolve(); });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Delete score' })).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Whirlwind', hidden: true })).toBeInTheDocument();
  });
});
