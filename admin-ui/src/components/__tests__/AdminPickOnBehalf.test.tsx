import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import AdminPickOnBehalf from '../AdminPickOnBehalf';
import { ToastProvider } from '../Toast';

/**
 * Admin queue-on-behalf panel (v2.121.0).
 *
 * The behaviours worth locking are the wire contract (does it POST the body
 * the server's `AdminQueueOnBehalfSchema` expects, to the room+tournament
 * scoped path?) and that it renders the queue the SERVER returned rather than
 * an optimistic local guess — the server is the authority on eligibility, so
 * a locally-assembled queue would drift the moment a pick is rejected.
 */

const ROOM = 'room-1';
const TOURNAMENT = 'tour-1';
const PLAYER = '111111111111111111';

function ok(body: unknown, status = 200) {
  return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
}

/** Routes the four GETs the panel makes on mount, then delegates writes. */
function makeFetchMock(onWrite?: (url: string, init: RequestInit) => unknown) {
  return vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET') {
      if (url.includes('/admin/members')) {
        return ok([{ userId: PLAYER, displayName: 'AbsentAl', avatarHash: null, avatarUrl: null }]);
      }
      if (url.includes('/game-availability/')) {
        return ok({
          games: [
            { name: 'Medieval Madness', available: true, daysUntilAvailable: 0 },
            { name: 'Recently Played', available: false, daysUntilAvailable: 12 },
          ],
        });
      }
      if (url.includes('/pick-disposition/')) return ok({ disposition: null });
      if (url.includes('/queue/')) return ok({ queue: [] });
      return ok({});
    }
    return ok(onWrite ? onWrite(url, init!) : {});
  });
}

function renderPanel() {
  return render(
    <ToastProvider>
      <AdminPickOnBehalf roomId={ROOM} tournaments={[{ id: TOURNAMENT, name: 'Weekly Grind' }]} />
    </ToastProvider>,
  );
}

describe('AdminPickOnBehalf', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts { forUserId, gameName } to the room+tournament scoped admin queue endpoint', async () => {
    const fetchMock = makeFetchMock(() => ({
      game: { id: 'g-1', name: 'Medieval Madness' },
      tournament: { id: TOURNAMENT, name: 'Weekly Grind' },
      queue: [{ id: 'g-1', name: 'Medieval Madness', queue_order: 1, tournament_id: TOURNAMENT }],
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();

    // Pick the player first — the queue controls only exist for a chosen player.
    await waitFor(() => expect(screen.getByText('AbsentAl')).toBeInTheDocument());
    fireEvent.click(screen.getByText('AbsentAl'));

    await waitFor(() => expect(screen.getByText('Medieval Madness')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Medieval Madness'));

    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        c => ((c[1] as RequestInit)?.method ?? '').toUpperCase() === 'POST',
      );
      expect(post).toBeDefined();
      expect(String(post![0])).toBe(`/api/rooms/${ROOM}/admin/tournaments/${TOURNAMENT}/queue`);
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        forUserId: PLAYER,
        gameName: 'Medieval Madness',
      });
    });
  });

  it('renders the queue the server returned', async () => {
    vi.stubGlobal('fetch', makeFetchMock(() => ({
      game: { id: 'g-1', name: 'Medieval Madness' },
      tournament: { id: TOURNAMENT, name: 'Weekly Grind' },
      queue: [
        { id: 'g-1', name: 'Medieval Madness', queue_order: 1, tournament_id: TOURNAMENT },
        { id: 'g-2', name: 'Server Added Table', queue_order: 2, tournament_id: TOURNAMENT },
      ],
    })));

    renderPanel();
    await waitFor(() => expect(screen.getByText('AbsentAl')).toBeInTheDocument());
    fireEvent.click(screen.getByText('AbsentAl'));
    await waitFor(() => expect(screen.getByText('Medieval Madness')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Medieval Madness'));

    // The second row came from the response only — proof the list is the
    // server's, not a local push of what was clicked.
    await waitFor(() => {
      const queue = screen.getByTestId('on-behalf-queue');
      expect(queue.textContent).toContain('Medieval Madness');
      expect(queue.textContent).toContain('Server Added Table');
    });
  });

  it('surfaces the server rejection instead of pretending the pick landed', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method === 'GET') return makeFetchMock()(url, init);
      return Promise.resolve({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: '"Recently Played" is in cooldown for 12 more days', code: 'COOLDOWN' }),
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();
    await waitFor(() => expect(screen.getByText('AbsentAl')).toBeInTheDocument());
    fireEvent.click(screen.getByText('AbsentAl'));
    await waitFor(() => expect(screen.getByText('Recently Played')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Recently Played'));

    await waitFor(() => {
      expect(screen.getByText(/is in cooldown for 12 more days/)).toBeInTheDocument();
      expect(screen.queryByTestId('on-behalf-queue')).not.toBeInTheDocument();
    });
  });

  it('shows the cooldown label the availability payload carries', async () => {
    vi.stubGlobal('fetch', makeFetchMock());
    renderPanel();
    await waitFor(() => expect(screen.getByText('AbsentAl')).toBeInTheDocument());
    fireEvent.click(screen.getByText('AbsentAl'));
    await waitFor(() => expect(screen.getByText('cooldown 12d')).toBeInTheDocument());
  });
});
