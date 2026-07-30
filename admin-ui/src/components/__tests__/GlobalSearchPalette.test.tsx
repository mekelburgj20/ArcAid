import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalScoreboard from '../../pages/GlobalScoreboard';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { ThemeProvider } from '../ThemeProvider';

/**
 * v2.51.0 (A3) — the ⌘K search palette.
 *
 * These render the whole /scoreboard page rather than the component in
 * isolation, deliberately: the palette does not own its query (the page's
 * existing 300ms debounce feeds it), does not own the submission sheet, and
 * does not own the platform filter. Testing it mounted is the only way those
 * three seams are actually covered.
 */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signIn() {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64url({ alg: 'none' })}.${b64url({ discordId: 'discord-me', username: 'Tester', avatar: null, exp })}.sig`;
  localStorage.setItem('arcaid_player_token', token);
  localStorage.setItem('arcaid_player_user', JSON.stringify({ discordId: 'discord-me', username: 'Tester', avatar: null }));
}

function makeGame(id: string, name: string) {
  return {
    global_game_id: id,
    name,
    display_name: null,
    manufacturer: 'Gottlieb',
    year: 1982,
    type: 'pinball',
    image_url: null,
    local_image_path: null,
    wheel_image_path: null,
    platforms: JSON.stringify(['vpx']),
    score_count: 6,
    top_score: 9_525_852_588,
    last_submitted_at: null,
    avg_rating: 0,
    rating_count: 0,
    top_scores: [{
      iscored_username: 'Krobs',
      display_name: null,
      score: 9_525_852_588,
      avatar_hash: null,
      discord_user_id: 'd-1',
      origin_room_slug: null,
      origin_room_logo_url: null,
      origin_room_short_tag: null,
    }],
  };
}

const GAMES = [
  makeGame('g-1', 'Haunted House'),
  makeGame('g-2', 'The Return Of The Living Dead'),
  makeGame('g-3', 'Haunted Mansion'),
];

/** Every /api/global/scoreboard URL the page + palette requested, in order. */
let requested: string[] = [];

function mockFetch(total = GAMES.length) {
  const fetchMock = vi.fn((url: string) => {
    if (url.startsWith('/api/global/scoreboard')) {
      requested.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ data: GAMES, total, hasMore: false }),
      });
    }
    if (url.startsWith('/api/rooms')) {
      return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
    }
    if (url.startsWith('/api/submit/platforms')) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ platforms: ['vpx'], submittable: ['vpx'], tournamentRules: null }),
      });
    }
    return Promise.resolve({ ok: false, json: () => Promise.resolve(null) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderScoreboard() {
  return render(
    <MemoryRouter initialEntries={['/scoreboard']}>
      <ThemeProvider>
        <ViewerAuthProvider>
          <GlobalScoreboard />
        </ViewerAuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

/** Flush the page's 300ms debounce plus the resulting fetch microtasks. */
async function settle(ms = 350) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
  });
  await act(async () => { await Promise.resolve(); });
}

function getInput(): HTMLInputElement {
  // The room-scope <select> is also role=combobox — name it.
  return screen.getByRole('combobox', { name: 'Search games' }) as HTMLInputElement;
}

function openPalette() {
  fireEvent.keyDown(document.body, { key: 'k', metaKey: true });
}

async function typeQuery(text: string) {
  const input = getInput();
  fireEvent.change(input, { target: { value: text } });
  await settle();
}

/** Rows inside the dropdown — the room-scope <select> also emits role=option. */
function paletteOptions(): HTMLElement[] {
  return within(screen.getByRole('listbox')).getAllByRole('option');
}

/** Palette requests are the ones asking for the palette-sized page. */
function paletteRequests(): string[] {
  return requested.filter(u => u.includes('limit=10'));
}

describe('GlobalSearchPalette (v2.51.0 A3)', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    localStorage.clear();
    document.documentElement.className = '';
    requested = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('⌘K opens the palette and focuses the search field', async () => {
    mockFetch();
    renderScoreboard();
    await settle();

    const input = getInput();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    openPalette();

    expect(input).toHaveFocus();
    expect(input).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getByText('esc to close')).toBeInTheDocument();
  });

  it('does not hijack ⌘K while focus is in another text input', async () => {
    mockFetch();
    renderScoreboard();
    await settle();

    const other = document.createElement('input');
    document.body.appendChild(other);
    other.focus();
    fireEvent.keyDown(other, { key: 'k', metaKey: true });

    expect(getInput()).toHaveAttribute('aria-expanded', 'false');
    other.remove();
  });

  it('Esc closes the palette and leaves focus on the field', async () => {
    mockFetch();
    renderScoreboard();
    await settle();

    openPalette();
    expect(screen.getByRole('listbox')).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: 'Escape' });

    const input = getInput();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-expanded', 'false');
    expect(input).toHaveFocus();
  });

  it('↑/↓ move the selection and wrap at both ends', async () => {
    mockFetch();
    renderScoreboard();
    await settle();

    openPalette();
    await typeQuery('haunt');

    const input = getInput();
    const options = paletteOptions();
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute('aria-selected', 'true');

    // Up from the first row wraps to the last.
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(paletteOptions()[2]).toHaveAttribute('aria-selected', 'true');
    expect(input).toHaveAttribute('aria-activedescendant', paletteOptions()[2].id);

    // Down from the last wraps back to the first.
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(paletteOptions()[0]).toHaveAttribute('aria-selected', 'true');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(paletteOptions()[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('↵ opens the submission sheet for the selected row', async () => {
    signIn();
    mockFetch();
    renderScoreboard();
    await settle();

    openPalette();
    await typeQuery('haunt');

    const input = getInput();
    fireEvent.keyDown(input, { key: 'ArrowDown' }); // select row 2
    fireEvent.keyDown(input, { key: 'Enter' });
    await settle();

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('The Return Of The Living Dead')).toBeInTheDocument();
    // The palette gets out of the way once the sheet is up.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('a logged-out ↵ routes to the page login affordance, not a submission sheet', async () => {
    // jsdom has no layout, so scrollTo is a noop stub — silence its warning.
    vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
    mockFetch();
    renderScoreboard();
    await settle();

    // Header login block only, before the palette asks for a score.
    const before = screen.getAllByRole('button', { name: 'Login' }).length;

    openPalette();
    await typeQuery('haunt');
    fireEvent.keyDown(getInput(), { key: 'Enter' });
    await settle();

    // No submission sheet for an anonymous viewer; instead the page's inline
    // Discord + Google buttons are revealed (both providers, never just one).
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Login' })).toHaveLength(before + 2);
  });

  it('typing debounces to a single palette request', async () => {
    mockFetch();
    renderScoreboard();
    await settle();

    openPalette();
    const input = getInput();
    requested = [];

    for (const value of ['h', 'ha', 'hau', 'haun', 'haunt']) {
      fireEvent.change(input, { target: { value } });
      act(() => { vi.advanceTimersByTime(50); });
    }
    expect(paletteRequests()).toHaveLength(0);

    await settle();
    expect(paletteRequests()).toHaveLength(1);
    expect(paletteRequests()[0]).toContain('search=haunt');
  });

  it('respects the active platform filter', async () => {
    mockFetch();
    renderScoreboard();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Virtual Pinball' }));
    await settle();

    openPalette();
    requested = [];
    await typeQuery('haunt');

    expect(paletteRequests()).toHaveLength(1);
    expect(paletteRequests()[0]).toContain('platforms=');
    expect(decodeURIComponent(paletteRequests()[0])).toContain('vpx');
  });

  it('reports the full match count and the overflow hint', async () => {
    mockFetch(29);
    renderScoreboard();
    await settle();

    openPalette();
    await typeQuery('haunt');

    expect(screen.getByText('GAMES — 29 MATCHES')).toBeInTheDocument();
    expect(screen.getByText('26 more games matched "haunt"')).toBeInTheDocument();
  });

  it('disables the caret blink under prefers-reduced-motion', async () => {
    mockFetch();
    const { container } = renderScoreboard();
    await settle();

    openPalette();

    const css = Array.from(container.querySelectorAll('style')).map(s => s.textContent).join('\n');
    expect(css).toContain('@keyframes gsp-caret-blink');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.gsp-caret\s*\{\s*animation: none/);
  });
});
