import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import PublicLayout from '../PublicLayout';
import RoomAdminLayout from '../RoomAdminLayout';
import SuperAdminLayout from '../SuperAdminLayout';
import { ThemeProvider } from '../ThemeProvider';
import { ViewerAuthProvider } from '../../contexts/ViewerAuthContext';
import { setToken } from '../../lib/api';

/**
 * G29 (v2.264.0): the carpet floor is mounted by the three themed layouts and
 * by nothing else. Each layout draws it when the floor is on, not when it is
 * off, and never under High contrast.
 */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

function b64url(obj: object): string {
  return btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const fakeJwt = (payload: object) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

/** The portal (with the room's floor), and an empty OK for everything else. */
function stubFetch(roomFloor: 'on' | 'off' = 'on', personalTheme: string | null = null) {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.startsWith('/api/portal')) {
      const slug = new URL(url, 'http://localhost').searchParams.get('slug') || '';
      return j({ id: `id-${slug}`, roomId: `id-${slug}`, slug, name: slug, pick_award_enabled: false, ui_floor: roomFloor });
    }
    if (url === '/api/auth/me') return j({ username: 'admin', avatar: null });
    // Signed-in admins hydrate their personal theme from here (the server wins).
    if (url === '/api/me/preferences') return j({ ui_theme: personalTheme, appearance: null, ui_floor: null });
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
}

const settle = () => act(async () => { await new Promise(r => setTimeout(r, 30)); });

function renderPublic(slug: string) {
  return render(
    <MemoryRouter initialEntries={[`/${slug}/child`]}>
      <ThemeProvider>
        <ViewerAuthProvider>
          <Routes>
            <Route path="/:slug" element={<PublicLayout />}>
              <Route path="child" element={<div>public child</div>} />
            </Route>
          </Routes>
        </ViewerAuthProvider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function renderRoomAdmin(slug: string) {
  setToken(fakeJwt({ role: 'room_admin', gameRoomIds: [`id-${slug}`], exp: Math.floor(Date.now() / 1000) + 3600 }));
  return render(
    <MemoryRouter initialEntries={[`/${slug}/admin/dashboard`]}>
      <ThemeProvider>
        <Routes>
          <Route path="/:slug/admin" element={<RoomAdminLayout />}>
            <Route path="dashboard" element={<div>room admin child</div>} />
          </Route>
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function renderSuperAdmin() {
  setToken(fakeJwt({ role: 'super_admin', exp: Math.floor(Date.now() / 1000) + 3600 }));
  return render(
    <MemoryRouter initialEntries={['/admin/dashboard']}>
      <ThemeProvider>
        <Routes>
          <Route path="/admin" element={<SuperAdminLayout />}>
            <Route path="dashboard" element={<div>super admin child</div>} />
          </Route>
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.className = '';
});

afterEach(() => {
  setToken(null);
});

describe('PublicLayout', () => {
  it('draws the floor first, behind the positioned page, when the room leaves it on', async () => {
    stubFetch('on');
    renderPublic('floor-pub-on');
    const floor = await screen.findByTestId('carpet-floor');
    await screen.findByText('public child');
    const root = floor.parentElement!;
    expect(root.firstElementChild).toBe(floor);
    // The scroll area that holds the page is positioned, so it paints above.
    expect(screen.getByText('public child').closest('.overflow-y-auto')).toHaveClass('relative');
  });

  it("draws nothing when the room's floor is off", async () => {
    stubFetch('off');
    renderPublic('floor-pub-off');
    await screen.findByText('public child');
    await waitFor(() => expect(localStorage.getItem('arcaid-floor-public-floor-pub-off')).toBe('off'));
    await settle();
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });

  it('draws nothing under High contrast', async () => {
    stubFetch('on');
    localStorage.setItem('arcaid-theme-personal', 'contrast');
    renderPublic('floor-pub-contrast');
    await screen.findByText('public child');
    await settle();
    expect(document.documentElement).toHaveClass('theme-contrast');
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });
});

describe('RoomAdminLayout', () => {
  it('draws the floor when it is on', async () => {
    stubFetch('off'); // the room's own switch does not reach its admin pages
    renderRoomAdmin('floor-ra-on');
    await screen.findByText('room admin child');
    const floor = await screen.findByTestId('carpet-floor');
    expect(floor.parentElement!.firstElementChild).toBe(floor);
    expect(screen.getByText('room admin child').closest('main')).toHaveClass('relative');
  });

  it('draws nothing when the viewer turned it off', async () => {
    stubFetch('on');
    localStorage.setItem('arcaid-floor', 'off');
    renderRoomAdmin('floor-ra-off');
    await screen.findByText('room admin child');
    await settle();
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });

  it('draws nothing under High contrast', async () => {
    stubFetch('on', 'contrast');
    localStorage.setItem('arcaid-theme-personal', 'contrast');
    renderRoomAdmin('floor-ra-contrast');
    await screen.findByText('room admin child');
    await settle();
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });
});

describe('SuperAdminLayout', () => {
  it('draws the floor when it is on', async () => {
    stubFetch();
    renderSuperAdmin();
    await screen.findByText('super admin child');
    const floor = await screen.findByTestId('carpet-floor');
    expect(floor.parentElement!.firstElementChild).toBe(floor);
    expect(screen.getByText('super admin child').closest('main')).toHaveClass('relative');
  });

  it('draws nothing when the viewer turned it off', async () => {
    stubFetch();
    localStorage.setItem('arcaid-floor', 'off');
    renderSuperAdmin();
    await screen.findByText('super admin child');
    await settle();
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });

  it('draws nothing under High contrast', async () => {
    stubFetch('on', 'contrast');
    localStorage.setItem('arcaid-theme-personal', 'contrast');
    renderSuperAdmin();
    await screen.findByText('super admin child');
    await settle();
    expect(screen.queryByTestId('carpet-floor')).toBeNull();
  });
});

describe('where the floor is mounted', () => {
  const SRC = [resolve(process.cwd(), 'src'), resolve(process.cwd(), 'admin-ui/src')].find(existsSync)!;
  const read = (rel: string) => readFileSync(resolve(SRC, rel), 'utf8');

  it('is in the three themed layouts', () => {
    for (const file of ['components/PublicLayout.tsx', 'components/RoomAdminLayout.tsx', 'components/SuperAdminLayout.tsx']) {
      expect(read(file), file).toMatch(/<ThemeFloor \/>/);
    }
  });

  it('is not on the kiosk, the Global Scoreboard, the landing page, the Witness pages or the Arcaid-look root', () => {
    for (const file of [
      'pages/KioskScoreboard.tsx', 'pages/GlobalScoreboard.tsx', 'pages/LandingPage.tsx',
      'components/AwPageShell.tsx', 'components/parts/ArcaidPage.tsx',
    ]) {
      if (!existsSync(resolve(SRC, file))) continue;
      expect(read(file), file).not.toMatch(/ThemeFloor/);
    }
  });
});
