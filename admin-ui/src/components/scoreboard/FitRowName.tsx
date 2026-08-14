import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';

/**
 * Scale-to-fit wrapper for score-row player names (v2.104.0, owner revision
 * of the mobile polish batch: "instead of names wrapping, dynamically scale
 * font size down to fit, only when a name is too large").
 *
 * How it works: this wrapper owns the CLAMP (the flex/max-width/overflow
 * styles the name element used to carry) and forces `nowrap`; the child name
 * renders at its natural single-line width inside. When the natural width
 * (`scrollWidth`) exceeds the clamp (`clientWidth`), the wrapper applies
 * `transform: scale(ratio)` — the name shrinks by exactly the factor needed
 * to fit on one line, and names that already fit render at scale 1,
 * completely untouched. Transforms don't feed back into layout metrics, so
 * measurement is stable (no resize feedback loop). Re-measures on text
 * change and container resize (ResizeObserver).
 *
 * This replaces BOTH prior overflow behaviors: the desktop `truncate`
 * ellipsis (no-ellipsis doctrine — scaling preserves the full name) and the
 * first-draft mobile wrapping (wrapped names made row heights uneven).
 * Floor of 0.5 as a sanity clamp — a name needing less than half size would
 * be unreadable anyway; at the floor the wrapper's `overflow: hidden` is the
 * last resort, still ellipsis-free.
 *
 * jsdom note: scroll/client widths are 0 there → scale stays 1 → the wrapper
 * is a transparent pass-through in tests.
 */
export default function FitRowName({
    children,
    className,
    style,
    origin = 'center',
}: {
    children: ReactNode;
    className?: string;
    /** The CLAMP styles (flex, maxWidth, …) — moved here from the name element. */
    style?: CSSProperties;
    /** Match the row's alignment: 'center' for centered pills, 'left' for left-aligned rows. */
    origin?: 'center' | 'left';
}) {
    const ref = useRef<HTMLSpanElement>(null);
    const [scale, setScale] = useState(1);

    useLayoutEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => {
            const sw = el.scrollWidth;
            const cw = el.clientWidth;
            if (!sw || !cw) { setScale(1); return; }
            setScale(sw > cw ? Math.max(0.5, cw / sw) : 1);
        };
        measure();
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
        ro?.observe(el);
        // Font-swap race (P1 screenshot loop finding): a measure taken while
        // the fallback font is still active can under-read the natural width;
        // the swap to the real font widens the text WITHOUT resizing the
        // clamped container, so ResizeObserver never re-fires and the name
        // renders clipped at scale 1. Re-measure once all fonts settle.
        // (document.fonts is undefined in jsdom — same inertness as above.)
        let cancelled = false;
        if (typeof document !== 'undefined' && document.fonts?.ready) {
            document.fonts.ready.then(() => { if (!cancelled) measure(); });
        }
        return () => { cancelled = true; ro?.disconnect(); };
    }, [children]);

    return (
        <span
            ref={ref}
            className={className}
            style={{
                display: 'block',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                minWidth: 0,
                ...style,
            }}
        >
            {/* The transform lives on this INNER box, never on the clamping
                wrapper: an element's own overflow clips its content in LOCAL
                (pre-transform) coordinates, so scaling the wrapper scales
                text that is ALREADY clipped (P1 screenshot-loop finding — the
                v2.104.0 self-scale version rendered clipped names shrunk, not
                fitted). An ancestor's clip applies to the descendant's
                TRANSFORMED rendering, so scaling this child reveals the full
                name inside the wrapper's box. `width: max-content` keeps the
                box at the name's natural width instead of shrinking to the
                wrapper's; at scale < 1 the painted width equals the wrapper's
                width exactly, so `left center` origin fills it edge-to-edge
                for centered and left-aligned rows alike. `margin: 0 auto`
                keeps short names centered where the row is centered. */}
            <span
                style={{
                    display: 'block',
                    width: 'max-content',
                    margin: origin === 'center' ? '0 auto' : undefined,
                    ...(scale < 1
                        ? { transform: `scale(${scale})`, transformOrigin: 'left center' }
                        : {}),
                }}
            >
                {children}
            </span>
        </span>
    );
}
