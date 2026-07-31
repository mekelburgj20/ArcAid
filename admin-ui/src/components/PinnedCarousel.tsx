import { useCallback, useEffect, useRef, useState } from 'react';
import { Pin, Plus, TrendingUp, TrendingDown } from 'lucide-react';
import GlobalGameCard, { type GlobalGameCardGame } from './GlobalGameCard';
import { GRID_GAP_PX, gridColumnsAt } from '../lib/globalGrid';

/**
 * v2.55.0 — the "My Pins" carousel on /scoreboard, replacing v2.52.0's 220px
 * chip rail (`PinnedRail.tsx`).
 *
 * The cards here are the SAME component the grid below renders
 * (`GlobalGameCard`) at the SAME width the grid gives its cards — that is the
 * whole point of the change, and the reason the card was extracted rather than
 * restyled in place.
 *
 * Motion rules, all deliberate:
 *   • Auto-cycle ONLY when the cards actually overflow the container. When they
 *     fit, this renders a plain static row: no animation, no duplicated list.
 *     A marquee that has nothing to reveal is pure distraction.
 *   • Paused on hover, on focus-within, and while touched. Unlike the landing
 *     page's decorative ticker, these cards carry Submit buttons, pin toggles
 *     and links — a card sliding out from under a click is a real failure.
 *   • `prefers-reduced-motion: reduce` disables auto-cycle entirely and leaves a
 *     manually scrollable row.
 *   • Under 640px (the grid's 1-column breakpoint) there is no auto-cycle at
 *     all: one full-size card per view, native scroll-snap swipe. Auto-advancing
 *     under a reader's thumb is worse than useless.
 *
 * The duplicated copy that makes the loop seamless is `aria-hidden` and every
 * focusable node inside it is taken out of the tab order, so keyboard and
 * screen-reader users meet each pin exactly once.
 *
 * Every colour is a token (`--sb-*`, `--color-*`) — global pages are
 * light-capable since A1.
 */

/** One row of `GET /api/global/pins`. Structurally a card game + pin context. */
export interface PinnedGame extends GlobalGameCardGame {
    top_score: number | null;
    my_rank: number | null;
    my_score: number | null;
    /** Negative = improved, positive = dropped, 0/null = no badge. */
    rank_delta: number | null;
    pinned_at: string;
}

interface Props {
    pins: PinnedGame[];
    /** Opens SubmissionSheet for that game (the card's Submit button). */
    onSubmit: (pin: PinnedGame) => void;
    /** Trailing dashed tile — reuses the page's ⌘K palette open state. */
    onAdd: () => void;
    /** Card pin toggle. Undefined hides the hotspot (never the case in practice
     *  — the carousel only renders for a logged-in viewer). */
    onTogglePin?: (pin: PinnedGame) => void;
}

/** Marquee speed. Constant px/s, so more (or wider) cards travel no faster. */
const SCROLL_PX_PER_SECOND = 40;
/** Floor on the loop duration; a two-card overflow shouldn't whip past. */
const MIN_DURATION_S = 14;
/** Desktop add tile — a slim full-height column, not a card-sized empty box. */
const ADD_TILE_WIDTH_PX = 88;

/**
 * Rank movement badge. Rendered only when the delta is a non-zero number:
 * `0` (held station) and `null` (no prior reading — e.g. a fresh pin) both
 * mean "nothing worth drawing attention to".
 */
function DeltaBadge({ delta }: { delta: number }) {
    const improved = delta < 0;
    const Icon = improved ? TrendingUp : TrendingDown;
    const label = improved
        ? `Up ${Math.abs(delta)} ${Math.abs(delta) === 1 ? 'place' : 'places'} since you pinned it`
        : `Down ${delta} ${delta === 1 ? 'place' : 'places'} since you pinned it`;
    return (
        <span
            className={`inline-flex items-center gap-0.5 rounded-[3px] px-1.5 py-px font-mono text-[9px] font-bold ${
                improved ? 'text-neon-green' : 'text-neon-coral'
            }`}
            style={{ background: 'var(--sb-art-btn-bg)' }}
            title={label}
        >
            <Icon className="h-2.5 w-2.5" aria-hidden="true" />
            {Math.abs(delta)}
            <span className="sr-only">{label}</span>
        </span>
    );
}

/** OS-level motion preference. Defaults to "no preference" when matchMedia is
 *  unavailable (jsdom), which is also what the CSS fallback assumes. */
