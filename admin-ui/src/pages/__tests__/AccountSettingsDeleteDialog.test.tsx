import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AccountSettings from '../AccountSettings';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/** G23e: the delete-account confirmation is the Arcaid dialog, as guarded as before. */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signIn(discordId = '123456789012345678') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${b64url({ alg: 'none' })}.${b64url({ discordId, username: 'Tester', avatar: null, exp })}.sig`;
  localStorage.setItem('arcaid_player_token', jwt);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

function stubFetch() {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/me/notification-settings')) {
      return j({ prefs: {}, types: [], webPushTypes: [], playReminderHourOptions: [24], discord: { available: true, reachable: true, via: null, viaRoomName: null, gatewayReady: true, connectAvailable: false, inviteUrl: null } });
    }
    if (url.includes('/identity/claims')) return j({ aliases: [], pending: [] });
    if (url.includes('/me/profile')) return j({ discordUserId: '123456789012345678', displayName: 'Tester', avatarHash: null, identities: [] });
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/account/settings']}>
      <ThemeProvider>
        <ViewerAuthProvider>
          <AccountSettings />
        </ViewerAuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

describe('AccountSettings — delete account dialog', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    signIn();
    stubFetch();
  });

  async function open() {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Delete my account/ }));
    await waitForRealDialog();
  }

  it('opens as "Delete your account?", focus on the typed confirmation, delete disabled until DELETE', async () => {
    await open();
    expect(screen.getByRole('dialog', { name: 'Delete your account?' })).toBeInTheDocument();
    const input = screen.getByLabelText(/to confirm/);
    await waitFor(() => expect(document.activeElement).toBe(input));
    const del = screen.getByRole('button', { name: /^Delete account$/ });
    expect(del).toBeDisabled();
    fireEvent.change(input, { target: { value: 'DELETE' } });
    expect(del).toBeEnabled();
  });

  it('Escape closes it', async () => {
    await open();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete your account?' })).not.toBeInTheDocument());
  });
});
