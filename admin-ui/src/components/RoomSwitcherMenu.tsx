import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { LayoutGrid, SlidersHorizontal } from 'lucide-react';
import {
    Menu, MenuFooter, MenuGroup, MenuHeading, MenuItem, MenuNote, MenuPopup, MenuSeparator,
    MenuSkeletonRow, MenuStaticRow, MenuTile, MenuTrigger, type MenuActions,
} from './parts/Menu';

/** Tailwind's `sm`: the inline switcher shows from here up, the phone's brand-row one below it. */
const SM_UP = '(min-width: 640px)';

/**
 * G26 - the room switcher's menu: the base-ui half of `RoomSwitcher`.
 *
 * Loaded on demand (`RoomSwitcher` imports it with `import()`), so base-ui and
 * the Arcaid menu stay off the main bundle that every visitor downloads. This
 * is the ONLY way into `parts/Menu`: a static import of either from a page or
 * layout would put base-ui back on every page. `RoomSwitcher` works out what
 * to list and draws an identical plain button until this module arrives; from
 * then on this module's base-ui trigger owns the button's ARIA and keys.
 */

/** A press on the plain button that arrived before this module did. */
export type EarlyPress =
    | { kind: 'pointer' }
    | { kind: 'click' }
    | { kind: 'key'; key: 'ArrowDown' | 'ArrowUp' };

export interface SwitcherMenuRoom {
    roomId: string;
    slug: string;
    name: string;
    logoUrl: string | null;
    initials: string;
}

/** What the menu shows, worked out by `RoomSwitcher`. */
export interface SwitcherMenuModel {
    current: { name: string; logoUrl: string | null; initials: string };
    /** The viewer's other rooms, already in order. */
    others: SwitcherMenuRoom[];
    signedIn: boolean;
    listLoading: boolean;
    noOtherRoom: boolean;
    isMember: boolean;
    count: number;
}

export interface RoomSwitcherMenuProps {
    model: SwitcherMenuModel;
    variant: 'inline' | 'brandrow';
    triggerClassName: string;
    triggerLabel: string;
    triggerTitle: string;
    /** The button's inside (tile, name, arrow), the same nodes the plain button draws. */
    face: ReactNode;
    /**
     * Asked once, as this mounts (the plain button has just left the page):
     * did it have focus (keep it on the button), and was it pressed (replay the
     * press on the real trigger, so the menu opens as base-ui opens it)?
     */
    takeHandOff?: () => { focus: boolean; press: EarlyPress | null };
}

/**
 * Replays an early press on base-ui's trigger through its synchronous click and
 * key paths (never the mousedown path, which waits a frame that React
 * StrictMode's simulated unmount cancels in development). A pointer press is a
 * `click` with `detail` 1 and no `pointerdown`: base-ui opens it with nothing
 * highlighted, as after a tap. A keyboard press (Enter, Space, a screen reader)
 * is a `click` with `detail` 0, and an arrow key is its keydown: base-ui opens
 * those on the first room it can highlight.
 */
function replayPress(el: HTMLElement, press: EarlyPress) {
    if (press.kind === 'key') {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: press.key, bubbles: true, cancelable: true }));
        return;
    }
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: press.kind === 'pointer' ? 1 : 0 }));
}

