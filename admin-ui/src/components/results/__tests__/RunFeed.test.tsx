import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import RunFeed, { type RunCardData } from '../RunFeed';

/**
 * v2.241.0 (B26) — past runs a week at a time, one card per run, final
 * standings open by default with one Collapse all / Expand all toggle
 * (owner 2026-11-10). Shared by History and the tournament page.
 */

const PETE = { discord_user_id: '111111111111111111', avatar_hash: 'petehash', avatar_url: null };

function run(id: string, name: string, end: string, over: Partial<RunCardData> = {}): RunCardData {
  return {
    game_id: id, tournament_id: 't-dg', game_name: name, tournament_name: 'Daily Grind', tournament_type: 'DG',
    start_date: null, end_date: end, image_url: `/api/catalogue-images/${id}.png`,
    winner_name: 'Pete', winner_username: 'PeteG', winner_score: 900,
    winner_discord_user_id: PETE.discord_user_id, winner_avatar_hash: PETE.avatar_hash, winner_avatar_url: null,
    players: 2,
    standings: [
      { rank: 1, iscored_username: 'PeteG', display_name: 'Pete', score: 900, ...PETE },
      { rank: 2, iscored_username: 'Ann', display_name: null, score: 500 },
    ],
    ...over,
  };
}

const WEEK0 = {
  results: [
    run('g-godzilla', 'Godzilla', '2026-11-10T03:00:00.000Z'),
    run('g-darius', 'Darius', '2026-11-08T03:00:00.000Z'),
    run('g-empty', 'Dr. Dude', '2026-11-06T03:00:00.000Z', {
      winner_name: null, winner_username: null, winner_score: null, winner_discord_user_id: null,
      winner_avatar_hash: null, players: 0, standings: [], image_url: null,
    }),
  ],
  total: 12, week: 0,
  window: { from: '2026-11-03T03:00:00.000Z', to: '2026-11-10T03:00:00.000Z' },
  has_newer: false, has_older: true,
};
const WEEK1 = {
  results: [run('g-afm', 'Attack from Mars', '2026-11-02T03:00:00.000Z')],
  total: 12, week: 1,
  window: { from: '2026-10-27T03:00:00.000Z', to: '2026-11-03T03:00:00.000Z' },
  has_newer: true, has_older: true,
};

let weeks: Record<string, unknown>;
const fetchMock = vi.fn();

