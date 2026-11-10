import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import PublicHistory from '../PublicHistory';
import { RoomContext } from '../../contexts/RoomContext';

/**
 * `/:slug/history`. v2.241.0 (B26): a week at a time, one card per run, via
 * the shared `RunFeed` (its own behaviour is pinned in RunFeed.test.tsx).
 * These tests hold what the PAGE adds: the tournament and tag filters, their
 * URL state, and that each card names its tournament.
 */

const TOURNAMENTS = [
  { id: 't-old', name: 'Spring Cup', type: 'SC', is_active: 0 },
  { id: 't-1', name: 'Daily Grind', type: 'DG', is_active: 1 },
  { id: 't-2', name: 'Weekly Grind - VPX', type: 'WG-VPX', is_active: 1 },
];

const WEEK = {
  results: [{
    game_id: 'g-1', tournament_id: 't-1', game_name: 'WHO dunnit', tournament_name: 'Daily Grind', tournament_type: 'DG',
    start_date: null, end_date: '2026-11-08T03:00:00.000Z', image_url: '/api/catalogue-images/who.png',
    winner_name: 'PixelWizard', winner_username: 'PixelWizard', winner_score: 21_000_000, players: 1,
    standings: [{ rank: 1, iscored_username: 'PixelWizard', display_name: null, score: 21_000_000 }],
  }],
  total: 1, week: 0,
  window: { from: '2026-11-01T03:00:00.000Z', to: '2026-11-08T03:00:00.000Z' },
  has_newer: false, has_older: false,
};

let historyCalls: URL[];

beforeEach(() => {
  localStorage.clear();
  historyCalls = [];
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    if (url.endsWith('/tournaments')) return j(TOURNAMENTS);
    historyCalls.push(new URL(url, 'http://x'));
    return j(WEEK);
  }) as unknown as typeof fetch);
});
afterEach(() => { vi.unstubAllGlobals(); });

function LocationProbe() {
  const loc = useLocation();
  return <output data-testid="location">{loc.pathname + loc.search}</output>;
}

function renderAt(search = '') {
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

const lastQuery = () => Object.fromEntries(historyCalls.at(-1)!.searchParams);

describe('PublicHistory', () => {
  it('shows the latest week of runs as cards, each naming its tournament', async () => {
    renderAt();
    const [card] = await screen.findAllByTestId('run-card');
    expect(lastQuery()).toEqual({ week: '0', standings: '1' });
    expect(within(card!).getByRole('link', { name: 'WHO dunnit' })).toHaveAttribute('href', '/test-room/games/WHO%20dunnit');
    expect(within(card!).getByRole('link', { name: 'Daily Grind' })).toHaveAttribute('href', '/test-room/tournaments/t-1');
    expect(within(card!).getByText('DG')).toBeInTheDocument();
    expect(within(card!).getByTestId('run-board')).toBeInTheDocument();
  });

  it('filters by tournament (running ones first) and keeps it in the URL', async () => {
    renderAt();
    const select = await screen.findByRole('combobox', { name: 'Tournament' });
    expect(within(select).getAllByRole('option').map(o => o.textContent))
      .toEqual(['All tournaments', 'Daily Grind', 'Weekly Grind - VPX', 'Spring Cup']);

    fireEvent.change(select, { target: { value: 't-1' } });

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/test-room/history?tournament=t-1'));
    await waitFor(() => expect(lastQuery()).toEqual({ week: '0', standings: '1', tournament_id: 't-1' }));
    expect(screen.getByRole('link', { name: /Open the tournament page/ }))
      .toHaveAttribute('href', '/test-room/tournaments/t-1');
  });

  it('a shared URL restores its filters and week', async () => {
    renderAt('?tournament=t-2&type=WG-VPX&week=2');
    await waitFor(() => expect(historyCalls.length).toBeGreaterThan(0));
    expect(lastQuery()).toEqual({ week: '2', standings: '1', tournament_id: 't-2', type: 'WG-VPX' });
    expect(await screen.findByRole('combobox', { name: 'Tournament' })).toHaveValue('t-2');
    expect(screen.getByRole('combobox', { name: 'Type' })).toHaveValue('WG-VPX');
  });

  it('offers the room\'s own tags as types, and a filter change starts again at the latest week', async () => {
    renderAt('?week=3');
    const type = screen.getByRole('combobox', { name: 'Type' });
    await waitFor(() => expect(within(type).getAllByRole('option').map(o => o.textContent))
      .toEqual(['All Types', 'DG', 'SC', 'WG-VPX']));

    fireEvent.change(type, { target: { value: 'DG' } });
    expect(screen.getByTestId('location').textContent).toBe('/test-room/history?type=DG');
  });

  it('empty state', async () => {
    historyCalls = [];
    vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
      ok: true,
      json: () => Promise.resolve(url.endsWith('/tournaments') ? [] : { ...WEEK, results: [], window: null }),
    })) as unknown as typeof fetch);
    renderAt();
    expect(await screen.findByText('No completed games found.')).toBeInTheDocument();
  });
});
