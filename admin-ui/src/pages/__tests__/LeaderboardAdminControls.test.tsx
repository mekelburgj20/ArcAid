import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Leaderboard from '../Leaderboard';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * The room-admin Leaderboard card controls.
 *
 * v2.85.0 moved them out of an absolutely-positioned cluster pinned over the
 * card's TOP edge (i.e. on top of the game title, and `[@media(hover:none)]`
 * kept it permanently visible on touch, so on a phone no title was readable at
 * all) into a strip BELOW the card.
 *
 * v2.86.0 then deleted the page's private card entirely: the admin page now
 * renders `ScoreboardSurface`, the same component the public scoreboard uses,
 * and the strip is injected through its `renderUnderCard` slot. So these tests
 * drive the surface's LEGACY card path (`SCOREBOARD_STYLE` unset) and lock:
 *
 *   1. All five controls exist, exactly once per card, and none of them lives
 *      in the card at all — the card is public code now and knows nothing
 *      about admin.
 *   2. Nothing is absolutely positioned over the card top any more. That also
 *      pins the deliberate omission of `onSubmitScore`: the public page's "+"
 *      submit button is the one thing that draws there, and an admin
 *      previewing the design must not get a player affordance.
 *   3. The strip sits in a two-child, min-width-clamped column with the card.
 *   4. The verified-score checkmark reaches this card — via the public card's
 *      own BadgeCheck now, rather than a private admin reimplementation.
 */

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

const ROOM_ID = 'room-1';

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
    rankings: [
      { rank: 1, iscored_username: 'Krobs', display_name: null, score: 1000, discord_user_id: 'd-1', verified: true },
      { rank: 2, iscored_username: 'Nova', display_name: null, score: 500, discord_user_id: 'd-2', verified: false },
    ],
  },
];

/** Legacy card path: the config deliberately omits SCOREBOARD_STYLE. */
function stubFetch(config: Record<string, string> = {}, leaderboards: unknown = LEADERBOARDS) {
  const fetchMock = vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    // v2.118.0 — must precede '/leaderboard', which would otherwise answer the
    // card-order status with an array of boards.
    if (url.includes('/card-order')) return j({ active: false, savedAt: null });
    if (url.includes('/scoreboard-config')) return j(config);
    if (url.includes('/portal')) return j({ id: ROOM_ID, roomId: ROOM_ID, slug: 'test-room', name: 'Test Room', public_theme: null });
    if (url.includes('/rankings')) return j([]);
    if (url.includes('/leaderboard')) return j(leaderboards);
    return j([]);
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return fetchMock;
}

function renderLeaderboard() {
  return render(
    <MemoryRouter initialEntries={[`/test-room/admin/leaderboard`]}>
      <ToastProvider>
        <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: 'test-room', roomName: 'Test Room' }}>
          <Leaderboard />
        </RoomContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

const CONTROL_LABELS = ['Name', 'Notes', 'Style', 'Scores'];

