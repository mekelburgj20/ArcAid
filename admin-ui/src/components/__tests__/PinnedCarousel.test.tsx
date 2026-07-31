import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import PinnedCarousel, { type PinnedGame } from '../PinnedCarousel';

/**
 * v2.55.0 — the "My Pins" carousel (full grid cards, conditional marquee).
 *
 * jsdom has no layout engine, so overflow is simulated by stubbing the two
 * measurements the component actually reads: the viewport's `clientWidth` and
 * the single content copy's `scrollWidth`. That is deliberately the whole
 * measurement surface — if the component starts reading something else, these
 * tests stop describing it and fail loudly rather than silently passing.
 */

const ORIGINAL_INNER_WIDTH = window.innerWidth;

/** Stub the layout reads. `content > viewport` is what "overflowing" means. */
function mockLayout({ viewport, content }: { viewport: number; content: number }) {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
        configurable: true,
        get(this: HTMLElement) {
            return this.dataset.testid === 'pins-viewport' ? viewport : 0;
        },
    });
    Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
        configurable: true,
        get(this: HTMLElement) {
            return this.dataset.testid === 'pins-measure' ? content : 0;
        },
    });
}

function setViewportWidth(px: number) {
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: px });
}

afterEach(() => {
    // @ts-expect-error — restore jsdom's own (always-0) implementations.
    delete HTMLElement.prototype.clientWidth;
    // @ts-expect-error — ditto.
    delete HTMLElement.prototype.scrollWidth;
    setViewportWidth(ORIGINAL_INNER_WIDTH);
    vi.unstubAllGlobals();
});

function entry(name: string, score: number, rank?: number) {
    return {
        iscored_username: name,
        display_name: null,
        score,
        avatar_hash: null,
        discord_user_id: `disc-${name}`,
        origin_room_slug: null,
        origin_room_logo_url: null,
        origin_room_short_tag: null,
        ...(rank != null ? { rank } : {}),
    };
}

function pin(over: Partial<PinnedGame> = {}): PinnedGame {
    return {
        global_game_id: 'g-1',
        name: 'Medieval Madness',
        display_name: null,
        manufacturer: 'Williams',
        year: 1997,
        image_url: null,
        local_image_path: null,
        wheel_image_path: null,
        platforms: '["vpx"]',
        score_count: 4,
        top_score: 900,
        top_scores: [entry('Champ', 900), entry('Runner', 800)],
        neighbors: [],
        my_rank: 3,
        my_score: 400,
        rank_delta: null,
        pinned_at: '2026-07-28T12:00:00.000Z',
        ...over,
    };
}

function manyPins(n: number): PinnedGame[] {
    return Array.from({ length: n }, (_, i) =>
        pin({ global_game_id: `g-${i + 1}`, name: `Game ${i + 1}` }));
}

function renderCarousel(
    pins: PinnedGame[],
    handlers: Partial<{ onSubmit: () => void; onAdd: () => void; onTogglePin: () => void }> = {},
) {
    return render(
        <MemoryRouter>
            <PinnedCarousel
                pins={pins}
                onSubmit={handlers.onSubmit ?? (() => {})}
                onAdd={handlers.onAdd ?? (() => {})}
                onTogglePin={handlers.onTogglePin}
            />
        </MemoryRouter>,
    );
}

const track = () => screen.getByTestId('pins-track');
const viewportMode = () => screen.getByTestId('pins-viewport').getAttribute('data-mode');

