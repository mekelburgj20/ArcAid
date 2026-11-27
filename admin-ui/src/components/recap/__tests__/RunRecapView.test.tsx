import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import RunRecapView from '../RunRecapView';
import { makeRecap } from './recapFixture';
import type { RunRecap } from '../../../lib/runRecapTypes';

const fetchMock = vi.fn();
let recapRes: { status: number; body: unknown };

const DETAIL = {
  player: makeRecap().players[0],
  games: [
    { n: 1, source: 'witness', day: '2026-11-20', time: null, score: 5_000_000, session: 1, is_pb: true, is_best: false },
    { n: 2, source: 'witness', day: '2026-11-21', time: null, score: 31_400_000, session: 2, is_pb: true, is_best: true },
  ],
  sessions: [{ n: 1, games: 1, minutes: 5, best: 5_000_000, day: '2026-11-20' }, { n: 2, games: 1, minutes: 7, best: 31_400_000, day: '2026-11-21' }],
  hours: null,
  timezone: 'America/Chicago',
};

function stubFetch() {
  fetchMock.mockImplementation((url: string) => {
    const j = (body: unknown, status = 200) => Promise.resolve({
      ok: status >= 200 && status < 300, status, headers: new Headers(), json: () => Promise.resolve(body),
    });
    if (url.includes('/recap/players/')) return j(DETAIL);
    if (url.endsWith('/recap')) return j(recapRes.body, recapRes.status);
    return j(null, 404);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

const renderView = () => render(
  <MemoryRouter>
    <RunRecapView roomId="room-1" slug="r" tournamentId="t-1" gameId="g-1" />
  </MemoryRouter>,
);

describe('RunRecapView', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    recapRes = { status: 200, body: makeRecap() };
    stubFetch();
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('renders the hero, tiles, players and awards, and links back to all runs', async () => {
    renderView();
    const hero = await screen.findByTestId('recap-hero');
    expect(within(hero).getByRole('heading', { name: 'Lost in Space' })).toBeInTheDocument();
    expect(within(hero).getByText('Ann A')).toBeInTheDocument();
    expect(screen.getByTestId('hero-caption')).toHaveTextContent('Game #22 of 22 · about 7 hours before the close');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/rooms/room-1/runs/g-1/recap');
    expect(screen.getByRole('link', { name: /All runs/ })).toHaveAttribute('href', '/r/tournaments/t-1?run=g-1');
    expect(screen.getByTestId('recap-awards')).toHaveTextContent('Most games');
    expect(screen.getByTestId('recap-awards')).toHaveTextContent('Ann A and bob');
    expect(screen.getByTestId('games-per-day')).toHaveTextContent('Sat 11/21');
    expect(screen.getByTestId('lead-change-list').querySelectorAll('li')).toHaveLength(2);
    expect(screen.queryByText('So far')).not.toBeInTheDocument();
  });

  it('marks typed-only and hidden players with their reasons', async () => {
    renderView();
    const table = await screen.findByTestId('recap-player-table');
    expect(within(table).getAllByLabelText('Typed in or synced only')).toHaveLength(3);
    expect(within(table).getAllByLabelText('Keeps play stats private').length).toBeGreaterThan(0);
    expect(table).toHaveTextContent('† Typed in or synced only');
  });

  it('sorts by a column, numeric descending first, nulls last', async () => {
    renderView();
    const table = await screen.findByTestId('recap-player-table');
    const order = () => within(table).getAllByTestId('recap-player-row').map(r => r.textContent!.slice(0, 8));
    expect(order()[0]).toContain('Ann A');
    fireEvent.click(within(table).getByRole('button', { name: /^Games/ }));
    expect(within(table).getByRole('columnheader', { name: /Games/ })).toHaveAttribute('aria-sort', 'descending');
    expect(order()[0]).toContain('Ann A');
    expect(order()[2]).toContain('cy');
    fireEvent.click(within(table).getByRole('button', { name: /^Games/ }));
    // Ascending: Ann is the only non-null, so still first; nulls stay last.
    expect(order()[0]).toContain('Ann A');
  });

  it('opens the player detail and fetches the key route once', async () => {
    renderView();
    const table = await screen.findByTestId('recap-player-table');
    fireEvent.click(within(table).getByRole('button', { name: /Ann A/ }));
    await screen.findByTestId('game-list');
    const calls = fetchMock.mock.calls.map(c => String(c[0])).filter(u => u.includes('/recap/players/'));
    expect(calls).toEqual(['/api/rooms/room-1/runs/g-1/recap/players/ann']);
    expect(screen.getByTestId('game-bars').children).toHaveLength(2);
    expect(screen.getByTestId('session-list')).toHaveTextContent('Session 2');
  });

  it('shows only the reason for a hidden player (no fetch)', async () => {
    renderView();
    const table = await screen.findByTestId('recap-player-table');
    fireEvent.click(within(table).getByRole('button', { name: /cy/ }));
    expect(await screen.findByText(/keeps play stats private\. Their best/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/recap/players/'))).toBe(false);
  });

  it('copies the server text for Discord', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy for Discord' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('## Lost in Space recap'));
  });

  it('an active run says So far and Refresh reloads', async () => {
    const base = makeRecap();
    recapRes = { status: 200, body: makeRecap({ run: { ...base.run, state: 'active', end_date: null } } as Partial<RunRecap>) };
    renderView();
    expect(await screen.findByText(/So far/)).toBeInTheDocument();
    const before = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(before + 1));
  });

  it('a 404 is "no recap" with a way back', async () => {
    recapRes = { status: 404, body: { error: 'Run not found' } };
    renderView();
    expect(await screen.findByText('This run has no recap')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /All runs/ })).toBeInTheDocument();
  });
});
