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
let discordLinkPayload: unknown = null;

function mockNudge(nudge: unknown) {
  const dismissals: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/api/me/dm-nudge/dismiss')) {
      dismissals.push(url);
      return { ok: true, json: async () => ({ ok: true }) } as Response;
    }
    if (typeof url === 'string' && url.includes('/api/me/dm-nudge')) {
      return { ok: true, json: async () => ({ nudge, discordLink: discordLinkPayload }) } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  }));
  return dismissals;
}

function renderBanner(props: { roomDiscordEnabled?: boolean; roomId?: string } = {}) {
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
  discordLinkPayload = null;
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


/**
 * Discord-link nudge (2026-08-17). The owner's ask was "pop a message at every
 * Google user in a Discord room, and again on every score submission". Both
 * halves are wrong: the trigger is reachability rather than login provider, and
 * a per-submission modal nags the exact players who chose not to link. These
 * pin the shape that replaced it.
 */
describe('NotificationNudgeBanner — Discord link nudge', () => {
  const ROOM = 'room-abc';

  it('asks about a specific room, and prompts to LINK when no Discord is attached', async () => {
    signIn();
    discordLinkPayload = { state: 'no_discord', roomName: 'RTX_Pinball', inviteUrl: null };
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: true, roomId: ROOM });

    expect(await screen.findByText(/RTX_Pinball runs its tournaments through Discord/i)).toBeInTheDocument();
    expect(screen.getByText('Link Discord')).toBeInTheDocument();
    // Never implies submitting is blocked — it isn't.
    expect(screen.getByText(/keep playing and submitting scores/i)).toBeInTheDocument();
    expect((globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .some(c => String(c[0]).includes('roomId=' + ROOM))).toBe(true);
  });

  it('prompts to JOIN THE SERVER — not to link — when Discord is linked but not in the guild', async () => {
    signIn();
    discordLinkPayload = { state: 'not_in_guild', roomName: 'RTX_Pinball', inviteUrl: 'https://discord.gg/abc' };
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: true, roomId: ROOM });

    expect(await screen.findByText(/don't share its server/i)).toBeInTheDocument();
    const join = screen.getByText('Join the Discord server') as HTMLAnchorElement;
    expect(join.getAttribute('href')).toBe('https://discord.gg/abc');
    expect(screen.queryByText('Link Discord')).not.toBeInTheDocument();
  });

  it('degrades gracefully when the room has no invite url configured', async () => {
    signIn();
    discordLinkPayload = { state: 'not_in_guild', roomName: 'RTX_Pinball', inviteUrl: null };
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: true, roomId: ROOM });

    expect(await screen.findByText(/Ask a room admin for an invite/i)).toBeInTheDocument();
  });

  it('stays silent when the server returns no status (already fine, or indeterminate)', async () => {
    signIn();
    discordLinkPayload = null;
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: true, roomId: ROOM });

    await waitFor(() => expect(screen.queryByText(/runs its tournaments through Discord/i)).not.toBeInTheDocument());
  });

  it('the DM-failure banner still takes precedence', async () => {
    signIn();
    discordLinkPayload = { state: 'no_discord', roomName: 'RTX_Pinball', inviteUrl: null };
    mockNudge(FAILED_NUDGE);
    renderBanner({ roomDiscordEnabled: true, roomId: ROOM });

    expect(await screen.findByText(/couldn't/i)).toBeInTheDocument();
    expect(screen.queryByText(/runs its tournaments through Discord/i)).not.toBeInTheDocument();
  });

  it('dismissal is per-room and time-boxed, not permanent', async () => {
    signIn();
    discordLinkPayload = { state: 'no_discord', roomName: 'RTX_Pinball', inviteUrl: null };
    mockNudge(null);
    const { unmount } = renderBanner({ roomDiscordEnabled: true, roomId: ROOM });

    fireEvent.click(await screen.findByLabelText('Dismiss'));
    await waitFor(() => expect(screen.queryByText(/runs its tournaments/i)).not.toBeInTheDocument());
    expect(localStorage.getItem('arcaid_discord_link_dismissed_' + ROOM)).toBeTruthy();
    unmount();

    // A DIFFERENT room is unaffected — the copy names a room, so the dismissal
    // has to be scoped to one.
    renderBanner({ roomDiscordEnabled: true, roomId: 'other-room' });
    expect(await screen.findByText(/runs its tournaments through Discord/i)).toBeInTheDocument();
  });

  it('a dismissal older than 30 days lets the nudge return', async () => {
    signIn();
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    localStorage.setItem('arcaid_discord_link_dismissed_' + ROOM, old);
    discordLinkPayload = { state: 'no_discord', roomName: 'RTX_Pinball', inviteUrl: null };
    mockNudge(null);
    renderBanner({ roomDiscordEnabled: true, roomId: ROOM });

    expect(await screen.findByText(/runs its tournaments through Discord/i)).toBeInTheDocument();
  });
});