describe('PinnedCarousel — structure', () => {
    it('renders nothing at all when the viewer has zero pins', () => {
        const { container } = renderCarousel([]);
        expect(container).toBeEmptyDOMElement();
    });

    it('renders a FULL card per pin — leaderboard rows, score count, Submit — plus the add tile', async () => {
        mockLayout({ viewport: 1200, content: 600 });
        renderCarousel([pin()]);

        expect(screen.getByText('MY PINS')).toBeInTheDocument();
        expect(screen.getByText('— 1 game watched')).toBeInTheDocument();
        expect(screen.getByText('Medieval Madness')).toBeInTheDocument();
        // Rows come from top_scores, exactly as the grid card renders them.
        expect(screen.getByText('Champ')).toBeInTheDocument();
        expect(screen.getByText('Runner')).toBeInTheDocument();
        expect(screen.getByText('4 scores')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /^submit$/i })).toBeInTheDocument();
        expect(screen.getByLabelText('Find a game to pin')).toBeInTheDocument();
    });

    it('renders the pin hotspot already pinned, and appends the YOU row from neighbors', async () => {
        mockLayout({ viewport: 1200, content: 600 });
        renderCarousel([pin({
            top_scores: [1, 2, 3, 4, 5, 6].map(i => entry(`P${i}`, 1000 - i * 10)),
            my_rank: 8,
            my_score: 100,
            neighbors: [entry('P7', 200, 7), entry('MyRow', 100, 8)],
        })], { onTogglePin: vi.fn() });

        const hotspot = screen.getByLabelText('Unpin Medieval Madness');
        expect(hotspot).toHaveAttribute('aria-pressed', 'true');
        expect(screen.getByText('You')).toBeInTheDocument();
        expect(screen.getByText('MyRow')).toBeInTheDocument();
    });

    it('wires Submit, the add tile and the pin toggle', async () => {
        mockLayout({ viewport: 1200, content: 600 });
        const onSubmit = vi.fn();
        const onAdd = vi.fn();
        const onTogglePin = vi.fn();
        renderCarousel([pin()], { onSubmit, onAdd, onTogglePin });

        fireEvent.click(screen.getByRole('button', { name: /^submit$/i }));
        expect(onSubmit).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByLabelText('Find a game to pin'));
        expect(onAdd).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByLabelText('Unpin Medieval Madness'));
        expect(onTogglePin).toHaveBeenCalledTimes(1);
    });

    it('shows the rank-delta badge only for a non-zero delta, and labels the direction', () => {
        mockLayout({ viewport: 1200, content: 600 });
        const { unmount } = renderCarousel([pin({ rank_delta: null })]);
        expect(screen.queryByText(/since you pinned it/)).not.toBeInTheDocument();
        unmount();

        const held = renderCarousel([pin({ rank_delta: 0 })]);
        expect(screen.queryByText(/since you pinned it/)).not.toBeInTheDocument();
        held.unmount();

        const up = renderCarousel([pin({ rank_delta: -3 })]);
        expect(screen.getByText('Up 3 places since you pinned it')).toBeInTheDocument();
        up.unmount();

        renderCarousel([pin({ rank_delta: 2 })]);
        expect(screen.getByText('Down 2 places since you pinned it')).toBeInTheDocument();
    });
});

describe('PinnedCarousel — auto-cycle gating', () => {
    it('does NOT animate and does NOT duplicate the list when the cards fit', async () => {
        mockLayout({ viewport: 1200, content: 600 });
        renderCarousel(manyPins(2));

        await waitFor(() => expect(viewportMode()).toBe('static'));
        expect(screen.queryByTestId('pins-duplicate')).not.toBeInTheDocument();
        expect(track().className).not.toContain('pinned-carousel-track');
        expect(track().style.animationDuration).toBe('');
        // Each pin appears exactly once.
        expect(screen.getAllByText('Game 1')).toHaveLength(1);
    });

    it('animates and duplicates the list exactly once when the cards overflow', async () => {
        mockLayout({ viewport: 1200, content: 3400 });
        renderCarousel(manyPins(8));

        await waitFor(() => expect(viewportMode()).toBe('marquee'));
        expect(screen.getByTestId('pins-duplicate')).toBeInTheDocument();
        expect(track().className).toContain('pinned-carousel-track');
        expect(track().style.animationDuration).toBe('85s'); // 3400px / 40px-per-second
        expect(track().style.animationPlayState).toBe('running');
        // One visible copy + one aria-hidden copy — never a third.
        expect(screen.getAllByText('Game 1')).toHaveLength(2);
    });

    it('scales the duration with content width so more pins do not travel faster', async () => {
        mockLayout({ viewport: 1200, content: 6800 });
        renderCarousel(manyPins(16));
        await waitFor(() => expect(track().style.animationDuration).toBe('170s'));
    });

    it('disables the auto-cycle entirely under prefers-reduced-motion', async () => {
        mockLayout({ viewport: 1200, content: 3400 });
        vi.stubGlobal('matchMedia', ((query: string) => ({
            matches: query.includes('prefers-reduced-motion'),
            media: query,
            onchange: null,
            addListener: () => {}, removeListener: () => {},
            addEventListener: () => {}, removeEventListener: () => {},
            dispatchEvent: () => false,
        })) as unknown as typeof window.matchMedia);

        renderCarousel(manyPins(8));

        await waitFor(() => expect(screen.getAllByText('Game 1')).toHaveLength(1));
        expect(viewportMode()).toBe('static');
        expect(screen.queryByTestId('pins-duplicate')).not.toBeInTheDocument();
        expect(track().className).not.toContain('pinned-carousel-track');
        // The fallback is a manually scrollable row.
        expect(screen.getByTestId('pins-viewport').className).toContain('overflow-x-auto');
    });
});

