import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreateRoom from '../CreateRoom';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signInAs(discordId: string, username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64url({ alg: 'none' })}.${b64url({ discordId, username, avatar: null, exp })}.sig`;
  localStorage.setItem('arcaid_player_token', token);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/create-room']}>
      <ViewerAuthProvider>
        <CreateRoom />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

describe('CreateRoom', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('typing a name fills the web address', () => {
    signInAs('user-1');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })) as unknown as typeof fetch);
    renderPage();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: "Joe's Arcade" } });
    expect(screen.getByLabelText('Web address')).toHaveValue('joe_s_arcade');
  });

  it('an invalid web address shows the error text', () => {
    signInAs('user-1');
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })) as unknown as typeof fetch);
    renderPage();
    fireEvent.change(screen.getByLabelText('Web address'), { target: { value: 'bad slug!' } });
    expect(screen.getByText('Lowercase letters, numbers, and underscores only.')).toBeInTheDocument();
  });

  it('a 409 says the URL is taken', async () => {
    signInAs('user-1');
    vi.stubGlobal('fetch', vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return Promise.resolve({ ok: false, status: 409, json: () => Promise.resolve({ error: 'taken' }) });
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch);
    renderPage();
    fireEvent.change(screen.getByLabelText('Room name'), { target: { value: 'Taken Room' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create Room' }));
    await waitFor(() => expect(screen.getByText('That URL is taken. Try a different one.')).toBeInTheDocument());
  });
});
