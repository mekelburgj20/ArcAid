import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import DisplaySettingsHost from '../DisplaySettingsHost';
import { ThemeProvider } from '../ThemeProvider';
import { setPartImporterForTests } from '../../lib/lazyPart';
import { stubResizeObserver } from '../../test/stubResizeObserver';
import { waitForRealDialog } from '../../test/dialogTestUtils';

stubResizeObserver();

/**
 * G34a - the app-wide host opens the Display settings panel from the user
 * menu's event. The panel is a chunk of its own: it opens once that arrives,
 * and a chunk that cannot load says so with a way to try again.
 */

const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

function renderHost(path = '/scoreboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ThemeProvider>
        <DisplaySettingsHost />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const open = () => act(() => { window.dispatchEvent(new Event('open-scoreboard-prefs')); });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('arcaid_player_token', 'player.jwt.token');
  vi.stubGlobal('fetch', vi.fn(() => ok({})) as unknown as typeof fetch);
});
afterEach(() => {
  setPartImporterForTests('display-settings');
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('DisplaySettingsHost', () => {
  it('opens the panel on the user menu\'s event and closes it with the x', async () => {
    renderHost();
    expect(screen.queryByRole('dialog')).toBeNull();
    open();
    await waitForRealDialog();
    const dialog = await screen.findByRole('dialog', { name: 'Display settings' });
    expect(dialog.className).toContain('arc-dialog--panel');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('opens nothing for a signed-out visitor', async () => {
    localStorage.removeItem('arcaid_player_token');
    renderHost();
    open();
    await new Promise(r => setTimeout(r, 50));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a panel chunk that cannot load says so, and Try again asks for it again', async () => {
    // Fails until the connection is back (an idle prefetch may ask too, so not just once).
    let offline = true;
    const importer = vi.fn(() => (offline
      ? Promise.reject(new Error('Failed to fetch dynamically imported module'))
      : import('../displaySettings/DisplaySettingsPanel')));
    setPartImporterForTests('display-settings', importer);
    renderHost();
    open();
    // The dialog's stand-in gives way to the real one: wait for it before reading or clicking inside.
    await waitForRealDialog();
    expect(await screen.findByText("Couldn't open them. Check the connection and try again.")).toBeInTheDocument();
    const asked = importer.mock.calls.length;
    offline = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByRole('group', { name: 'Theme' });
    expect(importer.mock.calls.length).toBeGreaterThan(asked);
  });
});
