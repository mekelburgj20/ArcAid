import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import AccountSettings from '../AccountSettings';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';

/** The five reminder opt-ins and the "Remind me after" delay on Account Settings. */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signIn(discordId = '123456789012345678') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const jwt = `${b64url({ alg: 'none' })}.${b64url({ discordId, username: 'Tester', avatar: null, exp })}.sig`;
  localStorage.setItem('arcaid_player_token', jwt);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

type FetchArgs = [url: string, init?: RequestInit];

function stubFetch(prefs: Record<string, unknown>) {
  const puts: Record<string, unknown>[] = [];
  const settings = {
    prefs,
    types: ['playReminder', 'halfwayReminder', 'endingSoon', 'inactiveReminder', 'podiumLost'],
    webPushTypes: ['playReminder'],
    playReminderHourOptions: [24, 48, 72],
    discord: { available: true, reachable: true, via: null, viaRoomName: null, gatewayReady: true, connectAvailable: false, inviteUrl: null },
  };
  vi.stubGlobal('fetch', vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/me/notification-settings')) {
      if (method === 'PUT') puts.push(JSON.parse(String(init!.body)));
      return j(settings);
    }
    if (url.includes('/identity/claims')) return j({ aliases: [], pending: [] });
    if (url.includes('/me/profile')) {
      return j({ discordUserId: '123456789012345678', displayName: 'Tester', avatarHash: null, identities: [] });
    }
    return j({});
  }) as unknown as typeof fetch);
  return { puts };
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

/** The switch inside the row whose label text is `label`. */
async function rowSwitch(label: string) {
  const text = await screen.findByText(label, { selector: 'span.block' });
  return within(text.closest('label')!).getByRole('switch');
}

describe('AccountSettings — reminder opt-ins', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    signIn();
  });

  it('renders the five new rows', async () => {
    stubFetch({});
    renderPage();
    for (const label of ['Not Played Yet', 'Halfway Point', '3 Days Left', '3 Days Without a Score', 'Knocked Off the Podium']) {
      expect(await screen.findByText(label, { selector: 'span.block' })).toBeInTheDocument();
    }
  });

  it('shows the delay select only while Not Played Yet is on', async () => {
    stubFetch({});
    renderPage();
    const sw = await rowSwitch('Not Played Yet');
    expect(screen.queryByLabelText('Remind me after')).toBeNull();
    fireEvent.click(sw);
    expect(await screen.findByLabelText('Remind me after')).toHaveValue('24');
    fireEvent.click(sw);
    expect(screen.queryByLabelText('Remind me after')).toBeNull();
  });

  it('saves the chosen delay as a number alongside the toggle', async () => {
    const { puts } = stubFetch({});
    renderPage();
    fireEvent.click(await rowSwitch('Not Played Yet'));
    fireEvent.change(await screen.findByLabelText('Remind me after'), { target: { value: '48' } });
    const section = (await screen.findByLabelText('Remind me after')).closest('section')!;
    fireEvent.click(within(section).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(puts.length).toBe(1));
    const prefs = (puts[0].prefs ?? puts[0]) as Record<string, unknown>;
    expect(prefs.playReminder).toBe(true);
    expect(prefs.playReminderHours).toBe(48);
  });

  it('shows a stored 72-hour delay as selected on load', async () => {
    stubFetch({ playReminder: true, playReminderHours: 72 });
    renderPage();
    expect(await screen.findByLabelText('Remind me after')).toHaveValue('72');
  });
});
