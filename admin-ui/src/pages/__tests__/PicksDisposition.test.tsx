import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Picks from '../Picks';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ToastProvider } from '../../components/Toast';

/**
 * Next-win disposition control (ROADMAP, locked 2026-08-09) + the v2.97.x
 * nominee-field upgrade: the "If I win next…" control's "Give my pick to…"
 * branch now offers a room-member picker (search-and-click, the common case)
 * alongside the pre-existing free-text Discord ID/@mention fallback.
 *
 * Follows the PicksAlertStates idiom: signIn() writes the player token/user
 * to localStorage directly (no OAuth round trip), each test uses a unique
 * slug (getPortal/usePickAwardEnabled memoize per slug in module-level
 * caches that outlive a single test), and stubFetch is a URL-prefix switch
 * covering every endpoint the page touches.
 */

const ROOM_ID = 'room-1';

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}
function signIn(discordId = '111111111111111111', username = 'Tester') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

const AVAILABILITY = {
  tournament: { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball' },
  eligibilityDays: 120,
  games: [
    { name: 'Attack from Mars', available: true, daysUntilAvailable: 0, lastPlayedDate: null, lastEndDate: null, lastStatus: null, winnerName: null, winnerScore: null, allTimeHigh: null, allTimeHighPlayer: null },
  ],
};

const TOURNAMENTS = [
  { id: 't-1', name: 'Daily Grind', type: 'DG', mode: 'pinball', is_active: 1, max_active_games: 1, platform_rules: '{}' },
];

const EMPTY_STATUS = { pendingPicks: [], queuedGames: [], tournaments: TOURNAMENTS };
const EMPTY_ALERTS = { pendingPickCount: 0, emptyQueue: [], ineligible: [], count: 0, urgent: false };

const ROSTER = [
  { userId: '222222222222222222', displayName: 'Krobs', username: 'krobs', iscoredUsername: null, avatarHash: null, avatarUrl: null },
  { userId: '333333333333333333', displayName: 'ChuckRibbits', username: 'chuck', iscoredUsername: null, avatarHash: null, avatarUrl: null },
  // google:* identities can't be Discord-nominated — must be excluded.
  { userId: 'google:abc123', displayName: 'GoogleGamer', username: null, iscoredUsername: null, avatarHash: null, avatarUrl: null },
  // The signed-in viewer themself — server rejects self-nomination.
  { userId: '111111111111111111', displayName: 'Tester', username: 'tester', iscoredUsername: null, avatarHash: null, avatarUrl: null },
];

interface StubOpts {
  disposition?: { disposition: 'nominate' | 'forfeit'; nomineeDiscordId: string | null } | null;
  members?: unknown[] | null; // null => /members 500s
  putHandler?: (body: { disposition?: string; nomineeDiscordId?: string }) => { status: number; body: unknown };
  deleteHandler?: () => { status: number; body: unknown };
}

/** @param slug unique per test — getPortal/usePickAwardEnabled memoize per slug across tests. */
function stubFetch(slug: string, opts: StubOpts = {}) {
  const { disposition = null, members = ROSTER, putHandler, deleteHandler } = opts;
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const j = (body: unknown, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      return j({ id: ROOM_ID, roomId: ROOM_ID, slug, name: 'RTX Pinball', pick_award_enabled: true });
    }
    if (url.includes('/pick-disposition')) {
      const method = init?.method ?? 'GET';
      if (method === 'GET') return j({ disposition });
      if (method === 'PUT') {
        const body = init?.body ? JSON.parse(init.body as string) : {};
        const result = putHandler ? putHandler(body) : { status: 200, body: { disposition: body } };
        return j(result.body, result.status);
      }
      if (method === 'DELETE') {
        const result = deleteHandler ? deleteHandler() : { status: 200, body: { success: true } };
        return j(result.body, result.status);
      }
    }
    if (url.includes('/members')) {
      if (members === null) return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
      return j(members);
    }
    if (url.includes('/pick-alerts')) return j(EMPTY_ALERTS);
    if (url.includes('/pick-status')) return j(EMPTY_STATUS);
    if (url.includes('/game-availability')) return j(AVAILABILITY);
    if (url.includes('/tournaments')) return j(TOURNAMENTS);
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { fetchMock, calls };
}

function renderPicks(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/${slug}/picks`]}>
      <ToastProvider>
        <ViewerAuthProvider>
          <Routes>
            <Route path="/:slug/picks" element={<Picks />} />
          </Routes>
        </ViewerAuthProvider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

describe('Picks page — next-win disposition control', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders the control for a signed-in viewer with a tournament selected', async () => {
    signIn();
    stubFetch('disp_render_room');
    renderPicks('disp_render_room');

    expect(await screen.findByText('If I win next…')).toBeInTheDocument();
    expect(screen.getByText('Forfeit to runner-up')).toBeInTheDocument();
    expect(screen.getByText('Give my pick to…')).toBeInTheDocument();
  });

  it('is hidden when logged out', async () => {
    // No signIn().
    stubFetch('disp_guest_room');
    renderPicks('disp_guest_room');

    await screen.findByText('Picks');
    expect(screen.queryByText('If I win next…')).not.toBeInTheDocument();
  });

  it('GET prefill: an existing nominate disposition renders the roster-resolved name', async () => {
    signIn();
    stubFetch('disp_prefill_room', {
      disposition: { disposition: 'nominate', nomineeDiscordId: '222222222222222222' },
    });
    renderPicks('disp_prefill_room');

    await screen.findByText(/Currently set to hand off to/);
    // Roster resolution lands a tick after the disposition renders (separate
    // fetch) — wait for the resolved name rather than asserting immediately.
    const krobs = await screen.findByText('Krobs');
    const line = krobs.closest('p')!;
    expect(within(line).queryByText(/<@/)).not.toBeInTheDocument();
  });

  it('GET prefill: an unresolvable id (not in roster) keeps the raw <@id> rendering', async () => {
    signIn();
    stubFetch('disp_prefill_unknown_room', {
      disposition: { disposition: 'nominate', nomineeDiscordId: '999999999999999999' },
    });
    renderPicks('disp_prefill_unknown_room');

    const label = await screen.findByText(/Currently set to hand off to/);
    const line = label.closest('p')!;
    expect(within(line).getByText('<@999999999999999999>')).toBeInTheDocument();
  });

  it('forfeit: click issues a PUT with { disposition: "forfeit" }', async () => {
    signIn();
    const { fetchMock } = stubFetch('disp_forfeit_room');
    renderPicks('disp_forfeit_room');

    fireEvent.click(await screen.findByText('Forfeit to runner-up'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/pick-disposition') && (c[1] as RequestInit)?.method === 'PUT');
      expect(putCall).toBeTruthy();
      expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({ disposition: 'forfeit' });
    });
  });

  it('clear: click issues a DELETE', async () => {
    signIn();
    const { fetchMock } = stubFetch('disp_clear_room', {
      disposition: { disposition: 'forfeit', nomineeDiscordId: null },
    });
    renderPicks('disp_clear_room');

    const clearBtn = await screen.findByText('Pick from my queue');
    await waitFor(() => expect(clearBtn).not.toBeDisabled());
    fireEvent.click(clearBtn);

    await waitFor(() => {
      const delCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/pick-disposition') && (c[1] as RequestInit)?.method === 'DELETE');
      expect(delCall).toBeTruthy();
    });
  });

  it('nominate via picker: roster renders with google:* and self excluded, and clicking a member PUTs their id', async () => {
    signIn();
    const { fetchMock } = stubFetch('disp_picker_room');
    renderPicks('disp_picker_room');

    fireEvent.click(await screen.findByText('Give my pick to…'));

    const picker = await screen.findByTestId('member-admin-picker');
    expect(within(picker).getByText('Krobs')).toBeInTheDocument();
    expect(within(picker).getByText('ChuckRibbits')).toBeInTheDocument();
    // google:* identity excluded — can't be Discord-nominated.
    expect(within(picker).queryByText('GoogleGamer')).not.toBeInTheDocument();
    // The signed-in viewer excluded — self-nomination is rejected server-side.
    expect(within(picker).queryByText('Tester')).not.toBeInTheDocument();

    fireEvent.click(within(picker).getByText('Krobs'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/pick-disposition') && (c[1] as RequestInit)?.method === 'PUT');
      expect(putCall).toBeTruthy();
      expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
        disposition: 'nominate',
        nomineeDiscordId: '222222222222222222',
      });
    });
    // Picking a member does NOT go through the admin-add endpoint.
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/admins/discord'))).toBe(false);
  });

  it('free-text fallback: pasting an @mention PUTs the parsed id', async () => {
    signIn();
    const { fetchMock } = stubFetch('disp_freetext_room');
    renderPicks('disp_freetext_room');

    fireEvent.click(await screen.findByText('Give my pick to…'));
    const input = await screen.findByLabelText('Nominee Discord username or ID');
    fireEvent.change(input, { target: { value: '<@444444444444444444>' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/pick-disposition') && (c[1] as RequestInit)?.method === 'PUT');
      expect(putCall).toBeTruthy();
      expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
        disposition: 'nominate',
        nomineeDiscordId: '444444444444444444',
      });
    });
  });

  it('free-text fallback: a typed username is sent raw and the server-resolved name renders (v2.98.1)', async () => {
    signIn();
    // Server resolves '@chuckribbits' → id + display name (the guild-member-
    // but-not-room-member case: '4444…' is NOT in ROSTER, so the rendered
    // name can only come from the PUT response's nomineeDisplayName).
    const { fetchMock } = stubFetch('disp_freetext_name_room', {
      putHandler: () => ({
        status: 200,
        body: { disposition: { disposition: 'nominate', nomineeDiscordId: '444444444444444444', nomineeDisplayName: 'ChuckRibbits' } },
      }),
    });
    renderPicks('disp_freetext_name_room');

    fireEvent.click(await screen.findByText('Give my pick to…'));
    const input = await screen.findByLabelText('Nominee Discord username or ID');
    fireEvent.change(input, { target: { value: '@chuckribbits' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(c => String(c[0]).includes('/pick-disposition') && (c[1] as RequestInit)?.method === 'PUT');
      expect(putCall).toBeTruthy();
      // Sent raw — resolution is server-side against the linked guild.
      expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
        disposition: 'nominate',
        nomineeDiscordId: '@chuckribbits',
      });
    });
    const label = await screen.findByText(/Currently set to hand off to/);
    const line = label.closest('p')!;
    expect(within(line).getByText('ChuckRibbits')).toBeInTheDocument();
    expect(within(line).queryByText(/<@/)).not.toBeInTheDocument();
  });

  it('free-text fallback: a server rejection (unresolvable name) surfaces the server message', async () => {
    signIn();
    const { fetchMock } = stubFetch('disp_freetext_reject_room', {
      putHandler: () => ({
        status: 400,
        body: { error: `Couldn't find a Discord member matching "@nobody" in this room's server. Check the spelling, or paste their numeric Discord ID.` },
      }),
    });
    renderPicks('disp_freetext_reject_room');

    fireEvent.click(await screen.findByText('Give my pick to…'));
    const input = await screen.findByLabelText('Nominee Discord username or ID');
    fireEvent.change(input, { target: { value: '@nobody' } });
    fireEvent.click(screen.getByText('Save'));

    expect(await screen.findByText(/Couldn't find a Discord member/)).toBeInTheDocument();
    // Disposition unchanged — still no stored nomination.
    expect(screen.queryByText(/Currently set to hand off to/)).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/pick-disposition') && (c[1] as RequestInit)?.method === 'PUT')).toBe(true);
  });

  it('member roster fetch failure degrades to free-text-only, no error chrome', async () => {
    signIn();
    stubFetch('disp_members_fail_room', { members: null });
    renderPicks('disp_members_fail_room');

    fireEvent.click(await screen.findByText('Give my pick to…'));

    // Free-text input still present and usable.
    expect(await screen.findByLabelText('Nominee Discord username or ID')).toBeInTheDocument();
    // No picker (no candidates resolved) and no error text anywhere.
    await waitFor(() => expect(screen.queryByTestId('member-admin-picker')).not.toBeInTheDocument());
    expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/fail/i)).not.toBeInTheDocument();
  });
});
