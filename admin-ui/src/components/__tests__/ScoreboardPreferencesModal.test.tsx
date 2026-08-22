import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import ScoreboardPreferencesModal from '../ScoreboardPreferencesModal';
import { ThemeProvider } from '../ThemeProvider';

/**
 * Style-system revamp P3 — viewer preferences tiering.
 *
 * The modal used to put ~17 controls at the top level. P3 trims that to four
 * (Card Style + its conditional Showcase theme picker, UI Theme, Card Layout,
 * Zoom) and moves everything else into the existing Advanced section, grouped
 * by what it affects. It is a re-tiering, not a removal: these tests pin both
 * halves — what the top level shows, and that the demoted controls still
 * render and still write their own keys once Advanced is open.
 */

const SAVED_KEYS = [
  'UI_THEME',
  'SCOREBOARD_STYLE',
  'SCOREBOARD_THEME',
  'SCOREBOARD_LAYOUT',
  'SCOREBOARD_HIDE_EMPTY',
  'SCOREBOARD_TITLE_HIDDEN',
  'SCOREBOARD_LOGO_ENABLED',
  'SCOREBOARD_CARD_BG_FILL',
  'SCOREBOARD_GAME_HEADER_ENABLED',
  'SCOREBOARD_RANKINGS_STICKY',
  'SCOREBOARD_SHOW_TIMER',
  'SCOREBOARD_RANKINGS_POSITION',
  'SCOREBOARD_RANKINGS_STYLE',
  'SCOREBOARD_GAME_TITLE_STYLE',
  'SCOREBOARD_QR_MODE',
  'SCOREBOARD_QR_POSITION',
  'SCOREBOARD_QR_SIZE',
  'SCOREBOARD_QR_OFFSET_PX',
  'SCOREBOARD_MAX_SCORES',
  'SCOREBOARD_MIN_SCORES',
  'SCOREBOARD_CARD_SPACING',
  'SCOREBOARD_TITLE_FONT_SIZE',
  'SCOREBOARD_MOBILE_VERTICAL',
  'SCOREBOARD_MOBILE_SCALE',
  'SCOREBOARD_ZOOM',
];

/** Controls that P3 demoted — none of these may render before Advanced opens. */
const ADVANCED_LABELS = [
  'Hide Empty Games',
  'Hide Game Room Title',
  'Hide Game Room Logo',
  'Card Background Fill',
  'Hide Game Art',
  'Show Countdown Timer',
  'Game Title Style',
  'Scores Per Card',
  'Rankings Position',
  'Rankings Card Style',
  'Always Visible Rankings',
  'QR Codes',
  'QR Code Position',
  'Mobile Vertical Scroll',
  'Mobile Density',
];

let fetchMock: ReturnType<typeof vi.fn>;

