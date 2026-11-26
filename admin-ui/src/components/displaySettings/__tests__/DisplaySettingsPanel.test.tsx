import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import DisplaySettingsPanel from '../DisplaySettingsPanel';
import { ThemeProvider } from '../../ThemeProvider';
import { waitForRealDialog } from '../../../test/dialogTestUtils';
import { stubResizeObserver } from '../../../test/stubResizeObserver';
import {
  DISPLAY_SETTINGS_LIVE_EVENT, DISPLAY_SETTINGS_SAVED_EVENT, type DisplaySettingsLiveDetail,
} from '../../../lib/displaySettingsLive';
import { SAVED_KEYS } from '../model';

stubResizeObserver();

// G34b: the toasts the panel raises are read here (the real ones need Sonner on the page).
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../../Toast', () => ({ useToast: () => ({ toast: toastMock }) }));

/**
 * G34a - Display settings as a live panel (owner decisions 2026-11-26): only
 * the device in hand, every change on the page at once and saved by itself,
 * Undo changes and Room defaults, one theme picker with Everywhere / Only in,
 * and every row showing the value the viewer actually gets.
 */

interface Server {
  personal: string | null;
  appearance: string | null;
  floor: string | null;
  prefs: Record<string, string>;
  /** What the OTHER device (mobile, when the panel is on a computer) has stored. */
  otherPrefs: Record<string, string>;
  failPosts: boolean;
}

let server: Server;
const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const failed = () => Promise.resolve({ ok: false, status: 500, headers: { get: () => null }, json: () => Promise.resolve({}) });

