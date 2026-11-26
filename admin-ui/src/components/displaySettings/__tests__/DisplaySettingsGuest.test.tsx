import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import DisplaySettingsPanel from '../DisplaySettingsPanel';
import { ThemeProvider } from '../../ThemeProvider';
import { waitForRealDialog } from '../../../test/dialogTestUtils';
import { stubResizeObserver } from '../../../test/stubResizeObserver';
import {
  DISPLAY_SETTINGS_LIVE_EVENT, DISPLAY_SETTINGS_SAVED_EVENT, readGuestPrefs, writeGuestPrefs,
  type DisplaySettingsLiveDetail,
} from '../../../lib/displaySettingsLive';

stubResizeObserver();

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../../Toast', () => ({ useToast: () => ({ toast: toastMock }) }));

/**
 * G34c - the Display settings panel for a signed-out visitor: no token, no
 * account. Card settings live in this browser under
 * `arcaid-scoreboard-prefs-<device>`; nothing is requested from `/api/me/*`.
 */

const fetchMock = vi.fn();
const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

let live: DisplaySettingsLiveDetail[] = [];
const onLive = (e: Event) => { live.push((e as CustomEvent<DisplaySettingsLiveDetail>).detail); };
const lastLive = () => live[live.length - 1]!.prefs;

function renderPanel() {
  const onClose = vi.fn();
  render(
    <MemoryRouter initialEntries={['/rooma']}>
      <ThemeProvider>
        <Routes>
          <Route
            path="*"
            element={(
              <DisplaySettingsPanel
                onClose={onClose}
                playerToken={null}
                slug="rooma"
                roomId="room-1"
                roomName="Room A"
                roomConfig={{ SCOREBOARD_STYLE: 'arcade' }}
              />
            )}
          />
        </Routes>
      </ThemeProvider>
    </MemoryRouter>,
  );
  return { onClose };
}

async function ready() {
  await waitForRealDialog();
  await screen.findByRole('group', { name: 'Card style' });
}
const press = (groupName: string, button: string | RegExp) =>
  fireEvent.click(within(screen.getByRole('group', { name: groupName })).getByRole('button', { name: button }));
const KEY = 'arcaid-scoreboard-prefs-desktop';
const meCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/me/'));
const innerWidth = window.innerWidth;

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => ok({}));
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  toastMock.mockReset();
  live = [];
  window.addEventListener(DISPLAY_SETTINGS_LIVE_EVENT, onLive);
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
});
afterEach(() => {
  window.removeEventListener(DISPLAY_SETTINGS_LIVE_EVENT, onLive);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.className = '';
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
});

describe('Display settings panel - signed-out visitor', () => {
  it('opens with no token, says it is saved in this browser, and has no Copy button', async () => {
    renderPanel();
    await ready();
    const dialog = screen.getByRole('dialog', { name: 'Display settings' });
    expect(within(dialog).getByText('Saved in this browser only.')).toBeInTheDocument();
    expect(within(dialog).queryByText('Only you see these.')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Copy to my/ })).toBeNull();
    expect(screen.queryByTestId('copy-row')).toBeNull();
  });

  it('a card change writes this browser key at once and makes no request to /api/me', async () => {
    renderPanel();
    await ready();
    press('Card style', /^Banner/);
    expect(lastLive()).toEqual({ SCOREBOARD_STYLE: 'banner' });
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ SCOREBOARD_STYLE: 'banner' });
    expect(screen.getByTestId('display-save-status')).toHaveTextContent('Saved ✓');
    fireEvent.click(screen.getByRole('button', { name: 'More scores per card' }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_MAX_SCORES: '6' });
    expect(meCalls()).toHaveLength(0);
  });

  it('loads what this browser already holds, and the mobile set has its own key', async () => {
    writeGuestPrefs('desktop', { SCOREBOARD_STYLE: 'minimal' });
    writeGuestPrefs('mobile', { SCOREBOARD_STYLE: 'banner' });
    renderPanel();
    await ready();
    const pressedNow = within(screen.getByRole('group', { name: 'Card style' })).getAllByRole('button')
      .filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.textContent);
    expect(pressedNow).toHaveLength(1);
    expect(pressedNow[0]).toMatch(/^Minimal/);
    expect(readGuestPrefs('mobile')).toEqual({ SCOREBOARD_STYLE: 'banner' });
  });

  it('Undo puts this browser key back; Room defaults clears it', async () => {
    writeGuestPrefs('desktop', { SCOREBOARD_STYLE: 'minimal' });
    renderPanel();
    await ready();
    press('Card style', /^Banner/);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ SCOREBOARD_STYLE: 'banner' });
    fireEvent.click(screen.getByRole('button', { name: 'Undo changes' }));
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ SCOREBOARD_STYLE: 'minimal' });
    expect(lastLive()).toEqual({ SCOREBOARD_STYLE: 'minimal' });
    fireEvent.click(screen.getByRole('button', { name: 'Room defaults' }));
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(lastLive()).toEqual({});
    expect(meCalls()).toHaveLength(0);
  });

  it('closing tells the page to read this browser key again', async () => {
    const saved = vi.fn();
    window.addEventListener(DISPLAY_SETTINGS_SAVED_EVENT, saved);
    const { onClose } = renderPanel();
    await ready();
    press('Card style', /^Banner/);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
    await waitFor(() => expect(saved).toHaveBeenCalled());
    window.removeEventListener(DISPLAY_SETTINGS_SAVED_EVENT, saved);
  });

  it('blocked storage still applies the change live, with no crash', async () => {
    renderPanel();
    await ready();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    press('Card style', /^Banner/);
    expect(lastLive()).toEqual({ SCOREBOARD_STYLE: 'banner' });
    expect(screen.getByRole('dialog', { name: 'Display settings' })).toBeInTheDocument();
    expect(screen.getByTestId('display-save-status')).toHaveTextContent("Couldn't save");
    expect(meCalls()).toHaveLength(0);
  });

  it('the colours a guest picks stay in this browser across a reload', async () => {
    const first = render(
      <MemoryRouter initialEntries={['/rooma']}>
        <ThemeProvider>
          <DisplaySettingsPanel onClose={() => {}} playerToken={null} slug="rooma" roomId="room-1" roomName="Room A" roomConfig={{}} />
        </ThemeProvider>
      </MemoryRouter>,
    );
    await ready();
    fireEvent.click(within(screen.getByRole('group', { name: 'Appearance' })).getByRole('button', { name: /^Light/ }));
    expect(localStorage.getItem('arcaid-appearance')).toBe('light');
    first.unmount();
    expect(readGuestPrefs('desktop')).toEqual({});
    expect(meCalls()).toHaveLength(0);
  });
});
