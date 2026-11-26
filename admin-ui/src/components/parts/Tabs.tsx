import { useCallback, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';

/**
 * G23 - rail tabs (owner's pick, 2026-11-25): a row of tracked-caps tabs over a
 * lit rail, with ONE chrome pinball that rolls (250 ms) to sit under the active
 * tab. The active label is the theme's lead as text; the rest are muted. A row
 * wider than its box scrolls sideways (never wraps, never ellipsises) and keeps
 * the active tab in view. Reduced motion: the ball jumps.
 *
 * Keyboard (the WAI-ARIA tabs pattern, automatic activation): Left / Right move
 * to the previous or next tab (wrapping), Home / End to the first or last; each
 * move focuses AND selects. One tab is in the tab order (roving tabindex).
 * The caller renders the panel with `tabPanelProps(idPrefix, value)` (`./tabPanel`).
 */

export type TabItem = { id: string; label: string };

export function RailTabs({ label, idPrefix, tabs, value, onChange }: {
    label: string;
    idPrefix: string;
    tabs: TabItem[];
    value: string;
    onChange: (id: string) => void;
}) {
    const listRef = useRef<HTMLDivElement>(null);
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const [geo, setGeo] = useState({ x: 0, w: 0 });
    const [ready, setReady] = useState(false);

    const measure = useCallback(() => {
        const idx = tabs.findIndex(t => t.id === value);
        const el = tabRefs.current[idx];
        if (!el) return;
        setGeo(g => (g.x === el.offsetLeft && g.w === el.offsetWidth ? g : { x: el.offsetLeft, w: el.offsetWidth }));
        // Keep the active tab in view: the same as `scrollIntoView({ inline: 'nearest' })`,
        // without ever scrolling the page itself.
        const list = listRef.current;
        if (list && list.clientWidth > 0) {
            if (el.offsetLeft < list.scrollLeft) list.scrollLeft = el.offsetLeft;
            else if (el.offsetLeft + el.offsetWidth > list.scrollLeft + list.clientWidth) {
                list.scrollLeft = el.offsetLeft + el.offsetWidth - list.clientWidth;
            }
        }
    }, [tabs, value]);

    useLayoutEffect(() => { measure(); }, [measure]);

    useLayoutEffect(() => {
        // Slide only after the first placement, so the ball does not roll in from the left on load.
        const raf = requestAnimationFrame(() => setReady(true));
        const onResize = () => measure();
        window.addEventListener('resize', onResize);
        const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(onResize) : null;
        if (ro && listRef.current) ro.observe(listRef.current);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', onResize);
            ro?.disconnect();
        };
    }, [measure]);

    const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
        let n = -1;
        if (e.key === 'ArrowRight') n = (i + 1) % tabs.length;
        else if (e.key === 'ArrowLeft') n = (i - 1 + tabs.length) % tabs.length;
        else if (e.key === 'Home') n = 0;
        else if (e.key === 'End') n = tabs.length - 1;
        if (n < 0) return;
        e.preventDefault();
        tabRefs.current[n]?.focus();
        onChange(tabs[n]!.id);
    };

    const vars = { ['--x' as string]: `${geo.x}px`, ['--w' as string]: `${geo.w}px`, ['--bx' as string]: `${geo.x + geo.w / 2}px` } as CSSProperties;

    return (
        <div className={`part-tabs${ready ? ' part-tabs--ready' : ''}`} ref={listRef}>
            <div className="part-tabs__row" role="tablist" aria-label={label} style={vars}>
                {tabs.map((t, i) => {
                    const on = t.id === value;
                    return (
                        <button
                            key={t.id}
                            ref={el => { tabRefs.current[i] = el; }}
                            type="button"
                            role="tab"
                            className="part-tab"
                            id={`${idPrefix}-tab-${t.id}`}
                            aria-selected={on}
                            aria-controls={`${idPrefix}-panel`}
                            tabIndex={on ? 0 : -1}
                            onClick={() => { if (!on) onChange(t.id); }}
                            onKeyDown={e => onKeyDown(e, i)}
                        >
                            {t.label}
                        </button>
                    );
                })}
                <span className="part-tabs__rail" aria-hidden="true" />
                <span className="part-tabs__lit" aria-hidden="true" />
                <span className="part-tabs__ball" aria-hidden="true" />
            </div>
        </div>
    );
}