function mockFetch() {
  fetchMock = vi.fn((_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

async function renderModal(roomConfig: Record<string, string> = {}) {
  const onClose = vi.fn();
  const onSaved = vi.fn();
  // v2.130.0: the sheet leads with the Appearance control (useTheme), so it
  // needs a ThemeProvider — and ThemeProvider needs a router for useLocation.
  const utils = render(
    <MemoryRouter initialEntries={['/rooma']}>
      <ThemeProvider>
        <ScoreboardPreferencesModal
          open
          onClose={onClose}
          playerToken="token-1"
          roomConfig={roomConfig}
          onSaved={onSaved}
        />
      </ThemeProvider>
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getByText('Card Style')).toBeInTheDocument());
  return { ...utils, onClose, onSaved };
}

/** The select that belongs to a given control label. */
function selectFor(label: string): HTMLSelectElement {
  const el = screen.getByText(label).closest('div.py-2')!.querySelector('select');
  if (!el) throw new Error(`no select found for "${label}"`);
  return el as HTMLSelectElement;
}

function openAdvanced() {
  fireEvent.click(screen.getByText('Advanced'));
}

async function savedPayload(): Promise<Record<string, string | null>> {
  fireEvent.click(screen.getByText('Save Preferences'));
  await waitFor(() => expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(true));
  const post = fetchMock.mock.calls.find(c => c[1]?.method === 'POST')!;
  return JSON.parse(post[1].body as string);
}

describe('ScoreboardPreferencesModal — P3 tiering', () => {
  beforeEach(() => {
    mockFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders exactly the four top-level controls', async () => {
    await renderModal();
    expect(screen.getByText('Card Style')).toBeInTheDocument();
    expect(screen.getByText('Theme for this room only')).toBeInTheDocument();
    expect(screen.getByText('Card Layout')).toBeInTheDocument();
    expect(screen.getByText('Zoom')).toBeInTheDocument();
    // Card Style + UI Theme + Card Layout tiles/selects only — no showcase
    // theme picker on a non-showcase style.
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();
  });

  it('does not render demoted controls until Advanced is expanded', async () => {
    await renderModal();
    for (const label of ADVANCED_LABELS) {
      expect(screen.queryByText(label)).not.toBeInTheDocument();
    }
    openAdvanced();
    for (const label of ADVANCED_LABELS) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('shows the Showcase theme picker beneath Card Style only for showcase', async () => {
    const { unmount } = await renderModal({ SCOREBOARD_STYLE: 'showcase' });
    expect(screen.getByText('Theme')).toBeInTheDocument();
    unmount();

    await renderModal({ SCOREBOARD_STYLE: 'minimal' });
    expect(screen.queryByText('Theme')).not.toBeInTheDocument();
  });

  it('groups the Advanced controls under captions', async () => {
    await renderModal();
    openAdvanced();
    expect(screen.getByText('Cards & header')).toBeInTheDocument();
    expect(screen.getByText('Rankings')).toBeInTheDocument();
    expect(screen.getByText('QR codes — never show on phones')).toBeInTheDocument();
    // "Mobile" also names the header's device toggle — match the caption.
    expect(screen.getAllByText('Mobile').some(el => el.className.includes('uppercase'))).toBe(true);
  });

  it('still writes the keys of controls that moved into Advanced', async () => {
    await renderModal();
    openAdvanced();

    fireEvent.change(selectFor('Game Title Style'), { target: { value: 'chrome' } });
    fireEvent.change(selectFor('QR Codes'), { target: { value: 'all' } });
    fireEvent.change(selectFor('Rankings Position'), { target: { value: 'top' } });
    fireEvent.click(screen.getByText('Hide Empty Games').closest('div.py-2')!.querySelector('button')!);

    const payload = await savedPayload();
    expect(payload['SCOREBOARD_GAME_TITLE_STYLE']).toBe('chrome');
    expect(payload['SCOREBOARD_QR_MODE']).toBe('all');
    expect(payload['SCOREBOARD_RANKINGS_POSITION']).toBe('top');
    expect(payload['SCOREBOARD_HIDE_EMPTY']).toBe('true');
  });

  it('still writes the top-level Card Layout key', async () => {
    await renderModal();
    fireEvent.change(selectFor('Card Layout'), { target: { value: 'grid' } });
    const payload = await savedPayload();
    expect(payload['SCOREBOARD_LAYOUT']).toBe('grid');
  });

  it('saves every preference key — the re-tiering removed none', async () => {
    await renderModal();
    const payload = await savedPayload();
    for (const key of SAVED_KEYS) {
      expect(Object.keys(payload)).toContain(key);
    }
    expect(Object.keys(payload)).toHaveLength(SAVED_KEYS.length);
  });

  it('hides Rankings Position (with a note) when the rankings style is ticker', async () => {
    await renderModal({ SCOREBOARD_RANKINGS_STYLE: 'ticker' });
    openAdvanced();
    expect(screen.queryByText('Rankings Position')).not.toBeInTheDocument();
    expect(screen.getByText(/Ticker pins to the top/)).toBeInTheDocument();
    // The style select itself is still there to switch back with.
    expect(screen.getByText('Rankings Card Style')).toBeInTheDocument();
  });

  it('keeps Rankings Position when the rankings style is not ticker', async () => {
    await renderModal({ SCOREBOARD_RANKINGS_STYLE: 'plaque' });
    openAdvanced();
    expect(screen.getByText('Rankings Position')).toBeInTheDocument();
    expect(screen.queryByText(/Ticker pins to the top/)).not.toBeInTheDocument();
  });

  it('keeps the per-control reset affordance on a demoted control', async () => {
    await renderModal();
    openAdvanced();
    const titleStyle = screen.getByText('Game Title Style').closest('div.py-2')!;
    expect(titleStyle.querySelector('button')).toBeNull();
    fireEvent.change(selectFor('Game Title Style'), { target: { value: 'fire' } });
    expect(screen.getByText('Game Title Style').closest('div.py-2')!.querySelector('button')).not.toBeNull();
  });
});

/**
 * Reset All (owner ask, 2026-08-19). The save path must be the SAME full
 * enumeration the Save button uses: the backend deletes keys posted as null
 * and leaves absent keys untouched, so a bare `{}` POST would clear nothing.
 */
describe('ScoreboardPreferencesModal — Reset All', () => {
  beforeEach(() => {
    mockFetch();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('asks for confirmation inline before resetting', async () => {
    await renderModal();
    expect(screen.queryByText('Reset everything')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Reset All'));
    expect(screen.getByText('Reset everything')).toBeInTheDocument();
    // Backing out leaves nothing saved.
    fireEvent.click(screen.getByText('Cancel', { selector: 'button.text-xs' }));
    expect(screen.queryByText('Reset everything')).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(false);
  });

  it('clears local overrides and posts null for every key', async () => {
    await renderModal();
    openAdvanced();
    // Two overrides in hand — one top-level, one demoted.
    fireEvent.change(selectFor('Card Layout'), { target: { value: 'grid' } });
    fireEvent.change(selectFor('Game Title Style'), { target: { value: 'fire' } });

    fireEvent.click(screen.getByText('Reset All'));
    fireEvent.click(screen.getByText('Reset everything'));

    await waitFor(() => expect(fetchMock.mock.calls.some(c => c[1]?.method === 'POST')).toBe(true));
    const post = fetchMock.mock.calls.find(c => c[1]?.method === 'POST')!;
    const payload = JSON.parse(post[1].body as string);

    for (const key of SAVED_KEYS) {
      expect(payload[key]).toBeNull();
    }
    expect(Object.keys(payload)).toHaveLength(SAVED_KEYS.length);
  });

  it('closes through the normal saved flow', async () => {
    const { onClose, onSaved } = await renderModal();
    fireEvent.click(screen.getByText('Reset All'));
    fireEvent.click(screen.getByText('Reset everything'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});

/**
 * v2.132.0 — "Scoreboard display" became "Display settings": three labelled
 * sections (Appearance / My theme / This room), the last of which is hidden
 * off-room. The scoreboard-pref half above is untouched by the re-grouping;
 * these tests pin the new frame around it.
 */
describe('ScoreboardPreferencesModal — Display settings sections', () => {
  beforeEach(() => {
    mockFetch();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  function renderOffRoom() {
    return render(
      <MemoryRouter initialEntries={['/scoreboard']}>
        <ThemeProvider>
          <ScoreboardPreferencesModal
            open
            onClose={vi.fn()}
            playerToken="token-1"
            roomConfig={{}}
            onSaved={vi.fn()}
            roomScoped={false}
          />
        </ThemeProvider>
      </MemoryRouter>,
    );
  }

  it('is titled "Display settings" and renders all three sections on a room page', async () => {
    await renderModal();
    expect(screen.getByText('Display settings')).toBeInTheDocument();
    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.getByText('My theme')).toBeInTheDocument();
    expect(screen.getByText('This room')).toBeInTheDocument();
  });

  it('hides the "This room" section (and Save) off-room, keeping the first two', async () => {
    renderOffRoom();
    await waitFor(() => expect(screen.getByText('My theme')).toBeInTheDocument());

    expect(screen.getByText('Appearance')).toBeInTheDocument();
    expect(screen.queryByText('This room')).toBeNull();
    expect(screen.queryByText('Card Style')).toBeNull();
    expect(screen.queryByText('Theme for this room only')).toBeNull();
    // Save would post null for every scoreboard key and wipe the overrides.
    expect(screen.queryByText('Save Preferences')).toBeNull();
    expect(screen.getByText('Close')).toBeInTheDocument();
  });

  it('does not fetch scoreboard preferences off-room', async () => {
    renderOffRoom();
    await waitFor(() => expect(screen.getByText('My theme')).toBeInTheDocument());
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/api/me/scoreboard-preferences'))).toBe(false);
  });

  it('saving "My theme" POSTs { ui_theme } to /me/preferences, on its own', async () => {
    localStorage.setItem('arcaid_player_token', 'player.jwt.token');
    await renderModal();

    fireEvent.change(screen.getByTestId('personal-theme-picker'), { target: { value: 'retro' } });

    await waitFor(() => expect(
      fetchMock.mock.calls.some(c => String(c[0]).startsWith('/api/me/preferences') && c[1]?.method === 'POST'),
    ).toBe(true));
    const post = fetchMock.mock.calls.find(c => String(c[0]).startsWith('/api/me/preferences') && c[1]?.method === 'POST')!;
    expect(JSON.parse(post[1]!.body as string)).toEqual({ ui_theme: 'retro' });
    // Instant save — it must NOT wait for, or ride along with, the
    // scoreboard-prefs Save button.
    expect(fetchMock.mock.calls.some(c => String(c[0]).includes('/api/me/scoreboard-preferences') && c[1]?.method === 'POST')).toBe(false);
  });

  it('"Use each room\'s default" clears the personal theme', async () => {
    localStorage.setItem('arcaid_player_token', 'player.jwt.token');
    await renderModal();

    const picker = screen.getByTestId('personal-theme-picker');
    fireEvent.change(picker, { target: { value: 'retro' } });
    await waitFor(() => expect(localStorage.getItem('arcaid-theme-personal')).toBe('retro'));

    fireEvent.change(picker, { target: { value: '' } });

    await waitFor(() => expect(localStorage.getItem('arcaid-theme-personal')).toBeNull());
    const posts = fetchMock.mock.calls.filter(c => String(c[0]).startsWith('/api/me/preferences') && c[1]?.method === 'POST');
    expect(JSON.parse(posts[posts.length - 1][1]!.body as string)).toEqual({ ui_theme: null });
  });

  it('still saves the this-room theme override through the scoreboard-prefs payload', async () => {
    await renderModal();
    fireEvent.change(screen.getByTestId('room-theme-picker'), { target: { value: 'plasma' } });
    const payload = await savedPayload();
    expect(payload['UI_THEME']).toBe('plasma');
  });
});
