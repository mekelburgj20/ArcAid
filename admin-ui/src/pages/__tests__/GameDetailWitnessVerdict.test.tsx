import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import GameDetail from '../GameDetail';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import { FLAGGED_TITLE, NOT_COUNTED_LABEL } from '../../components/WitnessBadge';

/**
 * v2.190.0 (W22) — the game page of an EVENT ROUND carries the witness verdict.
 *
 * WWS test event, 2026-10-23: a geared-up score the event page left out still
 * headed the game page with no mark. The server now derives an event round's
 * rows from the round board (ranked as the standings rank them, a `witness` per
 * row, `notCounted` per game); this pins what the page draws from that.
 */

const verified = { status: 'verified', method: 'session', launchTs: 1, exitTs: 2, durationSec: 240, table: 'mm_109c', via: 'live', checkinTs: null, sample: null };
const flagged = { ...verified, status: 'flagged' };

const PREVENT_BOARD = {
  gameId: 'round-1', gameName: 'Medieval Madness', tournamentName: 'WWS Night',
  imageUrl: null, gameStatus: 'ACTIVE', globalGameId: null,
  rankings: [
    { rank: 1, discord_user_id: 'disc-bee', iscored_username: 'Bee', score: 700, history_id: 103, source: 'vpx', submitted_by_user_id: 'disc-bee', witness: verified },
    { rank: 2, discord_user_id: 'disc-tom', iscored_username: 'TomatoGrass', score: 500, history_id: 102, source: 'vpx', submitted_by_user_id: 'disc-tom', witness: verified },
  ],
  notCounted: [
    { discord_user_id: 'disc-tom', iscored_username: 'TomatoGrass', score: 54692760, history_id: 101, source: 'vpx', submitted_by_user_id: 'disc-tom', witness: flagged },
  ],
  witnessFlagMode: 'prevent',
  witnessByHistoryId: { '101': flagged, '102': verified, '103': verified },
};

const FLAG_BOARD = {
  ...PREVENT_BOARD,
  rankings: [
    { rank: 1, discord_user_id: 'disc-tom', iscored_username: 'TomatoGrass', score: 54692760, history_id: 101, source: 'vpx', submitted_by_user_id: 'disc-tom', witness: flagged },
    { rank: 2, discord_user_id: 'disc-bee', iscored_username: 'Bee', score: 700, history_id: 103, source: 'vpx', submitted_by_user_id: 'disc-bee', witness: verified },
  ],
  notCounted: [],
  witnessFlagMode: 'flag',
};

const TOMATO_HISTORY = [
  { id: 101, iscored_username: 'TomatoGrass', score: 54692760, source: 'vpx', created_at: '2026-10-23 20:10:00', tournament_id: 't-1', tournament_name: 'WWS Night', tournament_active: 1 },
  { id: 102, iscored_username: 'TomatoGrass', score: 500, source: 'vpx', created_at: '2026-10-23 20:20:00', tournament_id: 't-1', tournament_name: 'WWS Night', tournament_active: 1 },
];

function stubFetch(board: typeof PREVENT_BOARD | typeof FLAG_BOARD & { tournamentId?: string }) {
  const fetchMock = vi.fn((url: string) => {
    if (url.includes('/integrity')) {
      // v2.191.0 (W53): the quit map, keyed by score_history id.
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ mode: 'open', verdicts: {}, quits: { '102': { ball: 2 } } }) });
    }
    if (/\/leaderboard\/round-1(\?|$)/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ...board, distinctEngines: [] }) });
    }
    if (url.endsWith('/leaderboard')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([board]) });
    }
    if (url.includes('/score-counts')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ tomatograss: 2, bee: 1 }) });
    }
    if (url.includes('/score-history/') && url.includes('/player/')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(TOMATO_HISTORY) });
    }
    if (/\/stats\/game\/[^/]+$/.test(url)) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve({
        gameName: 'Medieval Madness', timesPlayed: 1, avgScore: 600, uniquePlayers: 2,
        allTimeHigh: 700, allTimeHighPlayer: 'Bee', recentResults: [],
      }) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/wws/games/Medieval%20Madness']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'wws', roomName: 'WWS' }}>
            <Routes>
              <Route path="/:slug/games/:name" element={<GameDetail />} />
            </Routes>
          </RoomContext.Provider>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('GameDetail — witness verdicts on an event round', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('prevent: ranks the counted rows and lists the geared-up score as Not counted, struck through', async () => {
    stubFetch(PREVENT_BOARD);
    renderPage();

    const block = await screen.findByTestId('not-counted');
    expect(within(block).getByText(NOT_COUNTED_LABEL)).toBeInTheDocument();
    const struck = within(block).getByText('54,692,760');
    expect(struck.className).toMatch(/line-through/);
    expect(within(block).getByText('TomatoGrass')).toBeInTheDocument();

    // The ranked rows carry the verified check; nothing ranked is flagged.
    expect(screen.queryByTitle(FLAGGED_TITLE)).not.toBeInTheDocument();
    expect(screen.getAllByTitle(/Witnessed: launched inside the round window/).length).toBe(2);
    // The geared-up score is not in the ranked list — only in the block.
    expect(screen.getAllByText('54,692,760')).toHaveLength(1);
  });

  it('prevent: the history expand marks the flagged score from the verdict map', async () => {
    stubFetch(PREVENT_BOARD);
    renderPage();

    await screen.findByTestId('not-counted');
    // TomatoGrass has two scores → the row expands.
    const rows = await screen.findAllByRole('button', { expanded: false });
    const tomatoRow = rows.find(r => within(r).queryByText('500'))!;
    fireEvent.click(tomatoRow);

    await waitFor(() => expect(screen.getByTitle(FLAGGED_TITLE)).toBeInTheDocument());
  });

  it('W53: the history-expand rows carry the quit chip from the integrity quit map', async () => {
    stubFetch({ ...PREVENT_BOARD, tournamentId: 't-1' });
    renderPage();

    await screen.findByTestId('not-counted');
    const rows = await screen.findAllByRole('button', { expanded: false });
    fireEvent.click(rows.find(r => within(r).queryByText('500'))!);

    await waitFor(() => expect(screen.getByTestId('quit-chip')).toHaveTextContent('Quit on ball 2'));
  });

  it('flag: the flagged score ranks and wears the warning badge', async () => {
    stubFetch(FLAG_BOARD);
    renderPage();

    await waitFor(() => expect(screen.getByTitle(FLAGGED_TITLE)).toBeInTheDocument());
    expect(screen.queryByTestId('not-counted')).not.toBeInTheDocument();
  });
});
