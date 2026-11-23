import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ThemeProvider, useTheme } from '../ThemeProvider';
import ThemeFloor from '../ThemeFloor';
import { FloorToggle, MyFloorToggle } from '../FloorToggle';
import { THEME_FLOOR_CLASSES, THEME_FLOOR_SVG } from '../themeFloorTiles.generated';
import { resolveFloor } from '../../lib/floor';
import { invalidatePortal } from '../../lib/portal';

/**
 * G29 (v2.264.0): the carpet floor. Resolution (the viewer's choice, else the
 * room's on its own public pages, else on), the first-paint mirrors, the
 * hydrate from the portal and /me/preferences, the layer itself, the switch,
 * and the CSS the generated markup depends on.
 */

type FetchArgs = [url: string, init?: RequestInit];

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signInPlayer(discordId = 'floor-player') {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  localStorage.setItem('arcaid_player_token', `${b64url({ alg: 'none' })}.${b64url({ discordId, exp })}.sig`);
}

/** Portal and /me/preferences answers; everything else is an empty OK. */
function stubFetch(opts: { roomFloor?: 'on' | 'off'; prefs?: Record<string, unknown> | null } = {}) {
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      const slug = new URL(url, 'http://localhost').searchParams.get('slug') || '';
      return j({ id: slug, roomId: slug, slug, name: slug, ui_theme: null, public_theme: null, ...(opts.roomFloor ? { ui_floor: opts.roomFloor } : {}) });
    }
    if (url.includes('/me/preferences') && method === 'GET') {
      return opts.prefs ? j(opts.prefs) : Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    }
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

const posted = (fetchMock: ReturnType<typeof stubFetch>) => fetchMock.mock.calls
  .filter((c: FetchArgs) => String(c[0]).includes('/me/preferences') && (c[1]?.method || 'GET').toUpperCase() === 'POST')
  .map((c: FetchArgs) => JSON.parse(String(c[1]!.body)));

/** Shows the context's floor values; every render reports its floor, so the first call is the first paint. */
const rendered = vi.fn<(floor: boolean) => void>();
function Probe() {
  const { floor, floorChoice, publicFloor, setFloorChoice } = useTheme();
  rendered(floor);
  const navigate = useNavigate();
  return (
    <div>
      <span data-testid="floor">{String(floor)}</span>
      <span data-testid="choice">{String(floorChoice)}</span>
      <span data-testid="room">{publicFloor}</span>
      <button onClick={() => setFloorChoice('off')}>choose-off</button>
      <button onClick={() => navigate('/rooma/admin/dashboard')}>go-admin</button>
      <button onClick={() => navigate('/rooma')}>go-room</button>
    </div>
  );
}

function renderAt(path: string, extra: React.ReactNode = null) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <Probe />
        {extra}
        <Routes>
          <Route path="/:slug/admin/dashboard" element={<div>admin</div>} />
          <Route path="/:slug" element={<div>room</div>} />
          <Route path="/account/settings" element={<div>account</div>} />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.className = '';
  rendered.mockClear();
  window.history.replaceState({}, '', '/');
  // The portal is cached per slug for the whole file; each test stubs its own.
  invalidatePortal('rooma');
});

afterEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('resolveFloor', () => {
  it('takes the viewer, else the room, else on', () => {
    expect(resolveFloor(null, null)).toBe(true);
    expect(resolveFloor(null, 'off')).toBe(false);
    expect(resolveFloor('on', 'off')).toBe(true);
    expect(resolveFloor('off', 'on')).toBe(false);
    expect(resolveFloor('off', null)).toBe(false);
  });
});

