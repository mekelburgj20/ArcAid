import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Friends from '../Friends';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

// G22: Friends loads through useRetryingLoad, so a failed load is "couldn't
// load" and never the silent "No friends added yet".

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signInAs(discordId: string, username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64url({ alg: 'none' })}.${b64url({ discordId, username, avatar: null, exp })}.sig`;
  localStorage.setItem('arcaid_player_token', token);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

function renderFriends() {
  return render(
    <MemoryRouter initialEntries={['/friends']}>
      <ViewerAuthProvider>
        <Friends />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

const FRIENDS = [
  { id: 'f1', friend_user_id: 'u-1', friend_discord_username: 'wiz_discord', iscored_username: 'WizIscored', display_name: 'Wizard Ann', avatar_hash: null, avatar_url: null, created_at: '2026-01-01' },
  { id: 'f2', friend_user_id: 'u-2', friend_discord_username: null, iscored_username: 'Bobby', display_name: null, avatar_hash: null, avatar_url: null, created_at: '2026-01-02' },
];

describe('Friends', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists the friends by name', async () => {
    signInAs('me-1');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(FRIENDS) })) as unknown as typeof fetch);
    renderFriends();
    expect(await screen.findByText('Wizard Ann')).toBeInTheDocument();
    expect(screen.getByText('Bobby')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Bobby' })).toBeInTheDocument();
    expect(screen.queryByText('No friends added yet.')).toBeNull();
  });

  it('a 500 shows the load-failed notice, never the empty text', async () => {
    signInAs('me-1');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) })) as unknown as typeof fetch);
    renderFriends();
    expect(await screen.findByTestId('load-failed')).toBeInTheDocument();
    expect(screen.queryByText('No friends added yet.')).toBeNull();
  });

  it('Remove calls DELETE /api/me/friends/<id>', async () => {
    signInAs('me-1');
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(FRIENDS) });
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    renderFriends();
    fireEvent.click(await screen.findByRole('button', { name: 'Remove Bobby' }));
    await waitFor(() => {
      const del = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
      expect(del).toHaveLength(1);
      expect(del[0]![0]).toBe('/api/me/friends/u-2');
    });
  });
});
