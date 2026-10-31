import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Picks from '../Picks';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

/**
 * C2 - the Picks page "I own" filter and the per-row ownership markers.
 *
 * The chip exists only for a logged-in viewer (the inventory is private), it
 * counts the LISTED games the viewer owns, and pressing it narrows the list to
 * them. Every row also carries the public "N own" count from the
 * availability payload's `owner_count`. jsdom renders both the desktop row
 * and the mobile card, so counts here are per-twin aware.
 */

const ROOM_ID = 'room-1';

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signIn(discordId = '123456789012345678') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${b64url({ alg: 'none' })}.${b64url({ discordId, username: 'Tester', avatar: null, exp })}.sig`;
  localStorage.setItem('arcaid_player_token', jwt);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

const base = {
  available: true, daysUntilAvailable: 0, lastPlayedDate: null, lastEndDate: null, lastStatus: null,
  winnerName: null, winnerScore: null, allTimeHigh: null, allTimeHighPlayer: null,
  platforms: ['vpx'], features: [], room_tags: [], image_url: null,
};

const AVAILABILITY = {
  tournament: { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball' },
  eligibilityDays: 120,
  games: [
    { ...base, name: 'Attack from Mars', manufacturer: 'Bally', year: 1995, global_game_id: 'gg-afm', owner_count: 3 },
    { ...base, name: 'Medieval Madness', manufacturer: 'Williams', year: 1997, global_game_id: 'gg-mm', owner_count: 0 },
    { ...base, name: 'Twilight Zone', manufacturer: 'Bally', year: 1993, global_game_id: 'gg-tz', owner_count: 1 },
  ],
};

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
];

function stubFetch(slug: string, ownedIds: string[]) {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      return j({ id: ROOM_ID, roomId: ROOM_ID, slug, name: 'RTX Pinball', pick_award_enabled: true });
    }
    if (url === '/api/me/tables') {
      return j({ tables: ownedIds.map(id => ({ global_game_id: id, name: id, platforms: [], catalogue_platforms: [] })) });
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
      .map(h => decodeURIComponent(h.split('/games/')[1]!)),
  )];
}

describe('Picks page - "I own" filter (C2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('has no "I own" chip for a guest, but still shows the public owner count', async () => {
    const fetchMock = stubFetch('owned_guest_room', []);
    renderPicks('owned_guest_room');

    await screen.findAllByText('Attack from Mars');
    expect(screen.queryByTestId('picks-owned-filter')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(c => c[0] === '/api/me/tables')).toBe(false);
    // "3 own" on AFM (desktop + mobile twin); no chip for the 0-owner game.
    expect(screen.getAllByText('3 own').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('3 registered players own this table').length).toBeGreaterThan(0);
    expect(screen.getAllByTitle('1 registered player owns this table').length).toBeGreaterThan(0);
    expect(screen.queryByText('0 own')).not.toBeInTheDocument();
  });

  it('counts the owned games, marks them, and narrows the list when pressed', async () => {
    signIn();
    stubFetch('owned_room', ['gg-afm', 'gg-tz', 'gg-not-in-this-list']);
    renderPicks('owned_room');

    const chip = await screen.findByTestId('picks-owned-filter');
    // Only LISTED games count - the third owned id is not in this tournament.
    await waitFor(() => expect(chip.textContent).toBe('I own2'));
    expect(screen.getAllByText('Owned').length).toBeGreaterThan(0);
    expect(listedGames().sort()).toEqual(['Attack from Mars', 'Medieval Madness', 'Twilight Zone']);

    fireEvent.click(chip);
    await waitFor(() => expect(listedGames().sort()).toEqual(['Attack from Mars', 'Twilight Zone']));
    expect(chip).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(chip);
    await waitFor(() => expect(listedGames().length).toBe(3));
  });

  it('points an empty inventory at My Tables', async () => {
    signIn();
    stubFetch('owned_empty_room', []);
    renderPicks('owned_empty_room');

    const chip = await screen.findByTestId('picks-owned-filter');
    expect(chip).toHaveAttribute('title', 'Add tables at Account -> My Tables');
    expect(screen.getByRole('link', { name: 'Add my tables ->' })).toHaveAttribute('href', '/account/tables');
  });
});