function stubFetch() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.startsWith('/api/me/preferences')) {
      return method === 'GET' ? ok({ ui_theme: server.personal, appearance: server.appearance, ui_floor: server.floor }) : ok({});
    }
    if (url.startsWith('/api/me/scoreboard-preferences')) {
      if (method === 'GET') return ok(url.includes('device=mobile') ? server.otherPrefs : server.prefs);
      return server.failPosts ? failed() : ok({ ok: true });
    }
    if (url.startsWith('/api/me/room-themes')) return ok(method === 'GET' ? { roomThemes: {} } : {});
    return ok({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

const calls = (part: string, method: string) => fetchMock.mock.calls.filter(([url, init]) =>
  String(url).startsWith(part) && ((init as RequestInit | undefined)?.method ?? 'GET') === method);
const prefPosts = () => calls('/api/me/scoreboard-preferences', 'POST');
const lastBody = (list: unknown[][]) => JSON.parse((list[list.length - 1]![1] as RequestInit).body as string);

let live: DisplaySettingsLiveDetail[] = [];
const onLive = (e: Event) => { live.push((e as CustomEvent<DisplaySettingsLiveDetail>).detail); };
const lastLive = () => live[live.length - 1]!.prefs;

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function b64url(o: unknown) { return btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'); }
const jwt = (claims: Record<string, unknown>) => `${b64url({ alg: 'none' })}.${b64url({ exp: 4102444800, ...claims })}.sig`;

function renderPanel({ path = '/rooma', slug = 'rooma' as string | null, roomConfig = { SCOREBOARD_STYLE: 'arcade' } as Record<string, string>, token = 'player.jwt.token' } = {}) {
  const onClose = vi.fn();
  const utils = render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <Routes>
          <Route
            path="*"
            element={(
              <>
                <DisplaySettingsPanel
                  onClose={onClose}
                  playerToken={token}
                  slug={slug}
                  roomId={slug ? 'room-1' : undefined}
                  roomName={slug ? 'Room A' : undefined}
                  roomConfig={slug ? roomConfig : null}
                />
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
  return { ...utils, onClose };
}

async function ready() {
  await waitForRealDialog();
  await screen.findByRole('group', { name: 'Card style' });
}

const group = (name: string) => screen.getByRole('group', { name });
const press = (groupName: string, button: string | RegExp) => fireEvent.click(within(group(groupName)).getByRole('button', { name: button }));
const pressed = (groupName: string) => within(group(groupName)).getAllByRole('button').filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent);
const status = () => screen.getByTestId('display-save-status');
const innerWidth = window.innerWidth;

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('arcaid_player_token', 'player.jwt.token');
  server = { personal: null, appearance: null, floor: null, prefs: {}, otherPrefs: {}, failPosts: false };
  toastMock.mockReset();
  fetchMock.mockReset();
  stubFetch();
  live = [];
  window.addEventListener(DISPLAY_SETTINGS_LIVE_EVENT, onLive);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});
afterEach(() => {
  window.removeEventListener(DISPLAY_SETTINGS_LIVE_EVENT, onLive);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.className = '';
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

describe('Display settings panel - saving as you go', () => {
  it('is the Arcaid panel: named Display settings, "Only you see these.", non-modal', async () => {
    renderPanel();
    await ready();
    const dialog = screen.getByRole('dialog', { name: 'Display settings' });
    expect(dialog.className).toContain('arc-dialog--panel');
    expect(dialog).toHaveAttribute('aria-modal', 'false');
    expect(within(dialog).getByText('Only you see these.')).toBeInTheDocument();
  });

  it('a change goes to the page at once and is posted once after quick repeated changes', async () => {
    renderPanel();
    await ready();
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled();
    vi.useFakeTimers();
    press('Card style', /^Banner/);
    expect(lastLive()).toEqual({ SCOREBOARD_STYLE: 'banner' });
    expect(live[0]!.device).toBe('desktop');
    press('Card style', /^Minimal/);
    fireEvent.click(screen.getByRole('button', { name: 'More scores per card' }));
    expect(lastLive()).toEqual({ SCOREBOARD_STYLE: 'minimal', SCOREBOARD_MAX_SCORES: '6' });
    expect(status()).toHaveTextContent('Saving…');

    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(prefPosts()).toHaveLength(0);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(prefPosts()).toHaveLength(1);
    expect(String(prefPosts()[0]![0])).toBe('/api/me/scoreboard-preferences?device=desktop');
    const body = lastBody(prefPosts());
    // Exactly what the old Save posted: every key, null for unset.
    expect(Object.keys(body).sort()).toEqual([...SAVED_KEYS].sort());
    expect(body.SCOREBOARD_STYLE).toBe('minimal');
    expect(body.SCOREBOARD_MAX_SCORES).toBe('6');
    expect(body.UI_THEME).toBeNull();
    expect(body.SCOREBOARD_ZOOM).toBeNull();
    expect(status()).toHaveTextContent('Saved ✓');
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeEnabled();
  });

  it('a slider sends the change while it moves', async () => {
    renderPanel();
    await ready();
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '120' } });
    expect(lastLive()).toEqual({ SCOREBOARD_ZOOM: '120' });
    fireEvent.change(screen.getByRole('slider', { name: 'Zoom' }), { target: { value: '125' } });
    expect(lastLive()).toEqual({ SCOREBOARD_ZOOM: '125' });
    expect(within(screen.getByRole('slider', { name: 'Zoom' }).parentElement!).getByText('125%')).toBeInTheDocument();
  });

  it('a failed save says Couldn\'t save, and Try again posts again', async () => {
    server.failPosts = true;
    renderPanel();
    await ready();
    vi.useFakeTimers();
    press('Card style', /^Banner/);
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(prefPosts()).toHaveLength(1);
    expect(status()).toHaveTextContent("Couldn't save");
    expect(within(status()).getByText("Couldn't save")).toHaveClass('ink-danger');

    server.failPosts = false;
    fireEvent.click(within(status()).getByRole('button', { name: 'Try again' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(prefPosts()).toHaveLength(2);
    expect(lastBody(prefPosts()).SCOREBOARD_STYLE).toBe('banner');
    expect(status()).toHaveTextContent('Saved ✓');
  });

  it('closing with a save pending sends it at once, then tells the page', async () => {
    const saved = vi.fn();
    window.addEventListener(DISPLAY_SETTINGS_SAVED_EVENT, saved);
    try {
      const { onClose } = renderPanel();
      await ready();
      vi.useFakeTimers();
      press('Card style', /^Banner/);
      expect(prefPosts()).toHaveLength(0);
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalled();
      // Not 500 ms later: now.
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(prefPosts()).toHaveLength(1);
      expect(lastBody(prefPosts()).SCOREBOARD_STYLE).toBe('banner');
      expect(saved).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
      expect(prefPosts()).toHaveLength(1);
    } finally {
      window.removeEventListener(DISPLAY_SETTINGS_SAVED_EVENT, saved);
    }
  });

  it('Escape with focus in the panel closes it', async () => {
    const { onClose } = renderPanel();
    await ready();
    const appearance = within(group('Appearance')).getByRole('button', { name: 'Dark' });
    appearance.focus();
    fireEvent.keyDown(appearance, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });
});

describe('Display settings panel - Undo changes and Room defaults', () => {
  it('Undo puts back the card settings, the theme, Appearance and the floor as they were on open', async () => {
    localStorage.setItem('arcaid-appearance', 'dark');
    localStorage.setItem('arcaid-theme-personal', 'retro');
    localStorage.setItem('arcaid-floor', 'on');
    server = { ...server, personal: 'retro', appearance: 'dark', floor: 'on', prefs: { SCOREBOARD_STYLE: 'minimal' } };
    renderPanel();
    await ready();
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled();

    press('Card style', /^Banner/);
    // A light theme while Appearance is Dark: the setter switches Appearance to Auto, and the panel says so.
    press('Theme', 'Light');
    fireEvent.click(screen.getByRole('switch', { name: 'Carpet floor' }));
    await waitFor(() => expect(localStorage.getItem('arcaid-theme-personal')).toBe('light'));
    expect(localStorage.getItem('arcaid-appearance')).toBe('auto');
    expect(localStorage.getItem('arcaid-floor')).toBe('off');
    expect(screen.getByText('Switched to Auto so Light can show.')).toBeInTheDocument();

    const before = calls('/api/me/preferences', 'POST').length;
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    await waitFor(() => expect(localStorage.getItem('arcaid-theme-personal')).toBe('retro'));
    expect(localStorage.getItem('arcaid-appearance')).toBe('dark');
    expect(localStorage.getItem('arcaid-floor')).toBe('on');
    expect(lastLive()).toEqual({ SCOREBOARD_STYLE: 'minimal' });
    expect(pressed('Card style')[0]).toMatch(/^Minimal/);
    expect(pressed('Appearance')).toEqual(['Dark']);
    expect(screen.queryByText(/Switched to Auto/)).toBeNull();

    // The setters were called back with the snapshot, Appearance last.
    const undone = calls('/api/me/preferences', 'POST').slice(before).map(c => JSON.parse((c[1] as RequestInit).body as string));
    expect(undone).toContainEqual({ ui_theme: 'retro' });
    expect(undone).toContainEqual({ ui_floor: 'on' });
    expect(undone[undone.length - 1]).toEqual({ appearance: 'dark' });
    await waitFor(() => expect(lastBody(prefPosts()).SCOREBOARD_STYLE).toBe('minimal'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled());
  });

  it('Room defaults clears this device\'s card settings only, with no confirm', async () => {
    localStorage.setItem('arcaid-theme-personal', 'forest');
    server = { ...server, personal: 'forest', prefs: { SCOREBOARD_STYLE: 'minimal', SCOREBOARD_MAX_SCORES: '8' } };
    renderPanel({ roomConfig: { SCOREBOARD_STYLE: 'arcade' } });
    await ready();
    const roomDefaults = screen.getByRole('button', { name: 'Room defaults' });
    expect(roomDefaults).toBeEnabled();
    const themeWrites = () => calls('/api/me/preferences', 'POST').length + calls('/api/me/room-themes/', 'PUT').length;
    const themeBefore = themeWrites();

    fireEvent.click(roomDefaults);
    expect(lastLive()).toEqual({});
    expect(pressed('Card style')[0]).toMatch(/^Arcade/);
    await waitFor(() => expect(prefPosts()).toHaveLength(1));
    const body = lastBody(prefPosts());
    for (const key of SAVED_KEYS) expect(body[key]).toBeNull();
    expect(themeWrites()).toBe(themeBefore);
    expect(localStorage.getItem('arcaid-theme-personal')).toBe('forest');
    expect(screen.getByRole('button', { name: 'Room defaults' })).toBeDisabled();
  });

  it('Room defaults is off when there is nothing of yours to clear', async () => {
    renderPanel();
    await ready();
    expect(screen.getByRole('button', { name: 'Room defaults' })).toBeDisabled();
  });
});

describe('Display settings panel - the rows', () => {
  it('Game art writes both keys, and a stored fill-on header-off reads as Full card', async () => {
    server.prefs = { SCOREBOARD_CARD_BG_FILL: 'true', SCOREBOARD_GAME_HEADER_ENABLED: 'false' };
    renderPanel();
    await ready();
    expect(pressed('Game art')).toEqual(['Full card']);
    press('Game art', 'Header');
    expect(lastLive()).toEqual({ SCOREBOARD_CARD_BG_FILL: 'false', SCOREBOARD_GAME_HEADER_ENABLED: 'true' });
    press('Game art', 'None');
    expect(lastLive()).toEqual({ SCOREBOARD_CARD_BG_FILL: 'false', SCOREBOARD_GAME_HEADER_ENABLED: 'false' });
    // Different from the room's: the lit dot, the room's value and a Reset that clears both keys.
    expect(screen.getByText('Room: Full card')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Reset Game art to the room's" }));
    expect(lastLive()).toEqual({});
    press('Game art', 'Full card');
    expect(lastLive()).toEqual({});
    press('Game art', 'None');
    press('Game art', 'Full card');
    expect(lastLive()).toEqual({ SCOREBOARD_CARD_BG_FILL: 'true', SCOREBOARD_GAME_HEADER_ENABLED: 'true' });
  });

  it('shows the value the viewer gets, never a blank (a Showcase room that stored no layout is Stacked)', async () => {
    renderPanel({ roomConfig: { SCOREBOARD_STYLE: 'showcase' } });
    await ready();
    expect(pressed('Card style')[0]).toMatch(/^Showcase/);
    expect(pressed('Layout')).toEqual(['Stacked']);
    expect(pressed('Game art')).toEqual(['Full card']);
    expect(pressed('Showcase colours')).toHaveLength(1);
    expect(within(group('Scores per card')).getByText('5')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('100');

    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.getByRole('combobox', { name: 'Game title style' })).toHaveValue('default');
    expect(screen.getByRole('combobox', { name: 'Position' })).toHaveValue('left');
    expect(screen.getByRole('combobox', { name: 'Rankings style' })).toHaveValue('match');
    expect(within(group('Card spacing')).getByText('24 px')).toBeInTheDocument();
    expect(within(group('Min card height')).getByText('5 rows')).toBeInTheDocument();
    expect(within(group('Title font size')).getByText('Auto')).toBeInTheDocument();
    expect(pressed('QR codes')).toEqual(['Off']);
    expect(pressed('Room title')).toEqual(['Shown']);
    expect(pressed('Room logo')).toEqual(['Shown']);
    for (const select of screen.getAllByRole('combobox')) expect((select as HTMLSelectElement).value).not.toBe('');
    for (const output of document.querySelectorAll('.dset output')) expect(output.textContent).not.toBe('');
    // Nothing is the viewer's own yet: no dots lit.
    expect(document.querySelector('.dset-row[data-changed]')).toBeNull();
  });

  it('QR codes: a stored kiosk-only shows as Off; On writes all and shows its size, position and offset', async () => {
    server.prefs = { SCOREBOARD_QR_MODE: 'kiosk-only' };
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(pressed('QR codes')).toEqual(['Off']);
    expect(screen.queryByRole('group', { name: 'QR size' })).toBeNull();
    press('QR codes', 'On');
    expect(lastLive()).toEqual({ SCOREBOARD_QR_MODE: 'all' });
    expect(group('QR size')).toBeInTheDocument();
    expect(group('QR position')).toBeInTheDocument();
    expect(group('QR offset')).toBeInTheDocument();
    press('QR codes', 'Off');
    expect(lastLive()).toEqual({ SCOREBOARD_QR_MODE: 'disabled' });
  });

  it('the phone set: Stacked / Side-scroll and Card size, no Zoom and no QR codes', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderPanel();
    await ready();
    expect(String(calls('/api/me/scoreboard-preferences', 'GET')[0]![0])).toBe('/api/me/scoreboard-preferences?device=mobile');
    expect(within(group('Layout')).getAllByRole('button').map(b => b.textContent)).toEqual(['Stacked', 'Side-scroll']);
    expect(pressed('Layout')).toEqual(['Stacked']);
    expect(screen.getByRole('slider', { name: 'Card size' })).toBeInTheDocument();
    expect(within(screen.getByRole('slider', { name: 'Card size' }).parentElement!).getByText('100%')).toBeInTheDocument();
    expect(screen.queryByRole('slider', { name: 'Zoom' })).toBeNull();
    expect(screen.getByText('this phone, every room')).toBeInTheDocument();
    expect(screen.getByText('Your computer keeps its own card settings.')).toBeInTheDocument();
    press('Layout', 'Side-scroll');
    expect(lastLive()).toEqual({ SCOREBOARD_MOBILE_VERTICAL: 'false' });
    expect(live[live.length - 1]!.device).toBe('mobile');
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(screen.queryByRole('group', { name: 'QR codes' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Rankings style' })).toBeInTheDocument();
  });

  it('the computer set says the phone keeps its own', async () => {
    renderPanel();
    await ready();
    expect(screen.getByText('this computer, every room')).toBeInTheDocument();
    expect(screen.getByText('Your phone keeps its own card settings.')).toBeInTheDocument();
  });
});

describe('Display settings panel - one theme picker, Everywhere or Only in this room', () => {
  const puts = () => calls('/api/me/room-themes/room-1', 'PUT').map(c => JSON.parse((c[1] as RequestInit).body as string));
  const themePosts = () => calls('/api/me/preferences', 'POST').map(c => JSON.parse((c[1] as RequestInit).body as string)).filter(b => 'ui_theme' in b);

  it('under Everywhere a tile sets the theme everywhere (Room\'s own clears it), not this room\'s', async () => {
    renderPanel();
    await ready();
    expect(pressed('Use it')).toEqual(['Everywhere']);
    expect(pressed('Theme')).toEqual(["Room's own"]);
    press('Theme', 'Forest');
    await waitFor(() => expect(themePosts()).toContainEqual({ ui_theme: 'forest' }));
    expect(pressed('Theme')).toEqual(['Forest']);
    press('Theme', "Room's own");
    await waitFor(() => expect(themePosts()).toContainEqual({ ui_theme: null }));
    expect(puts()).toHaveLength(0);
  });

  it('under Only in a tile sets this room\'s theme, and Room\'s own clears it', async () => {
    renderPanel();
    await ready();
    press('Use it', 'Only in Room A');
    press('Theme', 'Forest');
    await waitFor(() => expect(puts()).toContainEqual({ theme: 'forest' }));
    expect(localStorage.getItem('arcaid-theme-room-rooma')).toBe('forest');
    expect(themePosts()).not.toContainEqual({ ui_theme: 'forest' });
    press('Theme', "Room's own");
    await waitFor(() => expect(puts()[puts().length - 1]).toEqual({ theme: null }));
    expect(pressed('Use it')).toEqual(['Only in Room A']);
  });

  it('opens on Only in when this room has its own theme; going to Everywhere moves that tile there and clears the room', async () => {
    localStorage.setItem('arcaid-theme-room-rooma', 'paper');
    renderPanel();
    await ready();
    expect(pressed('Use it')).toEqual(['Only in Room A']);
    expect(pressed('Theme')).toEqual(['Paper']);
    press('Use it', 'Everywhere');
    await waitFor(() => expect(themePosts()).toContainEqual({ ui_theme: 'paper' }));
    await waitFor(() => expect(puts()).toContainEqual({ theme: null }));
    expect(localStorage.getItem('arcaid-theme-room-rooma')).toBeNull();
    expect(pressed('Use it')).toEqual(['Everywhere']);
    expect(pressed('Theme')).toEqual(['Paper']);
  });

  it('going from Everywhere to Only in gives this room the tile picked everywhere and keeps the theme everywhere', async () => {
    localStorage.setItem('arcaid-theme-personal', 'retro');
    server.personal = 'retro';
    renderPanel();
    await ready();
    expect(pressed('Theme')).toEqual(['Retro terminal']);
    const before = themePosts().length;
    press('Use it', 'Only in Room A');
    await waitFor(() => expect(puts()).toContainEqual({ theme: 'retro' }));
    expect(themePosts()).toHaveLength(before);
    expect(localStorage.getItem('arcaid-theme-personal')).toBe('retro');
    expect(pressed('Theme')).toEqual(['Retro terminal']);
  });

  it('Undo gives this room back the theme it had on open (none), after several picks', async () => {
    renderPanel();
    await ready();
    press('Use it', 'Only in Room A');
    press('Theme', 'Forest');
    press('Theme', 'Synthwave');
    await waitFor(() => expect(localStorage.getItem('arcaid-theme-room-rooma')).toBe('synthwave'));
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    await waitFor(() => expect(puts()[puts().length - 1]).toEqual({ theme: null }));
    expect(localStorage.getItem('arcaid-theme-room-rooma')).toBeNull();
    expect(pressed('Use it')).toEqual(['Everywhere']);
    expect(screen.getByRole('button', { name: 'Undo changes' })).toBeDisabled();
  });

  it('each theme tile shows that theme\'s own colours (scoped to it)', async () => {
    renderPanel();
    await ready();
    const synth = within(group('Theme')).getByRole('button', { name: 'Synthwave' });
    expect(synth.querySelector('.dset-swatch')).toHaveClass('sb-theme-scope', 'theme-synthwave');
    expect(synth.querySelectorAll('.dset-swatch i')).toHaveLength(4);
  });
});

describe('Display settings panel - where it is open', () => {
  it('on another room page the card settings say where they show, with a way there', async () => {
    renderPanel({ path: '/rooma/lobby' });
    await ready();
    const row = screen.getByTestId('not-on-scoreboard');
    expect(row).toHaveTextContent('These show on the Scoreboard.');
    // The controls stay usable below it.
    press('Card style', /^Banner/);
    expect(lastLive()).toEqual({ SCOREBOARD_STYLE: 'banner' });
    fireEvent.click(within(row).getByRole('button', { name: 'Open the Scoreboard' }));
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent(/^\/rooma$/));
    expect(screen.getByRole('dialog', { name: 'Display settings' })).toBeInTheDocument();
    expect(screen.queryByTestId('not-on-scoreboard')).toBeNull();
  });

  it('on the scoreboard there is no such row', async () => {
    renderPanel({ path: '/rooma' });
    await ready();
    expect(screen.queryByTestId('not-on-scoreboard')).toBeNull();
  });

  it('off room pages: Colours only, the theme note, nothing read or saved of the card settings', async () => {
    renderPanel({ path: '/scoreboard', slug: null });
    await waitForRealDialog();
    expect(screen.getByRole('group', { name: 'Theme' })).toBeInTheDocument();
    expect(within(group('Theme')).getAllByRole('button')[0]).toHaveTextContent("Each room's own");
    expect(screen.getByText('Shows in game rooms and admin pages. This page follows Appearance only.')).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Card style' })).toBeNull();
    expect(screen.queryByRole('group', { name: 'Use it' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Room defaults' })).toBeNull();
    expect(screen.queryByText(/keeps its own card settings/)).toBeNull();
    expect(calls('/api/me/scoreboard-preferences', 'GET')).toHaveLength(0);
  });

  it('a room admin gets a link to the room\'s own Display settings; a player does not', async () => {
    const { unmount } = renderPanel({ token: jwt({ role: 'room_admin', gameRoomIds: ['room-1'] }) });
    await ready();
    const link = screen.getByRole('link', { name: /Room admin\? Change it for everyone/ });
    expect(link).toHaveAttribute('href', '/rooma/admin/leaderboard');
    unmount();
    renderPanel({ token: jwt({ role: 'player' }) });
    await ready();
    expect(screen.queryByRole('link', { name: /Room admin/ })).toBeNull();
  });
});

describe('Display settings panel - G34b additions', () => {
  it('the TV row (Cards, last): the kiosk address for this room, Open to /<slug>/kiosk, Copy link copies it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel();
    await ready();
    const row = screen.getByTestId('tv-row');
    expect(row).toHaveTextContent('Show this board on a TV');
    expect(row).toHaveTextContent("A full-screen board that scrolls by itself. Open this link on the TV's browser.");
    expect(screen.getByTestId('tv-address')).toHaveTextContent(`${window.location.origin}/rooma/kiosk`);
    const open = within(row).getByRole('link', { name: 'Open' });
    expect(open).toHaveAttribute('href', '/rooma/kiosk');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener');
    fireEvent.click(within(row).getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/rooma/kiosk`));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Link copied', 'success'));
    // Not a preference: nothing was saved or sent live.
    expect(prefPosts()).toHaveLength(0);
    expect(live).toHaveLength(0);
  });

  it('the TV row is not there off room pages', async () => {
    renderPanel({ path: '/scoreboard', slug: null });
    await waitForRealDialog();
    expect(screen.queryByTestId('tv-row')).toBeNull();
  });

  it('Flash on new scores: writes false and back, reads "Room: On", and Reset clears it', async () => {
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const sw = screen.getByRole('switch', { name: 'Flash on new scores' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(lastLive()).toEqual({ SCOREBOARD_SCORE_FLASH: 'false' });
    expect(screen.getByRole('switch', { name: 'Flash on new scores' })).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Room: On')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Reset Flash on new scores to the room's" }));
    expect(lastLive()).toEqual({});
    fireEvent.click(screen.getByRole('switch', { name: 'Flash on new scores' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Flash on new scores' }));
    expect(lastLive()).toEqual({ SCOREBOARD_SCORE_FLASH: 'true' });
    await waitFor(() => expect(prefPosts().length).toBeGreaterThan(0));
    expect(lastBody(prefPosts())).toHaveProperty('SCOREBOARD_SCORE_FLASH', 'true');
  });

  it('Copy to my phone: Cancel sends nothing', async () => {
    renderPanel();
    await ready();
    // The last row of Cards, after the TV row, with the device line as its caption; not in the pinned footer.
    const copyRow = screen.getByTestId('copy-row');
    expect(copyRow).toHaveTextContent('Your phone keeps its own card settings.');
    expect(copyRow.previousElementSibling).toBe(screen.getByTestId('tv-row'));
    expect(within(screen.getByTestId('display-save-status').parentElement!).queryByRole('button', { name: 'Copy to my phone' })).toBeNull();
    fireEvent.click(within(copyRow).getByRole('button', { name: 'Copy to my phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy to your phone?' });
    expect(dialog).toHaveTextContent('Your card style, game art, scores per card and the More settings replace the ones on your phone. Zoom, layout and QR codes stay as they are.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Copy to your phone?' })).toBeNull());
    expect(prefPosts()).toHaveLength(0);
    expect(calls('/api/me/scoreboard-preferences', 'GET').filter(([u]) => String(u).includes('device=mobile'))).toHaveLength(0);
    expect(toastMock).not.toHaveBeenCalled();
  });

  it('Copy to my phone: copies only the shared keys over the phone\'s own, nulls what this device has not set', async () => {
    server.prefs = {
      SCOREBOARD_STYLE: 'banner', SCOREBOARD_MAX_SCORES: '9', SCOREBOARD_ZOOM: '120', SCOREBOARD_LAYOUT: 'grid',
      SCOREBOARD_QR_MODE: 'all', SCOREBOARD_QR_SIZE: '80',
    };
    server.otherPrefs = {
      SCOREBOARD_STYLE: 'minimal', SCOREBOARD_CARD_SPACING: '40', SCOREBOARD_MOBILE_VERTICAL: 'false', SCOREBOARD_MOBILE_SCALE: '0.6',
    };
    renderPanel();
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Copy to my phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy to your phone?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Copied to your phone', 'success'));
    const post = calls('/api/me/scoreboard-preferences?device=mobile', 'POST');
    expect(post).toHaveLength(1);
    const body = lastBody(post);
    expect(body.SCOREBOARD_STYLE).toBe('banner');
    expect(body.SCOREBOARD_MAX_SCORES).toBe('9');
    // This device has no spacing of its own: the phone then follows the room.
    expect(body.SCOREBOARD_CARD_SPACING).toBeNull();
    expect(body.SCOREBOARD_SCORE_FLASH).toBeNull();
    // The phone's own keys are untouched, and this computer's never go over.
    expect(body.SCOREBOARD_MOBILE_VERTICAL).toBe('false');
    expect(body.SCOREBOARD_MOBILE_SCALE).toBe('0.6');
    for (const key of ['SCOREBOARD_ZOOM', 'SCOREBOARD_LAYOUT', 'SCOREBOARD_QR_MODE', 'SCOREBOARD_QR_SIZE']) expect(body).not.toHaveProperty(key);
    // Nothing on this page changed: no live event, no save of this device's own.
    expect(live).toHaveLength(0);
    expect(prefPosts().filter(([u]) => String(u).includes('device=desktop'))).toHaveLength(0);
  });

  it('a failed copy says so', async () => {
    renderPanel();
    await ready();
    server.failPosts = true;
    fireEvent.click(screen.getByRole('button', { name: 'Copy to my phone' }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy to your phone?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Copy' }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("Couldn't copy. Try again.", 'error'));
    expect(toastMock).not.toHaveBeenCalledWith('Copied to your phone', 'success');
  });

  it('on a phone the button copies to the computer', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    renderPanel();
    await waitForRealDialog();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy to my computer' }));
    expect(await screen.findByRole('dialog', { name: 'Copy to your computer?' })).toBeInTheDocument();
  });
});