describe('ThemeProvider floor', () => {
  it('is on by default, on a room page and an admin page', async () => {
    stubFetch();
    renderAt('/rooma');
    expect(screen.getByTestId('floor')).toHaveTextContent('true');
    fireEvent.click(screen.getByText('go-admin'));
    await waitFor(() => expect(screen.getByText('admin')).toBeInTheDocument());
    expect(screen.getByTestId('floor')).toHaveTextContent('true');
  });

  it("applies the room's off on its public pages only", async () => {
    stubFetch({ roomFloor: 'off' });
    renderAt('/rooma');
    await waitFor(() => expect(screen.getByTestId('floor')).toHaveTextContent('false'));
    expect(localStorage.getItem('arcaid-floor-public-rooma')).toBe('off');

    fireEvent.click(screen.getByText('go-admin'));
    await waitFor(() => expect(screen.getByText('admin')).toBeInTheDocument());
    expect(screen.getByTestId('floor')).toHaveTextContent('true');
  });

  it("lets the viewer's choice beat the room's", async () => {
    stubFetch({ roomFloor: 'off' });
    localStorage.setItem('arcaid-floor', 'on');
    renderAt('/rooma');
    await waitFor(() => expect(screen.getByTestId('room')).toHaveTextContent('off'));
    expect(screen.getByTestId('floor')).toHaveTextContent('true');
  });

  it("turns it off everywhere when the viewer chose off, admin pages included", async () => {
    stubFetch({ roomFloor: 'on' });
    localStorage.setItem('arcaid-floor', 'off');
    renderAt('/rooma/admin/dashboard');
    expect(screen.getByTestId('floor')).toHaveTextContent('false');
  });

  it('reads both mirrors on the first paint, before any fetch resolves', () => {
    stubFetch();
    window.history.replaceState({}, '', '/rooma');
    localStorage.setItem('arcaid-floor-public-rooma', 'off');
    renderAt('/rooma').unmount();
    expect(rendered.mock.calls[0]?.[0]).toBe(false);

    rendered.mockClear();
    localStorage.setItem('arcaid-floor', 'on');
    renderAt('/rooma').unmount();
    expect(rendered.mock.calls[0]?.[0]).toBe(true);
  });

  it('records the viewer choice in localStorage and on the server when signed in', async () => {
    signInPlayer();
    const fetchMock = stubFetch({ prefs: { ui_theme: null, appearance: null, ui_floor: null } });
    renderAt('/account/settings');
    fireEvent.click(screen.getByText('choose-off'));
    expect(screen.getByTestId('floor')).toHaveTextContent('false');
    expect(localStorage.getItem('arcaid-floor')).toBe('off');
    await waitFor(() => expect(posted(fetchMock)).toContainEqual({ ui_floor: 'off' }));
  });

  it("takes the server's value over this device's on hydrate", async () => {
    signInPlayer();
    localStorage.setItem('arcaid-floor', 'on');
    stubFetch({ prefs: { ui_theme: null, appearance: null, ui_floor: 'off' } });
    renderAt('/account/settings');
    await waitFor(() => expect(screen.getByTestId('choice')).toHaveTextContent('off'));
    expect(localStorage.getItem('arcaid-floor')).toBe('off');
  });

  it("keeps a choice made before signing in when the account has none, and saves it up (appearance's rule)", async () => {
    signInPlayer();
    localStorage.setItem('arcaid-floor', 'off');
    const fetchMock = stubFetch({ prefs: { ui_theme: null, appearance: null, ui_floor: null } });
    renderAt('/account/settings');
    await waitFor(() => expect(posted(fetchMock)).toContainEqual({ ui_floor: 'off' }));
    expect(screen.getByTestId('choice')).toHaveTextContent('off');
    expect(localStorage.getItem('arcaid-floor')).toBe('off');
  });
});

