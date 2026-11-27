import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';
import LandingPage from '../LandingPage';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../../components/ThemeProvider';
import { ToastProvider } from '../../components/Toast';
import { waitForRealDialog } from '../../test/dialogTestUtils';

/**
 * G35c - the landing page on the Arcaid look (owner 2026-11-26): the header
 * with the room switcher ("Your rooms"), the Global Scoreboard panel (its
 * lamp, Open link, hot tables and floating score cards), "Your rooms" with
 * Leave room in each card's ⋯ menu (the retired My Rooms page's leave flow
 * moved here), and the rooms you have not joined, concept D with each
 * room's `activeTables` (G35b). Each section reads on its own, so one
 * failing read shows `LoadFailedNotice` while the others render.
 */

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fakeJwt(payload: object): string {
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;
}

function signInAs(discordId: string, username: string) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', fakeJwt({ discordId, username, avatar: null, exp }));
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId, username, avatar: null }));
}

const TABLES = [
  { gameId: 'g-mm', name: 'Medieval Madness', imageUrl: '/art/mm.png', leaderName: 'FlipperKing', topScore: 48151623420 },
  { gameId: 'g-afm', name: 'Attack from Mars', imageUrl: null, leaderName: 'SilverStreak', topScore: 9876543210 },
  { gameId: 'g-taf', name: 'The Addams Family', imageUrl: null, leaderName: null, topScore: null },
  { gameId: 'g-extra', name: 'Fourth Table', imageUrl: null, leaderName: 'Nobody', topScore: 1 },
];

const ROOM = (id: string, name: string, slug: string, players: number, extra: Record<string, unknown> = {}) => ({
  id, slug, name, description: `${name} description`, is_public: true, logo_url: null,
  activeGames: 3, activePlayers: players, discordInviteUrl: null, join_policy: 'open', ...extra,
});

/** Listed rooms: tables / none / an approval room / a server from before G35b (no field). */
const RTX = ROOM('room-1', 'RTX Pinball', 'rtx_pinball', 10, { activeTables: TABLES });
const OTHER = ROOM('room-2', 'Other Room', 'other_room', 40, { activeTables: [] });
const BACK_GLASS = ROOM('room-3', 'The Back Glass Bar', 'back_glass_bar', 0, { join_policy: 'approval', activeGames: 0, activeTables: [] });
const OLD_SERVER = ROOM('room-4', 'Old Server Room', 'old_server', 25);
const LISTED = [RTX, OTHER, BACK_GLASS, OLD_SERVER];

const MINE = [
  { roomId: 'room-1', name: 'RTX Pinball', slug: 'rtx_pinball', logoUrl: null, joinedAt: '2026-01-01', source: 'submission', lastActivityAt: '2026-11-20 10:00:00' },
  { roomId: 'room-9', name: 'Private Room', slug: 'private_room', logoUrl: null, joinedAt: '2026-01-01', source: 'admin_invite', lastActivityAt: new Date(Date.now() - 2 * 3600e3).toISOString() },
  { roomId: 'room-8', name: 'Quiet Room', slug: 'quiet_room', logoUrl: null, joinedAt: '2026-01-01', source: 'self_join', lastActivityAt: null },
];

const RECENT = [
  { id: 's1', score: 1234567, iscored_username: 'flipper_raw', player_display_name: 'FlipperKing', submitted_at: new Date(Date.now() - 17 * 60e3).toISOString(), discord_user_id: '100000000000000001', global_game_id: 'gg-1', game_name: 'Medieval Madness', display_name: null, local_image_path: null, wheel_image_path: null, image_url: '/art/mm.png', avatar_hash: null, avatar_url: null },
  { id: 's2', score: 98765, iscored_username: 'TiltMaster', player_display_name: null, submitted_at: new Date(Date.now() - 50 * 60e3).toISOString(), discord_user_id: '100000000000000002', global_game_id: 'gg-2', game_name: 'Attack from Mars', display_name: null, local_image_path: null, wheel_image_path: null, image_url: null, avatar_hash: null, avatar_url: null },
];

