import { createContext, useCallback, useContext, useLayoutEffect, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { Menu as BaseMenu } from '@base-ui/react/menu';

/**
 * G26 - the Arcaid menu, the first pop-up part (ADR 0042).
 *
 * base-ui's Menu carries the behaviour: focus handling, arrow keys, Home/End,
 * typeahead, Escape (focus goes back to the trigger), closing on an outside
 * press, and the ARIA (`menu`, `menuitem`, `group`, `aria-expanded`). Every
 * visible pixel is Arcaid's own CSS (`index.css` "The Arcaid menu"): the
 * toast family's dark glass slab with the double-line neon edge and the G20
 * top light bar, fixed dark on every theme (the popup carries
 * `sb-theme-scope`, which restates the site's dark tokens), and a chrome
 * pinball that rolls to the highlighted row along a lit rail.
 *
 * The shape of every Arcaid menu: a `MenuGroup` (heading + a list that
 * scrolls inside the popup, with the rail and the pinball), then optionally a
 * `MenuSeparator`, a `MenuNote` and a `MenuFooter` of quieter links. The
 * trigger is the caller's own button (`MenuTrigger`), styled for where it sits.
 *
 * The menu is not modal: a press outside closes it and still reaches what was
 * pressed, as in the approved mockup.
 */

type HighlightListener = (item: HTMLElement | undefined) => void;

/** The group's pinball listens here for base-ui's `onItemHighlighted`. */
const HighlightContext = createContext<RefObject<HighlightListener | null> | null>(null);

/** base-ui's imperative handle: `close()` shuts the menu (a route change it did not cause, say). */
export type MenuActions = BaseMenu.Root.Actions;

export function Menu({ children, onOpenChange, actionsRef }: {
    children: ReactNode;
    onOpenChange?: (open: boolean) => void;
    actionsRef?: RefObject<MenuActions | null>;
}) {
    const listenerRef = useRef<HighlightListener | null>(null);
    return (
        <HighlightContext.Provider value={listenerRef}>
            <BaseMenu.Root
                modal={false}
                actionsRef={actionsRef}
                onOpenChange={onOpenChange ? open => onOpenChange(open) : undefined}
                onItemHighlighted={item => listenerRef.current?.(item)}
            >
                {children}
            </BaseMenu.Root>
        </HighlightContext.Provider>
    );
}

/** The button that opens the menu: base-ui's trigger, passed through. It sets `aria-expanded` and `data-popup-open`. */
export function MenuTrigger(props: ComponentProps<typeof BaseMenu.Trigger>) {
    return <BaseMenu.Trigger {...props} />;
}

/**
 * The pop-up: portal (to `<body>`), positioner (below the trigger, kept on
 * screen) and the Arcaid slab. `align="center"` centres it under the trigger
 * (a phone's centred brand row).
 */
export function MenuPopup({ children, align = 'start', sideOffset = 8 }: {
    children: ReactNode;
    align?: 'start' | 'center';
    sideOffset?: number;
}) {
    return (
        <BaseMenu.Portal>
            <BaseMenu.Positioner className="arc-menu-pos" side="bottom" align={align} sideOffset={sideOffset} collisionPadding={12}>
                <BaseMenu.Popup className="arc-menu sb-theme-scope">{children}</BaseMenu.Popup>
            </BaseMenu.Positioner>
        </BaseMenu.Portal>
    );
}

/** The heading row of a `MenuGroup` (its `heading` slot): the group's label and, optionally, a count. */
export function MenuHeading({ label, count }: { label: string; count?: number }) {
    return (
        <div className="arc-menu__head">
            <BaseMenu.GroupLabel className="arc-menu__label">
                {label}
                {count != null && <span className="sr-only">, {count}</span>}
            </BaseMenu.GroupLabel>
            {count != null && <span className="arc-menu__count" aria-hidden="true">{count}</span>}
        </div>
    );
}

/**
 * The list: a group under its heading. The heading stays put while the rows
 * scroll inside the popup's height; the last row fades out while more are
 * below. One pinball sits at the left edge of the highlighted row and rolls to
 * the next as the highlight moves (no roll under reduced motion); it hides
 * when nothing in the list is highlighted.
 */
export function MenuGroup({ heading, children }: { heading?: ReactNode; children: ReactNode }) {
    const listenerRef = useContext(HighlightContext);
    const scrollRef = useRef<HTMLDivElement>(null);
    const trackRef = useRef<HTMLDivElement>(null);
    const ballRef = useRef<HTMLSpanElement>(null);

    useLayoutEffect(() => {
        if (!listenerRef) return;
        const roll: HighlightListener = item => {
            const ball = ballRef.current;
            const track = trackRef.current;
            if (!ball || !track) return;
            if (!item || !track.contains(item)) {
                ball.removeAttribute('data-on');
                return;
            }
            const y = `${item.offsetTop + item.offsetHeight / 2 - ball.offsetHeight / 2}px`;
            if (ball.hasAttribute('data-on')) {
                ball.style.setProperty('--y', y);
                return;
            }
            // Coming back from hidden: appear on the row, do not roll in from the last one.
            ball.setAttribute('data-jump', '');
            ball.style.setProperty('--y', y);
            void ball.offsetWidth;
            ball.removeAttribute('data-jump');
            ball.setAttribute('data-on', '');
        };
        listenerRef.current = roll;
        return () => {
            if (listenerRef.current === roll) listenerRef.current = null;
        };
    }, [listenerRef]);

    const syncFade = useCallback(() => {
        const el = scrollRef.current;
        if (el) el.toggleAttribute('data-more-below', el.scrollTop + el.clientHeight < el.scrollHeight - 2);
    }, []);
    // After every render (the list may have grown or shrunk), and whenever the
    // box changes size: the positioner caps the popup's height after it mounts.
    useLayoutEffect(() => { syncFade(); });
    useLayoutEffect(() => {
        const el = scrollRef.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const observer = new ResizeObserver(syncFade);
        observer.observe(el);
        if (trackRef.current) observer.observe(trackRef.current);
        return () => observer.disconnect();
    }, [syncFade]);

    return (
        <BaseMenu.Group className="arc-menu__group">
            {heading}
            <div ref={scrollRef} className="arc-menu__scroll" onScroll={syncFade}>
                <div ref={trackRef} className="arc-menu__track">
                    <span ref={ballRef} className="arc-menu__ball" aria-hidden="true" />
                    {children}
                </div>
            </div>
        </BaseMenu.Group>
    );
}

/**
 * A square tile at the start of a row: the given icon for a place with no logo
 * (the Global Scoreboard's trophy), else the image when there is one, else the
 * given initials.
 */
export function MenuTile({ src, initials = '', icon }: { src?: string | null; initials?: string; icon?: ReactNode }) {
    if (icon) return <span className="arc-menu__tile arc-menu__tile--icon" aria-hidden="true">{icon}</span>;
    return src ? (
        <span className="arc-menu__tile" aria-hidden="true"><img src={src} alt="" /></span>
    ) : (
        <span className="arc-menu__tile arc-menu__tile--init" aria-hidden="true">{initials}</span>
    );
}

function RowBody({ media, caption, mark, children }: { media?: ReactNode; caption?: ReactNode; mark?: boolean; children: ReactNode }) {
    return (
        <>
            {media ?? <span aria-hidden="true" />}
            <span className="arc-menu__text">
                <span className="arc-menu__name">{children}</span>
                {caption && <span className="arc-menu__caption">{caption}</span>}
            </span>
            {mark && (
                // The Arcaid logo's own double-line triangle, in the logo's pink.
                <svg className="arc-menu__mark" viewBox="0 0 32 32" aria-hidden="true">
                    <polygon className="arc-menu__mark-outer" points="13.1,3.3 29.3,21.3 5.6,26.4" />
                    <polygon className="arc-menu__mark-inner" points="14.1,8 24.8,19.9 9.1,23.2" />
                </svg>
            )}
        </>
    );
}

type ItemProps = {
    /** A router path: the item is a `<Link>`, navigates client-side and closes the menu. */
    to?: string;
    /** `row`: a list row (tile, name, wraps); `link`: a quiet footer link; `cta`: a footer link in the menu's colour. */
    variant?: 'row' | 'link' | 'cta';
    /** The row's tile (`MenuTile`) or the link's icon. */
    media?: ReactNode;
    /** Overrides the text typeahead matches on. */
    label?: string;
    onClick?: () => void;
    'aria-describedby'?: string;
    children: ReactNode;
};

/** One choice in the menu. */
export function MenuItem({ to, variant = 'row', media, label, onClick, children, ...aria }: ItemProps) {
    const className = variant === 'row' ? 'arc-menu__row' : `arc-menu__link${variant === 'cta' ? ' arc-menu__link--cta' : ''}`;
    const body = variant === 'row'
        ? <RowBody media={media}>{children}</RowBody>
        : <>{media}{children}</>;
    if (to) {
        return (
            <BaseMenu.LinkItem className={className} label={label} closeOnClick onClick={onClick} render={<Link to={to} />} {...aria}>
                {body}
            </BaseMenu.LinkItem>
        );
    }
    return (
        <BaseMenu.Item className={className} label={label} onClick={onClick} {...aria}>
            {body}
        </BaseMenu.Item>
    );
}

/**
 * A row that is information, not a choice (the room you are in). It can take
 * the highlight, so arrow keys and screen readers still reach it, but picking
 * it does nothing (`aria-disabled`). `mark` adds the Arcaid triangle.
 */
export function MenuStaticRow({ media, caption, mark = false, children, ...rest }: {
    media?: ReactNode;
    caption?: ReactNode;
    mark?: boolean;
    children: ReactNode;
    'aria-current'?: 'page' | 'true';
}) {
    return (
        <BaseMenu.Item className="arc-menu__row arc-menu__row--static" disabled closeOnClick={false} {...rest}>
            <RowBody media={media} caption={caption} mark={mark}>{children}</RowBody>
        </BaseMenu.Item>
    );
}

/** A row-shaped placeholder while the list loads. */
export function MenuSkeletonRow({ label }: { label: string }) {
    return (
        <div className="arc-menu__skeleton">
            <span className="sr-only">{label}</span>
            <span className="arc-menu__skeleton-tile" aria-hidden="true" />
            <span className="arc-menu__skeleton-bar" aria-hidden="true" />
        </div>
    );
}

export function MenuSeparator() {
    return <BaseMenu.Separator className="arc-menu__sep" />;
}

/** A plain line of text under the list (an empty state, a hint). Give it an id and point the next link's `aria-describedby` at it. */
export function MenuNote({ id, children }: { id?: string; children: ReactNode }) {
    return <p id={id} className="arc-menu__note">{children}</p>;
}

/** The footer: quieter links side by side, or stacked (`stack`). */
export function MenuFooter({ stack = false, children }: { stack?: boolean; children: ReactNode }) {
    return <div className={`arc-menu__foot${stack ? ' arc-menu__foot--stack' : ''}`} role="presentation">{children}</div>;
}
