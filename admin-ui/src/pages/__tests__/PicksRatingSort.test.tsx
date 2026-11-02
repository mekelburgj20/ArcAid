import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Picks from '../Picks';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

/**
 * A14.1 - the Picks page rating column and the "Top rated" sort.
 *
 * Every row carries the availability payload's `avg_rating` / `rating_count`;
 * a rated row shows the compact badge, an unrated one shows none. "Top rated"
 * orders by average, then count, then name, unrated last; "Default" restores
 * the server order. jsdom renders both the desktop row and the mobile card,
 * so badge counts here are per-twin aware.
 */

const ROOM_ID = 'room-1';

const base = {
  available: true, daysUntilAvailable: 0, lastPlayedDate: null, lastEndDate: null, lastStatus: null,
  winnerName: null, winnerScore: null, allTimeHigh: null, allTimeHighPlayer: null,
  platforms: ['vpx'], features: [], room_tags: [], image_url: null, owner_count: 0,
};

const AVAILABILITY = {
  tournament: { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball' },
  eligibilityDays: 120,
  games: [
    { ...base, name: 'Attack from Mars', manufacturer: 'Bally', year: 1995, global_game_id: 'gg-afm', avg_rating: 3.5, rating_count: 2 },
    { ...base, name: 'Black Knight', manufacturer: 'Williams', year: 1980, global_game_id: 'gg-bk', avg_rating: 0, rating_count: 0 },
    { ...base, name: 'Cyclone', manufacturer: 'Williams', year: 1988, global_game_id: 'gg-cy', avg_rating: 4.8, rating_count: 9 },
  ],
};

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
];

function stubFetch(slug: string) {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      return j({ id: ROOM_ID, roomId: ROOM_ID, slug, name: 'RTX Pinball', pick_award_enabled: true });
    }
    if (url.includes('/pick-alerts')) return j({ pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false });
    if (url.includes('/pick-status')) return j({ pendingPicks: [], queuedGames: [], tournaments: TOURNAMENTS });
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

function listedGames(): string[] {
  return [...new Set(
    screen.queryAllByRole('link')
      .map(a => a.getAttribute('href') ?? '')
      .filter(h => h.includes('/games/'))
      // A14.2 - the rating badges link to the same page plus `#ratings`.
      .map(h => decodeURIComponent(h.split('/games/')[1]!.split('#')[0]!)),
  )];
}

describe('Picks page - rating column and "Top rated" sort (A14.1)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('shows a badge on rated rows only', async () => {
    stubFetch('rating_badge_room');
    renderPicks('rating_badge_room');

    await screen.findAllByText('Cyclone');
    // Two rated games, each rendered as a desktop row AND a mobile card.
    const badges = screen.getAllByTestId('rating-badge');
    expect(badges.length).toBe(4);
    expect(screen.getAllByText('4.8').length).toBeGreaterThan(0);
    expect(screen.getAllByText('(9)').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('Average rating 4.8 from 9 players - see the ratings').length).toBe(2);
    // A14.2 - every badge (desktop row and mobile card) links to that game's ratings.
    const hrefs = badges.map(b => b.getAttribute('href'));
    expect(badges.every(b => b.tagName === 'A')).toBe(true);
    expect(hrefs.filter(h => h === '/rating_badge_room/games/Attack%20from%20Mars#ratings').length).toBe(2);
    expect(hrefs.filter(h => h === '/rating_badge_room/games/Cyclone#ratings').length).toBe(2);
    expect(screen.queryByText('0.0')).not.toBeInTheDocument();
  });

  it('reorders by rating and back to the default order', async () => {
    stubFetch('rating_sort_room');
    renderPicks('rating_sort_room');

    await screen.findAllByText('Cyclone');
    expect(listedGames()).toEqual(['Attack from Mars', 'Black Knight', 'Cyclone']);

    const sort = screen.getByTestId('picks-sort');
    const topRated = within(sort).getByRole('button', { name: 'Top rated' });
    const byDefault = within(sort).getByRole('button', { name: 'Default' });
    expect(byDefault).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(topRated);
    await waitFor(() => expect(listedGames()).toEqual(['Cyclone', 'Attack from Mars', 'Black Knight']));
    expect(topRated).toHaveAttribute('aria-pressed', 'true');
    expect(byDefault).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(byDefault);
    await waitFor(() => expect(listedGames()).toEqual(['Attack from Mars', 'Black Knight', 'Cyclone']));
  });
});
