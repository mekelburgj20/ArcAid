import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Picks from '../Picks';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

/**
 * v2.84.0 — Picks list filtering: engine pills, chips, multi-field search.
 *
 * The endpoint now ships catalogue metadata (`manufacturer`, `year`,
 * `platforms`, `features`, `room_tags`) on every availability row, and the page
 * filters entirely client-side over it. These lock the three behaviours a
 * player actually notices: the pill row only exists when there's a choice to
 * make, search reaches past the title, and the three filters compose.
 *
 * jsdom resolves no media queries, so BOTH the desktop row and the mobile card
 * render — every assertion here uses `getAllBy*`/`queryAllBy*` accordingly.
 */

const ROOM_ID = 'room-1';

const AVAILABILITY = {
  tournament: { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball' },
  eligibilityDays: 120,
  games: [
    {
      name: 'Attack from Mars', available: true, daysUntilAvailable: 0,
      lastPlayedDate: null, lastEndDate: null, lastStatus: null,
      winnerName: null, winnerScore: null, allTimeHigh: null, allTimeHighPlayer: null,
      manufacturer: 'Bally', year: 1995, platforms: ['vpx'], features: ['vpxs'], room_tags: [],
      global_game_id: 'gg-afm', image_url: '/api/catalogue-images/afm.png',
    },
    {
      name: 'Sorcerers Lair', available: true, daysUntilAvailable: 0,
      lastPlayedDate: null, lastEndDate: null, lastStatus: null,
      winnerName: null, winnerScore: null, allTimeHigh: null, allTimeHighPlayer: null,
      manufacturer: 'Zen Studios', year: 2012, platforms: ['fx'], features: [], room_tags: ['house rules'],
      global_game_id: 'gg-sl', image_url: null,
    },
    {
      name: 'Medieval Madness', available: false, daysUntilAvailable: 12,
      lastPlayedDate: '2026-08-01T00:00:00.000Z', lastEndDate: null, lastStatus: 'COMPLETED',
      winnerName: 'Krobs', winnerScore: 100, allTimeHigh: 100, allTimeHighPlayer: 'Krobs',
      manufacturer: 'Williams', year: 1997, platforms: ['vpx'], features: [], room_tags: [],
      global_game_id: 'gg-mm', image_url: null,
    },
  ],
};

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
];

/** @param slug unique per test — getPortal/usePickAwardEnabled memoize per slug across tests. */
function stubFetch(slug: string, availability: object = AVAILABILITY) {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      return j({ id: ROOM_ID, roomId: ROOM_ID, slug, name: 'RTX Pinball', pick_award_enabled: true });
    }
    if (url.startsWith('/api/global/games/')) {
      return j({ manufacturer: 'Bally', year: 1995, platforms: ['vpx'] });
    }
    if (url.includes('/pick-alerts')) return j({ pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false });
    if (url.includes('/pick-status')) return j({ pendingPicks: [], queuedGames: [], tournaments: TOURNAMENTS });
    if (url.includes('/game-availability')) return j(availability);
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

/** Game names currently in the list, deduped across the desktop/mobile twins. */
function listedGames(): string[] {
  return [...new Set(
    screen.queryAllByRole('link')
      .map(a => a.getAttribute('href') ?? '')
      .filter(h => h.includes('/games/'))
      .map(h => decodeURIComponent(h.split('/games/')[1]!)),
  )];
}

