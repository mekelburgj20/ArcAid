import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Leaderboard from '../Leaderboard';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.116.0 (C1) — the room-display editing rail on the admin Leaderboard page.
 *
 * The thing worth pinning is the DRAFT contract, because it is the whole point
 * of moving these controls off Settings: an edit must reach the real
 * `ScoreboardSurface` immediately (the page is its own preview) while reaching
 * the server only on Save, and Save must carry the changed keys and nothing
 * else. `CardRouter` is mocked to a marker carrying its design-bearing props —
 * the same idiom `ScoreboardWysiwygParity.test.tsx` uses — so the assertion is
 * "the card was configured from the draft", not a screenshot.
 */

const CARD_PROPS = ['style', 'maxScores', 'cardBgFill', 'qrMode'] as const;

vi.mock('../../components/scoreboard/CardRouter', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="card"
      data-props={JSON.stringify(Object.fromEntries(CARD_PROPS.map(k => [k, props[k] ?? null])))}
    />
  ),
}));

const socketHandlers: Record<string, ((data?: unknown) => void)[]> = {};
vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({
    emit: vi.fn(),
    on: (event: string, fn: (data?: unknown) => void) => { (socketHandlers[event] ||= []).push(fn); },
    off: (event: string, fn: (data?: unknown) => void) => {
      socketHandlers[event] = (socketHandlers[event] || []).filter(h => h !== fn);
    },
  }),
}));

const ROOM_ID = 'room-1';
const SLUG = 'test-room';

const LEADERBOARDS = [
  {
    gameId: 'game-1',
    gameName: 'Medieval Madness',
    displayName: null,
    tournamentName: 'Daily Grind',
    tournamentType: 'DG',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: null,
    logoStyleId: null,
    bgStyleId: null,
    styleHeaderDisabled: false,
    notes: null,
    rankings: [{ rank: 1, iscored_username: 'Krobs', display_name: null, score: 1000, discord_user_id: 'd-1' }],
  },
];

type FetchArgs = [url: string, init?: RequestInit];

/** `SCOREBOARD_STYLE` is set so the surface takes the CardRouter path (the
 *  legacy GameCard path ignores most of these keys). */
function stubFetch(config: Record<string, string> = { SCOREBOARD_STYLE: 'banner' }) {
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url] = args;
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/admin/style-profiles')) return j({ profiles: [], current: {} });
    if (url.includes('/scoreboard-config')) return j(config);
    if (url.includes('/portal')) return j({ id: ROOM_ID, roomId: ROOM_ID, slug: SLUG, name: 'Test Room', public_theme: null });
    if (url.includes('/rankings')) return j([]);
    if (url.includes('/leaderboard')) return j(LEADERBOARDS);
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderLeaderboard() {
  return render(
    <MemoryRouter initialEntries={[`/${SLUG}/admin/leaderboard`]}>
      <ToastProvider>
        <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: SLUG, roomName: 'Test Room' }}>
          <Leaderboard />
        </RoomContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

function cardProps(): Record<string, unknown> {
  return JSON.parse(screen.getAllByTestId('card')[0].getAttribute('data-props')!);
}

/** The saved payload from the most recent POST .../settings call, or null. */
function lastSavePayload(fetchMock: ReturnType<typeof vi.fn<(...args: FetchArgs) => unknown>>) {
  const call = fetchMock.mock.calls
    .filter((c: FetchArgs) => c[0].includes('/settings') && (c[1]?.method || '').toUpperCase() === 'POST')
    .pop();
  return call ? JSON.parse((call[1] as RequestInit).body as string) as Record<string, string> : null;
}

function rowFor(labelText: string): HTMLElement {
  const label = screen.getByText(labelText);
  return label.closest('div')!.parentElement as HTMLElement;
}

async function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: /Display settings/ }));
  return screen.findByTestId('display-settings-panel');
}

