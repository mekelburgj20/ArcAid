import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AccountSettings from '../AccountSettings';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

/**
 * v2.125.0 — the "Arcaid chat responses to my messages" switch on Account
 * Settings.
 *
 * It shares the `notification_prefs` blob with the DM opt-ins but inverts both
 * of their conventions: it is an INBOUND reply, not an outbound DM, and it
 * defaults to ON rather than OFF. Those two differences are the whole reason it
 * renders outside the `NOTIF_TYPES` map, and they are what this file pins — a
 * future refactor that folds it back into the list would flip its default and
 * silence the bot for every user who has never opened this page.
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

type FetchArgs = [url: string, init?: RequestInit];

/** Serves the notification-settings payload; records every PUT body. */
function stubFetch(prefs: Record<string, unknown>) {
  const puts: Record<string, unknown>[] = [];
  const settings = {
    prefs,
    types: ['tournamentWin', 'turnToPick', 'tournamentStarting', 'rankDethroned', 'friendScore', 'rotationReady', 'queueLow'],
    webPushTypes: ['turnToPick'],
    discord: { available: true, reachable: true, via: null, viaRoomName: null, gatewayReady: true, connectAvailable: false, inviteUrl: null },
  };
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/me/notification-settings')) {
      if (method === 'PUT') {
        const body = JSON.parse(String(init!.body));
        puts.push(body.prefs ?? body);
        return j(settings);
      }
      return j(settings);
    }
    // The page also loads the identity-claims panel; a bare {} there throws on
    // `claims.aliases.length` and takes the whole render down.
    if (url.includes('/identity/claims')) {
      return j({ aliases: [], pending: [] });
    }
    if (url.includes('/me/profile')) {
      return j({ discordUserId: '123456789012345678', displayName: 'Tester', avatarHash: null, identities: [] });
    }
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { fetchMock, puts };
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/account/settings']}>
      <ViewerAuthProvider>
        <AccountSettings />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

const SWITCH_NAME = 'Arcaid chat responses to my messages';

/**
 * The page has several Save buttons (display name, notifications, …), so the
 * notifications one is reached through the section this switch lives in rather
 * than by label alone.
 */
async function saveNotifications() {
  const section = (await screen.findByTestId('chat-responses-pref')).closest('section')!;
  fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
}

describe('AccountSettings — Arcaid chat responses switch', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    signIn();
  });

  it('reads ON when the pref has never been set (absent === on)', async () => {
    stubFetch({});
    renderPage();

    const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
  });

  it('reads OFF only for an explicit false', async () => {
    stubFetch({ chatResponses: false });
    renderPage();

    const toggle = await screen.findByRole('switch', { name: SWITCH_NAME });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
  });

  it('does NOT inherit the DM opt-ins default-off convention', async () => {
    // Every NOTIF_TYPES switch is off here; the chat one must not be.
    stubFetch({ tournamentWin: false, turnToPick: false });
    renderPage();

    expect(await screen.findByRole('switch', { name: SWITCH_NAME }))
      .toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: /Tournament Win/ }))
      .toHaveAttribute('aria-checked', 'false');
  });

  it('turning it off PUTs chatResponses: false', async () => {
    const { puts } = stubFetch({});
    renderPage();

    fireEvent.click(await screen.findByRole('switch', { name: SWITCH_NAME }));
    await saveNotifications();

    await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    expect(puts[puts.length - 1]!.chatResponses).toBe(false);
  });

  it('turning it back on PUTs chatResponses: true', async () => {
    const { puts } = stubFetch({ chatResponses: false });
    renderPage();

    fireEvent.click(await screen.findByRole('switch', { name: SWITCH_NAME }));
    await saveNotifications();

    await waitFor(() => expect(puts.length).toBeGreaterThan(0));
    expect(puts[puts.length - 1]!.chatResponses).toBe(true);
  });

  it('mentions the in-chat shortcut, so the switch is not the only known way out', async () => {
    stubFetch({});
    renderPage();

    expect(await screen.findByTestId('chat-responses-pref')).toHaveTextContent('Arcaid, shush');
  });
});
