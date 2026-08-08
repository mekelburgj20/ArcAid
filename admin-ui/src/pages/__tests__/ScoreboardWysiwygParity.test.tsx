import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { RoomContext } from '../../contexts/RoomContext';
import { ToastProvider } from '../../components/Toast';
import Scoreboard from '../Scoreboard';
import Leaderboard from '../Leaderboard';
import { stubResizeObserver } from '../../test/stubResizeObserver';

stubResizeObserver();

/**
 * v2.86.0 — the WYSIWYG contract.
 *
 * The room-admin Leaderboard page must render the public scoreboard, not a
 * lookalike. Before this release it carried a hand copy that had drifted forty
 * ways: its own re-derivation of the display config, its own private card
 * component players never saw, no QR, no per-game title style, no roomId (so
 * no score expand and no game-info links), no vertical layout, no
 * banner-forces-scroll rule.
 *
 * Both pages now render `ScoreboardSurface`, so this file asserts the thing a
 * future refactor could quietly break: given the SAME config and the SAME
 * payload, both pages must reach for the same card component with the same
 * design-bearing props.
 *
 * The card components are mocked to marker elements carrying their props. That
 * is deliberate — it tests the CONTRACT (which card, configured how) rather
 * than either card's internals, and it does not require production code to
 * grow test hooks.
 */

const CARD_PROPS = [
  'style', 'theme', 'maxScores', 'minScores', 'showTimer', 'cardBgFill',
  'titleFontSize', 'qrMode', 'qrSize', 'qrPosition', 'qrOverlapPx',
  'gameTitleStyle', 'roomId', 'slug',
] as const;

/** The mocked card renders its title the way the real cards do — as a Link
 *  when `titleLinkTo` is supplied, a plain `<h3>` otherwise — so the tests can
 *  assert that admin and public agree on which one that is. */
function MockTitle({ props }: { props: Record<string, unknown> }) {
  const name = String((props.lb as { gameName?: string })?.gameName);
  const to = props.titleLinkTo as string | undefined;
  const onClick = props.titleLinkOnClick as ((e: React.MouseEvent) => void) | undefined;
  return to
    ? <Link data-testid="card-title" to={to} onClick={onClick}>{name}</Link>
    : <h3 data-testid="card-title">{name}</h3>;
}

vi.mock('../../components/scoreboard/CardRouter', () => ({
  default: (props: Record<string, unknown>) => (
    <div
      data-testid="card"
      data-kind="router"
      data-props={JSON.stringify(Object.fromEntries(CARD_PROPS.map(k => [k, props[k] ?? null])))}
    >
      <MockTitle props={props} />
    </div>
  ),
}));

vi.mock('../../components/ScoreboardComponents', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ScoreboardComponents')>();
  return {
    ...actual,
    GameCard: (props: Record<string, unknown>) => (
      <div
        data-testid="card"
        data-kind="legacy"
        data-props={JSON.stringify({
          maxScores: props.maxScores ?? null,
          roomId: props.roomId ?? null,
          slug: props.slug ?? null,
          qrMode: props.qrMode ?? null,
          gameTitleStyle: props.gameTitleStyle ?? null,
          headerStyle: props.headerStyle ?? null,
          cardWidth: props.cardWidth ?? null,
          scoreColumns: props.scoreColumns ?? null,
        })}
      >
        <MockTitle props={props} />
      </div>
    ),
  };
});

vi.mock('../../lib/websocket', () => ({
  getSocket: () => ({ emit: vi.fn(), on: vi.fn(), off: vi.fn() }),
}));

vi.mock('../../components/ThemeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/ThemeProvider')>();
  return { ...actual, useTheme: () => ({ setPublicTheme: vi.fn() }) };
});

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
    rankings: [
      { rank: 1, iscored_username: 'Krobs', display_name: null, score: 1000, discord_user_id: 'd-1' },
    ],
  },
];

function stubFetch(config: Record<string, string>) {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const j = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
    if (url.includes('/scoreboard-config')) return j(config);
    if (url.includes('/portal')) return j({ id: ROOM_ID, roomId: ROOM_ID, slug: SLUG, name: 'Test Room', public_theme: null });
    if (url.includes('/scoreboard-preferences')) return Promise.resolve({ ok: false, status: 401, json: () => Promise.resolve({}) });
    if (url.includes('/rankings')) return j([]);
    if (url.includes('/leaderboard')) return j(LEADERBOARDS);
    return j([]);
  }) as unknown as typeof fetch);
}

