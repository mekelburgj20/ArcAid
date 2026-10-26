import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import EntryNotice from '../EntryNotice';

/**
 * Invite-only notice (v2.179.0, W39) — shown to a logged-in player off the
 * roster, silent otherwise.
 */

function mockFetch(me: unknown, requestStatus = 'pending') {
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/entry/me')) return new Response(JSON.stringify(me), { status: 200 });
    if (url.endsWith('/entry/request') && init?.method === 'POST') {
      return new Response(JSON.stringify({ status: requestStatus }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('EntryNotice', () => {
  it('a player off the roster sees the notice and can request to join', async () => {
    const fetchFn = mockFetch({ mode: 'invited', onRoster: false, request: null, canRequest: true });
    const toast = vi.fn();
    render(<EntryNotice roomId="r-1" tournamentId="t-1" playerToken="tok" toast={toast} />);
    expect(await screen.findByTestId('entry-notice')).toHaveTextContent('Invite-only');
    fireEvent.click(screen.getByTestId('request-entry'));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Request sent to the host', 'success'));
    expect(fetchFn).toHaveBeenCalledWith('/api/rooms/r-1/tournaments/t-1/entry/request', expect.objectContaining({ method: 'POST' }));
    expect(await screen.findByText('Your request to join is waiting for the host.')).toBeInTheDocument();
  });

  it('says nothing to a player on the roster, on an open tournament, or when logged out', async () => {
    mockFetch({ mode: 'invited', onRoster: true, request: null, canRequest: false });
    const { unmount } = render(<EntryNotice roomId="r-1" tournamentId="t-1" playerToken="tok" toast={() => {}} />);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('entry-notice')).toBeNull();
    unmount();

    mockFetch({ mode: 'members', onRoster: false, request: null, canRequest: false });
    const second = render(<EntryNotice roomId="r-1" tournamentId="t-1" playerToken="tok" toast={() => {}} />);
    await new Promise(r => setTimeout(r, 20));
    expect(screen.queryByTestId('entry-notice')).toBeNull();
    second.unmount();

    const fetchFn = mockFetch({ mode: 'invited', onRoster: false, request: null, canRequest: true });
    render(<EntryNotice roomId="r-1" tournamentId="t-1" playerToken={null} toast={() => {}} />);
    expect(screen.queryByTestId('entry-notice')).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
