import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import StyleProfiles from '../StyleProfiles';

/**
 * Style-system revamp P2 — the Style Profiles block.
 *
 * It sits at the TOP of the Leaderboard Display card, so its most important
 * property is that it cannot take the settings page down: a failed or
 * malformed profile fetch must degrade to "no profiles", never to a crash.
 */

type FetchArgs = [string, RequestInit | undefined];

const PROFILE = {
  id: 'p1',
  name: 'Neon Night',
  settings: { SCOREBOARD_STYLE: 'arcade', SCOREBOARD_MAX_SCORES: '10' },
  isDefault: false,
  updatedAt: '2026-08-15T00:00:00Z',
};

function stubFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const mock = vi.fn((...args: FetchArgs) => {
    const body = handler(args[0], args[1]);
    if (body === undefined) return Promise.reject(new Error('unrouted'));
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  });
  vi.stubGlobal('fetch', mock as unknown as typeof fetch);
  return mock;
}

function renderBlock(props: Partial<React.ComponentProps<typeof StyleProfiles>> = {}) {
  const toast = vi.fn();
  const onApplied = vi.fn();
  render(
    <StyleProfiles
      roomId="room-1"
      onApplied={onApplied}
      hasUnsavedChanges={false}
      toast={toast}
      {...props}
    />,
  );
  return { toast, onApplied };
}

describe('StyleProfiles', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('lists the owner\'s profiles', async () => {
    stubFetch(() => ({ profiles: [PROFILE], current: {} }));
    renderBlock();

    expect(await screen.findByRole('option', { name: /Neon Night/ })).toBeInTheDocument();
  });

  it('degrades to an empty list when the fetch fails, without crashing', async () => {
    stubFetch(() => undefined); // rejects
    renderBlock();

    expect(await screen.findByRole('option', { name: /No saved profiles yet/ })).toBeInTheDocument();
  });

  it('degrades when the response is missing its fields entirely', async () => {
    // The exact shape a misrouted proxy or an older server returns. Rendering
    // `undefined.map` here would take the whole settings page down.
    stubFetch(() => ({}));
    renderBlock();

    expect(await screen.findByRole('option', { name: /No saved profiles yet/ })).toBeInTheDocument();
  });

  it('applies the selected profile and tells the page to reload', async () => {
    const mock = stubFetch((url, init) => {
      if (url.includes('/apply')) return { applied: ['SCOREBOARD_STYLE', 'SCOREBOARD_MAX_SCORES'] };
      if ((init?.method || 'GET') === 'GET') return { profiles: [PROFILE], current: {} };
      return {};
    });
    const { onApplied, toast } = renderBlock();

    const select = await screen.findByRole('combobox');
    fireEvent.change(select, { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: /apply/i }));

    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(mock.mock.calls.some(([u, i]) => u.includes('/style-profiles/p1/apply') && i?.method === 'POST')).toBe(true);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('2 settings updated'), 'success');
  });

  it('saves the current room under a new name', async () => {
    const mock = stubFetch((url, init) => {
      if ((init?.method || 'GET') === 'GET') return { profiles: [], current: {} };
      if (init?.method === 'POST') return { profile: { ...PROFILE, name: 'My Look' } };
      return {};
    });
    const { toast } = renderBlock();

    const input = await screen.findByPlaceholderText(/name this look/i);
    fireEvent.change(input, { target: { value: 'My Look' } });
    fireEvent.click(screen.getByRole('button', { name: /save this room/i }));

    await waitFor(() => expect(toast).toHaveBeenCalledWith('Saved "My Look"', 'success'));
    const post = mock.mock.calls.find(([u, i]) => u.endsWith('/style-profiles') && i?.method === 'POST');
    expect(JSON.parse(post![1]!.body as string)).toEqual({ name: 'My Look' });
  });

  it('warns that a save captures SAVED settings while the page is dirty', async () => {
    stubFetch(() => ({ profiles: [], current: {} }));
    renderBlock({ hasUnsavedChanges: true });

    expect(await screen.findByText(/unsaved changes/i)).toBeInTheDocument();
  });

  it('marks the profile this room already matches', async () => {
    stubFetch(() => ({ profiles: [PROFILE], current: { ...PROFILE.settings } }));
    renderBlock();

    expect(await screen.findByRole('option', { name: /in use here/ })).toBeInTheDocument();
  });

  it('does not claim a match when the room carries extra settings', async () => {
    stubFetch(() => ({
      profiles: [PROFILE],
      current: { ...PROFILE.settings, SCOREBOARD_QR_MODE: 'all' },
    }));
    renderBlock();

    await screen.findByRole('option', { name: /Neon Night/ });
    expect(screen.queryByRole('option', { name: /in use here/ })).not.toBeInTheDocument();
  });

  it('offers default / re-capture / delete under Manage', async () => {
    stubFetch(() => ({ profiles: [PROFILE], current: {} }));
    renderBlock();

    fireEvent.click(await screen.findByText(/manage profiles/i));

    expect(screen.getByRole('button', { name: /make Neon Night the default/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update Neon Night from this room/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /delete Neon Night/i })).toBeInTheDocument();
  });
});