const roomCtx = { roomId: ROOM_ID, roomSlug: SLUG, roomName: 'Test Room' };

/** The public page reads its slug from the route (`useParams`), the admin page
 *  from RoomContext — so the public render needs a real `:slug` route for the
 *  two to be comparable. */
function renderPage(page: 'public' | 'admin') {
  const path = page === 'public' ? `/${SLUG}` : `/${SLUG}/admin/leaderboard`;
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ToastProvider>
        <RoomContext.Provider value={roomCtx}>
          <Routes>
            <Route path="/:slug" element={<Scoreboard />} />
            <Route path="/:slug/admin/leaderboard" element={<Leaderboard />} />
          </Routes>
        </RoomContext.Provider>
      </ToastProvider>
    </MemoryRouter>,
  );
}

/** Renders one page and returns the first card's kind + props. */
async function readCard(page: 'public' | 'admin', config: Record<string, string>) {
  stubFetch(config);
  const view = renderPage(page);
  const card = await screen.findByTestId('card');
  const result = {
    kind: card.getAttribute('data-kind'),
    props: JSON.parse(card.getAttribute('data-props') || '{}') as Record<string, unknown>,
  };
  view.unmount();
  return result;
}

const STYLES: Array<[label: string, config: Record<string, string>]> = [
  ['no style (legacy GameCard)', {}],
  ['banner', { SCOREBOARD_STYLE: 'banner' }],
  ['showcase', { SCOREBOARD_STYLE: 'showcase', SCOREBOARD_THEME: 'neon-circuit' }],
  ['minimal', { SCOREBOARD_STYLE: 'minimal' }],
];