const board = (id: string, name: string, category: string | null, count: number, top: Array<{ iscored_username: string; display_name?: string | null; score: number }>) => ({
  global_game_id: id, name, display_name: null, image_url: null, local_image_path: null, wheel_image_path: null,
  score_count: count, category, top_scores: top,
});
/** `?sort=popular`: one table twice (two categories), one with no score yet: three distinct tables come out. */
const HOT = {
  data: [
    board('gg-6', 'Theatre of Magic', 'simulation', 6, [{ iscored_username: 'p2raw', display_name: 'Player Two', score: 1234567890 }]),
    board('gg-6', 'Theatre of Magic', 'real', 2, [{ iscored_username: 'Someone', score: 5 }]),
    board('gg-5', 'Monster Bash', null, 0, []),
    board('gg-1', 'Medieval Madness', 'simulation', 4, [{ iscored_username: 'Player1', score: 48151623420 }]),
    board('gg-2', 'Attack from Mars', null, 3, [{ iscored_username: 'Player5', score: 9876543210 }]),
    board('gg-3', 'The Addams Family', null, 1, [{ iscored_username: 'Player8', score: 912345678 }]),
  ],
  total: 6, hasMore: false,
};

type Fail = 'rooms' | 'recent' | 'hot' | 'me';

function mockFetch(opts: { rooms?: unknown[]; meRooms?: unknown[]; joinRequestStatus?: string; fail?: Fail[]; deleteOk?: boolean } = {}) {
  const fail = new Set(opts.fail ?? []);
  const down = () => Promise.resolve({ ok: false, status: 503, headers: new Headers(), json: () => Promise.resolve({ error: 'down' }) });
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, headers: new Headers(), json: () => Promise.resolve(body) });
  const fetchMock = vi.fn((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.includes('join-request')) return ok({ status: opts.joinRequestStatus ?? 'pending' });
    if (url.startsWith('/api/me/rooms/') && method === 'DELETE') {
      return opts.deleteOk === false ? down() : ok({ success: true });
    }
    if (url.startsWith('/api/me/rooms/') && method === 'POST') return ok({ success: true });
    if (url === '/api/me/rooms') return fail.has('me') ? down() : ok(opts.meRooms ?? []);
    if (url === '/api/rooms') return fail.has('rooms') ? down() : ok(opts.rooms ?? LISTED);
    if (url.startsWith('/api/global/recent-scores')) return fail.has('recent') ? down() : ok(RECENT);
    if (url.startsWith('/api/global/scoreboard')) return fail.has('hot') ? down() : ok(HOT);
    return Promise.resolve({ ok: false, status: 404, headers: new Headers(), json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>;
}

function renderLanding() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <ThemeProvider>
        <ToastProvider>
          <ViewerAuthProvider>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="*" element={<Where />} />
            </Routes>
          </ViewerAuthProvider>
        </ToastProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const panels = () => screen.queryAllByTestId('landing-room-panel');
const panelNames = () => panels().map(p => within(p).getByRole('heading', { level: 3 }).textContent);
const panelFor = (name: string) => panels().find(p => within(p).queryByRole('heading', { level: 3, name }))!;
const myCards = () => screen.queryAllByTestId('landing-my-room');
const deleteCalls = (fetchMock: ReturnType<typeof mockFetch>) =>
  fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');

describe('LandingPage (G35c)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it('is an Arcaid-look page: the fixed dark kit on the carpet, whatever the light/dark choice', async () => {
    localStorage.setItem('arcaid-global-theme', 'light');
    mockFetch();
    const { container } = renderLanding();
    await waitFor(() => expect(panels().length).toBeGreaterThan(0));
    const root = container.querySelector('.aw-screen--arcaid');
    expect(root).toBeTruthy();
    expect(root).toHaveClass('aw-island', 'sb-theme-scope');
    // The hero mark is the dark one in light mode too.
    expect(container.querySelector('.arcaid-logo-wrap.arcaid-logo-dark')).toBeTruthy();
    expect(container.querySelector('.arcaid-logo-light')).toBeNull();
  });

  describe('signed out', () => {
    it('no switcher, no Your rooms, the Log in buttons and the Display button; every listed room, View only', async () => {
      mockFetch();
      renderLanding();
      await waitFor(() => expect(panelNames()).toEqual(['Other Room', 'Old Server Room', 'RTX Pinball', 'The Back Glass Bar']));

      expect(screen.queryByRole('button', { name: /switch game room/ })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Your rooms' })).toBeNull();
      expect(myCards()).toHaveLength(0);
      expect(screen.getAllByText('Login').length).toBeGreaterThan(0);
      expect(screen.getByRole('button', { name: 'Display settings' })).toBeInTheDocument();
      expect(screen.queryByLabelText('User menu')).toBeNull();
      // No admin link on the landing page.
      expect(screen.queryByText('Admin')).toBeNull();

      expect(screen.getByRole('heading', { name: 'Game rooms' })).toBeInTheDocument();
      const rtx = panelFor('RTX Pinball');
      expect(within(rtx).getByRole('link', { name: 'View RTX Pinball' })).toHaveAttribute('href', '/rtx_pinball');
      expect(within(rtx).queryByRole('button', { name: /Join/ })).toBeNull();
      // The create panel closes the list.
      expect(screen.getByRole('link', { name: 'Create a room' })).toHaveAttribute('href', '/create-room');
    });
  });

  describe('signed in', () => {
    it('the switcher reads "Your rooms"; the cards are newest activity first, with counts, last play and how you joined', async () => {
      signInAs('user-1', 'Justin');
      mockFetch({ meRooms: MINE });
      renderLanding();
      await waitFor(() => expect(myCards()).toHaveLength(3));

      // Inline (sm and up) and the phone's row: both read "Your rooms".
      const switches = screen.getAllByRole('button', { name: 'Your rooms, switch game room' });
      expect(switches.length).toBeGreaterThan(0);
      for (const s of switches) expect(s).toHaveTextContent('Your rooms');
      expect(screen.getByLabelText('User menu')).toBeInTheDocument();
      expect(screen.queryByText('Login')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Display settings' })).toBeNull();

      const names = myCards().map(c => within(c).getAllByRole('link')[0]!.textContent);
      expect(names).toEqual(['Private Room', 'RTX Pinball', 'Quiet Room']);

      const [priv, rtx, quiet] = myCards();
      expect(within(rtx!).getByRole('link', { name: 'RTX Pinball' })).toHaveAttribute('href', '/rtx_pinball');
      await waitFor(() => expect(rtx).toHaveTextContent('10 players · 3 active games'));
      expect(rtx).toHaveTextContent(/You played .* · Submitted scores/);
      expect(priv).toHaveTextContent('Unlisted room');
      expect(priv).toHaveTextContent('You played 2h ago · Admin invite');
      // Never played there: only how you joined.
      expect(quiet).toHaveTextContent('Joined');
      expect(quiet).not.toHaveTextContent('You played');
    });

    it('the rooms you have not joined leave yours out, most active players first', async () => {
      signInAs('user-1', 'Justin');
      mockFetch({ meRooms: MINE });
      renderLanding();
      await waitFor(() => expect(panels().length).toBeGreaterThan(0));
      expect(screen.getByRole('heading', { name: 'More game rooms' })).toBeInTheDocument();
      expect(panelNames()).toEqual(['Other Room', 'Old Server Room', 'The Back Glass Bar']);
      expect(within(panelFor('Other Room')).getByRole('button', { name: 'Join Other Room' })).toBeInTheDocument();
    });

    it('with no rooms of your own the section is skipped', async () => {
      signInAs('user-1', 'Justin');
      mockFetch({ meRooms: [] });
      renderLanding();
      await waitFor(() => expect(panels()).toHaveLength(4));
      expect(screen.queryByRole('heading', { name: 'Your rooms' })).toBeNull();
      expect(myCards()).toHaveLength(0);
    });

    describe('Leave room, from the card\'s ⋯ menu', () => {
      async function openLeave() {
        await import('../../components/landing/RoomMenu'); // the menu's chunk in hand before the press
        await waitFor(() => expect(myCards()).toHaveLength(3));
        fireEvent.click(screen.getByRole('button', { name: 'More for RTX Pinball' }));
        const menu = await screen.findByRole('menu');
        fireEvent.click(within(menu).getByRole('menuitem', { name: /Leave room/ }));
        await waitForRealDialog();
        return screen.getByRole('dialog', { name: 'Leave RTX Pinball?' });
      }

      it('Cancel closes the confirm and sends nothing', async () => {
        signInAs('user-1', 'Justin');
        const fetchMock = mockFetch({ meRooms: MINE });
        renderLanding();
        const dialog = await openLeave();
        expect(within(dialog).getByText(/You can rejoin any time/)).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(myCards()).toHaveLength(3);
        expect(deleteCalls(fetchMock)).toHaveLength(0);
      });

      it('Leave room sends the request, the card goes and a toast says so', async () => {
        signInAs('user-1', 'Justin');
        const fetchMock = mockFetch({ meRooms: MINE });
        renderLanding();
        const dialog = await openLeave();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Leave room' }));

        expect(await screen.findByText('You left RTX Pinball. You can rejoin any time.')).toBeInTheDocument();
        await waitFor(() => expect(myCards()).toHaveLength(2));
        expect(myCards().some(c => c.textContent?.includes('RTX Pinball'))).toBe(false);
        const deletes = deleteCalls(fetchMock);
        expect(deletes).toHaveLength(1);
        expect(deletes[0]![0]).toBe('/api/me/rooms/room-1');
        // Left, it is a room you have not joined again.
        await waitFor(() => expect(panelNames()).toContain('RTX Pinball'));
      });

      it('a failed leave keeps the card and says so', async () => {
        signInAs('user-1', 'Justin');
        mockFetch({ meRooms: MINE, deleteOk: false });
        renderLanding();
        const dialog = await openLeave();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Leave room' }));
        expect(await screen.findByText('Could not leave RTX Pinball — try again.')).toBeInTheDocument();
        await waitFor(() => expect(myCards()).toHaveLength(3));
      });
    });

    it('Join adds an open room to Your rooms', async () => {
      signInAs('user-1', 'Justin');
      const fetchMock = mockFetch({ meRooms: MINE });
      renderLanding();
      await waitFor(() => expect(panelNames()).toContain('Other Room'));
      fireEvent.click(screen.getByRole('button', { name: 'Join Other Room' }));
      await waitFor(() => expect(myCards()).toHaveLength(4));
      expect(panelNames()).not.toContain('Other Room');
      expect(fetchMock).toHaveBeenCalledWith('/api/me/rooms/room-2', expect.objectContaining({ method: 'POST' }));
    });

    it('an approval room asks first (G23e): Cancel sends nothing; Request to join posts and shows the request as sent', async () => {
      signInAs('user-1', 'Justin');
      const fetchMock = mockFetch({ meRooms: MINE });
      renderLanding();
      await waitFor(() => expect(panelNames()).toContain('The Back Glass Bar'));

      fireEvent.click(screen.getByRole('button', { name: 'Ask to join The Back Glass Bar' }));
      await waitForRealDialog();
      expect(screen.getByRole('dialog', { name: 'Request to join?' })).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(fetchMock).not.toHaveBeenCalledWith('/api/me/rooms/room-3/join-request', expect.anything());

      fireEvent.click(screen.getByRole('button', { name: 'Ask to join The Back Glass Bar' }));
      await waitForRealDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Request to join' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/rooms/room-3/join-request', expect.objectContaining({ method: 'POST' })));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Request sent to The Back Glass Bar' })).toBeDisabled());
      expect(screen.queryByRole('button', { name: 'Ask to join The Back Glass Bar' })).toBeNull();
    });

    it('an approval request answered "member" (auto-approve) shows no pending state', async () => {
      signInAs('user-1', 'Justin');
      const fetchMock = mockFetch({ meRooms: MINE, joinRequestStatus: 'member' });
      renderLanding();
      await waitFor(() => expect(panelNames()).toContain('The Back Glass Bar'));
      fireEvent.click(screen.getByRole('button', { name: 'Ask to join The Back Glass Bar' }));
      await waitForRealDialog();
      fireEvent.click(screen.getByRole('button', { name: 'Request to join' }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/me/rooms/room-3/join-request', expect.anything()));
      expect(screen.queryByRole('button', { name: 'Request sent to The Back Glass Bar' })).toBeNull();
    });
  });

  describe('the Global Scoreboard panel', () => {
    it('opens the Global Scoreboard, names when the newest score came in, and lists three hot tables with their leaders', async () => {
      mockFetch();
      renderLanding();
      const global = await screen.findByTestId('landing-global');
      expect(within(global).getByRole('heading', { name: 'Global Scoreboard' })).toBeInTheDocument();
      expect(within(global).getByRole('link', { name: /Open the Global Scoreboard/ })).toHaveAttribute('href', '/scoreboard');
      await waitFor(() => expect(within(global).getByTestId('landing-latest')).toHaveTextContent('Latest score 17m ago'));

      const hot = await within(global).findByTestId('landing-hot-tables');
      const rows = within(hot).getAllByRole('link');
      // One row per table (Theatre of Magic's second board is skipped), none without a score.
      expect(rows.map(r => r.textContent)).toEqual(['Theatre of Magic', 'Medieval Madness', 'Attack from Mars']);
      expect(rows[0]).toHaveAttribute('href', '/games/gg-6?category=simulation');
      expect(rows[2]).toHaveAttribute('href', '/games/gg-2');
      // The leader through playerName(): the chosen name over the raw one.
      expect(hot).toHaveTextContent('Player Two');
      expect(hot).not.toHaveTextContent('p2raw');
      expect(hot).toHaveTextContent('1,234,567,890');
    });

    it('the floating score cards each open their table; the loop\'s second copy is hidden from readers and Tab', async () => {
      mockFetch();
      renderLanding();
      const cards = await screen.findAllByTestId('landing-ticker-card');
      expect(cards).toHaveLength(2);
      expect(cards[0]).toHaveAttribute('href', '/games/gg-1');
      expect(cards[1]).toHaveAttribute('href', '/games/gg-2');
      expect(cards[0]).toHaveAccessibleName(/Medieval Madness: FlipperKing/);
      // The player's chosen name, never the raw alias.
      expect(cards[0]).toHaveTextContent('FlipperKing');
      expect(cards[0]).not.toHaveTextContent('flipper_raw');
      const copies = document.querySelectorAll('.lp-tk__card[data-copy]');
      expect(copies).toHaveLength(2);
      for (const c of copies) {
        expect(c).toHaveAttribute('aria-hidden', 'true');
        expect(c).toHaveAttribute('tabindex', '-1');
      }
    });
  });

  describe('what is on in each room (activeTables, G35b)', () => {
    it('shows up to three tables with their leaders and scores, each opening the room\'s table', async () => {
      mockFetch();
      renderLanding();
      await waitFor(() => expect(panelNames()).toContain('RTX Pinball'));
      const rtx = panelFor('RTX Pinball');
      const list = within(rtx).getByTestId('landing-on-now');
      const links = within(list).getAllByRole('link');
      expect(links.map(l => l.textContent)).toEqual(['Medieval Madness', 'Attack from Mars', 'The Addams Family']);
      expect(links[0]).toHaveAttribute('href', '/rtx_pinball/games/Medieval%20Madness');
      expect(list).toHaveTextContent('FlipperKing leads');
      expect(list).toHaveTextContent('48,151,623,420');
      expect(list).not.toHaveTextContent('Fourth Table');
      expect(rtx).toHaveTextContent('10 players · 3 active games');
    });

    it('an empty list and a missing one (a server before G35b) both read "No tables running right now"', async () => {
      mockFetch();
      renderLanding();
      await waitFor(() => expect(panels()).toHaveLength(4));
      for (const name of ['Other Room', 'Old Server Room']) {
        const panel = panelFor(name);
        expect(panel).toHaveTextContent('No tables running right now');
        expect(within(panel).queryByTestId('landing-on-now')).toBeNull();
      }
    });

    it('an approval room says it approves its members, and shows no withheld counts', async () => {
      mockFetch();
      renderLanding();
      await waitFor(() => expect(panelNames()).toContain('The Back Glass Bar'));
      const bgb = panelFor('The Back Glass Bar');
      expect(bgb).toHaveTextContent('This room approves its members. Ask to join to see its tables.');
      expect(bgb).toHaveTextContent('Approval to join');
      expect(bgb).not.toHaveTextContent('0 players');
    });
  });

  describe('a failed read shows LoadFailedNotice in its own section while the others render', () => {
    it('the room list', async () => {
      mockFetch({ fail: ['rooms'] });
      renderLanding();
      expect(await screen.findByTestId('more-rooms-failed')).toHaveTextContent("Couldn't load the game rooms");
      expect(await screen.findByTestId('landing-hot-tables')).toBeInTheDocument();
      expect(await screen.findAllByTestId('landing-ticker-card')).toHaveLength(2);
    });

    it('the latest scores and the hot tables', async () => {
      mockFetch({ fail: ['recent', 'hot'] });
      renderLanding();
      expect(await screen.findByTestId('latest-scores-failed')).toBeInTheDocument();
      expect(await screen.findByTestId('hot-tables-failed')).toBeInTheDocument();
      await waitFor(() => expect(panels()).toHaveLength(4));
      expect(screen.queryByTestId('landing-latest')).toBeNull();
    });

    it('your rooms', async () => {
      signInAs('user-1', 'Justin');
      mockFetch({ meRooms: MINE, fail: ['me'] });
      renderLanding();
      expect(await screen.findByTestId('your-rooms-failed')).toHaveTextContent("Couldn't load your rooms");
      // The rooms you have not joined do not wait for it.
      await waitFor(() => expect(panels()).toHaveLength(4));
    });
  });
});
