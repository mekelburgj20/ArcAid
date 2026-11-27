import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DisplaySettingsButton from '../DisplaySettingsButton';
import PublicLayout from '../PublicLayout';
import GlobalScoreboard from '../../pages/GlobalScoreboard';
import { ThemeProvider } from '../ThemeProvider';
import { ViewerAuthContext, type ViewerAuth } from '../../contexts/ViewerAuthContext';

/**
 * G34c - the "Display" button beside the light/dark switch is for signed-out
 * visitors only (a signed-in viewer opens the panel from the user menu) and
 * opens the panel with the same window event the user menu sends.
 */

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function stubFetch() {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    if (url.startsWith('/api/portal')) {
      return ok({ id: 'room-1', roomId: 'room-1', slug: 'rtx_pinball', name: 'RTX Pinball', pick_award_enabled: false });
    }
    return ok([]);
  }) as unknown as typeof fetch);
}

const signedOut: ViewerAuth = {
  token: null, discordUser: null, playerToken: null,
  loginWithDiscord: () => {}, loginWithGoogle: () => {}, logoutPlayer: () => {}, setViewerAvatar: () => {},
} as unknown as ViewerAuth;
const signedIn: ViewerAuth = {
  ...signedOut, playerToken: 'player.jwt.token',
  discordUser: { id: 'u1', username: 'justin', avatar: null },
} as unknown as ViewerAuth;

function renderRoom(viewer: ViewerAuth) {
  return render(
    <MemoryRouter initialEntries={['/rtx_pinball']}>
      <ThemeProvider>
        <ViewerAuthContext.Provider value={viewer}>
          <Routes>
            <Route path="/:slug" element={<PublicLayout />} />
          </Routes>
        </ViewerAuthContext.Provider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

function renderGlobal(viewer: ViewerAuth) {
  return render(
    <MemoryRouter initialEntries={['/scoreboard']}>
      <ThemeProvider>
        <ViewerAuthContext.Provider value={viewer}>
          <GlobalScoreboard />
        </ViewerAuthContext.Provider>
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => { localStorage.clear(); stubFetch(); });
afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

describe('DisplaySettingsButton', () => {
  it('is named Display settings and sends the open event the user menu sends, after taking focus', () => {
    const seen = vi.fn();
    window.addEventListener('open-scoreboard-prefs', seen);
    render(<DisplaySettingsButton />);
    const button = screen.getByRole('button', { name: 'Display settings' });
    expect(button).toHaveAttribute('title', 'Display settings');
    fireEvent.click(button);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
    window.removeEventListener('open-scoreboard-prefs', seen);
  });

  it('shows on a room page signed out, and is absent signed in', async () => {
    const out = renderRoom(signedOut);
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch to (light|dark) mode/ })).toBeInTheDocument());
    // One copy in each place; CSS (display:none) leaves exactly one visible at any width.
    expect(screen.getAllByRole('button', { name: 'Display settings' })).toHaveLength(2);
    const bar = screen.getByTestId('display-button-bar');
    expect(bar.className).toContain('hidden');
    expect(bar.className).toContain('sm:inline-flex');
    expect(within(bar).getByRole('button', { name: 'Display settings' })).toBeInTheDocument();
    const row = screen.getByTestId('brandrow');
    expect(row.className).toContain('sm:hidden');
    expect(within(row).getByRole('button', { name: 'Display settings' })).toBeInTheDocument();
    out.unmount();
    renderRoom(signedIn);
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch to (light|dark) mode/ })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Display settings' })).toBeNull();
  });

  it('shows on the Global Scoreboard signed out, and is absent signed in', async () => {
    const out = renderGlobal(signedOut);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Display settings' })).toBeInTheDocument());
    out.unmount();
    renderGlobal(signedIn);
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch to (light|dark) mode/ })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Display settings' })).toBeNull();
  });
});