describe('admin Leaderboard mirrors the public Scoreboard', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  for (const [label, config] of STYLES) {
    it(`renders the same card, configured identically — ${label}`, async () => {
      const publicCard = await readCard('public', config);
      const adminCard = await readCard('admin', config);

      expect(adminCard.kind).toBe(publicCard.kind);
      expect(adminCard.props).toEqual(publicCard.props);
    });
  }

  it('passes roomId through, which the old admin copy dropped', async () => {
    // Without roomId the cards lose per-player score expand and the
    // GameInfoPopup's links, which is exactly what admin used to look like.
    for (const [, config] of STYLES) {
      const admin = await readCard('admin', config);
      expect(admin.props.roomId).toBe(ROOM_ID);
      expect(admin.props.slug).toBe(SLUG);
    }
  });

  it('honours QR settings on both pages', async () => {
    const config = {
      SCOREBOARD_STYLE: 'showcase',
      SCOREBOARD_QR_MODE: 'all',
      SCOREBOARD_QR_SIZE: '44',
      SCOREBOARD_QR_POSITION: 'bottom-center',
      SCOREBOARD_QR_OVERLAP_PX: '6',
    };
    const publicCard = await readCard('public', config);
    const adminCard = await readCard('admin', config);

    // The old admin copy never passed any of these, so its cards had no QR.
    expect(adminCard.props).toMatchObject({
      qrMode: 'all', qrSize: 44, qrPosition: 'bottom-center', qrOverlapPx: 6,
    });
    expect(adminCard.props).toEqual(publicCard.props);
  });

  it('honours the per-game title style on both pages', async () => {
    const config = { SCOREBOARD_STYLE: 'banner', SCOREBOARD_GAME_TITLE_STYLE: 'fire' };
    const publicCard = await readCard('public', config);
    const adminCard = await readCard('admin', config);

    expect(adminCard.props.gameTitleStyle).toBe('fire');
    expect(adminCard.props).toEqual(publicCard.props);
  });

  it('applies the banner-forces-scroll rule on both pages', async () => {
    // Banner overrides an explicit grid layout with horizontal scroll. Admin
    // had no such rule, so a banner room rendered as a grid there.
    const config = { SCOREBOARD_STYLE: 'banner', SCOREBOARD_LAYOUT: 'grid' };
    for (const page of ['public', 'admin'] as const) {
      stubFetch(config);
      const view = renderPage(page);
      await screen.findByTestId('card');
      await waitFor(() => {
        expect(view.container.querySelector('.scoreboard-grid-layout')).toBeNull();
        expect(view.container.querySelector('.scoreboard-hscroll-layout')).toBeInTheDocument();
      });
      view.unmount();
    }
  });

  it('supports the vertical layout on both pages', async () => {
    // Vertical was a public-only branch; admin fell through to horizontal.
    const config = { SCOREBOARD_STYLE: 'showcase', SCOREBOARD_LAYOUT: 'vertical' };
    for (const page of ['public', 'admin'] as const) {
      stubFetch(config);
      const view = renderPage(page);
      await screen.findByTestId('card');
      expect(view.container.querySelector('.scoreboard-hscroll-layout')).toBeNull();
      expect(view.container.querySelector('.scoreboard-grid-layout')).toBeNull();
      expect(view.container.querySelectorAll('.scoreboard-card-slot').length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('gives every card slot the shared surface class on both pages', async () => {
    // `.scoreboard-card-slot` is what the mobile full-width rules key off. The
    // admin copy never had it, so admin cards ignored mobile layout entirely.
    for (const page of ['public', 'admin'] as const) {
      stubFetch({ SCOREBOARD_STYLE: 'minimal' });
      const view = renderPage(page);
      await screen.findByTestId('card');
      expect(view.container.querySelectorAll('.scoreboard-card-slot')).toHaveLength(1);
      view.unmount();
    }
  });

  /**
   * A card whose title is a `<Link>` for players but a dead `<h3>` for admins
   * is not the same card. Admin used to pass no title-link factories at all,
   * so every admin title fell back to plain text — visually identical in a
   * screenshot, which is exactly why it needs a test.
   */
  for (const [label, config] of STYLES) {
    it(`renders the title as the same element on both pages — ${label}`, async () => {
      stubFetch(config);
      const pub = renderPage('public');
      const publicTitle = await screen.findByTestId('card-title');
      const publicShape = { tag: publicTitle.tagName, href: publicTitle.getAttribute('href') };
      pub.unmount();

      stubFetch(config);
      const adm = renderPage('admin');
      const adminTitle = await screen.findByTestId('card-title');
      expect({ tag: adminTitle.tagName, href: adminTitle.getAttribute('href') }).toEqual(publicShape);
      adm.unmount();
    });
  }

  it('links new-style card titles to game detail, on both pages', async () => {
    // Guards the assertion above from passing vacuously: with SCOREBOARD_STYLE
    // set, the title must actually BE a link, not two matching <h3>s.
    for (const page of ['public', 'admin'] as const) {
      stubFetch({ SCOREBOARD_STYLE: 'banner' });
      const view = renderPage(page);
      const title = await screen.findByTestId('card-title');
      expect(title.tagName).toBe('A');
      expect(title.getAttribute('href')).toBe(`/${SLUG}/games/Medieval%20Madness?tab=tournaments`);
      view.unmount();
    }
  });

  it('opens the quick-view popup from a title click, on both pages', async () => {
    for (const page of ['public', 'admin'] as const) {
      stubFetch({ SCOREBOARD_STYLE: 'banner' });
      const view = renderPage(page);
      const title = await screen.findByTestId('card-title');

      // Plain left-click previews rather than navigating.
      fireEvent.click(title, { button: 0 });
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.getAllByText('Medieval Madness').length).toBeGreaterThan(0);
      view.unmount();
    }
  });

  it('adds the admin controls strip and nothing else', async () => {
    stubFetch({ SCOREBOARD_STYLE: 'banner' });
    const pub = renderPage('public');
    const publicCardHtml = (await screen.findByTestId('card')).outerHTML;
    const publicSlot = pub.container.querySelector('.scoreboard-card-slot') as HTMLElement;
    expect(pub.container.querySelector('[data-testid="admin-card-controls"]')).toBeNull();
    // The public slot holds the card plus the `+` submit button, and nothing else.
    expect(publicSlot.children).toHaveLength(2);
    pub.unmount();

    stubFetch({ SCOREBOARD_STYLE: 'banner' });
    const adm = renderPage('admin');
    const strip = await screen.findByTestId('admin-card-controls');
    const adminSlot = adm.container.querySelector('.scoreboard-card-slot') as HTMLElement;

    // Admin's slot holds ONLY the card column (no submit button), and that
    // column is exactly the card plus the strip.
    expect(adminSlot.children).toHaveLength(1);
    const column = strip.parentElement as HTMLElement;
    expect(column.children).toHaveLength(2);
    // The card itself is byte-identical to the public page's.
    expect((column.firstElementChild as HTMLElement).outerHTML).toBe(publicCardHtml);
    adm.unmount();
  });
});
