import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import PublicHistory from '../PublicHistory';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * Public History list (v2.76 redesign). The owner's field report was that the
 * mobile rendering hid everything useful: the winner and the completion date
 * were `hidden sm:*`, the tournament name ellipsized, and the type tag wrapped.
 *
 * jsdom has no viewport, so `sm:hidden` / `hidden sm:grid` do NOT resolve here —
 * BOTH the mobile list and the desktop grid are in the DOM, each rendering one
 * link per row. That means these tests can only assert PRESENCE of the
 * mobile-line content, not its exclusivity; queries below use `getAllBy*` and
 * index 0 (the mobile list renders first), with the visual side covered by the
 * 390px/1280px screenshot pass instead.
 */

const ROWS = [
  {
    game_id: 'g-1',
    tournament_id: 't-1',
    game_name: 'WHO dunnit',
    tournament_name: 'Daily Grind',
    tournament_type: 'DG',
    start_date: '2026-01-01T00:00:00.000Z',
    end_date: '2026-01-02T00:00:00.000Z',
    winner_name: 'PixelWizard',
    winner_score: 21_000_000,
  },
  {
    game_id: 'g-2',
    tournament_id: null,
    game_name: 'Medieval Madness',
    tournament_name: 'Legacy Tournament',
    tournament_type: 'MG',
    start_date: '2026-01-03T00:00:00.000Z',
    end_date: '2026-01-04T00:00:00.000Z',
    winner_name: null,
    winner_score: null,
  },
];

/**
 * Mirrors the page's own `shortDate`. Asserting a literal ("Jan 2, 2026") would
 * bind the suite to the runner's timezone — an ISO instant at midnight UTC
 * renders as the previous day anywhere west of Greenwich.
 */
const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

function mockFetch(results: unknown[]) {
  const fetchMock = vi.fn(() => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ results, total: results.length, page: 1, limit: 20 }),
  }));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderHistory() {
  return render(
    <MemoryRouter initialEntries={['/test-room/history']}>
      <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'test-room', roomName: 'Test Room' }}>
        <Routes>
          <Route path="/:slug/history" element={<PublicHistory />} />
        </Routes>
      </RoomContext.Provider>
    </MemoryRouter>,
  );
}

describe('PublicHistory', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the winner and the completion date in the mobile row, not only the desktop grid', async () => {
    mockFetch(ROWS);
    renderHistory();

    await waitFor(() => expect(screen.getAllByText('WHO dunnit').length).toBeGreaterThan(0));

    // Index 0 is the mobile list's row. Asserting INSIDE it is what pins the
    // regression — winner and completion date used to be desktop-only.
    const mobile = screen.getAllByRole('link', { name: /Daily Grind — WHO dunnit scores/ })[0]!;
    expect(within(mobile).getByText('PixelWizard')).toBeInTheDocument();
    expect(within(mobile).getByText('21,000,000')).toBeInTheDocument();
    expect(within(mobile).getByText('Daily Grind')).toBeInTheDocument();
    expect(within(mobile).getByText(fmtDate('2026-01-02T00:00:00.000Z'))).toBeInTheDocument();
  });

  it('links each row to its run on the tournament page (B24: ?run=)', async () => {
    mockFetch(ROWS);
    renderHistory();

    await waitFor(() => expect(screen.getAllByText('WHO dunnit').length).toBeGreaterThan(0));

    // Both the mobile row and the desktop row are links to the same board page.
    const links = screen.getAllByRole('link', { name: /Daily Grind — WHO dunnit scores/ });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute('href', '/test-room/tournaments/t-1?run=g-1');
  });

  it('leaves a row with no tournament_id non-interactive rather than linking nowhere', async () => {
    mockFetch(ROWS);
    renderHistory();

    await waitFor(() => expect(screen.getAllByText('Medieval Madness').length).toBeGreaterThan(0));

    expect(screen.queryByRole('link', { name: /Medieval Madness scores/ })).not.toBeInTheDocument();
    // Its winner cell still renders the empty-state label.
    expect(screen.getAllByText('No submissions').length).toBeGreaterThan(0);
  });

  it('renders the tournament type tag for each row', async () => {
    mockFetch(ROWS);
    renderHistory();

    await waitFor(() => expect(screen.getAllByText('DG').length).toBeGreaterThan(0));
    expect(screen.getAllByText('MG').length).toBeGreaterThan(0);
  });

  it('pushes the mobile type tag to the right edge instead of trailing the name', async () => {
    mockFetch(ROWS);
    renderHistory();

    // Wait on the LINK, not on 'DG' text — the filter `<option>`s also read
    // "DG" and render synchronously, so a text-based waitFor can pass before
    // the fetched rows exist and the link query then races the mock fetch
    // (flaked on a slow CI runner, 2026-08-09). Index 0 is the mobile list's
    // row. `ml-auto` on the badge's slot is what makes the tags line up down
    // the list rather than starting at a name-length-dependent offset; the
    // badge keeps its own no-shrink/no-wrap.
    const mobileRow = (await screen.findAllByRole('link', { name: /Daily Grind — WHO dunnit scores/ }))[0]!;
    const mobileBadge = within(mobileRow).getByText('DG');
    expect(mobileBadge.parentElement).toHaveClass('ml-auto');
    expect(mobileBadge).toHaveClass('flex-shrink-0');
  });

  it('empty state', async () => {
    mockFetch([]);
    renderHistory();
    await waitFor(() => expect(screen.getByText('No completed games found.')).toBeInTheDocument());
  });
});