beforeEach(() => {
  localStorage.clear();
  weeks = { '0': WEEK0, '1': WEEK1 };
  fetchMock.mockReset();
  fetchMock.mockImplementation((url: string) => {
    const q = new URL(url, 'http://x').searchParams;
    const body = q.get('run') === 'g-afm' ? WEEK1 : (weeks[q.get('week') ?? '0'] ?? { ...WEEK1, results: [], week: Number(q.get('week')) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.search}</output>;
}

function renderFeed(search = '', props: Partial<Parameters<typeof RunFeed>[0]> = {}) {
  return render(
    <MemoryRouter initialEntries={[`/rtx/history${search}`]}>
      <Routes>
        <Route path="/:slug/history" element={(
          <>
            <RunFeed roomId="room-1" slug="rtx" showTournament {...props} />
            <LocationProbe />
          </>
        )} />
      </Routes>
    </MemoryRouter>,
  );
}

const cards = () => screen.getAllByTestId('run-card');
const lastFetch = () => new URL(String(fetchMock.mock.calls.at(-1)![0]), 'http://x');

describe('RunFeed', () => {
  it('asks for the latest week with standings, and draws one card per run, newest first', async () => {
    renderFeed('', { tournamentId: 't-dg', type: 'DG' });
    await screen.findAllByTestId('run-card');

    const q = lastFetch();
    expect(q.pathname).toBe('/api/rooms/room-1/history');
    expect(Object.fromEntries(q.searchParams)).toEqual({ week: '0', standings: '1', tournament_id: 't-dg', type: 'DG' });
    expect(cards().map(c => within(c).getByRole('link', { name: /Godzilla|Darius|Dr\. Dude/ }).textContent))
      .toEqual(['Godzilla', 'Darius', 'Dr. Dude']);
    expect(screen.getByText(/Latest week · 3 games/)).toBeInTheDocument();
  });

  it('each card shows big table art, the winner with their avatar, and the tournament on History', async () => {
    renderFeed();
    const [first] = await screen.findAllByTestId('run-card');
    const art = within(first!).getByTestId('game-art');
    expect(art).toHaveAttribute('src', '/api/catalogue-images/g-godzilla.png');
    expect(art).toHaveAttribute('width', '112');
    expect(within(first!).getAllByAltText('Pete')[0]!.getAttribute('src')).toContain('petehash');
    expect(within(first!).getByRole('link', { name: 'Daily Grind' })).toHaveAttribute('href', '/rtx/tournaments/t-dg');
    // No art: initials.
    expect(within(cards()[2]!).getByTestId('game-art-fallback')).toHaveTextContent('DD');
  });

  it('the tournament page leaves the tournament off each card', async () => {
    renderFeed('', { showTournament: false });
    const [first] = await screen.findAllByTestId('run-card');
    expect(within(first!).queryByRole('link', { name: 'Daily Grind' })).toBeNull();
  });

  it('every card\'s final standings are open by default, with avatars', async () => {
    renderFeed();
    await screen.findAllByTestId('run-card');
    const boards = screen.getAllByTestId('run-board');
    expect(boards).toHaveLength(3);
    expect(within(boards[0]!).getByRole('link', { name: 'Ann' })).toHaveAttribute('href', '/rtx/players/Ann');
    expect(within(boards[2]!).getByText('Nobody posted a score in this run.')).toBeInTheDocument();
    for (const toggle of screen.getAllByRole('button', { name: /final standings/ })) {
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
    }
  });

  it('Collapse all folds every card; Expand all opens them again; the choice is remembered', async () => {
    const first = renderFeed();
    await screen.findAllByTestId('run-card');

    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.queryAllByTestId('run-board')).toHaveLength(0);
    expect(localStorage.getItem('arcaid-results-collapsed')).toBe('1');
    first.unmount();

    renderFeed();
    await screen.findAllByTestId('run-card');
    expect(screen.queryAllByTestId('run-board')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getAllByTestId('run-board')).toHaveLength(3);
    expect(localStorage.getItem('arcaid-results-collapsed')).toBe('0');
  });

  it('a card\'s own chevron opens or closes just that card', async () => {
    renderFeed();
    await screen.findAllByTestId('run-card');
    const toggle = screen.getByRole('button', { name: 'Hide Darius final standings' });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getAllByTestId('run-board')).toHaveLength(2);

    // Collapse all, then open one card alone.
    fireEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show Godzilla final standings' }));
    expect(screen.getAllByTestId('run-board')).toHaveLength(1);
  });

  it('Older / Newer step a week at a time and keep it in the URL', async () => {
    renderFeed();
    await screen.findAllByTestId('run-card');
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Older' }));
    await waitFor(() => expect(cards()).toHaveLength(1));
    expect(screen.getByTestId('location').textContent).toBe('?week=1');
    expect(lastFetch().searchParams.get('week')).toBe('1');

    fireEvent.click(screen.getByRole('button', { name: 'Newer' }));
    await waitFor(() => expect(cards()).toHaveLength(3));
    expect(screen.getByTestId('location').textContent).toBe('');
  });

  it('?run= with no week asks for that run\'s week, opens its card even when all are collapsed, and marks it', async () => {
    localStorage.setItem('arcaid-results-collapsed', '1');
    renderFeed('?run=g-afm');
    const [card] = await screen.findAllByTestId('run-card');
    expect(lastFetch().searchParams.get('run')).toBe('g-afm');
    expect(within(card!).getByTestId('run-board')).toBeInTheDocument();
    expect(card).toHaveClass('ring-2');
    // The week shown is the run's week (labels in the runner's own timezone).
    const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const label = `${fmt(new Date(Date.parse(WEEK1.window.from) + 1))} – ${fmt(new Date(WEEK1.window.to))}`;
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it('an empty week says so and still offers the way on', async () => {
    renderFeed('?week=2');
    expect(await screen.findByText('No games finished in this week.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Newer' })).toBeEnabled();
  });

  it('no runs at all: the empty text', async () => {
    weeks = { '0': { results: [], total: 0, week: 0, window: null, has_newer: false, has_older: false } };
    renderFeed('', { emptyText: 'No completed games found.' });
    expect(await screen.findByText('No completed games found.')).toBeInTheDocument();
  });
});
