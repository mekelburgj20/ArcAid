import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { LayoutGrid, SlidersHorizontal } from 'lucide-react';
import {
    Menu, MenuFooter, MenuGroup, MenuHeading, MenuItem, MenuNote, MenuPopup, MenuSeparator,
    MenuSkeletonRow, MenuStaticRow, MenuTile, MenuTrigger,
} from './parts/Menu';

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
    | { kind: 'pointer'; pointerType: string }
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
 * Replays an early press as the events the browser would have sent, so base-ui
 * opens exactly as on a normal press: a pointer press opens on `mousedown` with
 * nothing highlighted, a keyboard press (Enter, Space, a screen reader: a click
 * with `detail` 0) or an arrow key opens on the first room it can highlight.
 */
function replayPress(el: HTMLElement, press: EarlyPress) {
    if (press.kind === 'key') {
        el.dispatchEvent(new KeyboardEvent('keydown', { key: press.key, bubbles: true, cancelable: true }));
        return;
    }
    if (press.kind === 'click') {
        el.click();
        return;
    }
    const mouse = { bubbles: true, cancelable: true, composed: true, button: 0, detail: 1 };
    // 1x1 with pressure, so it does not read as a screen reader's synthesized press.
    const pointer = { ...mouse, pointerId: 1, pointerType: press.pointerType, isPrimary: true, width: 1, height: 1, pressure: 0.5 };
    const Pointer = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
    el.dispatchEvent(new Pointer('pointerdown', { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...mouse, buttons: 1 }));
    el.dispatchEvent(new Pointer('pointerup', { ...pointer, pressure: 0 }));
    el.dispatchEvent(new MouseEvent('mouseup', mouse));
    el.dispatchEvent(new MouseEvent('click', mouse));
}

export default function RoomSwitcherMenu({
    model, variant, triggerClassName, triggerLabel, triggerTitle, face, takeHandOff,
}: RoomSwitcherMenuProps) {
    const noteId = useId();
    const triggerRef = useRef<HTMLButtonElement>(null);
    const takeHandOffRef = useRef(takeHandOff);
    // Taken once per mount; StrictMode runs effects twice, and a second replay would close the menu again.
    const handOffRef = useRef<{ focus: boolean; press: EarlyPress | null } | null>(null);
    const replayedRef = useRef(false);

    // Focus first, before paint, so focus never rests on <body> between the two buttons.
    useLayoutEffect(() => {
        if (handOffRef.current) return;
        const handOff = takeHandOffRef.current?.() ?? { focus: false, press: null };
        handOffRef.current = handOff;
        if (handOff.focus || handOff.press) triggerRef.current?.focus({ preventScroll: true });
    }, []);
    // The press after base-ui's own effects have run, so its trigger is wired up.
    useEffect(() => {
        const press = handOffRef.current?.press;
        if (!press || replayedRef.current || !triggerRef.current) return;
        replayedRef.current = true;
        replayPress(triggerRef.current, press);
    }, []);

    const { current, others, signedIn, listLoading, noOtherRoom, isMember, count } = model;

    return (
        <Menu>
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