/**
 * v2.238.0 (B24) — History filters by TOURNAMENT, takes its type options from
 * the room's own tags, and keeps filters + page in the URL.
 */
describe('PublicHistory — tournament filter and URL state', () => {
  const TOURNAMENTS = [
    { id: 't-old', name: 'Spring Cup', type: 'SC', is_active: 0 },
    { id: 't-1', name: 'Daily Grind', type: 'DG', is_active: 1 },
    { id: 't-2', name: 'Weekly Grind - VPX', type: 'WG-VPX', is_active: 1 },
  ];
  let historyCalls: string[];

  function stubRoomFetch(total = ROWS.length) {
    historyCalls = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      const j = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
      if (url.endsWith('/tournaments')) return j(TOURNAMENTS);
      historyCalls.push(url);
      const page = Number(new URL(url, 'http://x').searchParams.get('page'));
      return j({ results: ROWS, total, page, limit: 20 });
    }) as unknown as typeof fetch);
  }

  function LocationProbe() {
    const loc = useLocation();
    return <output data-testid="location">{loc.pathname + loc.search}</output>;
  }

  function renderAt(search: string) {
    return render(
      <MemoryRouter initialEntries={[`/test-room/history${search}`]}>
        <RoomContext.Provider value={{ roomId: 'room-1', roomSlug: 'test-room', roomName: 'Test Room' }}>
          <Routes>
            <Route path="/:slug/history" element={<><PublicHistory /><LocationProbe /></>} />
          </Routes>
        </RoomContext.Provider>
      </MemoryRouter>,
    );
  }

  beforeEach(() => vi.restoreAllMocks());

  it('filters by tournament (running ones first) and keeps it in the URL', async () => {
    stubRoomFetch();
    renderAt('');
    const select = await screen.findByRole('combobox', { name: 'Tournament' });
    expect(within(select).getAllByRole('option').map(o => o.textContent))
      .toEqual(['All tournaments', 'Daily Grind', 'Weekly Grind - VPX', 'Spring Cup']);

    fireEvent.change(select, { target: { value: 't-1' } });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/test-room/history?tournament=t-1'));
    await waitFor(() => expect(historyCalls.at(-1)).toBe('/api/rooms/room-1/history?page=1&limit=20&tournament_id=t-1'));
    expect(screen.getByRole('link', { name: /Open the tournament page/ }))
      .toHaveAttribute('href', '/test-room/tournaments/t-1');
  });

  it('a shared URL restores its filters and page', async () => {
    stubRoomFetch(45);
    renderAt('?tournament=t-2&type=WG-VPX&page=2');
    await waitFor(() => expect(historyCalls[0])
      .toBe('/api/rooms/room-1/history?page=2&limit=20&tournament_id=t-2&type=WG-VPX'));
    expect(await screen.findByRole('combobox', { name: 'Tournament' })).toHaveValue('t-2');
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('WG-VPX');
    expect(await screen.findByText('Page 2 of 3')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByTestId('location').textContent).toBe('/test-room/history?tournament=t-2&type=WG-VPX&page=3');
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    // Page 1 is the default, so it leaves the URL.
    expect(screen.getByTestId('location').textContent).toBe('/test-room/history?tournament=t-2&type=WG-VPX');
  });

  it('offers the room\'s own tags as types, and changing a filter goes back to page 1', async () => {
    stubRoomFetch(45);
    renderAt('?page=3');
    const type = screen.getByRole('combobox', { name: 'Type' });
    await waitFor(() => expect(within(type).getAllByRole('option').map(o => o.textContent))
      .toEqual(['All Types', 'DG', 'SC', 'WG-VPX']));

    fireEvent.change(type, { target: { value: 'DG' } });
    expect(screen.getByTestId('location').textContent).toBe('/test-room/history?type=DG');
  });
});
