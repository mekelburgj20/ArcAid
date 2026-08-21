import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CardStyleEditorSheet from '../CardStyleEditorSheet';
import type { SyntheticCardSource } from '../SyntheticCardPreview';
import { stubResizeObserver } from '../../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.124.0 (C3) — the sheet that retires `StylePicker` on GameLibrary and
 * Tournaments.
 *
 * Both pages used to hand-roll the Apply routing, and both had already drifted
 * from the rail: neither knew about the `/framing` family, so a zoom-only edit
 * either did nothing (GameLibrary's Apply was disabled without a style pick) or
 * DELETEd the style. These tests pin the routing per Apply-as mode for BOTH
 * targets — the library row (GameLibrary's room default) and an activated game
 * row plus its optional library twin (Tournaments) — and the two rules that
 * silently corrupt data when they rot:
 *
 *   trap #2: the FULL framing triple on every write (an omitted axis is read
 *            as "unframed" and resets it);
 *   trap #3: the `/image` family carries the framing separately from `/style`.
 *
 * Plus: nothing reaches the server before Apply, and closing a dirty session
 * asks first (with `ConfirmModal`, never `window.confirm`).
 */

vi.mock('../CardRouter', () => ({
  default: (props: { lb: Record<string, unknown> }) => (
    <div data-testid="card" data-lb={JSON.stringify(props.lb)} />
  ),
}));

const ROOM_ID = 'room-1';
const GAME_NAME = 'Medieval Madness';
const CONFIG = { SCOREBOARD_STYLE: 'banner', SCOREBOARD_CARD_BG_FILL: 'true' };

const STYLES = [
  { id: 'style-old', name: 'Old Pack', author: 'Tester', has_background: 1, has_header: 1, source: 'custom' },
  { id: 'style-new', name: 'Neon Wall', author: 'Tester', has_background: 1, has_header: 0, source: 'custom' },
];

const SOURCE: SyntheticCardSource = {
  gameName: GAME_NAME,
  displayName: null,
  imageUrl: null,
  catalogueStyleId: 'style-old',
  styleHeaderDisabled: false,
  bgZoom: null,
  bgPosX: null,
  bgPosY: null,
};

type FetchArgs = [url: string, init?: RequestInit];

function stubFetch() {
  const writes: { method: string; url: string; body: unknown }[] = [];
  const fetchMock = vi.fn((...args: FetchArgs) => {
    const [url, init] = args;
    const method = (init?.method || 'GET').toUpperCase();
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (method !== 'GET') {
      writes.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : null });
      return j({ success: true });
    }
    if (url.includes('/styles')) return j({ styles: STYLES, total: STYLES.length });
    return j({});
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
  return { writes };
}

function renderSheet(props: Partial<React.ComponentProps<typeof CardStyleEditorSheet>> = {}) {
  const onApplied = vi.fn();
  const onClose = vi.fn();
  render(
    <MemoryRouter>
      <CardStyleEditorSheet
        roomId={ROOM_ID}
        target={{ kind: 'library', gameName: GAME_NAME }}
        source={SOURCE}
        config={CONFIG}
        onApplied={onApplied}
        onClose={onClose}
        {...props}
      />
    </MemoryRouter>,
  );
  return { onApplied, onClose };
}

/** The art-pack list resolves a tick after mount. */
async function ready() {
  await screen.findByTestId('card-style-editor');
  await screen.findByText('Neon Wall');
}

const apply = () => fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
const zoomSlider = () => screen.getByRole('slider', { name: 'Background zoom' }) as HTMLInputElement;

/** The framing triple every write must carry in full (trap #2). */
const TRIPLE = { bgZoom: 100, bgPosX: 50, bgPosY: 50 };

describe('CardStyleEditorSheet — GameLibrary (room default)', () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it('opens on the row’s current values, previewing on a synthetic card', async () => {
    stubFetch();
    renderSheet({ source: { ...SOURCE, bgZoom: 180, bgPosX: 25, bgPosY: 70, styleHeaderDisabled: true } });
    await ready();

    expect(screen.getByTestId('card-style-editor-sheet')).toBeInTheDocument();
    expect(screen.getByTestId('synthetic-card-preview')).toBeInTheDocument();
    expect(zoomSlider().value).toBe('180');
    expect(screen.getByRole('switch', { name: 'Hide game identifier' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /Old Pack/ })).toHaveAttribute('aria-pressed', 'true');
    // The card is draggable for framing, exactly as on the admin board.
    expect(screen.getByTestId('card-edit-overlay')).toBeInTheDocument();
  });

  it('a style pick previews on the card and writes nothing until Apply', async () => {
    const { writes } = stubFetch();
    renderSheet();
    await ready();

    fireEvent.click(screen.getByText('Neon Wall'));

    await waitFor(() => {
      const lb = JSON.parse(screen.getByTestId('card').getAttribute('data-lb')!);
      expect(lb.catalogueStyleId).toBe('style-new');
      // Trap #6 — 'Neon Wall' is background-only.
      expect(lb.catHasHeader).toBe(0);
    });
    expect(writes).toHaveLength(0);
  });

  it('Apply as Both → PUT game_library/:name/style with the FULL framing triple', async () => {
    const { writes } = stubFetch();
    const { onApplied, onClose } = renderSheet();
    await ready();

    fireEvent.click(screen.getByText('Neon Wall'));
    apply();

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('PUT');
    expect(writes[0]!.url).toBe(`/api/rooms/${ROOM_ID}/game_library/Medieval%20Madness/style`);
    expect(writes[0]!.body).toEqual({ catalogueStyleId: 'style-new', headerDisabled: false, ...TRIPLE });
    await waitFor(() => expect(onApplied).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('Apply as Background → PUT game_library/:name/image, framing riding along (trap #3)', async () => {
    const { writes } = stubFetch();
    renderSheet();
    await ready();

    fireEvent.click(screen.getByText('Neon Wall'));
    fireEvent.click(screen.getByRole('button', { name: 'Background' }));
    apply();

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url).toBe(`/api/rooms/${ROOM_ID}/game_library/Medieval%20Madness/image`);
    expect(writes[0]!.body).toEqual({ styleId: 'style-new', imageType: 'background', ...TRIPLE });
  });

  it('a zoom-only edit takes the /framing family — no style id involved', async () => {
    const { writes } = stubFetch();
    renderSheet();
    await ready();

    fireEvent.change(zoomSlider(), { target: { value: '60' } });
    apply();

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('PUT');
    expect(writes[0]!.url).toBe(`/api/rooms/${ROOM_ID}/game_library/Medieval%20Madness/framing`);
    expect(writes[0]!.body).toEqual({ bgZoom: 60, bgPosX: 50, bgPosY: 50 });
  });

  it('Clear style → DELETE game_library/:name/style', async () => {
    const { writes } = stubFetch();
    renderSheet();
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Clear style' }));
    apply();

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.method).toBe('DELETE');
    expect(writes[0]!.url).toBe(`/api/rooms/${ROOM_ID}/game_library/Medieval%20Madness/style`);
  });

  it('Cancel is a pure client-side discard', async () => {
    const { writes } = stubFetch();
    const { onClose } = renderSheet();
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(writes).toHaveLength(0);
    expect(onClose).toHaveBeenCalled();
  });

  it('closing a DIRTY session asks first, in a ConfirmModal', async () => {
    const { writes } = stubFetch();
    const { onClose } = renderSheet();
    await ready();

    fireEvent.change(zoomSlider(), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Discard card changes' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalled();
    expect(writes).toHaveLength(0);
  });

  it('a clean session closes on Escape without asking', async () => {
    stubFetch();
    const { onClose } = renderSheet();
    await ready();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Discard card changes' })).not.toBeInTheDocument();
  });

  it('the library row IS the default, so no "set as room default" twin is offered', async () => {
    stubFetch();
    renderSheet();
    await ready();

    expect(screen.queryByRole('switch', { name: /room default/i })).not.toBeInTheDocument();
  });
});

describe('CardStyleEditorSheet — Tournaments (an activated game)', () => {
  beforeEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  const gameProps = {
    target: { kind: 'game' as const, gameId: 'game-1', gameName: GAME_NAME },
    showDefaultOption: true,
    libraryHasDefault: false,
  };

  it('Apply writes the GAME row, then the library twin when "set as default" is on', async () => {
    const { writes } = stubFetch();
    renderSheet(gameProps);
    await ready();

    // `libraryHasDefault: false` opens the toggle ON, exactly as v1's checkbox did.
    expect(screen.getByRole('switch', { name: /Set as this game’s room default/ })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByText('Neon Wall'));
    apply();

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]!.url).toBe(`/api/rooms/${ROOM_ID}/admin/games/game-1/style`);
    expect(writes[0]!.body).toEqual({ catalogueStyleId: 'style-new', headerDisabled: false, ...TRIPLE });
    expect(writes[1]!.url).toBe(`/api/rooms/${ROOM_ID}/game_library/Medieval%20Madness/style`);
    expect(writes[1]!.body).toEqual({ catalogueStyleId: 'style-new', headerDisabled: false, ...TRIPLE });
  });

  it('with the default toggle OFF only the game row is written', async () => {
    const { writes } = stubFetch();
    renderSheet(gameProps);
    await ready();

    fireEvent.click(screen.getByRole('switch', { name: /Set as this game’s room default/ }));
    fireEvent.click(screen.getByText('Neon Wall'));
    apply();

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.url).toBe(`/api/rooms/${ROOM_ID}/admin/games/game-1/style`);
  });

  it('a zoom-only edit hits the game AND library /framing endpoints', async () => {
    const { writes } = stubFetch();
    renderSheet(gameProps);
    await ready();

    fireEvent.change(zoomSlider(), { target: { value: '60' } });
    apply();

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]!.url).toBe(`/api/rooms/${ROOM_ID}/admin/games/game-1/framing`);
    expect(writes[1]!.url).toBe(`/api/rooms/${ROOM_ID}/game_library/Medieval%20Madness/framing`);
    expect(writes[0]!.body).toEqual({ bgZoom: 60, bgPosX: 50, bgPosY: 50 });
  });

  it('Clear style → DELETE on both rows', async () => {
    const { writes } = stubFetch();
    renderSheet(gameProps);
    await ready();

    fireEvent.click(screen.getByRole('button', { name: 'Clear style' }));
    apply();

    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[0]).toMatchObject({ method: 'DELETE', url: `/api/rooms/${ROOM_ID}/admin/games/game-1/style` });
    expect(writes[1]).toMatchObject({ method: 'DELETE', url: `/api/rooms/${ROOM_ID}/game_library/Medieval%20Madness/style` });
  });
});
