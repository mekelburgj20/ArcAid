import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import MyTables from '../MyTables';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

/**
 * C2 - My Tables. Locks the three things the page does with the API:
 * it renders the owned list (sorted by name), toggling an engine chip PUTs
 * the player's full new engine array, and Remove DELETEs the table.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signIn(discordId = '123456789012345678') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username: 'Tester', avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

const MEDIEVAL = {
  global_game_id: 'gg-mm', name: 'Medieval Madness', manufacturer: 'Williams', year: 1997,
  type: 'pinball', image_url: null, catalogue_platforms: ['vpx', 'fx'], platforms: [],
  created_at: '2026-10-01 00:00:00', avg_rating: 4.5, rating_count: 3,
};
const AFM = {
  global_game_id: 'gg-afm', name: 'Attack from Mars', manufacturer: 'Bally', year: 1995,
  type: 'pinball', image_url: '/api/catalogue-images/afm.png', catalogue_platforms: ['vpx'], platforms: ['vpx'],
  created_at: '2026-10-02 00:00:00', avg_rating: 0, rating_count: 0,
};

type Call = { url: string; method: string; body: unknown };

function stubFetch() {
  const calls: Call[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const j = (b: unknown, status = 200) =>
      Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(b) });
    if (url === '/api/me/tables' && method === 'GET') return j({ tables: [MEDIEVAL, AFM] });
    if (url.startsWith('/api/me/tables/') && method === 'PUT') {
      const id = decodeURIComponent(url.split('/').pop()!);
      const base = id === 'gg-mm' ? MEDIEVAL : AFM;
      return j({ table: { ...base, platforms: (body as { platforms: string[] }).platforms } });
    }
    if (url.startsWith('/api/me/tables/') && method === 'DELETE') return j({ ok: true, removed: true });
    if (url.startsWith('/api/global/games?')) return j({ data: [], hasMore: false });
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/account/tables']}>
      <ViewerAuthProvider>
        <MyTables />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('My Tables page (C2)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('asks a guest to log in and fetches nothing', () => {
    const calls = stubFetch();
    renderPage();
    expect(screen.getByText('Log in to manage your tables.')).toBeInTheDocument();
    expect(calls.filter(c => c.url.startsWith('/api/me/tables'))).toHaveLength(0);
  });

  it('renders the owned list sorted by name with mfg / year', async () => {
    stubFetch();
    signIn();
    renderPage();

    const list = await screen.findByTestId('my-tables-list');
    // Title links only (the rating badge is a link too since A14.2).
    const names = within(list).getAllByRole('link')
      .filter(a => a.getAttribute('data-testid') !== 'rating-badge')
      .map(a => a.textContent);
    expect(names).toEqual(['Attack from Mars', 'Medieval Madness']);
    expect(screen.getByText(/Williams . 1997/)).toBeInTheDocument();
    // No engine chosen -> "any platform".
    const mm = screen.getByTestId('owned-gg-mm');
    expect(within(mm).getByText('Owned on: any platform')).toBeInTheDocument();
    // Offered chips = catalogue engines + Real, nothing pressed.
    const chips = within(mm).getAllByRole('button', { pressed: false }).map(b => b.textContent);
    expect(chips).toEqual(expect.arrayContaining(['VPX', 'FX', 'Real']));
  });

  it('shows the rating badge on rated tables and sorts by rating (A14.1)', async () => {
    stubFetch();
    signIn();
    renderPage();

    const list = await screen.findByTestId('my-tables-list');
    const badge = within(screen.getByTestId('owned-gg-mm')).getByTestId('rating-badge');
    expect(badge).toHaveAttribute('title', 'Average rating 4.5 from 3 players - see the ratings');
    // A14.2 - the badge links to the Global game page's ratings.
    expect(badge.tagName).toBe('A');
    expect(badge).toHaveAttribute('href', '/games/gg-mm#ratings');
    expect(within(screen.getByTestId('owned-gg-afm')).queryByTestId('rating-badge')).not.toBeInTheDocument();

    // Title links only (the rating badge is a link too since A14.2).
    const titleLinks = (root: HTMLElement) => within(root).getAllByRole('link')
      .filter(a => a.getAttribute('data-testid') !== 'rating-badge')
      .map(a => a.textContent);
    const names = () => titleLinks(screen.getByTestId('my-tables-list'));
    expect(titleLinks(list)).toEqual(['Attack from Mars', 'Medieval Madness']);

    const sort = screen.getByTestId('my-tables-sort');
    fireEvent.click(within(sort).getByRole('button', { name: 'Top rated' }));
    await waitFor(() => expect(names()).toEqual(['Medieval Madness', 'Attack from Mars']));
    expect(within(sort).getByRole('button', { name: 'Top rated' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(within(sort).getByRole('button', { name: 'Name' }));
    await waitFor(() => expect(names()).toEqual(['Attack from Mars', 'Medieval Madness']));
  });

  it('toggling a chip PUTs the full new engine array', async () => {
    const calls = stubFetch();
    signIn();
    renderPage();

    const afm = await screen.findByTestId('owned-gg-afm');
    // AFM is held on VPX; adding Real must send both.
    fireEvent.click(within(afm).getByRole('button', { name: 'Real' }));
    await waitFor(() => {
      const put = calls.find(c => c.method === 'PUT');
      expect(put?.url).toBe('/api/me/tables/gg-afm');
      expect(put?.body).toEqual({ platforms: ['vpx', 'real'] });
    });
    await waitFor(() =>
      expect(within(screen.getByTestId('owned-gg-afm')).getByRole('button', { name: 'Real' }))
        .toHaveAttribute('aria-pressed', 'true'),
    );

    // Un-toggling VPX sends the remainder.
    fireEvent.click(within(screen.getByTestId('owned-gg-afm')).getByRole('button', { name: 'VPX' }));
    await waitFor(() => {
      const puts = calls.filter(c => c.method === 'PUT');
      expect(puts).toHaveLength(2);
      expect(puts[1]!.body).toEqual({ platforms: ['real'] });
    });
  });

  it('Remove DELETEs the table and drops it from the list', async () => {
    const calls = stubFetch();
    signIn();
    renderPage();

    await screen.findByTestId('owned-gg-mm');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Medieval Madness' }));
    await waitFor(() => {
      const del = calls.find(c => c.method === 'DELETE');
      expect(del?.url).toBe('/api/me/tables/gg-mm');
    });
    await waitFor(() => expect(screen.queryByTestId('owned-gg-mm')).not.toBeInTheDocument());
    expect(screen.getByTestId('owned-gg-afm')).toBeInTheDocument();
  });
});