describe('PinnedCarousel — pausing', () => {
    async function renderOverflowing() {
        mockLayout({ viewport: 1200, content: 3400 });
        renderCarousel(manyPins(8), { onTogglePin: vi.fn() });
        await waitFor(() => expect(viewportMode()).toBe('marquee'));
        return screen.getByTestId('pins-viewport');
    }

    it('pauses on hover and resumes on leave', async () => {
        const viewport = await renderOverflowing();
        fireEvent.mouseEnter(viewport);
        expect(track().style.animationPlayState).toBe('paused');
        fireEvent.mouseLeave(viewport);
        expect(track().style.animationPlayState).toBe('running');
    });

    it('pauses while anything inside has focus', async () => {
        await renderOverflowing();
        const submit = screen.getAllByRole('button', { name: /^submit$/i })[0];
        fireEvent.focus(submit);
        expect(track().style.animationPlayState).toBe('paused');
        fireEvent.blur(submit);
        expect(track().style.animationPlayState).toBe('running');
    });

    it('pauses while touched', async () => {
        const viewport = await renderOverflowing();
        fireEvent.touchStart(viewport);
        expect(track().style.animationPlayState).toBe('paused');
        fireEvent.touchEnd(viewport);
        expect(track().style.animationPlayState).toBe('running');
    });
});

describe('PinnedCarousel — duplicated copy accessibility', () => {
    it('hides the duplicate from assistive tech and takes it out of the tab order', async () => {
        mockLayout({ viewport: 1200, content: 3400 });
        renderCarousel(manyPins(8), { onTogglePin: vi.fn() });

        await waitFor(() => expect(screen.getByTestId('pins-duplicate')).toBeInTheDocument());
        const duplicate = screen.getByTestId('pins-duplicate');
        expect(duplicate).toHaveAttribute('aria-hidden', 'true');

        const focusables = within(duplicate).getAllByRole('button', { hidden: true })
            .concat(within(duplicate).getAllByRole('link', { hidden: true }));
        expect(focusables.length).toBeGreaterThan(0);
        for (const node of focusables) {
            expect(node).toHaveAttribute('tabindex', '-1');
        }

        // The visible copy stays fully reachable.
        const primary = screen.getByTestId('pins-measure');
        for (const node of within(primary).getAllByRole('button')) {
            expect(node).not.toHaveAttribute('tabindex', '-1');
        }
    });
});

describe('PinnedCarousel — mobile', () => {
    it('renders one full card per view as a scroll-snap row, and never auto-cycles', async () => {
        setViewportWidth(390);
        // Content far exceeds the viewport: on desktop this would animate.
        mockLayout({ viewport: 358, content: 1500 });
        renderCarousel(manyPins(4));

        await waitFor(() => expect(viewportMode()).toBe('swipe'));
        const viewport = screen.getByTestId('pins-viewport');
        expect(viewport.className).toContain('snap-x');
        expect(viewport.className).toContain('snap-mandatory');
        expect(viewport.className).toContain('overflow-x-auto');
        expect(screen.queryByTestId('pins-track')).not.toBeInTheDocument();
        expect(screen.queryByTestId('pins-duplicate')).not.toBeInTheDocument();
        expect(screen.getAllByText('Game 1')).toHaveLength(1);

        // One column at this width → the card fills the container.
        //
        // Waited, not asserted inline: `data-mode` flips to "swipe" off the
        // window width alone, but the per-card width comes from the deferred
        // measure() pass. Reading `.closest('[style*="width"]')` before that
        // lands returns null (the style attribute carries only margin-right),
        // so the old inline read threw "Cannot read properties of null" on
        // roughly two runs in three.
        await waitFor(() => {
            const el = screen.getByText('Game 1').closest('[style*="width"]') as HTMLElement | null;
            expect(el?.style.width).toBe('358px');
        });
        const card = screen.getByText('Game 1').closest('[style*="width"]') as HTMLElement;
        expect(card.className).toContain('snap-center');

        // The add tile is the final snap item.
        expect(screen.getByLabelText('Find a game to pin')).toBeInTheDocument();
    });
});
