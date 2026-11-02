import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import MyRooms from '../MyRooms';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

// v2.38.0 — join-leave contract. MyRooms backs onto the shared useMyRooms
// hook. W21 (2026-10-23) removed the row's one-tap leave icon after an
// accidental leave on a phone; W84 (owner, 2026-11-01) brings leave back as a
// LABELLED button OUTSIDE the row's Link that asks first, with the same
// confirm as the room's user menu.

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signInAs(discordId: string, username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

function renderMyRooms() {
  return render(
    <MemoryRouter initialEntries={['/my-rooms']}>
      <ToastProvider>
        <ViewerAuthProvider>
          <Routes>
            <Route path="/my-rooms" element={<MyRooms />} />
            <Route path="/:slug" element={<div>ROOM PAGE</div>} />
          </Routes>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const ROOMS = [
  { roomId: 'room-1', name: 'RTX Pinball', slug: 'rtx_pinball', logoUrl: null, joinedAt: '2026-01-01', source: 'self_join', lastActivityAt: null },
  { roomId: 'room-2', name: 'Wizard Room', slug: 'wizard', logoUrl: null, joinedAt: '2026-01-02', source: 'submission', lastActivityAt: null },
];

/** Stubs fetch: GET /api/me/rooms answers ROOMS; a DELETE answers `deleteOk`. */
function stubFetch(deleteOk = true) {
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      return Promise.resolve({
        ok: deleteOk,
        status: deleteOk ? 200 : 500,
        json: () => Promise.resolve(deleteOk ? { success: true } : { error: 'boom' }),
      });
    }
    if (url.startsWith('/api/me/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve(ROOMS) });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function deleteCalls(fetchMock: ReturnType<typeof stubFetch>) {
  return fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
}

describe('MyRooms', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('logged-out: prompts to log in, no room list', () => {
    renderMyRooms();
    expect(screen.getByText('Log in to see the rooms you belong to')).toBeInTheDocument();
  });

  it('each row has a Leave button labelled with the room name, outside the row link', async () => {
    signInAs('user-1', 'Justin');
    stubFetch();
    renderMyRooms();
    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());

    const buttons = screen.getAllByTestId('my-rooms-leave');
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Leave RTX Pinball' })).toHaveTextContent('Leave');
    expect(screen.getByRole('button', { name: 'Leave Wizard Room' })).toBeInTheDocument();
    // W21: the button must never sit inside the Link (a tap on it would navigate).
    for (const b of buttons) expect(b.closest('a')).toBeNull();
  });

  it('clicking Leave opens the confirm and does NOT navigate', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = stubFetch();
    renderMyRooms();
    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Leave RTX Pinball' }));

    const dialog = screen.getByRole('dialog', { name: 'Leave RTX Pinball?' });
    expect(within(dialog).getByText('Leave RTX Pinball?')).toBeInTheDocument();
    expect(within(dialog).getByText(/You can rejoin any time/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Leave room' })).toBeInTheDocument();
    expect(screen.queryByText('ROOM PAGE')).not.toBeInTheDocument();
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it('Cancel closes the confirm, leaves the list unchanged and calls nothing', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = stubFetch();
    renderMyRooms();
    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Leave RTX Pinball' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('my-rooms-row')).toHaveLength(2);
    expect(screen.getByText('RTX Pinball')).toBeInTheDocument();
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });

  it('Confirm calls leave once, removes the row and shows the toast', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = stubFetch(true);
    renderMyRooms();
    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Leave RTX Pinball' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

    await waitFor(() => expect(screen.getByText('You left RTX Pinball. You can rejoin any time.')).toBeInTheDocument());
    expect(screen.queryByText('RTX Pinball')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('my-rooms-row')).toHaveLength(1);
    expect(screen.getByText('Wizard Room')).toBeInTheDocument();
    const deletes = deleteCalls(fetchMock);
    expect(deletes).toHaveLength(1);
    expect(deletes[0][0]).toBe('/api/me/rooms/room-1');
  });

  it('a failed leave keeps the row and shows an error toast', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = stubFetch(false);
    renderMyRooms();
    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Leave RTX Pinball' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave room' }));

    await waitFor(() => expect(screen.getByText('Could not leave RTX Pinball — try again.')).toBeInTheDocument());
    expect(screen.getByText('RTX Pinball')).toBeInTheDocument();
    expect(screen.getAllByTestId('my-rooms-row')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Leave RTX Pinball' })).not.toBeDisabled();
    expect(deleteCalls(fetchMock)).toHaveLength(1);
  });

  it('clicking the room title still links to the room, with no dialog', async () => {
    signInAs('user-1', 'Justin');
    const fetchMock = stubFetch();
    renderMyRooms();
    await waitFor(() => expect(screen.getByText('RTX Pinball')).toBeInTheDocument());

    expect(screen.getByText('RTX Pinball').closest('a')).toHaveAttribute('href', '/rtx_pinball');
    fireEvent.click(screen.getByText('RTX Pinball'));

    await waitFor(() => expect(screen.getByText('ROOM PAGE')).toBeInTheDocument());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(deleteCalls(fetchMock)).toHaveLength(0);
  });
});
