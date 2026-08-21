import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GameStates from '../GameStates';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';

/**
 * Game States — iScored link check + re-create repair (v2.123.2).
 *
 * The rtx_pinball incident (2026-08-21): an ACTIVE game's iScored entry was
 * deleted behind Arcaid's back. Nothing on this page said so, and the only
 * create button rendered when `iscored_id` was already NULL — so the one row
 * that needed repairing was the one row with no action on it.
 *
 * What the page has to do now:
 *   1. "Check iScored links" asks the server and badges the rows whose entry
 *      is gone. Rows it did NOT cover stay unbadged — absence of an answer is
 *      not evidence of a broken link.
 *   2. Those rows (and rows with no id at all) get a re-create action whose
 *      confirm modal states the three consequences: new id, scores replayed as
 *      per-player bests, dates become now.
 *   3. Confirming POSTs `{ action: 'recreate' }` to the game's sync-iscored
 *      path — NOT the legacy `create`, which neither tags nor replays.
 */

const ROOM_ID = 'room-1';

const GAMES = [
  {
    id: 'g-dead', name: 'Clown Deluxe', status: 'ACTIVE', iscored_id: '105425',
    picker_discord_id: null, picker_type: null, picker_designated_at: null,
    reminder_count: 0, won_game_id: null, start_date: '2026-08-20T22:00:00Z',
    end_date: null, queue_order: null, style_id: null,
    tournament_name: 'Daily Grind', tournament_type: 'DG', tournament_id: 't-1',
  },
  {
    id: 'g-alive', name: 'Attack From Mars', status: 'ACTIVE', iscored_id: '999111',
    picker_discord_id: null, picker_type: null, picker_designated_at: null,
    reminder_count: 0, won_game_id: null, start_date: '2026-08-20T22:00:00Z',
    end_date: null, queue_order: null, style_id: null,
    tournament_name: 'Daily Grind', tournament_type: 'DG', tournament_id: 't-1',
  },
  {
    id: 'g-unlinked', name: 'Theatre of Magic', status: 'QUEUED', iscored_id: null,
    picker_discord_id: null, picker_type: null, picker_designated_at: null,
    reminder_count: 0, won_game_id: null, start_date: null,
    end_date: null, queue_order: 1, style_id: null,
    tournament_name: 'Daily Grind', tournament_type: 'DG', tournament_id: 't-1',
  },
];

const LINK_CHECK = {
  games: [
    { gameId: 'g-dead', name: 'Clown Deluxe', iscoredId: '105425', status: 'ACTIVE', present: false },
    { gameId: 'g-alive', name: 'Attack From Mars', iscoredId: '999111', status: 'ACTIVE', present: true },
  ],
  missingCount: 1,
};

type Write = { url: string; body: unknown };

function stubFetch(writes: Write[]) {
  const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      writes.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return j({ success: true, action: 'recreate', newId: 'ISC_NEW', oldId: '105425', scoresSubmitted: 4, scoresRejected: 0 });
    }
    // Must precede '/admin/game-states', which is a prefix of this path.
    if (url.includes('/iscored-link-check')) return j(LINK_CHECK);
    if (url.includes('/admin/game-states')) return j(GAMES);
    if (url.includes('/tournaments')) return j([]);
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/test-room/admin/game-states']}>
      <ToastProvider>
        <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: 'test-room', roomName: 'Test Room' }}>
          <GameStates />
        </RoomContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** The <tr> a game's name sits in. */
function rowFor(name: string): HTMLElement {
  return screen.getByText(name).closest('tr') as HTMLElement;
}

describe('Game States — iScored link check + re-create', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('badges only the rows the check reported as missing', async () => {
    stubFetch([]);
    renderPage();
    await screen.findByText('Clown Deluxe');

    // Nothing is badged before the check runs — it costs a session, so it is
    // never fired on page load.
    expect(screen.queryByText('missing on iScored')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Check iScored links'));

    await waitFor(() => expect(screen.getAllByText('missing on iScored')).toHaveLength(1));
    expect(within(rowFor('Clown Deluxe')).getByText('missing on iScored')).toBeInTheDocument();
    expect(within(rowFor('Attack From Mars')).queryByText('missing on iScored')).not.toBeInTheDocument();
    // The unlinked QUEUED row was never covered by the check — no badge.
    expect(within(rowFor('Theatre of Magic')).queryByText('missing on iScored')).not.toBeInTheDocument();
  });

  it('offers Re-create only on a broken row, and only after the check', async () => {
    stubFetch([]);
    renderPage();
    await screen.findByText('Clown Deluxe');

    // Before the check: a linked row has no repair affordance at all.
    expect(within(rowFor('Clown Deluxe')).queryByTitle('Re-create on iScored')).not.toBeInTheDocument();
    // A row with no id keeps the plain create affordance.
    expect(within(rowFor('Theatre of Magic')).getByTitle('Create on iScored')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Check iScored links'));
    await waitFor(() => expect(within(rowFor('Clown Deluxe')).getByTitle('Re-create on iScored')).toBeInTheDocument());
    // The healthy row stays untouched.
    expect(within(rowFor('Attack From Mars')).queryByTitle('Re-create on iScored')).not.toBeInTheDocument();
  });

  it("explains the consequences, then POSTs { action: 'recreate' }", async () => {
    const writes: Write[] = [];
    stubFetch(writes);
    renderPage();
    await screen.findByText('Clown Deluxe');

    fireEvent.click(screen.getByText('Check iScored links'));
    await waitFor(() => within(rowFor('Clown Deluxe')).getByTitle('Re-create on iScored'));
    fireEvent.click(within(rowFor('Clown Deluxe')).getByTitle('Re-create on iScored'));

    // The modal names all three losses before the admin commits.
    await screen.findByText('Re-create on iScored: Clown Deluxe');
    const modalText = document.body.textContent || '';
    expect(modalText).toContain('new iScored ID');
    expect(modalText).toContain('one best per player');
    expect(modalText).toContain('become now');

    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toBe(`/api/rooms/${ROOM_ID}/admin/game-states/g-dead/sync-iscored`);
    expect(writes[0].body).toEqual({ action: 'recreate' });
    await screen.findByText(/re-created on iScored \(ISC_NEW\) — 4 score\(s\) replayed/);
  });

  it("routes the no-id create button through 'recreate' too", async () => {
    const writes: Write[] = [];
    stubFetch(writes);
    renderPage();
    await screen.findByText('Theatre of Magic');

    fireEvent.click(within(rowFor('Theatre of Magic')).getByTitle('Create on iScored'));
    await screen.findByText('Re-create on iScored: Theatre of Magic');
    fireEvent.click(screen.getByText('Confirm'));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].url).toBe(`/api/rooms/${ROOM_ID}/admin/game-states/g-unlinked/sync-iscored`);
    expect(writes[0].body).toEqual({ action: 'recreate' });
  });
});