describe('Leaderboard admin card controls (legacy card path)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('renders all five controls in one strip below the card', async () => {
    stubFetch();
    renderLeaderboard();

    const strip = await screen.findByTestId('admin-card-controls');
    for (const label of CONTROL_LABELS) {
      expect(within(strip).getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(within(strip).getByRole('button', { name: 'Remove game' })).toBeInTheDocument();

    // Exactly one strip per card, and no second copy of any button anywhere.
    expect(screen.getAllByTestId('admin-card-controls')).toHaveLength(1);
    for (const label of CONTROL_LABELS) {
      expect(screen.getAllByRole('button', { name: label })).toHaveLength(1);
    }
  });

  it('keeps the controls out of the card', async () => {
    stubFetch();
    renderLeaderboard();

    const strip = await screen.findByTestId('admin-card-controls');
    const heading = screen.getByRole('heading', { name: /Medieval Madness/ });

    // The strip is a SIBLING that follows the card, not a layer inside it.
    expect(strip.contains(heading)).toBe(false);
    expect(heading.compareDocumentPosition(strip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const wrapper = strip.parentElement as HTMLElement;
    const card = wrapper.firstElementChild as HTMLElement;
    expect(card.contains(strip)).toBe(false);
    expect(card.contains(heading)).toBe(true);
  });

  it('draws nothing over the card top, and offers no submit affordance', async () => {
    const { container } = renderLeaderboardWith(stubFetch);
    await screen.findByTestId('admin-card-controls');

    // The `+` submit button is the only thing the surface positions there, and
    // it renders only when `onSubmitScore` is supplied. The admin page
    // deliberately does not supply one.
    expect(container.querySelectorAll('.absolute.z-20')).toHaveLength(0);
    expect(screen.queryByLabelText(/Submit score for/)).not.toBeInTheDocument();

    // The strip itself is unconditionally visible: no hover gating, no
    // touch-device escape hatch, nothing to fade in.
    const strip = screen.getByTestId('admin-card-controls');
    expect(strip.className).not.toMatch(/opacity-0|group-hover|hover:none/);
  });

  /**
   * A structural regression from the first cut of v2.85.0, caused by an
   * intermediate `flex-1 min-h-0` box between the card and the strip. jsdom
   * measures no layout, so this asserts the STRUCTURE and the clamp classes the
   * browser-side fix depends on — the part a later refactor would silently
   * undo. The column now lives in `ScoreboardSurface.renderSlotContent`.
   */
  it('puts the card directly next to the strip in one min-width-clamped column', async () => {
    stubFetch();
    renderLeaderboard();

    const strip = await screen.findByTestId('admin-card-controls');
    const wrapper = strip.parentElement as HTMLElement;

    // No growth box between them: an intermediate `flex-1` child swallowed the
    // grid row-height stretch, leaving a short card's strip floating ~120px
    // below its own content.
    expect(wrapper.children).toHaveLength(2);
    const card = wrapper.firstElementChild as HTMLElement;
    expect(card).not.toBe(strip);
    expect(card.className).not.toMatch(/flex-1/);

    // `min-w-0` defeats the flex/grid automatic minimum size. Without it the
    // column takes its min-content width from the `truncate`d (nowrap) title,
    // and a long game name widens the card clean out of its grid track.
    expect(wrapper.className).toMatch(/\bmin-w-0\b/);
    expect(wrapper.className).toMatch(/\bflex-col\b/);
    expect(wrapper.className).toMatch(/\bh-full\b/);
  });

  it('renders the surface under the room theme, not the admin theme', async () => {
    stubFetch();
    const { container } = renderLeaderboard();
    await screen.findByTestId('admin-card-controls');

    // `sb-theme-scope` restates the default (dark) tokens so the mirror is not
    // tinted by whichever theme the ADMIN happens to be wearing. See index.css.
    await waitFor(() => expect(container.querySelector('.sb-theme-scope')).toBeInTheDocument());
    const scope = container.querySelector('.sb-theme-scope') as HTMLElement;
    expect(scope.contains(screen.getByTestId('admin-card-controls'))).toBe(true);
    // This room's public_theme is null → dark → no extra theme class.
    expect([...scope.classList].filter(c => c.startsWith('theme-'))).toEqual([]);
  });

  it('applies the room public theme class when the room has one', async () => {
    const fetchMock = vi.fn((url: string) => {
      const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      if (url.includes('/scoreboard-config')) return j({});
      if (url.includes('/portal')) return j({ id: ROOM_ID, roomId: ROOM_ID, slug: 'themed-room', name: 'Themed', public_theme: 'cyberpunk' });
      if (url.includes('/rankings')) return j([]);
      if (url.includes('/leaderboard')) return j(LEADERBOARDS);
      return j([]);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

    const { container } = render(
      <MemoryRouter initialEntries={[`/themed-room/admin/leaderboard`]}>
        <ToastProvider>
          <RoomContext.Provider value={{ roomId: ROOM_ID, roomSlug: 'themed-room', roomName: 'Themed' }}>
            <Leaderboard />
          </RoomContext.Provider>
        </ToastProvider>
      </MemoryRouter>,
    );

    await screen.findByTestId('admin-card-controls');
    await waitFor(() => {
      expect(container.querySelector('.sb-theme-scope.theme-cyberpunk')).toBeInTheDocument();
    });
  });

  /**
   * v2.85.1 — a bottom-anchored QR overlay hangs down across the strip's band.
   * It used to paint (and hit-test) ABOVE the strip, hiding the Name/Style
   * buttons and eating their clicks: nothing between the two creates a
   * stacking context, so the QR's z-index simply beat the strip's.
   *
   * jsdom computes no paint order, so this asserts the thing paint order is
   * DERIVED from — the two z-indexes and the absence of an isolating ancestor
   * between them. That is precisely the pair a future change would break, from
   * either side. The visual result was verified by screenshot; see the branch
   * report.
   */
  it('paints the controls strip above the card QR overlay', async () => {
    stubFetch({
      SCOREBOARD_STYLE: 'banner',
      SCOREBOARD_QR_MODE: 'all',
      SCOREBOARD_QR_POSITION: 'bottom-center',
    });
    const { container } = renderLeaderboard();

    const strip = await screen.findByTestId('admin-card-controls');

    // The QR overlay is the POSITIONED box carrying its own z-index; it is the
    // only such box inside the card. (It was `absolute` until the 2026-08-15
    // QR rework moved the non-Showcase families to an in-flow, `relative` box
    // so the card slot reserves the QR's space itself. Either way it is
    // positioned and z-indexed, which is what makes the comparison below
    // meaningful — so this asserts "not static" rather than a specific value.)
    const qr = container.querySelector('canvas')?.parentElement as HTMLElement;
    expect(qr, 'expected a QR overlay to render for this config').toBeTruthy();
    expect(['absolute', 'relative']).toContain(qr.style.position);

    const qrZ = Number(qr.style.zIndex);
    const stripZ = Number(strip.style.zIndex);
    expect(Number.isFinite(qrZ) && qrZ > 0).toBe(true);
    expect(Number.isFinite(stripZ) && stripZ > 0).toBe(true);
    expect(stripZ).toBeGreaterThan(qrZ);

    // ...and the comparison is meaningful only while the two share a stacking
    // context. Any ancestor between the QR and the strip that established one
    // would trap the QR and make the numbers unrelated — fine for THIS bug,
    // but it would mean this test had stopped testing anything.
    const column = strip.parentElement as HTMLElement;
    expect(column.contains(qr)).toBe(true);
    for (let el = qr.parentElement; el && el !== column; el = el.parentElement) {
      expect(el.style.zIndex, `${el.className} must not establish a stacking context`).toBe('');
      expect(el.style.isolation ?? '').not.toBe('isolate');
    }
  });

  it('keeps the QR visible rather than hiding it behind the strip', async () => {
    // The owner's requirement is specifically that the QR still RENDERS — an
    // admin previews what the card looks like with one. Fixing the overlap by
    // suppressing the QR on admin would be the wrong fix.
    stubFetch({
      SCOREBOARD_STYLE: 'banner',
      SCOREBOARD_QR_MODE: 'all',
      SCOREBOARD_QR_POSITION: 'bottom-center',
    });
    const { container } = renderLeaderboard();
    await screen.findByTestId('admin-card-controls');
    expect(container.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('flags a verified score and only a verified score', async () => {
    stubFetch();
    renderLeaderboard();

    await screen.findByText('Krobs');
    // Krobs is verified, Nova is not.
    expect(screen.getAllByLabelText('Verified score')).toHaveLength(1);
  });

  it('renders no checkmark when nothing is verified', async () => {
    stubFetch({}, [{
      ...LEADERBOARDS[0],
      rankings: LEADERBOARDS[0].rankings.map(r => ({ ...r, verified: false })),
    }]);

    renderLeaderboard();

    await screen.findByText('Krobs');
    await waitFor(() => expect(screen.queryByLabelText('Verified score')).not.toBeInTheDocument());
  });
});

/**
 * v2.118.0 — drag-to-reposition, which lives on this same strip.
 *
 * The order the page sends is the FULL server order with one id moved. The
 * "Manual order · Reset" chip is driven by the SERVER's answer, not by local
 * state, because the override self-invalidates (a tournament rotates, an admin
 * edits the configured positions) and the page must not claim an order that
 * every board has already discarded.
 */
describe('Leaderboard card reorder', () => {
  const TWO = [
    LEADERBOARDS[0],
    { ...LEADERBOARDS[0], gameId: 'game-2', gameName: 'Attack From Mars', rankings: [] },
  ];

  function stubOrder(status: { active: boolean; savedAt: string | null }, boards: unknown = TWO) {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      if (url.includes('/card-order')) {
        if (init?.method === 'PUT') return j({ active: true, savedAt: '2026-08-20T17:10:00.000Z' });
        if (init?.method === 'DELETE') return j({ active: false, savedAt: null });
        return j(status);
      }
      if (url.includes('/scoreboard-config')) return j({});
      if (url.includes('/portal')) return j({ id: ROOM_ID, roomId: ROOM_ID, slug: 'test-room', name: 'Test Room', public_theme: null });
      if (url.includes('/rankings')) return j([]);
      if (url.includes('/leaderboard')) return j(boards);
      return j([]);
    });
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    return fetchMock;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('puts a labelled drag handle in every card strip', async () => {
    stubOrder({ active: false, savedAt: null });
    renderLeaderboard();

    await screen.findAllByTestId('admin-card-controls');
    const handles = screen.getAllByLabelText(/^Drag to reorder /);
    expect(handles).toHaveLength(2);
    expect(handles[0]).toHaveAttribute('aria-label', 'Drag to reorder Medieval Madness');
    // 44px touch target, and no browser touch-scroll competing with the drag.
    expect(handles[0].className).toMatch(/w-11/);
    expect(handles[0].style.touchAction).toBe('none');
  });

  it('sends the full order when a card is dropped on another', async () => {
    const fetchMock = stubOrder({ active: false, savedAt: null });
    const { container } = renderLeaderboard();
    await screen.findAllByTestId('admin-card-controls');

    container.querySelectorAll('.scoreboard-card-slot').forEach((el, i) => {
      const left = i * 200;
      (el as HTMLElement).getBoundingClientRect = () => ({
        left, right: left + 200, top: 0, bottom: 200, width: 200, height: 200, x: left, y: 0, toJSON: () => ({}),
      }) as DOMRect;
    });

    const handle = screen.getByLabelText('Drag to reorder Medieval Madness');
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 10, clientY: 100 });
    fireEvent.pointerMove(handle, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientX: 300, clientY: 100 });

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(c => (c[1] as RequestInit)?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(String(put![0])).toContain(`/rooms/${ROOM_ID}/admin/leaderboard/card-order`);
      expect(JSON.parse((put![1] as RequestInit).body as string)).toEqual({ gameIds: ['game-2', 'game-1'] });
    });

    // Optimistic: the strip order flips before any refetch lands.
    const names = [...document.querySelectorAll('[aria-label^="Drag to reorder "]')]
      .map(el => el.getAttribute('aria-label'));
    expect(names).toEqual(['Drag to reorder Attack From Mars', 'Drag to reorder Medieval Madness']);
  });

  it('shows the Manual order chip only when the server says the override survives', async () => {
    stubOrder({ active: false, savedAt: null });
    const view = renderLeaderboard();
    await screen.findAllByTestId('admin-card-controls');
    expect(screen.queryByTestId('card-order-chip')).not.toBeInTheDocument();
    view.unmount();

    stubOrder({ active: true, savedAt: '2026-08-20T17:10:00.000Z' });
    renderLeaderboard();
    expect(await screen.findByTestId('card-order-chip')).toHaveTextContent('Manual order');
  });

  it('resets through a confirm dialog, never a native confirm()', async () => {
    const fetchMock = stubOrder({ active: true, savedAt: '2026-08-20T17:10:00.000Z' });
    const nativeConfirm = vi.spyOn(window, 'confirm');
    renderLeaderboard();

    fireEvent.click(within(await screen.findByTestId('card-order-chip')).getByRole('button', { name: 'Reset' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reset card order' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Reset' }));

    await waitFor(() => {
      const del = fetchMock.mock.calls.find(c => (c[1] as RequestInit)?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(String(del![0])).toContain('/admin/leaderboard/card-order');
    });
    await waitFor(() => expect(screen.queryByTestId('card-order-chip')).not.toBeInTheDocument());
    expect(nativeConfirm).not.toHaveBeenCalled();
  });
});

/** Renders with a stub applied first, returning RTL's container for raw
 *  class-name queries (the overlay assertion needs the DOM, not a role). */
function renderLeaderboardWith(applyStub: () => unknown) {
  applyStub();
  return renderLeaderboard();
}
