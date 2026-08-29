import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import RotationLogPanel from '../RotationLogPanel';

/**
 * Rotation log panel (v2.146.0).
 *
 * The panel exists to answer the 2026-08-27 question — "who or what picked
 * what, and what triggered it" — in a sentence a room admin can read. So the
 * tests are about the SENTENCES (the source and queue owner have to survive
 * into the copy) and about the two controls that change what is fetched.
 */

const ROOM_ID = 'room-1';

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind' },
  { id: 't-2', name: 'WG-VPXS' },
];

function ev(over: Record<string, unknown>) {
  return {
    id: 1,
    tournament_id: 't-1',
    tournament_name: 'Daily Grind',
    event_type: 'game_activated',
    actor: 'system:cron',
    source: 'winner_queue',
    queue_owner: null,
    game_id: 'g-1',
    game_name: 'Attack from Mars',
    details: {},
    created_at: '2026-08-27 22:00:00',
    ...over,
  };
}

/** Captures every rotation-log URL the panel requests, in order. */
function stubFetch(pages: { events: unknown[]; nextCursor: string | null }[]) {
  const urls: string[] = [];
  let call = 0;
  const fetchMock = vi.fn((url: string) => {
    urls.push(url);
    const body = pages[Math.min(call++, pages.length - 1)];
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return urls;
}

const renderPanel = () =>
  render(<RotationLogPanel roomId={ROOM_ID} tournaments={TOURNAMENTS} />);

describe('RotationLogPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('names the branch and the queue owner in the activation line', async () => {
    stubFetch([{
      events: [ev({
        id: 9, source: 'runner_up_queue', queue_owner: 'BrickShotBobes',
        details: { replacedGame: 'Bad Cats' },
      })],
      nextCursor: null,
    }]);
    renderPanel();

    const line = await screen.findByText(/Activated Attack from Mars/);
    expect(line.textContent).toContain("from the runner-up's queue");
    expect(line.textContent).toContain("BrickShotBobes's queue");
    expect(line.textContent).toContain('replacing Bad Cats');
  });

  it('renders a readable line for winner, hand-off and pick-window rows', async () => {
    stubFetch([{
      events: [
        ev({ id: 1, event_type: 'winner_resolved', details: { resolved: true, winnerName: 'Wyo', fromGame: 'Xenon', score: 1234567 } }),
        ev({ id: 2, event_type: 'disposition_applied', actor: 'player:Wyo', details: { disposition: 'forfeit' } }),
        ev({ id: 3, event_type: 'pick_window_granted', details: { pickerLabel: 'soggybacon', pickerType: 'RUNNER_UP', windowMin: 30 } }),
        ev({ id: 4, event_type: 'placeholder_deleted', details: { reason: 'capacity_guard' } }),
      ],
      nextCursor: null,
    }]);
    renderPanel();

    expect((await screen.findByText(/Wyo won Xenon/)).textContent).toContain('1,234,567');
    expect(screen.getByText(/Wyo forfeited the pick/)).toBeTruthy();
    expect(screen.getByText(/soggybacon got a runner-up pick window of 30 min/)).toBeTruthy();
    expect(screen.getByText(/the tournament was already full/)).toBeTruthy();
  });

  it('re-queries with tournamentId when the filter changes', async () => {
    const urls = stubFetch([{ events: [], nextCursor: null }]);
    renderPanel();
    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain(`/rooms/${ROOM_ID}/admin/rotation-log`);
    expect(urls[0]).not.toContain('tournamentId');

    fireEvent.change(screen.getByLabelText('Filter rotation log by tournament'), { target: { value: 't-2' } });

    await waitFor(() => expect(urls).toHaveLength(2));
    expect(urls[1]).toContain('tournamentId=t-2');
  });

  it('appends the next page through the cursor', async () => {
    const urls = stubFetch([
      { events: [ev({ id: 2, game_name: 'Medieval Madness' })], nextCursor: '2026-08-27 22:00:00|2' },
      { events: [ev({ id: 1, game_name: 'Theatre of Magic' })], nextCursor: null },
    ]);
    renderPanel();

    await screen.findByText(/Activated Medieval Madness/);
    fireEvent.click(screen.getByText('Load more'));

    await screen.findByText(/Activated Theatre of Magic/);
    // The first page is still on screen — Load more appends, never replaces.
    expect(screen.getByText(/Activated Medieval Madness/)).toBeTruthy();
    expect(urls[1]).toContain('before=');
    // …and the exhausted cursor retires the button.
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('shows an empty state rather than crashing on an unexpected body', async () => {
    // A body with no `events` key (a stubbed/legacy response) must render as
    // "nothing yet" — this panel is a guest on the Game States page and may
    // not take it down.
    stubFetch([[] as unknown as { events: unknown[]; nextCursor: string | null }]);
    renderPanel();
    expect(await screen.findByText(/No rotation decisions recorded yet/)).toBeTruthy();
  });
});