describe('Leaderboard — room display rail', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
  });

  it('renders no panel until the header button is clicked', async () => {
    stubFetch();
    renderLeaderboard();
    await screen.findByTestId('card');

    expect(screen.queryByTestId('display-settings-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('display-settings-rail')).not.toBeInTheDocument();

    await openPanel();
    expect(screen.getByTestId('display-settings-rail')).toBeInTheDocument();
  });

  it('an edit reaches the real surface immediately and the server not at all', async () => {
    const fetchMock = stubFetch({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_CARD_BG_FILL: 'true' });
    renderLeaderboard();
    await screen.findByTestId('card');
    expect(cardProps().cardBgFill).toBe(true);

    await openPanel();
    fireEvent.click(within(rowFor('Card Background Fill')).getByRole('button'));

    await waitFor(() => expect(cardProps().cardBgFill).toBe(false));
    expect(lastSavePayload(fetchMock)).toBeNull();
  });

  it('Save posts ONLY the changed keys, then re-baselines', async () => {
    const fetchMock = stubFetch({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_MAX_SCORES: '5' });
    renderLeaderboard();
    await screen.findByTestId('card');
    await openPanel();

    fireEvent.click(within(rowFor('Hide Empty Games')).getByRole('button'));
    const bar = await screen.findByTestId('display-settings-savebar');
    expect(bar).toHaveTextContent('1 unsaved change');

    fireEvent.click(within(bar).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(lastSavePayload(fetchMock)).not.toBeNull());
    expect(lastSavePayload(fetchMock)).toEqual({ SCOREBOARD_HIDE_EMPTY: 'true' });
    // Re-fetch of scoreboard-config re-baselines the draft, clearing dirty.
    await waitFor(() => expect(screen.queryByTestId('display-settings-savebar')).not.toBeInTheDocument());
  });

  it('Discard puts the surface back on the saved config', async () => {
    stubFetch({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_CARD_BG_FILL: 'true' });
    renderLeaderboard();
    await screen.findByTestId('card');
    await openPanel();

    fireEvent.click(within(rowFor('Card Background Fill')).getByRole('button'));
    await waitFor(() => expect(cardProps().cardBgFill).toBe(false));

    const bar = await screen.findByTestId('display-settings-savebar');
    fireEvent.click(within(bar).getByRole('button', { name: 'Discard' }));

    await waitFor(() => expect(cardProps().cardBgFill).toBe(true));
    expect(screen.queryByTestId('display-settings-savebar')).not.toBeInTheDocument();
  });

  it('a toggle flipped on and back off reads as clean (default-resolved diff)', async () => {
    stubFetch();
    renderLeaderboard();
    await screen.findByTestId('card');
    await openPanel();

    const control = within(rowFor('Hide Empty Games')).getByRole('button');
    fireEvent.click(control);
    expect(await screen.findByTestId('display-settings-savebar')).toBeInTheDocument();
    fireEvent.click(control);
    await waitFor(() => expect(screen.queryByTestId('display-settings-savebar')).not.toBeInTheDocument());
  });

  it('closing with unsaved changes confirms first, and cancelling keeps the panel open', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    stubFetch();
    renderLeaderboard();
    await screen.findByTestId('card');
    await openPanel();

    fireEvent.click(within(rowFor('Hide Empty Games')).getByRole('button'));
    await screen.findByTestId('display-settings-savebar');

    fireEvent.click(screen.getByRole('button', { name: 'Close display settings' }));
    expect(confirmSpy).toHaveBeenCalled();
    expect(screen.getByTestId('display-settings-panel')).toBeInTheDocument();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'Close display settings' }));
    await waitFor(() => expect(screen.queryByTestId('display-settings-panel')).not.toBeInTheDocument());
  });

  /**
   * Another admin saved. The page must pick that up — but never over the top
   * of an edit in progress, which is worse than a stale baseline.
   */
  it('refetches config on settings:updated while clean', async () => {
    const fetchMock = stubFetch();
    renderLeaderboard();
    await screen.findByTestId('card');
    const before = fetchMock.mock.calls.filter(c => String(c[0]).includes('/scoreboard-config')).length;

    socketHandlers['settings:updated']?.forEach(fn => fn());

    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(c => String(c[0]).includes('/scoreboard-config')).length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('does NOT refetch config on settings:updated while the draft is dirty', async () => {
    const fetchMock = stubFetch();
    renderLeaderboard();
    await screen.findByTestId('card');
    await openPanel();
    fireEvent.click(within(rowFor('Hide Empty Games')).getByRole('button'));
    await screen.findByTestId('display-settings-savebar');

    const before = fetchMock.mock.calls.filter(c => String(c[0]).includes('/scoreboard-config')).length;
    socketHandlers['settings:updated']?.forEach(fn => fn());
    await new Promise(r => setTimeout(r, 0));

    const after = fetchMock.mock.calls.filter(c => String(c[0]).includes('/scoreboard-config')).length;
    expect(after).toBe(before);
    expect(screen.getByTestId('display-settings-savebar')).toBeInTheDocument();
  });
});
