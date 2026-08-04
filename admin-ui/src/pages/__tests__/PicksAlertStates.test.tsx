import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Picks from '../Picks';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

/**
 * v2.77.0 — badge/page agreement on the Picks page.
 *
 * The nav badge counts three states (pending placeholder / empty queue /
 * ineligible head-of-queue) but the page only ever rendered the first. A
 * player with an empty queue in two gated tournaments got a count-2 badge and
 * a page with nothing on it — a number they could not clear.
 *
 * The page now reads the SAME `/pick-alerts` endpoint the badge reads, so
 * every counted state has something to look at. These tests lock that: an
 * `emptyQueue` entry must produce a banner naming the tournament, and an
 * `ineligible` entry must mark the queued row it refers to.
 *
 * jsdom resolves no media queries, so the mobile/desktop split introduced in
 * the same release is covered by the 390px/1280px screenshot pass instead.
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
  games: [
    { name: 'Attack from Mars', available: true, daysUntilAvailable: 0, lastPlayedDate: null, lastEndDate: null, lastStatus: null, winnerName: null, winnerScore: null, allTimeHigh: null, allTimeHighPlayer: null },
    { name: 'Medieval Madness', available: true, daysUntilAvailable: 0, lastPlayedDate: null, lastEndDate: null, lastStatus: null, winnerName: null, winnerScore: null, allTimeHigh: null, allTimeHighPlayer: null },
  ],
};

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
];

/**
 * @param slug        unique per test — usePickAwardEnabled and getPortal both
 *                    memoize per slug in module-level caches that outlive a
 *                    single test.
 * @param pickStatus  the /pick-status payload
 * @param alerts      the /pick-alerts payload
 */
function stubFetch(slug: string, pickStatus: object, alerts: object | null) {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      return j({ id: ROOM_ID, roomId: ROOM_ID, slug, name: 'RTX Pinball', pick_award_enabled: true });
    }
    if (url.includes('/pick-alerts')) {
      if (!alerts) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      return j(alerts);
    }
    if (url.includes('/pick-status')) return j(pickStatus);
    if (url.includes('/game-availability')) return j(AVAILABILITY);
    if (url.includes('/tournaments')) return j(TOURNAMENTS);
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPicks(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/${slug}/picks`]}>
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

const EMPTY_STATUS = { pendingPicks: [], queuedGames: [], tournaments: TOURNAMENTS, pickAwardEnabled: true };

describe('Picks page — renders every badge state', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders a soft banner per emptyQueue alert, naming the tournament', async () => {
    signIn();
    stubFetch('eq_room', EMPTY_STATUS, {
      pendingPickCount: 0,
      emptyQueue: [
        { tournamentId: 't-1', tournamentName: 'Daily Grind' },
        { tournamentId: 't-2', tournamentName: 'Weekly Grind' },
      ],
      ineligible: [],
      count: 2,
      urgent: false,
    });

    renderPicks('eq_room');

    const banner = await screen.findByTestId('picks-empty-queue-banner');
    expect(banner).toHaveTextContent('Nothing queued for');
    expect(banner).toHaveTextContent('Daily Grind');
    expect(banner).toHaveTextContent('Weekly Grind');
    expect(banner).toHaveTextContent('line up your next pick');
  });

  it('renders no banner when the server reports nothing to do', async () => {
    signIn();
    stubFetch('eq_clear_room', EMPTY_STATUS, {
      pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false,
    });

    renderPicks('eq_clear_room');

    await screen.findByText('Picks');
    await waitFor(() => {
      expect(screen.queryByTestId('picks-empty-queue-banner')).not.toBeInTheDocument();
    });
  });

  it('marks the queued row an ineligible alert refers to with a cooldown chip', async () => {
    signIn();
    stubFetch(
      'inelig_room',
      {
        ...EMPTY_STATUS,
        queuedGames: [
          { id: 'q-1', game_name: 'Repeat Game', tournament_id: 't-1', tournament_name: 'Daily Grind', queue_order: 1 },
          { id: 'q-2', game_name: 'Fresh Game', tournament_id: 't-1', tournament_name: 'Daily Grind', queue_order: 2 },
        ],
      },
      {
        pendingPickCount: 0,
        emptyQueue: [],
        ineligible: [{ tournamentId: 't-1', tournamentName: 'Daily Grind', gameId: 'q-1', gameName: 'Repeat Game', reason: 'cooldown' }],
        count: 1,
        urgent: false,
      },
    );

    renderPicks('inelig_room');

    const chip = await screen.findByTestId('picks-cooldown-chip-q-1');
    expect(chip).toHaveTextContent('On cooldown');
    // The healthy row behind it stays unmarked — the server only ever flags
    // the head of the queue, and a blanket marker would be noise.
    expect(screen.queryByTestId('picks-cooldown-chip-q-2')).not.toBeInTheDocument();
  });

  it('leaves queued rows unmarked when nothing is ineligible', async () => {
    signIn();
    stubFetch(
      'healthy_room',
      {
        ...EMPTY_STATUS,
        queuedGames: [
          { id: 'q-1', game_name: 'Fresh Game', tournament_id: 't-1', tournament_name: 'Daily Grind', queue_order: 1 },
        ],
      },
      { pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false },
    );

    renderPicks('healthy_room');

    await screen.findByText('Fresh Game');
    expect(screen.queryByTestId('picks-cooldown-chip-q-1')).not.toBeInTheDocument();
  });

  it('degrades quietly when the alerts probe fails — the page still renders', async () => {
    signIn();
    stubFetch('alerts_fail_room', EMPTY_STATUS, null);

    renderPicks('alerts_fail_room');

    await screen.findByText('Picks');
    expect(screen.queryByTestId('picks-empty-queue-banner')).not.toBeInTheDocument();
  });

  it('never probes /pick-alerts for a guest', async () => {
    // No signIn() — no player token.
    const fetchMock = stubFetch('guest_room', EMPTY_STATUS, {
      pendingPickCount: 0, emptyQueue: [{ tournamentId: 't-1', tournamentName: 'Daily Grind' }], ineligible: [], count: 1, urgent: false,
    });

    renderPicks('guest_room');

    await screen.findByText('Picks');
    await waitFor(() => {
      expect(screen.queryByTestId('picks-empty-queue-banner')).not.toBeInTheDocument();
    });
    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('/pick-alerts'))).toBe(false);
  });
});