describe('ThemeFloor', () => {
  it('draws the generated floor, hidden from assistive tech, when the floor is on', async () => {
    stubFetch();
    renderAt('/rooma', <ThemeFloor />);
    const layer = await screen.findByTestId('carpet-floor');
    expect(layer).toHaveAttribute('aria-hidden', 'true');
    expect(layer).toHaveClass('carpet-floor');
    expect(layer.querySelectorAll('pattern[id^="tf-"]').length).toBeGreaterThanOrEqual(4);
  });

  it('draws nothing when the floor is off', async () => {
    stubFetch();
    localStorage.setItem('arcaid-floor', 'off');
    renderAt('/rooma', <ThemeFloor />);
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });

  it('never draws under High contrast, even when the floor is on', async () => {
    stubFetch();
    localStorage.setItem('arcaid-floor', 'on');
    localStorage.setItem('arcaid-theme-personal', 'contrast');
    renderAt('/rooma/admin/dashboard', <ThemeFloor />);
    await waitFor(() => expect(document.documentElement).toHaveClass('theme-contrast'));
    await act(async () => { await new Promise(r => setTimeout(r, 20)); });
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });
});

describe('FloorToggle', () => {
  it('is a labelled switch that flips and shows the room copy', () => {
    const onChange = vi.fn();
    render(<FloorToggle scope="room" look="settings" checked onChange={onChange} />);
    const sw = screen.getByRole('switch', { name: 'Carpet floor' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    expect(sw).toHaveAccessibleDescription(
      "A faint arcade-carpet pattern behind this room's pages, in the theme's colours. Visitors can turn it off for themselves.",
    );
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it('adds the High contrast note for the viewer only when it applies', () => {
    const { rerender } = render(<FloorToggle scope="viewer" look="sheet" checked={false} onChange={() => {}} />);
    const sw = screen.getByRole('switch', { name: 'Carpet floor' });
    expect(sw).toHaveAttribute('aria-checked', 'false');
    expect(sw).toHaveAccessibleDescription("A faint arcade-carpet pattern behind the page, in the theme's colours.");
    rerender(<FloorToggle scope="viewer" look="account" checked={false} onChange={() => {}} highContrast />);
    expect(screen.getByRole('switch', { name: 'Carpet floor' })).toHaveAccessibleDescription(
      "A faint arcade-carpet pattern behind the page, in the theme's colours. High contrast never shows it.",
    );
  });

  it("MyFloorToggle shows the effective state on a room page and writes an explicit off", async () => {
    stubFetch({ roomFloor: 'on' });
    renderAt('/rooma', <MyFloorToggle look="sheet" />);
    const sw = screen.getByRole('switch', { name: 'Carpet floor' });
    expect(sw).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(sw);
    expect(screen.getByRole('switch', { name: 'Carpet floor' })).toHaveAttribute('aria-checked', 'false');
    expect(localStorage.getItem('arcaid-floor')).toBe('off');
  });
});

describe('the generated floor and its CSS', () => {
  const CSS_PATH = [resolve(process.cwd(), 'src/index.css'), resolve(process.cwd(), 'admin-ui/src/index.css')].find(existsSync)!;
  const css = readFileSync(CSS_PATH, 'utf8');
  const block = css.slice(css.indexOf('/* === Carpet floor'));

  it('gives every colour class the markup uses a rule that reads a site token', () => {
    expect(THEME_FLOOR_CLASSES.length).toBeGreaterThan(0);
    for (const cls of THEME_FLOOR_CLASSES) {
      const rule = new RegExp(`\\.carpet-floor \\.${cls} \\{ (fill|stroke|stop-color): ([^;]+); \\}`).exec(block);
      expect(rule, `.carpet-floor .${cls}`).not.toBeNull();
      expect(rule![2]).toMatch(/var\(--color-/);
    }
  });

  it('carries no colour literal, in the markup or in the floor CSS', () => {
    expect(THEME_FLOOR_SVG.replace(/url\(#[^)]*\)/g, '')).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(rules).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|oklch\(\s*[\d.]/i);
  });

  it('hides the layer from pointers and print', () => {
    expect(block).toMatch(/\.carpet-floor \{[^}]*pointer-events: none;[^}]*\}/);
    expect(block).toMatch(/@media print \{\s*\.carpet-floor \{ display: none; \}/);
    expect(block).toMatch(/\.theme-contrast \.carpet-floor \{ display: none; \}/);
  });
});
