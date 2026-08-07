import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PersonalBestsSection, type PersonalBestRow } from '../PersonalBestsSection';

/**
 * Searchable Personal Bests (ROADMAP line 11). Moved from
 * PlayerDetail.tsx/PlayerDetailPersonalBests.test.tsx in v2.82.0 (My Stats,
 * plan decision 5, tmp/my-stats-v282-plan.md) so both PlayerDetail
 * (room-scoped, `room_rank` rows, no `source`) and MyStats (cross-room,
 * `rank` + `source` rows) can share the component.
 *
 * The section is extracted from its page so it can be mounted without any
 * fetch-on-mount + ViewerAuth/Room context machinery; the render output for
 * the no-search, short-list, PlayerDetail-shaped case is byte-for-byte
 * unchanged from before the move.
 *
 * Behaviour under test: the default 20-row cap + "Show all N" toggle, the
 * case-insensitive substring filter (which is NOT capped — a hidden match is
 * the exact failure the search exists to prevent), the "N of M games" count
 * line that appears only while filtering, the no-match empty state, and the
 * v2.82.0 additions — per-row link resolution (room/global/no-link), the
 * "Global" provenance chip, and the opt-in room-name caption.
 */

function makeBests(names: string[]): PersonalBestRow[] {
  return names.map((game_name, i) => ({
    game_name,
    best_score: 1_000_000 - i * 1000,
    room_rank: i + 1,
    total_players: 12,
    achieved_at: '2026-05-01T12:00:00.000Z',
  }));
}

/** 25 rows so the 20-row default cap is exercised. */
const MANY = makeBests([
  'Medieval Madness',
  'Attack from Mars',
  'Twilight Zone',
  'Monster Bash',
  'Theatre of Magic',
  'Cirqus Voltaire',
  'Scared Stiff',
  'Tales of the Arabian Nights',
  'Indiana Jones',
  'Star Trek: The Next Generation',
  'Funhouse',
  'The Addams Family',
  'White Water',
  'Whirlwind',
  'Terminator 2',
  'Junk Yard',
  'No Good Gofers',
  'Congo',
  'Champion Pub',
  'Big Bang Bar',
  'Cactus Canyon',
  'Revenge from Mars',
  'Safe Cracker',
  'Road Show',
  'Dr. Dude',
]);

function renderSection(personalBests?: PersonalBestRow[], extraProps: Record<string, unknown> = {}) {
  return render(
    <MemoryRouter>
      <PersonalBestsSection personalBests={personalBests} slug="test-room" {...extraProps} />
    </MemoryRouter>,
  );
}

/** Data rows only (link OR plain-text names) — the header strip is a sibling
 *  grid without any `pb-game-name` cell. */
function visibleGameNames(): string[] {
  return screen
    .queryAllByTestId('pb-game-name')
    .map(el => el.textContent || '')
    .filter(Boolean);
}

