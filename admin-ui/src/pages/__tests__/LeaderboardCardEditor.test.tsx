import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Leaderboard from '../Leaderboard';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.119.0 (C2) — the card editor that replaces `StylePicker` on the admin
 * Leaderboard page.
 *
 * The owner's complaints were all one structural fact: the modal previewed art
 * in a wide strip that was not the card, so zoom, framing and identifier state
 * could all look right in the picker and wrong on the board. The fix is that
 * the REAL card is the preview, which is only true if a draft overlay reaches
 * the real `ScoreboardSurface` on every edit and reaches the SERVER only on
 * Apply. That contract is what these tests pin:
 *
 *   1. the editor opens on the card's CURRENT values (not defaults);
 *   2. every edit — style pick, zoom, drag, hide-identifier — lands on the
 *      card immediately, `has_*` flags included (build trap #6), and on
 *      nothing else;
 *   3. the overlay is DERIVED, so a `leaderboard:updated` refetch mid-edit
 *      cannot wipe it (build trap #8);
 *   4. Apply sends the FULL framing triple (trap #2) to the endpoint family
 *      the Apply-as mode selects (trap #3);
 *   5. Cancel is a pure client-side discard.
 *
 * `CardRouter` is mocked to a marker carrying the identity-bearing fields of
 * the row it was handed — the same idiom `LeaderboardDisplayRail.test.tsx`
 * uses — so an assertion reads "the card was rendered from the overlay".
 */

const LB_FIELDS = [
  'gameId', 'catalogueStyleId', 'logoStyleId', 'bgStyleId', 'styleHeaderDisabled',
  'bgZoom', 'bgPosX', 'bgPosY', 'catHasBg', 'catHasHeader', 'bgHasBg', 'logoHasHeader',
] as const;

vi.mock('../../components/scoreboard/CardRouter', () => ({
  default: (props: { lb: Record<string, unknown> }) => (
    <div
      data-testid="card"
      data-lb={JSON.stringify(Object.fromEntries(LB_FIELDS.map(k => [k, props.lb[k] ?? null])))}
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
const GAME_ID = 'game-1';

/** A card that is ALREADY styled and framed — the "current values" case. */
const LEADERBOARDS = [
  {
    gameId: GAME_ID,
    gameName: 'Medieval Madness',
    displayName: null,
    tournamentName: 'Daily Grind',
    tournamentType: 'DG',
    imageUrl: null,
    gameStatus: 'ACTIVE',
    catalogueStyleId: 'style-old',
    logoStyleId: null,
    bgStyleId: null,
    styleHeaderDisabled: true,
    catHasBg: 1,
    catHasHeader: 1,
    bgZoom: 180,
    bgPosX: 25,
    bgPosY: 70,
    notes: null,
    rankings: [{ rank: 1, iscored_username: 'Krobs', display_name: null, score: 1000, discord_user_id: 'd-1' }],
  },
];

const STYLES = [
  { id: 'style-old', name: 'Old Pack', author: 'Tester', has_background: 1, has_header: 1, source: 'custom' },
  { id: 'style-new', name: 'Neon Wall', author: 'Tester', has_background: 1, has_header: 0, source: 'custom' },
];

type FetchArgs = [url: string, init?: RequestInit];

function stubFetch(leaderboards: unknown = LEADERBOARDS) {
  const writes: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (method !== 'GET') {
      writes.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : null });
      return j({ success: true });
    }
    if (url.includes('/card-order')) return j({ active: false, savedAt: null });
    if (url.includes('/admin/style-profiles')) return j({ profiles: [], current: {} });
    if (url.includes('/scoreboard-config')) return j({ SCOREBOARD_STYLE: 'banner', SCOREBOARD_CARD_BG_FILL: 'true' });
    if (url.includes('/portal')) return j({ id: ROOM_ID, roomId: ROOM_ID, slug: SLUG, name: 'Test Room', public_theme: null });
    if (url.includes('/game_library/')) return j({ catalogueStyleId: null });
    if (url.includes('/rankings')) return j([]);
    if (url.includes('/styles')) return j({ styles: STYLES, total: STYLES.length });
    if (url.includes('/leaderboard')) return j(leaderboards);
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { fetchMock, writes };
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

/** The row the surface actually rendered — overlay merged. */
function cardLb(): Record<string, unknown> {
  return JSON.parse(screen.getAllByTestId('card')[0]!.getAttribute('data-lb')!);
}

async function openEditor() {
  const strip = await screen.findByTestId('admin-card-controls');
  fireEvent.click(within(strip).getByRole('button', { name: 'Edit card' }));
  const editor = await screen.findByTestId('card-style-editor');
  // The art-pack list resolves a tick later; every style-picking test needs it.
  await screen.findByText('Neon Wall');
  return editor;
}

const zoomSlider = () => screen.getByRole('slider', { name: 'Background zoom' }) as HTMLInputElement;

/** The card-edit overlay with a known geometry, so drag deltas are computable. */
function overlayWithBox(width = 400, height = 300): HTMLElement {
  const el = screen.getByTestId('card-edit-overlay');
  el.getBoundingClientRect = () => ({
    left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  return el;
}

describe('Leaderboard card editor', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    for (const k of Object.keys(socketHandlers)) delete socketHandlers[k];
  });

  it('opens in the rail on the card’s CURRENT values, and spotlights the card', async () => {
    stubFetch();
    renderLeaderboard();
    await openEditor();

    // The rail switched context rather than opening a second panel.
    expect(screen.getByTestId('display-settings-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('display-settings-panel')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Edit card' })).toBeInTheDocument();

    // Stored framing and identifier state, not the 100/50/50 defaults.
    expect(zoomSlider().value).toBe('180');
    expect(screen.getByRole('switch', { name: 'Hide game identifier' })).toHaveAttribute('aria-checked', 'true');
    // The card's existing art pack is the selected tile.
    expect(screen.getByRole('button', { name: /Old Pack/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('card-edit-overlay')).toBeInTheDocument();
  });

  it('picking a style previews on the card WITH the has_* flags, and writes nothing', async () => {
    const { writes } = stubFetch();
    renderLeaderboard();
    await openEditor();

    fireEvent.click(screen.getByText('Neon Wall'));

    await waitFor(() => expect(cardLb().catalogueStyleId).toBe('style-new'));
    // Trap #6: the cards gate on the flags, not the id. 'Neon Wall' is
    // background-only, so a preview that kept catHasHeader=1 would keep
    // drawing the OLD identifier over the new art.
    expect(cardLb().catHasBg).toBe(1);
    expect(cardLb().catHasHeader).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('the zoom slider floors at 50, and 49 is clamped rather than stored', async () => {
    stubFetch();
    renderLeaderboard();
    await openEditor();

    expect(zoomSlider().min).toBe('50');
    expect(zoomSlider().max).toBe('300');

    fireEvent.change(zoomSlider(), { target: { value: '50' } });
    await waitFor(() => expect(cardLb().bgZoom).toBe(50));

    fireEvent.change(zoomSlider(), { target: { value: '49' } });
    await waitFor(() => expect(cardLb().bgZoom).toBe(50));
  });

  it('dragging the card repositions the background by the subtractive delta', async () => {
    stubFetch();
    renderLeaderboard();
    await openEditor();

    const overlay = overlayWithBox(400, 300);
    fireEvent.pointerDown(overlay, { pointerId: 1, clientX: 200, clientY: 150 });
    fireEvent.pointerMove(overlay, { pointerId: 1, clientX: 240, clientY: 120 });
    fireEvent.pointerUp(overlay, { pointerId: 1, clientX: 240, clientY: 120 });

    // Subtraction, not addition: +40px right over a 400px card is -10% on the
    // X position, which is what makes the art follow the pointer.
    await waitFor(() => expect(cardLb().bgPosX).toBe(15));   // 25 - 10
    expect(cardLb().bgPosY).toBe(80);                        // 70 - (-30/300*100)
  });

  it('the hide-identifier toggle is reachable and previews live', async () => {
    stubFetch();
    renderLeaderboard();
    await openEditor();

    expect(cardLb().styleHeaderDisabled).toBe(true);
    fireEvent.click(screen.getByRole('switch', { name: 'Hide game identifier' }));
    await waitFor(() => expect(cardLb().styleHeaderDisabled).toBe(false));
  });

  it('Apply sends the FULL framing triple to the style endpoint in Both mode', async () => {
    const { writes } = stubFetch();
    renderLeaderboard();
    await openEditor();

    fireEvent.click(screen.getByText('Neon Wall'));
    fireEvent.change(zoomSlider(), { target: { value: '75' } });
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const put = writes.find(w => w.method === 'PUT' && w.url.includes(`/admin/games/${GAME_ID}/style`));
    expect(put).toBeTruthy();
    // Trap #2 — an omitted axis reads as "unframed" server-side.
    expect(put!.body).toEqual({
      catalogueStyleId: 'style-new', headerDisabled: true, bgZoom: 75, bgPosX: 25, bgPosY: 70,
    });
    expect(writes.some(w => w.url.includes('/image'))).toBe(false);
  });

  it('Apply routes to the image endpoint when Apply-as is Background', async () => {
    const { writes } = stubFetch();
    renderLeaderboard();
    await openEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    fireEvent.click(screen.getByText('Neon Wall'));
    // The background override previews through its OWN flag pair.
    await waitFor(() => expect(cardLb().bgStyleId).toBe('style-new'));
    expect(cardLb().bgHasBg).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(writes.length).toBeGreaterThan(0));
    const put = writes.find(w => w.method === 'PUT' && w.url.includes(`/admin/games/${GAME_ID}/image`));
    expect(put).toBeTruthy();
    expect(put!.body).toEqual({
      styleId: 'style-new', imageType: 'background', bgZoom: 180, bgPosX: 25, bgPosY: 70,
    });
    expect(writes.some(w => w.url.includes(`/admin/games/${GAME_ID}/style`))).toBe(false);
  });

  it('Cancel drops the overlay without a request', async () => {
    const { writes } = stubFetch();
    renderLeaderboard();
    await openEditor();

    fireEvent.click(screen.getByText('Neon Wall'));
    await waitFor(() => expect(cardLb().catalogueStyleId).toBe('style-new'));

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(cardLb().catalogueStyleId).toBe('style-old'));
    expect(screen.queryByTestId('card-style-editor')).not.toBeInTheDocument();
    expect(screen.queryByTestId('card-edit-overlay')).not.toBeInTheDocument();
    expect(writes).toHaveLength(0);
  });

  it('the overlay survives a leaderboard:updated refetch mid-edit', async () => {
    stubFetch();
    renderLeaderboard();
    await openEditor();

    fireEvent.click(screen.getByText('Neon Wall'));
    fireEvent.change(zoomSlider(), { target: { value: '60' } });
    await waitFor(() => expect(cardLb().catalogueStyleId).toBe('style-new'));

    // A score lands somewhere in the room: the page replaces its whole
    // `leaderboards` array. The overlay is derived, so it re-merges.
    socketHandlers['leaderboard:updated']?.forEach(fn => fn());

    await waitFor(() => {
      expect(cardLb().catalogueStyleId).toBe('style-new');
      expect(cardLb().bgZoom).toBe(60);
    });
    expect(screen.getByTestId('card-style-editor')).toBeInTheDocument();
  });
});
