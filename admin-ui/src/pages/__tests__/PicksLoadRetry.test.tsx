import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Picks from '../Picks';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

/**
 * G32 — the Picks page when its loads fail for now. A refused game-library
 * read used to read "No game library configured for this tournament." and
 * nothing asked again; a refusal's JSON error body was stored as the library
 * and the render threw on `data.games.filter`.
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
      manufacturer: 'Bally', year: 1995, platforms: ['vpx'], features: [], room_tags: [],
      global_game_id: 'gg-afm', image_url: null,
    },
  ],
};

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
];

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const refused = () => Promise.resolve({
  ok: false, status: 429, headers: { get: () => null },
  json: () => Promise.resolve({ error: 'Too many requests. Please try again later.' }),
});
const notFound = () => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'none' }) });

let libraryMode: 'ok' | 'limited' | 'missing' = 'ok';
let tournamentsLimited = false;
const fetchMock = vi.fn();

function stubFetch(slug: string) {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith('/api/portal')) return ok({ id: ROOM_ID, roomId: ROOM_ID, slug, name: 'RTX Pinball', pick_award_enabled: true });
    if (url.includes('/game-availability')) {
      if (libraryMode === 'limited') return refused();
      if (libraryMode === 'missing') return notFound();
      return ok(AVAILABILITY);
    }
    if (url.includes('/tournaments')) return tournamentsLimited ? refused() : ok(TOURNAMENTS);
    return ok([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
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

const calls = (part: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(part)).length;
const settle = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('Picks when its loads fail for now', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    fetchMock.mockReset();
    libraryMode = 'ok';
    tournamentsLimited = false;
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a refused game list says so, not "No game library configured"', async () => {
    libraryMode = 'limited';
    stubFetch('retry_a');
    renderPicks('retry_a');
    await settle();
    await settle();

    expect(screen.getByTestId('picks-load-failed')).toHaveTextContent("Couldn't load the game list");
    expect(screen.queryByText('No game library configured for this tournament.')).not.toBeInTheDocument();
  });

  it('asks again by itself and the games appear', async () => {
    libraryMode = 'limited';
    stubFetch('retry_b');
    renderPicks('retry_b');
    await settle();
    await settle();
    expect(calls('/game-availability')).toBe(1);

    libraryMode = 'ok';
    await advance(1_000);
    expect(screen.queryByTestId('picks-load-failed')).not.toBeInTheDocument();
    expect(screen.getAllByText('Attack from Mars').length).toBeGreaterThan(0);
  });

  it('"Try now" asks at once', async () => {
    libraryMode = 'limited';
    stubFetch('retry_c');
    renderPicks('retry_c');
    await settle();
    await settle();
    libraryMode = 'ok';

    fireEvent.click(screen.getByRole('button', { name: 'Try now' }));
    await settle();
    expect(screen.getAllByText('Attack from Mars').length).toBeGreaterThan(0);
    expect(calls('/game-availability')).toBe(2);
  });

  it('a tournament that answered with no library keeps the existing text and is not retried', async () => {
    libraryMode = 'missing';
    stubFetch('retry_d');
    renderPicks('retry_d');
    await settle();
    await settle();

    expect(screen.getByText('No game library configured for this tournament.')).toBeInTheDocument();
    expect(screen.queryByTestId('picks-load-failed')).not.toBeInTheDocument();
    await advance(45_000);
    expect(calls('/game-availability')).toBe(1);
  });

  it('a refusal\'s JSON error body never crashes the page', async () => {
    libraryMode = 'limited';
    stubFetch('retry_e');
    renderPicks('retry_e');
    await settle();
    await settle();
    await advance(3_000);

    expect(screen.getByRole('heading', { name: 'Picks' })).toBeInTheDocument();
  });

  it('a refused tournaments list says so and recovers', async () => {
    tournamentsLimited = true;
    stubFetch('retry_f');
    renderPicks('retry_f');
    await settle();
    await settle();

    expect(screen.getByTestId('picks-tournaments-load-failed')).toHaveTextContent("Couldn't load the picks");
    expect(screen.queryByText('No game library configured for this tournament.')).not.toBeInTheDocument();

    tournamentsLimited = false;
    await advance(1_000);
    expect(screen.queryByTestId('picks-tournaments-load-failed')).not.toBeInTheDocument();
    expect(screen.getAllByText('Attack from Mars').length).toBeGreaterThan(0);
  });
});
