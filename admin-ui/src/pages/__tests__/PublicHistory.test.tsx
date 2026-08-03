import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
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

  it('links each row to its tournament board page', async () => {
    mockFetch(ROWS);
    renderHistory();

    await waitFor(() => expect(screen.getAllByText('WHO dunnit').length).toBeGreaterThan(0));

    // Both the mobile row and the desktop row are links to the same board page.
    const links = screen.getAllByRole('link', { name: /Daily Grind — WHO dunnit scores/ });
    expect(links).toHaveLength(2);
    for (const link of links) expect(link).toHaveAttribute('href', '/test-room/tournaments/t-1');
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

    await waitFor(() => expect(screen.getAllByText('DG').length).toBeGreaterThan(0));

    // Index 0 is the mobile list's row (the filter `<option>`s also read "DG",
    // hence scoping to the row). `ml-auto` on the badge's slot is what makes
    // the tags line up down the list rather than starting at a
    // name-length-dependent offset; the badge keeps its own no-shrink/no-wrap.
    const mobileRow = screen.getAllByRole('link', { name: /Daily Grind — WHO dunnit scores/ })[0]!;
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