describe('PersonalBestsSection', () => {
  it('renders nothing when there are no personal bests', () => {
    const { container } = renderSection([]);
    expect(container).toBeEmptyDOMElement();
    const undef = renderSection(undefined);
    expect(undef.container).toBeEmptyDOMElement();
  });

  it('renders a short list in API order with no search box', () => {
    renderSection(makeBests(['Funhouse', 'Whirlwind', 'Junk Yard']));
    expect(screen.getByText('Personal Bests')).toBeTruthy();
    expect(visibleGameNames()).toEqual(['Funhouse', 'Whirlwind', 'Junk Yard']);
    // <= 5 rows: a search box would be clutter.
    expect(screen.queryByLabelText('Search your personal bests')).toBeNull();
    // Count line only appears while filtering.
    expect(screen.queryByText(/of 3 games/)).toBeNull();
  });

  it('shows the search box once the list is long enough', () => {
    renderSection(MANY);
    expect(screen.getByLabelText('Search your personal bests')).toBeTruthy();
  });

  it('caps the default view at 20 rows and expands via "Show all N"', () => {
    renderSection(MANY);

    expect(visibleGameNames()).toHaveLength(20);
    // API order is preserved — no client-side re-sort.
    expect(visibleGameNames()[0]).toBe('Medieval Madness');
    expect(screen.queryByText('Cactus Canyon')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Show all 25' }));
    expect(visibleGameNames()).toHaveLength(25);
    expect(screen.getByText('Cactus Canyon')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Show fewer' }));
    expect(visibleGameNames()).toHaveLength(20);
  });

  it('does not offer a toggle when the list fits under the cap', () => {
    renderSection(makeBests(['Funhouse', 'Whirlwind', 'Junk Yard', 'Congo', 'Big Bang Bar', 'Dr. Dude']));
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('filters by substring as-you-type and shows a count line', () => {
    renderSection(MANY);

    fireEvent.change(screen.getByLabelText('Search your personal bests'), { target: { value: 'mars' } });
    expect(visibleGameNames()).toEqual(['Attack from Mars', 'Revenge from Mars']);
    expect(screen.getByText('2 of 25 games')).toBeTruthy();
  });

  it('matches case-insensitively', () => {
    renderSection(MANY);
    const input = screen.getByLabelText('Search your personal bests');

    fireEvent.change(input, { target: { value: 'MEDIEVAL' } });
    expect(visibleGameNames()).toEqual(['Medieval Madness']);

    fireEvent.change(input, { target: { value: 'mEdIeVaL' } });
    expect(visibleGameNames()).toEqual(['Medieval Madness']);
  });

  it('shows every match while filtering, ignoring the 20-row cap', () => {
    // 24 rows all containing "game" — more than the collapsed cap.
    const bests = makeBests(Array.from({ length: 24 }, (_, i) => `Game ${i + 1}`));
    renderSection(bests);

    fireEvent.change(screen.getByLabelText('Search your personal bests'), { target: { value: 'game' } });
    expect(visibleGameNames()).toHaveLength(24);
    expect(screen.getByText('24 of 24 games')).toBeTruthy();
    // The collapse toggle is suppressed while a query is active.
    expect(screen.queryByRole('button', { name: /Show all/ })).toBeNull();
  });

  it('renders an empty-state row rather than hiding the section on no match', () => {
    renderSection(MANY);

    fireEvent.change(screen.getByLabelText('Search your personal bests'), { target: { value: 'zzzznope' } });
    expect(screen.getByText('Personal Bests')).toBeTruthy();
    expect(screen.getByText(/No games match/)).toBeTruthy();
    expect(screen.getByText(/zzzznope/)).toBeTruthy();
    expect(screen.getByText('0 of 25 games')).toBeTruthy();
    expect(visibleGameNames()).toHaveLength(0);
  });

  it('stacks each row on phones: the name owns line 1, rank/date caption line 2', () => {
    renderSection(makeBests(['Funhouse', 'Whirlwind', 'Junk Yard']));

    // The name cell spans BOTH mobile tracks — that is what gives the game
    // title the full width instead of sharing its line with the score, which
    // is what truncated "Attack from Mar…". It collapses back to one column
    // from `sm` up.
    const nameCell = screen.getByText('Funhouse').parentElement as HTMLElement;
    expect(nameCell).toHaveClass('col-span-2');
    expect(nameCell).toHaveClass('sm:col-span-1');

    // Line 2's caption carries the two columns the phone layout drops. Date is
    // formatted by the runner's locale, so match loosely.
    expect(screen.getAllByText(/^#1 of 12 · /).length).toBeGreaterThan(0);
    // ...and the desktop columns still exist beside it.
    expect(screen.getByText('#1 of 12')).toBeTruthy();
  });

  it('keeps score / rank / date columns intact for a filtered row', () => {
    renderSection(MANY);

    fireEvent.change(screen.getByLabelText('Search your personal bests'), { target: { value: 'twilight' } });
    const row = screen.getByText('Twilight Zone').closest('div') as HTMLElement;
    expect(within(row).getByText('998,000')).toBeTruthy();
    expect(within(row).getByText('#3 of 12')).toBeTruthy();
  });

  // --- v2.82.0 My Stats additions -------------------------------------------

  it('room row with its own room_slug links there, not the slug prop', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Fire!', best_score: 500_000, rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z', source: 'room', room_slug: 'other_room', room_name: 'Other Room' },
    ];
    renderSection(rows);
    const link = screen.getByTestId('pb-game-name') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/other_room/games/Fire!');
  });

  it('room row without room_slug falls back to the slug prop (PlayerDetail behavior)', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Fire!', best_score: 500_000, room_rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z' },
    ];
    renderSection(rows);
    const link = screen.getByTestId('pb-game-name') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/test-room/games/Fire!');
  });

  it('global row links to /games/:global_game_id and shows the "Global Scoreboard" chip', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Cosmic Cart Racing', best_score: 42, rank: 1, total_players: 3, achieved_at: '2026-05-01T00:00:00.000Z', source: 'global', global_game_id: 'gg-123' },
    ];
    renderSection(rows);
    const link = screen.getByTestId('pb-game-name') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/games/gg-123');
    // "Global Scoreboard", not bare "Global" (owner revision — a room score
    // can ALSO fan out there, so "Global" alone misread as exclusivity).
    expect(screen.getByText('Global Scoreboard')).toBeTruthy();
    expect(screen.queryByText('Global')).toBeNull();
  });

  it('global row missing global_game_id renders plain text, not a link', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Cosmic Cart Racing', best_score: 42, rank: 1, total_players: 3, achieved_at: '2026-05-01T00:00:00.000Z', source: 'global' },
    ];
    renderSection(rows);
    const nameNode = screen.getByTestId('pb-game-name');
    expect(nameNode.tagName).toBe('SPAN');
    expect(screen.queryAllByRole('link')).toHaveLength(0);
  });

  it('room row with neither room_slug nor slug prop renders plain text', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Fire!', best_score: 500_000, rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z', source: 'room' },
    ];
    render(
      <MemoryRouter>
        <PersonalBestsSection personalBests={rows} />
      </MemoryRouter>,
    );
    const nameNode = screen.getByTestId('pb-game-name');
    expect(nameNode.tagName).toBe('SPAN');
  });

  it('rankHeader prop overrides the default "Room Rank" desktop header', () => {
    renderSection(makeBests(['Funhouse', 'Whirlwind', 'Junk Yard']), { rankHeader: 'Rank' });
    expect(screen.getByText('Rank')).toBeTruthy();
    expect(screen.queryByText('Room Rank')).toBeNull();
  });

  it('defaults to "Room Rank" when rankHeader is not passed (PlayerDetail unchanged)', () => {
    renderSection(makeBests(['Funhouse', 'Whirlwind', 'Junk Yard']));
    expect(screen.getByText('Room Rank')).toBeTruthy();
  });

  it('shows the room_name caption on a room row only when showRoomCaption is on', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Fire!', best_score: 500_000, rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z', source: 'room', room_slug: 'other_room', room_name: 'Other Room' },
    ];
    renderSection(rows);
    expect(screen.queryByText('Other Room')).toBeNull();

    renderSection(rows, { showRoomCaption: true });
    expect(screen.getByText('Other Room')).toBeTruthy();
  });

  it('never shows the room_name caption (or a room logo) on a global row, even with showRoomCaption on', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Cosmic Cart Racing', best_score: 42, rank: 1, total_players: 3, achieved_at: '2026-05-01T00:00:00.000Z', source: 'global', global_game_id: 'gg-123', room_name: 'Should Not Show', room_logo_url: 'https://example.com/should-not-show.png' },
    ];
    renderSection(rows, { showRoomCaption: true });
    expect(screen.queryByText('Should Not Show')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Global Scoreboard')).toBeTruthy();
  });

  it('shows the room logo in place of the text caption when the row has room_logo_url', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Fire!', best_score: 500_000, rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z', source: 'room', room_slug: 'other_room', room_name: 'Other Room', room_logo_url: 'https://example.com/other-room-logo.png' },
    ];
    renderSection(rows, { showRoomCaption: true });
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('https://example.com/other-room-logo.png');
    expect(img.getAttribute('alt')).toBe('Other Room');
    // The text caption is suppressed when a logo is present — no duplicate room identity.
    expect(screen.queryByText('Other Room')).toBeNull();
  });

  it('falls back to the text caption when room_logo_url is absent, even with showRoomCaption on', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Fire!', best_score: 500_000, rank: 1, total_players: 5, achieved_at: '2026-05-01T00:00:00.000Z', source: 'room', room_slug: 'other_room', room_name: 'Other Room' },
    ];
    renderSection(rows, { showRoomCaption: true });
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('Other Room')).toBeTruthy();
  });

  it('a My Stats row using `rank` (no room_rank) renders the same rank caption as a room_rank row', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Fire!', best_score: 500_000, rank: 4, total_players: 9, achieved_at: '2026-05-01T00:00:00.000Z', source: 'room', room_slug: 'other_room' },
    ];
    renderSection(rows);
    expect(screen.getByText('#4 of 9')).toBeTruthy();
  });

  it('default (no source, no showRoomCaption) row keeps the exact single-Link name-cell shape', () => {
    // Regression guard for the "pixel-identical PlayerDetail" requirement:
    // the plain case must not gain the flex-col wrapper used for chip/caption
    // rows, since that changes vertical alignment.
    renderSection(makeBests(['Funhouse']));
    const link = screen.getByTestId('pb-game-name');
    const nameCell = link.parentElement as HTMLElement;
    // The Link is still the ONLY element in the name cell — no chip/caption
    // siblings — and the cell keeps the single-line `items-center` layout.
    expect(nameCell.children).toHaveLength(1);
    expect(nameCell).toHaveClass('items-center');
    expect(nameCell).not.toHaveClass('flex-col');
    // Title still truncates by default — `wrapTitles` is opt-in, and
    // PlayerDetail never passes it (pixel-identical requirement).
    expect(link).toHaveClass('truncate');
    expect(link).not.toHaveClass('break-words');
  });

  // --- v2.82.0 owner revision: wrapTitles (no ellipsis cutoff) --------------

  it('wrapTitles off (default): long titles keep the truncating class — PlayerDetail is unaffected', () => {
    renderSection(makeBests(['Tales of the Arabian Nights (Special Collector\'s Edition)']));
    const link = screen.getByTestId('pb-game-name');
    expect(link).toHaveClass('truncate');
    expect(link).not.toHaveClass('break-words');
  });

  it('wrapTitles on: long titles wrap (break-words) instead of truncating, for a linked row', () => {
    renderSection(makeBests(['Tales of the Arabian Nights (Special Collector\'s Edition)']), { wrapTitles: true });
    const link = screen.getByTestId('pb-game-name');
    expect(link).toHaveClass('break-words');
    expect(link).not.toHaveClass('truncate');
    // Full text present, not ellipsized/clipped in markup.
    expect(link.textContent).toBe('Tales of the Arabian Nights (Special Collector\'s Edition)');
  });

  it('wrapTitles on: also applies to a plain-text (no-link) row', () => {
    const rows: PersonalBestRow[] = [
      { game_name: 'Neon Drift Overdrive Championship Edition', best_score: 42, rank: 1, total_players: 3, achieved_at: '2026-05-01T00:00:00.000Z', source: 'global' },
    ];
    render(
      <MemoryRouter>
        <PersonalBestsSection personalBests={rows} wrapTitles />
      </MemoryRouter>,
    );
    const nameNode = screen.getByTestId('pb-game-name');
    expect(nameNode.tagName).toBe('SPAN');
    expect(nameNode).toHaveClass('break-words');
    expect(nameNode).not.toHaveClass('truncate');
  });
});
