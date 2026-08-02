import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import NotificationNudgeBanner from '../NotificationNudgeBanner';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';

/**
 * Discord HQ arc (v2.72.0), contract Sections 4 + 5 — the site-wide nudges.
 *
 * The banner is the ONLY way a player learns that Arcaid tried to DM them and
 * Discord refused: the send path swallows that failure by design. So the cases
 * that matter are "does it appear when it should", "does it stay gone once
 * dismissed", and — just as important — "does it stay silent otherwise",
 * because a false alarm here nags every page of the app.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signIn(discordId = '111122223333444455') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username: 'Tester', avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username: 'Tester', avatar: null }));
}

/** Mock /api/me/dm-nudge; returns the recorded dismiss calls. */
function mockNudge(nudge: unknown) {
  const dismissals: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/me/dm-nudge/dismiss')) {
      dismissals.push(url);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (typeof url === 'string' && url.includes('/api/me/dm-nudge')) {
      return { ok: true, json: async () => ({ nudge }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
  return dismissals;
}

function renderBanner(props: { roomDiscordEnabled?: boolean } = {}) {
  return render(
    <MemoryRouter>
      <ViewerAuthProvider>
        <NotificationNudgeBanner {...props} />
      </ViewerAuthProvider>
    </MemoryRouter>,
  );
}

const FAILED_NUDGE = { failedAt: '2026-08-01T10:00:00.000Z', reason: 'send_failed', type: 'tournamentWin' };

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NotificationNudgeBanner — failure nudge (Section 4)', () => {
  it('renders nothing for a signed-out visitor', async () => {
    mockNudge(FAILED_NUDGE);
    renderBanner();
    await waitFor(() => {
      expect(screen.queryByText(/couldn't/i)).not.toBeInTheDocument();
    });
  });

  it('warns when the server reports a failed DM', async () => {
    signIn();
    mockNudge(FAILED_NUDGE);
    renderBanner();

    expect(await screen.findByText(/tried to send you a Discord notification but couldn't/i))
      .toBeInTheDocument();
    expect(screen.getByRole('link', { name: /notification settings/i })).toBeInTheDocument();
  });

  it('disappears on dismiss and tells the server to clear the flag', async () => {
    signIn();
    const dismissals = mockNudge(FAILED_NUDGE);
    renderBanner();

    fireEvent.click(await screen.findByLabelText('Dismiss'));

    await waitFor(() => {
      expect(screen.queryByText(/tried to send you a Discord notification/i)).not.toBeInTheDocument();
    });
    expect(dismissals).toHaveLength(1);
  });

  it('stays silent when there is no pending nudge', async () => {
    signIn();
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: true });

    await waitFor(() => {
      expect(screen.queryByText(/tried to send you a Discord notification/i)).not.toBeInTheDocument();
    });
  });
});

describe('NotificationNudgeBanner — onboarding offer (Section 5)', () => {
  it('offers setup in a room without Discord integration', async () => {
    signIn();
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: false });

    expect(await screen.findByText(/Want score and pick notifications\?/i)).toBeInTheDocument();
  });

  it('stays silent in a Discord-connected room — DMs already work there', async () => {
    signIn();
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: true });

    await waitFor(() => {
      expect(screen.queryByText(/Want score and pick notifications\?/i)).not.toBeInTheDocument();
    });
  });

  it('yields to the failure warning rather than stacking two banners', async () => {
    signIn();
    mockNudge(FAILED_NUDGE);
    renderBanner({ roomDiscordEnabled: false });

    expect(await screen.findByText(/tried to send you a Discord notification/i)).toBeInTheDocument();
    expect(screen.queryByText(/Want score and pick notifications\?/i)).not.toBeInTheDocument();
  });

  it('stays dismissed across mounts', async () => {
    signIn();
    mockNudge(null);
    const view = renderBanner({ roomDiscordEnabled: false });

    fireEvent.click(await screen.findByLabelText('Dismiss'));
    view.unmount();

    renderBanner({ roomDiscordEnabled: false });
    await waitFor(() => {
      expect(screen.queryByText(/Want score and pick notifications\?/i)).not.toBeInTheDocument();
    });
  });
});