describe('Picks page — engine pills, chips and multi-field search', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders engine + room-tag chips and a manufacturer · year line per game', async () => {
    stubFetch('chips_room');
    renderPicks('chips_room');

    await screen.findAllByText('Attack from Mars');
    // Engine chips fold to the provenance vocabulary: `vpx` → "VPX", `fx` → "FX".
    expect(screen.queryAllByText('VPX').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('FX').length).toBeGreaterThan(0);
    // Room tags render too, but on Picks they join the ONE chip family — the
    // amber "Room-only tag" treatment is admin plumbing and stays on the admin
    // Game Library page (owner decision, v2.84.0).
    expect(screen.queryAllByText(/HOUSE RULES/i).length).toBeGreaterThan(0);
    expect(screen.queryAllByTitle('Room-only tag')).toHaveLength(0);
    expect(screen.queryAllByText('Bally · 1995').length).toBeGreaterThan(0);
  });

  it('labels the cooldown number so the bare duration is not a mystery', async () => {
    stubFetch('cooldown_room');
    renderPicks('cooldown_room');

    await screen.findAllByText('Medieval Madness');
    // Desktop status cell + mobile card twin both carry the caption.
    expect(screen.queryAllByText('12d').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('cooldown').length).toBeGreaterThan(0);
  });

  it('shows one pill per distinct engine and filters the list to it', async () => {
    stubFetch('pills_room');
    renderPicks('pills_room');

    const pills = await screen.findByTestId('picks-engine-pills');
    const all = within_(pills, 'All');
    expect(all).toHaveAttribute('aria-pressed', 'true');
    expect(listedGames().sort()).toEqual(['Attack from Mars', 'Medieval Madness', 'Sorcerers Lair']);

    fireEvent.click(within_(pills, 'FX'));
    await waitFor(() => expect(listedGames()).toEqual(['Sorcerers Lair']));
    expect(within_(pills, 'FX')).toHaveAttribute('aria-pressed', 'true');

    // Clicking the active pill clears back to All.
    fireEvent.click(within_(pills, 'FX'));
    await waitFor(() => expect(listedGames().length).toBe(3));
  });

  it('hides the pill row when every game shares one engine', async () => {
    stubFetch('one_engine_room', {
      ...AVAILABILITY,
      games: AVAILABILITY.games.filter(g => g.platforms[0] === 'vpx'),
    });
    renderPicks('one_engine_room');

    await screen.findAllByText('Attack from Mars');
    expect(screen.queryByTestId('picks-engine-pills')).not.toBeInTheDocument();
  });

  it('searches manufacturer, year and chip labels — not just the title', async () => {
    stubFetch('search_room');
    renderPicks('search_room');

    await screen.findAllByText('Attack from Mars');
    const input = screen.getByLabelText('Search games');

    fireEvent.change(input, { target: { value: 'williams' } });
    await waitFor(() => expect(listedGames()).toEqual(['Medieval Madness']));

    fireEvent.change(input, { target: { value: '2012' } });
    await waitFor(() => expect(listedGames()).toEqual(['Sorcerers Lair']));

    fireEvent.change(input, { target: { value: 'house rules' } });
    await waitFor(() => expect(listedGames()).toEqual(['Sorcerers Lair']));

    fireEvent.change(input, { target: { value: 'mars' } });
    await waitFor(() => expect(listedGames()).toEqual(['Attack from Mars']));
  });

  it('ANDs the availability cards, the engine pill and the search box', async () => {
    stubFetch('compose_room');
    renderPicks('compose_room');

    const pills = await screen.findByTestId('picks-engine-pills');
    // VPX has two games, one of which is on cooldown.
    fireEvent.click(within_(pills, 'VPX'));
    await waitFor(() => expect(listedGames().sort()).toEqual(['Attack from Mars', 'Medieval Madness']));

    fireEvent.click(availabilityCard('Available'));
    await waitFor(() => expect(listedGames()).toEqual(['Attack from Mars']));

    fireEvent.change(screen.getByLabelText('Search games'), { target: { value: 'williams' } });
    await waitFor(() => expect(listedGames()).toEqual([]));
    expect(screen.getByText('No games match your filters.')).toBeInTheDocument();
  });

  it('opens the quick-view popup on a title click instead of navigating away', async () => {
    stubFetch('quickview_room');
    renderPicks('quickview_room');

    const titles = await screen.findAllByText('Attack from Mars');
    fireEvent.click(titles[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAccessibleName('Attack from Mars preview');
    // The list is still mounted behind the popup — nothing navigated, so the
    // player's scroll position and active filters are untouched.
    expect(screen.queryAllByText('Medieval Madness').length).toBeGreaterThan(0);
    // Full detail is still one click away from inside the popup.
    expect(within(dialog).getByText('View full info').closest('a'))
      .toHaveAttribute('href', '/quickview_room/games/Attack%20from%20Mars');

    fireEvent.click(within(dialog).getByLabelText('Close'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the all-time high as one stat, not a leaderboard', async () => {
    stubFetch('stat_room');
    renderPicks('stat_room');

    const titles = await screen.findAllByText('Medieval Madness');
    fireEvent.click(titles[0]!);

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('All-Time High')).toBeInTheDocument();
    expect(within(dialog).getByText('100')).toBeInTheDocument();
    expect(within(dialog).getByText('Krobs')).toBeInTheDocument();
  });

  it('says nothing about scores for a game that has none', async () => {
    stubFetch('nostat_room');
    renderPicks('nostat_room');

    // Attack from Mars has allTimeHigh: null.
    const titles = await screen.findAllByText('Attack from Mars');
    fireEvent.click(titles[0]!);

    const dialog = await screen.findByRole('dialog');
    // Neither the leaderboard's empty-state copy nor an orphan stat label.
    expect(within(dialog).queryByText('No scores yet')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('All-Time High')).not.toBeInTheDocument();
    // The popup still does its job: it names the game and shows its identity.
    expect(dialog).toHaveAccessibleName('Attack from Mars preview');
    expect(await within(dialog).findByText(/Bally/)).toBeInTheDocument();
  });

  it('leaves ctrl-click on a title as a real navigation', async () => {
    stubFetch('ctrl_room');
    renderPicks('ctrl_room');

    const titles = await screen.findAllByText('Attack from Mars');
    fireEvent.click(titles[0]!, { ctrlKey: true });

    // Modifier clicks fall through to the <Link> so "open in new tab" works.
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('shows the match count only while a filter is narrowing the list', async () => {
    stubFetch('count_room');
    renderPicks('count_room');

    await screen.findAllByText('Attack from Mars');
    expect(screen.queryByText(/of 3 games/)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Search games'), { target: { value: 'mars' } });
    expect(await screen.findByText('1 of 3 games')).toBeInTheDocument();
  });
});

/** The availability count card (a button whose label leads its text, e.g. "Available3"). */
function availabilityCard(label: string): HTMLElement {
  const hit = screen.getAllByRole('button').find(b => (b.textContent ?? '').trim().startsWith(label));
  if (!hit) throw new Error(`No availability card labelled "${label}"`);
  return hit as HTMLElement;
}

/** The one pill/button inside `scope` whose visible label is exactly `label`. */
function within_(scope: HTMLElement, label: string): HTMLElement {
  const hit = [...scope.querySelectorAll('button')].find(b => b.textContent?.trim() === label);
  if (!hit) throw new Error(`No pill labelled "${label}"`);
  return hit as HTMLElement;
}
