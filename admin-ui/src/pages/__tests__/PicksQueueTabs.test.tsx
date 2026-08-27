import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';
import Picks from '../Picks';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

/**
 * Picks-queue UX redesign (owner ruling 2026-08-27), F1 selector + F2 tabs +
 * F3 reorder scoping.
 *
 * Pre-redesign, "Your Picks" was one interleaved list across every tournament
 * the player had queued something in, with a single shared numbering that
 * meant nothing (`queue_order` is per-(tournament, player)). These tests lock
 * the per-tournament tab split and confirm a reorder can never leak another
 * tournament's ids into the PUT payload.
 */

const ROOM_ID = 'room-1';

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signIn(discordId = '123', username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

const AVAILABILITY = {
  tournament: { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball' },
  eligibilityDays: 120,
  games: [],
};

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
  { id: 't-2', name: 'Weekly Grind', type: 'WG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
];

const PICK_STATUS_TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', max_active_games: 1, platform_rules: '{}', nextRotationAt: '2026-09-01T22:00:00.000Z' },
  { id: 't-2', name: 'Weekly Grind', type: 'WG', mode: 'pinball', max_active_games: 1, platform_rules: '{}', nextRotationAt: null },
];

const PICK_STATUS = {
  pendingPicks: [],
  queuedGames: [
    { id: 'dg-2', game_name: 'DG Second', tournament_id: 't-1', tournament_name: 'Daily Grind', queue_order: 1 },
    { id: 'dg-1', game_name: 'DG First', tournament_id: 't-1', tournament_name: 'Daily Grind', queue_order: 2 },
    { id: 'wg-1', game_name: 'WG Only', tournament_id: 't-2', tournament_name: 'Weekly Grind', queue_order: 1 },
  ],
  tournaments: PICK_STATUS_TOURNAMENTS,
  queueMax: 30,
};

const ALERTS = { pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false };

function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      return j({ id: ROOM_ID, roomId: ROOM_ID, slug: 'tabs_room', name: 'RTX Pinball', pick_award_enabled: true });
    }
    if (url.includes('/pick-alerts')) return j(ALERTS);
    if (url.includes('/pick-status')) return j(PICK_STATUS);
    if (url.includes('/game-availability')) return j(AVAILABILITY);
    if (url.includes('/queue/reorder')) return j({ success: true });
    if (url.includes('/tournaments')) return j(TOURNAMENTS);
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPicks() {
  return render(
    <MemoryRouter initialEntries={['/tabs_room/picks']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <Routes>
            <Route path="/:slug/picks" element={<Picks />} />
          </Routes>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('Picks — F1 tournament selector', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('shows the selected tournament name in the selector', async () => {
    signIn();
    stubFetch();
    renderPicks();

    const selector = await screen.findByTestId('picks-tournament-selector');
    // Defaults to the first active tournament (Daily Grind).
    expect(within(selector).getByTestId('picks-tournament-selector-name')).toHaveTextContent('Daily Grind');
  });
});

describe('Picks — F2 per-tournament queue tabs', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('renders one tab per tournament with queued picks, plus All', async () => {
    signIn();
    stubFetch();
    renderPicks();

    const tabs = await screen.findByTestId('picks-queue-tabs');
    expect(within(tabs).getByTestId('picks-queue-tab-all')).toHaveTextContent('All');
    expect(within(tabs).getByTestId('picks-queue-tab-all')).toHaveTextContent('3');
    expect(within(tabs).getByTestId('picks-queue-tab-t-1')).toHaveTextContent('Daily Grind');
    expect(within(tabs).getByTestId('picks-queue-tab-t-1')).toHaveTextContent('2');
    expect(within(tabs).getByTestId('picks-queue-tab-t-2')).toHaveTextContent('Weekly Grind');
    expect(within(tabs).getByTestId('picks-queue-tab-t-2')).toHaveTextContent('1');
  });

  it('defaults to the selected tournament\'s tab and clicking a tab only changes the queue view', async () => {
    signIn();
    stubFetch();
    renderPicks();

    // Default: selectedTournamentId is Daily Grind (t-1), which has picks,
    // so its tab is active on load — its rows render. The tab-sync effect
    // fires only after the tournaments fetch resolves, and the transient
    // 'All' view also renders these names, so wait for the SYNCED state
    // (WG Only filtered out) rather than the first paint of a row name.
    await screen.findByText('DG Second');
    await screen.findByText('DG First');
    await waitFor(() => expect(screen.queryByText('WG Only')).not.toBeInTheDocument());

    fireEvent.click(screen.getByTestId('picks-queue-tab-t-2'));

    // Clicking a tab swaps the visible queue rows...
    await screen.findByText('WG Only');
    expect(screen.queryByText('DG Second')).not.toBeInTheDocument();

    // ...but never touches the page's selected tournament (the F1 selector
    // still names Daily Grind, and the game list wasn't re-fetched for t-2).
    const selector = screen.getByTestId('picks-tournament-selector');
    expect(within(selector).getByTestId('picks-tournament-selector-name')).toHaveTextContent('Daily Grind');
  });

  it('the All tab is read-only: no move/top controls, grouped by tournament', async () => {
    signIn();
    stubFetch();
    renderPicks();

    await screen.findByText('DG Second');
    fireEvent.click(screen.getByTestId('picks-queue-tab-all'));

    const allView = await screen.findByTestId('picks-queue-all-view');
    expect(within(allView).getByText('DG Second')).toBeInTheDocument();
    expect(within(allView).getByText('WG Only')).toBeInTheDocument();
    expect(within(allView).queryByTitle('Move up')).not.toBeInTheDocument();
    expect(within(allView).queryByTitle('Send to top')).not.toBeInTheDocument();
    expect(within(allView).queryByTestId('picks-queue-grip-dg-2')).not.toBeInTheDocument();
  });
});

describe('Picks — F3 reorder payload scoping', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('a reorder PUT never includes another tournament\'s ids', async () => {
    signIn();
    const fetchMock = stubFetch();
    renderPicks();

    // Active tab defaults to Daily Grind (t-1): DG Second (pos 1), DG First
    // (pos 2). Move DG First up — this must PUT only t-1's two ids.
    //
    // Wait for the tab SYNC, not just a row name: before the tournaments
    // fetch resolves the section shows the read-only 'All' view, which
    // renders 'DG First' with no move buttons (the exact flake that failed
    // this test's first run).
    await screen.findByText('DG First');
    await waitFor(() => expect(screen.queryByText('WG Only')).not.toBeInTheDocument());
    const rows = screen.getAllByTitle('Move up');
    // The first row's "Move up" is disabled (index 0); click the second's.
    fireEvent.click(rows[1]);

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/queue/reorder'));
      expect(putCall).toBeDefined();
      const body = JSON.parse(String((putCall![1] as RequestInit).body));
      expect(body.gameIds.sort()).toEqual(['dg-1', 'dg-2'].sort());
      expect(body.gameIds).not.toContain('wg-1');
    });
  });
});
