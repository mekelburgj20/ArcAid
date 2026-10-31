import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import TableOwnersLine from '../TableOwnersLine';
import RatedByList from '../RatedByList';

/**
 * C2 - the two shared game-page pieces: the public owner count + the viewer's
 * "I own this" toggle, and the named "Rated by" list.
 */

type Call = { url: string; method: string; body: unknown; auth: string | undefined };

function stubOwners(initial: { count: number; mine: { owned: boolean; platforms: string[] } | null }) {
  const calls: Call[] = [];
  let state = initial;
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: headers.Authorization });
    const j = (b: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
    if (url.endsWith('/owners')) return j(state);
    if (method === 'PUT') { state = { count: state.count + 1, mine: { owned: true, platforms: [] } }; return j({ table: {} }); }
    if (method === 'DELETE') { state = { count: state.count - 1, mine: { owned: false, platforms: [] } }; return j({ ok: true, removed: true }); }
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return calls;
}

function renderOwners(token: string | null) {
  return render(
    <MemoryRouter>
      <TableOwnersLine globalGameId="gg-1" playerToken={token} />
    </MemoryRouter>,
  );
}

describe('TableOwnersLine (C2)', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('shows the count to a guest, with no toggle', async () => {
    stubOwners({ count: 4, mine: null });
    renderOwners(null);
    expect(await screen.findByText('4 players own this table')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('hides entirely for a guest when nobody owns it', async () => {
    const calls = stubOwners({ count: 0, mine: null });
    renderOwners(null);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(screen.queryByTestId('table-owners')).not.toBeInTheDocument();
  });

  it('lets a logged-in viewer add and remove it', async () => {
    const calls = stubOwners({ count: 0, mine: { owned: false, platforms: [] } });
    renderOwners('tok');

    expect(await screen.findByText('Be the first to add it to your tables')).toBeInTheDocument();
    expect(calls[0]!.auth).toBe('Bearer tok');
    expect(screen.getByRole('link', { name: 'Set platforms' })).toHaveAttribute('href', '/account/tables');

    fireEvent.click(screen.getByRole('button', { name: 'I own this' }));
    await screen.findByText('1 player owns this table');
    const put = calls.find(c => c.method === 'PUT')!;
    expect(put.url).toBe('/api/me/tables/gg-1');
    expect(put.body).toEqual({ platforms: [] });

    const owned = screen.getByRole('button', { name: 'Owned' });
    expect(owned).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(owned);
    await screen.findByText('Be the first to add it to your tables');
    expect(calls.find(c => c.method === 'DELETE')!.url).toBe('/api/me/tables/gg-1');
  });
});

describe('RatedByList (C2)', () => {
  const raters = [
    { user_id: '111111111111111111', display_name: 'Krobs', rating: 5, updated_at: '2026-10-02', platform: '' },
    { user_id: '222222222222222222', display_name: 'Wyo', rating: 3, updated_at: '2026-10-01', platform: '' },
  ];

  it('collapses to "Rated by N" and expands to names, never ids', () => {
    render(<RatedByList raters={raters} loggedIn={false} />);
    expect(screen.queryByText('Ratings are public and carry your name.')).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: /Rated by 2/ });
    expect(screen.queryByText('Krobs')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByText('Krobs')).toBeInTheDocument();
    expect(screen.getByText('Wyo')).toBeInTheDocument();
    expect(screen.getByLabelText('5 stars')).toBeInTheDocument();
    expect(screen.queryByText(/111111111111111111/)).not.toBeInTheDocument();
  });

  it('C3 - a per-platform row carries an engine chip; the count is distinct players', () => {
    const rows = [
      ...raters,
      { user_id: '111111111111111111', display_name: 'Krobs', rating: 4, updated_at: '2026-10-03', platform: 'vpx' },
    ];
    render(<RatedByList raters={rows} loggedIn={false} raterCount={2} />);
    fireEvent.click(screen.getByRole('button', { name: /Rated by 2/ }));
    expect(screen.getAllByText('Krobs')).toHaveLength(2);
    const chips = screen.getAllByTestId('rater-engine-chip');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('VPX');
  });

  it('C3 - falls back to the list length when no count is given', () => {
    const rows = [...raters, { user_id: '333', display_name: 'Zed', rating: 2, updated_at: '2026-10-04', platform: 'fx' }];
    render(<RatedByList raters={rows} loggedIn={false} />);
    expect(screen.getByRole('button', { name: /Rated by 3/ })).toBeInTheDocument();
  });

  it('tells a logged-in viewer their rating carries their name', () => {
    render(<RatedByList raters={[]} loggedIn />);
    expect(screen.getByText('Ratings are public and carry your name.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});
