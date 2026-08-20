import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Leaderboard from '../Leaderboard';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * Ranking-card backgrounds (owner-designed 2026-08-09) — the admin card
 * control on the room-admin Leaderboard page for RANKING GROUP cards,
 * mirroring the game-card `AdminControlsStrip` pattern from v2.85.0/v2.86.0
 * (see LeaderboardAdminControls.test.tsx). Covers: the strip renders on the
 * ranking card (not the game card), opens the rail's `CardStyleEditor`, and
 * PUT/DELETEs the correct ranking-groups/:id/style endpoint on apply/clear.
 *
 * v2.119.0 (C2) — the modal `StylePicker` was replaced here by the in-rail
 * editor. A ranking group is the STYLE-ONLY case: its write schema is
 * `{ styleId }` and nothing else, so the editor must offer no Apply-as, no
 * framing and no library default, and its edits must reach the card live
 * before Apply ever fires.
 */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

const ROOM_ID = 'room-1';

const RANKING_GROUPS = [
  {
    group: {
      id: 'group-1',
      name: 'Season Overall',
      description: '',
      rank_method: 'max_10',
      best_n: 25,
      min_games: 1,
      bg_style_id: null,
      bg_has_bg: null,
      tournaments: [{ id: 't1', name: 'Daily Grind', type: 'DG' }],
    },
    rankings: [
      { rank: 1, iscored_username: 'Krobs', total_points: 180, games_played: 2 },
    ],
  },
];

const STYLES = [
  { id: 'style-1', name: 'Neon Wall', author: 'Tester', has_background: 1, has_header: 0, source: 'custom' },
];

function stubFetch(overrides: Partial<{ rankingGroups: unknown; putStyleStatus: number }> = {}) {
  const putCalls: { url: string; body: unknown }[] = [];
  const deleteCalls: string[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const j = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (url.includes('/scoreboard-config')) return j({});
    if (url.includes('/portal')) return j({ id: ROOM_ID, roomId: ROOM_ID, slug: 'test-room', name: 'Test Room', public_theme: null });
    if (url.includes('/rankings')) return j(overrides.rankingGroups ?? RANKING_GROUPS);
    if (url.includes('/leaderboard')) return j([]);
    if (url.includes('/styles')) return j({ styles: STYLES, total: STYLES.length });
    if (init?.method === 'PUT' && url.includes('/ranking-groups/group-1/style')) {
      putCalls.push({ url, body: init.body ? JSON.parse(init.body as string) : null });
      return j({ success: true }, overrides.putStyleStatus ?? 200);
    }
    if (init?.method === 'DELETE' && url.includes('/ranking-groups/group-1/style')) {
      deleteCalls.push(url);
      return j({ success: true });
    }
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { fetchMock, putCalls, deleteCalls };
}

function renderLeaderboard() {
  return render(
    <MemoryRouter initialEntries={[`/test-room/admin/leaderboard`]}>
      <ToastProvider>
        <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: 'test-room', roomName: 'Test Room' }}>
          <Leaderboard />
        </RoomContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Click the ranking card's "Edit card" button and wait for the rail editor. */
async function openRankingEditor() {
  const strip = await screen.findByTestId('ranking-admin-card-controls');
  fireEvent.click(within(strip).getByRole('button', { name: 'Edit card' }));
  return screen.findByTestId('card-style-editor');
}

describe('Leaderboard admin ranking-card Style control', () => {
  it('renders a Style control on the ranking card, separate from any game strip', async () => {
    stubFetch();
    renderLeaderboard();

    const strip = await screen.findByTestId('ranking-admin-card-controls');
    expect(within(strip).getByRole('button', { name: 'Edit card' })).toBeInTheDocument();
    // Only one ranking card in this fixture → exactly one strip.
    expect(screen.getAllByTestId('ranking-admin-card-controls')).toHaveLength(1);
  });

  it('opens the in-rail card editor, style-only', async () => {
    stubFetch();
    renderLeaderboard();

    await openRankingEditor();
    await waitFor(() => expect(screen.getByText('Neon Wall')).toBeInTheDocument());

    // A ranking group has one background slot and nothing else, so none of the
    // game-card affordances may appear.
    expect(screen.queryByText('Apply as')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-framing-controls')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Hide game identifier' })).not.toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Background zoom' })).not.toBeInTheDocument();
  });

  it('sends a PUT with the chosen styleId to /ranking-groups/:id/style', async () => {
    const stub = stubFetch();
    renderLeaderboard();

    await openRankingEditor();
    await waitFor(() => expect(screen.getByText('Neon Wall')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Neon Wall'));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(stub.putCalls).toHaveLength(1));
    expect(stub.putCalls[0]!.url).toContain(`/rooms/${ROOM_ID}/ranking-groups/group-1/style`);
    expect(stub.putCalls[0]!.body).toEqual({ styleId: 'style-1' });
  });

  it('DELETEs the style when Clear style is applied', async () => {
    const stub = stubFetch({
      rankingGroups: [{ ...RANKING_GROUPS[0], group: { ...RANKING_GROUPS[0]!.group, bg_style_id: 'style-1', bg_has_bg: 1 } }],
    });
    renderLeaderboard();

    await openRankingEditor();
    fireEvent.click(screen.getByRole('button', { name: 'Clear style' }));
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(stub.deleteCalls).toHaveLength(1));
    expect(stub.deleteCalls[0]).toContain(`/rooms/${ROOM_ID}/ranking-groups/group-1/style`);
  });

  it('Cancel drops the edit without touching the server', async () => {
    const stub = stubFetch();
    renderLeaderboard();

    await openRankingEditor();
    await waitFor(() => expect(screen.getByText('Neon Wall')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Neon Wall'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByTestId('card-style-editor')).not.toBeInTheDocument());
    expect(stub.putCalls).toHaveLength(0);
    expect(stub.deleteCalls).toHaveLength(0);
  });
});