export default function RoomSwitcherMenu({
    model, variant, triggerClassName, triggerLabel, triggerTitle, face, takeHandOff,
}: RoomSwitcherMenuProps) {
    const noteId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const actionsRef = useRef<MenuActions | null>(null);
    const takeHandOffRef = useRef(takeHandOff);
    // Taken once per mount; StrictMode runs effects twice, and a second replay would close the menu again.
    const handOffRef = useRef<{ press: EarlyPress | null } | null>(null);
    const replayedRef = useRef(false);

    // Focus first, before paint, so focus never rests on <body> between the two buttons. Only
    // when nothing else has it: the plain button had it as it left (so <body> has it now), or a
    // press is waiting and focus is still on <body>. If the viewer has moved on to something
    // else, a press still waiting is dropped too.
    useLayoutEffect(() => {
        if (handOffRef.current) return;
        const handOff = takeHandOffRef.current?.() ?? { focus: false, press: null };
        const active = document.activeElement;
        const focusFree = !active || active === document.body;
        const keep = focusFree && (handOff.focus || handOff.press !== null);
        handOffRef.current = { press: keep ? handOff.press : null };
        if (keep) triggerRef.current?.focus({ preventScroll: true });
    }, []);
    // The press once base-ui's own effects have run and settled: a microtask after this
    // commit, so StrictMode's second pass over base-ui's effects (development) is over too.
    useEffect(() => {
        const press = handOffRef.current?.press;
        if (!press || replayedRef.current) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled || replayedRef.current || !triggerRef.current) return;
            replayedRef.current = true;
            replayPress(triggerRef.current, press);
        });
        return () => { cancelled = true; };
    }, []);

    // A route change the menu did not cause (Back, a link elsewhere) closes it; so does
    // crossing the `sm` breakpoint, which hides this trigger (the popup would otherwise
    // re-anchor to the top-left corner). Not on mount: StrictMode re-runs this effect.
    const location = useLocation();
    const locationKeyRef = useRef(location.key);
    useEffect(() => {
        if (locationKeyRef.current === location.key) return;
        locationKeyRef.current = location.key;
        actionsRef.current?.close();
    }, [location.key]);
    useEffect(() => {
        if (typeof window.matchMedia !== 'function') return;
        const query = window.matchMedia(SM_UP);
        const close = () => actionsRef.current?.close();
        query.addEventListener('change', close);
        return () => query.removeEventListener('change', close);
    }, []);

    const { current, others, signedIn, listLoading, noOtherRoom, isMember, count } = model;

    return (
        <Menu actionsRef={actionsRef}>
            <MenuTrigger ref={triggerRef} className={triggerClassName} aria-label={triggerLabel} title={triggerTitle}>
                {face}
            </MenuTrigger>
            <MenuPopup align={variant === 'brandrow' ? 'center' : 'start'} sideOffset={variant === 'brandrow' ? 10 : 8}>
                <MenuGroup
                    heading={(
                        <MenuHeading
                            label={signedIn ? 'Your game rooms' : 'Game rooms'}
                            count={signedIn && !listLoading ? count : undefined}
                        />
                    )}
                >
                    <MenuStaticRow
                        media={<MenuTile src={current.logoUrl} initials={current.initials} />}
                        caption="You are here"
                        mark
                        aria-current="page"
                    >
                        {current.name}
                    </MenuStaticRow>
                    {listLoading ? (
                        <MenuSkeletonRow label="Loading your rooms" />
                    ) : others.map(room => (
                        <MenuItem
                            key={room.roomId}
                            to={`/${room.slug}`}
                            media={<MenuTile src={room.logoUrl} initials={room.initials} />}
                        >
                            {room.name}
                        </MenuItem>
                    ))}
                </MenuGroup>
                <MenuSeparator />
                {!signedIn ? (
                    <>
                        <MenuNote id={noteId}>Sign in to see your rooms</MenuNote>
                        <MenuFooter stack>
                            <MenuItem variant="link" to="/" media={<LayoutGrid aria-hidden="true" />} aria-describedby={noteId}>
                                All game rooms
                            </MenuItem>
                        </MenuFooter>
                    </>
                ) : noOtherRoom ? (
                    <>
                        <MenuNote id={noteId}>
                            {isMember ? 'This is your only room so far.' : 'You have not joined a game room yet.'}
                        </MenuNote>
                        <MenuFooter stack>
                            <MenuItem variant="cta" to="/" media={<LayoutGrid aria-hidden="true" />} aria-describedby={noteId}>
                                Find more rooms
                            </MenuItem>
                            <MenuItem variant="link" to="/my-rooms" media={<SlidersHorizontal aria-hidden="true" />}>
                                Manage my rooms
                            </MenuItem>
                        </MenuFooter>
                    </>
                ) : (
                    <MenuFooter>
                        <MenuItem variant="link" to="/" media={<LayoutGrid aria-hidden="true" />}>All game rooms</MenuItem>
                        <MenuItem variant="link" to="/my-rooms" media={<SlidersHorizontal aria-hidden="true" />}>Manage my rooms</MenuItem>
                    </MenuFooter>
                )}
            </MenuPopup>
        </Menu>
    );
}
