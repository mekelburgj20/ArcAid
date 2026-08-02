import { describe, it, expect } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PersonalBestsSection } from '../PlayerDetail';

/**
 * Searchable Personal Bests (ROADMAP line 11).
 *
 * The section is extracted from PlayerDetail so it can be mounted without the
 * page's fetch-on-mount + ViewerAuth/Room context machinery; the render output
 * is unchanged from the pre-search version for the no-search, short-list case.
 *
 * Behaviour under test: the default 20-row cap + "Show all N" toggle, the
 * case-insensitive substring filter (which is NOT capped — a hidden match is
 * the exact failure the search exists to prevent), the "N of M games" count
 * line that appears only while filtering, and the no-match empty state.
 */

type PB = {
  game_name: string;
  best_score: number;
  room_rank: number;
  total_players: number;
  achieved_at: string;
};

function makeBests(names: string[]): PB[] {
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

function renderSection(personalBests?: PB[]) {
  return render(
    <MemoryRouter>
      <PersonalBestsSection personalBests={personalBests} slug="test-room" />
    </MemoryRouter>,
  );
}

/** Data rows only — the header strip is a sibling grid without links. */
function visibleGameNames(): string[] {
  return screen
    .queryAllByRole('link')
    .map(a => a.textContent || '')
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

  it('keeps score / rank / date columns intact for a filtered row', () => {
    renderSection(MANY);

    fireEvent.change(screen.getByLabelText('Search your personal bests'), { target: { value: 'twilight' } });
    const row = screen.getByText('Twilight Zone').closest('div') as HTMLElement;
    expect(within(row).getByText('998,000')).toBeTruthy();
    expect(within(row).getByText('#3 of 12')).toBeTruthy();
  });
});
