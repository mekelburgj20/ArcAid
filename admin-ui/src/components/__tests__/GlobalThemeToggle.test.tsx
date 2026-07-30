import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import GlobalThemeToggle from '../GlobalThemeToggle';
import { ThemeProvider, STORAGE_GLOBAL_PAGE_KEY } from '../ThemeProvider';

// v2.50.0 (A1) — global pages (/, /scoreboard, /catalogue, /games/*) stopped
// rendering the admin-set GLOBAL_PAGE_THEME and now follow the visitor:
//   1. localStorage['arcaid-global-theme'] (explicit choice)
//   2. prefers-color-scheme
//   3. dark
// These tests pin that precedence plus the "once you've chosen, the OS can't
// override you" rule — the easy regression is re-attaching the media listener
// unconditionally, which would let an OS flip stomp the visitor's choice.

/** jsdom ships no usable matchMedia; install a controllable one. */
function stubMatchMedia(prefersLight: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: prefersLight,
    media: '(prefers-color-scheme: light)',
    onchange: null,
    addEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => { listeners.add(cb); },
    removeEventListener: (_type: string, cb: (e: MediaQueryListEvent) => void) => { listeners.delete(cb); },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  };
  vi.stubGlobal('matchMedia', vi.fn(() => mql) as unknown as typeof window.matchMedia);
  return {
    get listenerCount() { return listeners.size; },
    /** Simulate the OS flipping its light/dark preference. */
    flipTo(light: boolean) {
      mql.matches = light;
      listeners.forEach(cb => cb({ matches: light } as MediaQueryListEvent));
    },
  };
}

function renderToggle() {
  return render(
    <MemoryRouter initialEntries={['/scoreboard']}>
      <ThemeProvider>
        <GlobalThemeToggle />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

const isLightApplied = () => document.documentElement.classList.contains('theme-light');

describe('GlobalThemeToggle / global-page polarity', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, json: () => Promise.resolve(null) })) as unknown as typeof fetch);
    localStorage.clear();
    document.documentElement.className = '';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('with no stored choice, follows the OS preference (light)', async () => {
    stubMatchMedia(true);

    renderToggle();

    await waitFor(() => expect(isLightApplied()).toBe(true));
    // Showing the Moon = "switch to dark", i.e. we are currently light.
    expect(screen.getByLabelText('Switch to dark mode')).toBeInTheDocument();
  });

  it('with no stored choice and an OS dark preference, stays dark', async () => {
    stubMatchMedia(false);

    renderToggle();

    await waitFor(() => expect(screen.getByLabelText('Switch to light mode')).toBeInTheDocument());
    expect(isLightApplied()).toBe(false);
  });

  it('an explicit stored choice wins over the OS preference', async () => {
    // OS says light; the visitor previously picked dark. Dark must win.
    stubMatchMedia(true);
    localStorage.setItem(STORAGE_GLOBAL_PAGE_KEY, 'dark');

    renderToggle();

    await waitFor(() => expect(screen.getByLabelText('Switch to light mode')).toBeInTheDocument());
    expect(isLightApplied()).toBe(false);
  });

  it('clicking the toggle applies and persists the choice', async () => {
    stubMatchMedia(false);

    renderToggle();
    await waitFor(() => expect(screen.getByLabelText('Switch to light mode')).toBeInTheDocument());

    fireEvent.click(screen.getByLabelText('Switch to light mode'));

    await waitFor(() => expect(isLightApplied()).toBe(true));
    expect(localStorage.getItem(STORAGE_GLOBAL_PAGE_KEY)).toBe('light');
    expect(screen.getByLabelText('Switch to dark mode')).toBeInTheDocument();
  });

  it('the OS listener is active only while no explicit choice exists', async () => {
    const media = stubMatchMedia(false);

    renderToggle();
    await waitFor(() => expect(isLightApplied()).toBe(false));
    expect(media.listenerCount).toBe(1);

    fireEvent.click(screen.getByLabelText('Switch to light mode')); // records a choice
    await waitFor(() => expect(isLightApplied()).toBe(true));
    // Choice recorded -> the listener detaches, so an OS flip to dark is ignored.
    await waitFor(() => expect(media.listenerCount).toBe(0));
    media.flipTo(false);
    expect(isLightApplied()).toBe(true);
  });

  it('an OS flip re-themes the page while no explicit choice exists', async () => {
    const media = stubMatchMedia(false);

    renderToggle();
    await waitFor(() => expect(isLightApplied()).toBe(false));

    media.flipTo(true);

    await waitFor(() => expect(isLightApplied()).toBe(true));
    // Still no stored choice — the page is merely mirroring the OS.
    expect(localStorage.getItem(STORAGE_GLOBAL_PAGE_KEY)).toBeNull();
  });
});