function usePrefersReducedMotion(): boolean {
    const [reduce, setReduce] = useState(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
        return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    });
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onChange = () => setReduce(mq.matches);
        mq.addEventListener?.('change', onChange);
        return () => mq.removeEventListener?.('change', onChange);
    }, []);
    return reduce;
}

export default function PinnedCarousel({ pins, onSubmit, onAdd, onTogglePin }: Props) {
    const viewportRef = useRef<HTMLDivElement>(null);
    const measureRef = useRef<HTMLDivElement>(null);
    const duplicateRef = useRef<HTMLDivElement>(null);

    const [viewportWidth, setViewportWidth] = useState(0);
    const [contentWidth, setContentWidth] = useState(0);
    const [windowWidth, setWindowWidth] = useState(
        () => (typeof window === 'undefined' ? 1280 : window.innerWidth),
    );
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    const [touched, setTouched] = useState(false);
    const reduceMotion = usePrefersReducedMotion();

    /**
     * Card width comes from the grid's own column counts (`gridColumnsAt`), not
     * from a second hardcoded number: n cards across at the same breakpoints the
     * grid uses, sharing the same 14px gutter.
     */
    const columns = gridColumnsAt(windowWidth);
    const isMobile = columns === 1;
    const cardWidth = viewportWidth > 0
        ? Math.max(160, Math.floor((viewportWidth - (columns - 1) * GRID_GAP_PX) / columns))
        : null;

    // Measure the container and the (single) content copy. ResizeObserver
    // catches font loading, image decode and card-height settling, which a
    // window resize listener alone would miss.
    const measure = useCallback(() => {
        if (typeof window !== 'undefined') setWindowWidth(window.innerWidth);
        const viewport = viewportRef.current;
        const content = measureRef.current;
        if (viewport) setViewportWidth(viewport.clientWidth);
        if (content) setContentWidth(content.scrollWidth);
    }, []);

    useEffect(() => {
        const viewport = viewportRef.current;
        const content = measureRef.current;
        // No ResizeObserver (jsdom, ancient browsers): measure on the next tick
        // and on window resize. Deferred rather than called inline so the effect
        // never sets state synchronously during commit.
        if (typeof ResizeObserver === 'undefined') {
            const timer = window.setTimeout(measure, 0);
            window.addEventListener('resize', measure);
            return () => {
                window.clearTimeout(timer);
                window.removeEventListener('resize', measure);
            };
        }
        // `observe()` delivers an initial observation, so this is also the
        // first measurement — no separate inline call needed.
        const ro = new ResizeObserver(() => measure());
        if (viewport) ro.observe(viewport);
        if (content) ro.observe(content);
        return () => ro.disconnect();
    }, [measure, pins.length, isMobile]);

    const overflowing = contentWidth > viewportWidth + 1;
    const animate = !isMobile && !reduceMotion && overflowing;
    const paused = hovered || focused || touched;
    const durationS = Math.max(MIN_DURATION_S, contentWidth / SCROLL_PX_PER_SECOND);

    /**
     * The duplicated copy is decorative: `aria-hidden` keeps it off the
     * accessibility tree, and this pass keeps its links and buttons out of the
     * tab order (an aria-hidden subtree containing focusable nodes is itself an
     * a11y defect). Mouse clicks still work — `inert` would kill those too, and
     * a dead card under the cursor is exactly the failure mode the hover-pause
     * exists to prevent.
     */
    useEffect(() => {
        const el = duplicateRef.current;
        if (!el) return;
        el.querySelectorAll<HTMLElement>('a, button, input, select, textarea, [tabindex]')
            .forEach(node => { node.tabIndex = -1; });
    }, [animate, pins]);

    // Zero pins → render nothing at all, not an empty shell.
    if (pins.length === 0) return null;

    const itemStyle = (width: number | null) => ({
        width: width ?? undefined,
        marginRight: GRID_GAP_PX,
    });

    const cards = (duplicated: boolean) => pins.map(pin => (
        <div
            key={`${duplicated ? 'dup-' : ''}${pin.global_game_id}`}
            className={`shrink-0 ${isMobile ? 'snap-center' : ''}`}
            style={itemStyle(cardWidth)}
        >
            <GlobalGameCard
                // The rail only ever holds pinned games, so the hotspot renders
                // pressed without the component needing a rail-specific mode.
                game={{ ...pin, is_pinned: true }}
                onSubmit={() => onSubmit(pin)}
                onTogglePin={onTogglePin ? () => onTogglePin(pin) : undefined}
                badge={pin.rank_delta != null && pin.rank_delta !== 0
                    ? <DeltaBadge delta={pin.rank_delta} />
                    : undefined}
            />
        </div>
    ));

    const addTile = (duplicated: boolean) => (
        <div
            key={`${duplicated ? 'dup-' : ''}add-tile`}
            className={`shrink-0 ${isMobile ? 'snap-center' : ''}`}
            style={itemStyle(isMobile ? cardWidth : ADD_TILE_WIDTH_PX)}
        >
            <button
                type="button"
                onClick={onAdd}
                className="flex h-full min-h-[120px] w-full items-center justify-center rounded-[10px] border border-dashed border-border text-faint transition-colors hover:border-neon-cyan hover:text-neon-cyan"
                title="Find a game to pin"
                aria-label="Find a game to pin"
            >
                <Plus className="h-[22px] w-[22px]" aria-hidden="true" />
            </button>
        </div>
    );

    const header = (
        <div className="mb-2.5 flex items-center gap-2">
            <Pin className="h-3.5 w-3.5 text-neon-amber" aria-hidden="true" />
            <h2 className="font-display text-[14px] font-bold tracking-[0.5px]">MY PINS</h2>
            <span className="text-[10px] text-muted">
                — {pins.length} {pins.length === 1 ? 'game' : 'games'} watched
            </span>
        </div>
    );

    const sectionProps = {
        'aria-label': 'My pinned games',
        className: 'mb-5 rounded-[10px] border p-3.5',
        style: { background: 'var(--sb-rail-bg)', borderColor: 'var(--sb-rail-border)' },
    } as const;

    // ── Mobile: one card per view, native scroll-snap swipe, never animated ──
    if (isMobile) {
        return (
            <section {...sectionProps}>
                {header}
                <div
                    ref={viewportRef}
                    data-testid="pins-viewport"
                    data-mode="swipe"
                    // One column at this width, so each card is exactly the
                    // container's width: `snap-center` then lands every card
                    // flush inside the panel — nothing is ever clipped, and the
                    // first and last need no compensating padding.
                    className="flex snap-x snap-mandatory overflow-x-auto scrollbar-thin pb-1"
                >
                    <div ref={measureRef} data-testid="pins-measure" className="flex">
                        {cards(false)}
                        {addTile(false)}
                    </div>
                </div>
            </section>
        );
    }

    // ── Desktop: static row when it fits, marquee when it doesn't ────────────
    return (
        <section {...sectionProps}>
            {header}
            <div
                ref={viewportRef}
                data-testid="pins-viewport"
                data-mode={animate ? 'marquee' : 'static'}
                className={`relative ${animate ? 'overflow-hidden' : 'overflow-x-auto scrollbar-thin pb-1'}`}
                onMouseEnter={() => setHovered(true)}
                onMouseLeave={() => setHovered(false)}
                onFocusCapture={() => setFocused(true)}
                onBlurCapture={() => setFocused(false)}
                onTouchStart={() => setTouched(true)}
                onTouchEnd={() => setTouched(false)}
                onTouchCancel={() => setTouched(false)}
            >
                <div
                    data-testid="pins-track"
                    className={`flex w-max ${animate ? 'pinned-carousel-track' : ''}`}
                    style={animate
                        ? {
                            animationDuration: `${durationS}s`,
                            animationPlayState: paused ? 'paused' : 'running',
                        }
                        : undefined}
                >
                    <div ref={measureRef} data-testid="pins-measure" className="flex">
                        {cards(false)}
                        {addTile(false)}
                    </div>
                    {/* Second copy: what makes translateX(-50%) loop seamlessly.
                        Only exists while animating — a static row must not
                        render every pin twice. Each item carries its gutter as
                        margin-right (not a flex `gap`), so one copy's width is
                        exactly half the track and the wrap is invisible. */}
                    {animate && (
                        <div ref={duplicateRef} aria-hidden="true" data-testid="pins-duplicate" className="flex">
                            {cards(true)}
                            {addTile(true)}
                        </div>
                    )}
                </div>
            </div>

            {/* Scoped keyframes, per the LandingPage/TourOverlay convention. The
                media query is belt-and-braces: `animate` is already false under
                reduced motion, so the class isn't even applied. */}
            <style>{`
                .pinned-carousel-track {
                    animation-name: pinned-carousel-scroll;
                    animation-timing-function: linear;
                    animation-iteration-count: infinite;
                    will-change: transform;
                }
                @keyframes pinned-carousel-scroll {
                    from { transform: translateX(0); }
                    to { transform: translateX(-50%); }
                }
                @media (prefers-reduced-motion: reduce) {
                    .pinned-carousel-track { animation: none !important; }
                }
            `}</style>
        </section>
    );
}
