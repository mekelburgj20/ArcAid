import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import SeasonRecapView from '../SeasonRecapView';
import type { SeasonRecap } from '../../../lib/runRecapTypes';

const ref = (key: string, name: string, display: string | null = null) => ({
  key, iscored_username: name, display_name: display, discord_user_id: null, avatar_hash: null, avatar_url: null,
});

const RECAP: SeasonRecap = {
  tournament: { id: 't1', name: 'Season 6', type: 'DG', format: 'rotation', is_active: true },
  runs: 3,
  live_runs: 1,
  players: [ref('u1', 'AnnX', 'Annie'), ref('u2', 'Bob')],
  standings: [
    { player_key: 'u1', runs_played: 3, runs_won: 2, podiums: 3, games: 18 },
    { player_key: 'u2', runs_played: 3, runs_won: 1, podiums: 2, games: null },
  ],
  awards: [
    { id: 'most_runs_won', label: 'Most runs won', player_keys: ['u1'], value: 2, detail: '2 of 3 runs', run: null },
    {
      id: 'closest_finish', label: 'Closest finish', player_keys: ['u1', 'u2'], value: 0.004, detail: '0.4% between first and second',
      run: { game_id: 'g9', game_name: 'Godzilla', tournament_id: 't1', tournament_name: 'Season 6', end_date: null },
    },
  ],
};

let body: unknown;
beforeEach(() => {
  body = RECAP;
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })) as unknown as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

const renderView = () => render(
  <MemoryRouter>
    <SeasonRecapView roomId="room-1" slug="rtx" tournamentId="t1" />
  </MemoryRouter>,
);

describe('SeasonRecapView', () => {
  it('shows the tiles, the awards with names, and links a run award to its recap', async () => {
    renderView();
    const awards = await screen.findByTestId('season-awards');
    expect(within(awards).getByText('Most runs won')).toBeInTheDocument();
    expect(awards).toHaveTextContent('Annie');
    expect(awards).toHaveTextContent('Annie, Bob');
    expect(awards).toHaveTextContent('0.4% between first and second');
    expect(within(awards).getByRole('link', { name: 'Closest finish' })).toHaveAttribute('href', '/rtx/tournaments/t1?run=g9&recap=1');
    // Only the run award is a link.
    expect(within(awards).queryByRole('link', { name: 'Most runs won' })).not.toBeInTheDocument();
    // Witness games tile sums only the shown games.
    expect(screen.getByText('Witness games').closest('div')).toHaveTextContent('18');
  });

  it('draws a dash for a player who keeps their play stats private, and never a key', async () => {
    renderView();
    const table = await screen.findByTestId('season-standings');
    const bobRow = within(table).getByText('Bob').closest('tr')!;
    expect(bobRow).toHaveTextContent('—');
    expect(table).not.toHaveTextContent('u2');
    expect(within(table).getByText('Annie')).toBeInTheDocument();
  });

  it('says so when no run has finished', async () => {
    body = { ...RECAP, runs: 0, live_runs: 0, standings: [], awards: [], players: [] };
    renderView();
    expect(await screen.findByText('No finished runs yet')).toBeInTheDocument();
  });
});
