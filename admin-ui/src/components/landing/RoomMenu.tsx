import { useEffect, useLayoutEffect, useRef } from 'react';
import { LogOut, MoreHorizontal } from 'lucide-react';
import { Menu, MenuGroup, MenuHeading, MenuItem, MenuPopup, MenuTile, MenuTrigger } from '../parts/Menu';

/**
 * G35c - the ⋯ menu on a "Your rooms" card of the landing page: the Arcaid
 * menu (`parts/Menu`) with one choice, Leave room.
 *
 * This is the base-ui half, a chunk of its own (`RoomMoreButton` imports it
 * with `import()`), so base-ui stays off the main bundle; until it arrives the
 * card draws the same button by hand. A press on that button before the chunk
 * was here is replayed on base-ui's trigger as it mounts (`openOnMount`), the
 * way the room switcher's menu does it (`RoomSwitcherMenu`): a `click` with
 * `detail` 1, once, a microtask after this commit.
 */
export interface RoomMenuProps {
    roomName: string;
    /** Opens the leave confirm (the page owns it). */
    onLeave: () => void;
    /** A press on the hand-drawn button is waiting: open as soon as mounted. */
    openOnMount?: boolean;
    /** The hand-drawn button had focus as it left: keep it on this one. */
    focusOnMount?: boolean;
}

export default function RoomMenu({ roomName, onLeave, openOnMount = false, focusOnMount = false }: RoomMenuProps) {
    const triggerRef = useRef<HTMLButtonElement>(null);
    // Read once per mount; StrictMode runs effects twice, and a second replay would close the menu again.
    const firstRef = useRef({ open: openOnMount, focus: focusOnMount || openOnMount });
    const replayedRef = useRef(false);

    useLayoutEffect(() => {
        if (firstRef.current.focus) triggerRef.current?.focus({ preventScroll: true });
    }, []);
    useEffect(() => {
        if (!firstRef.current.open || replayedRef.current) return;
        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled || replayedRef.current || !triggerRef.current) return;
            replayedRef.current = true;
            triggerRef.current.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1 }));
        });
        return () => { cancelled = true; };
    }, []);

    return (
        <Menu>
            <MenuTrigger ref={triggerRef} className="lp-room__more" aria-label={`More for ${roomName}`}>
                <MoreHorizontal aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup>
                <MenuGroup heading={<MenuHeading label={roomName} />}>
                    <MenuItem media={<MenuTile icon={<LogOut />} />} onClick={onLeave}>
                        Leave room
                    </MenuItem>
                </MenuGroup>
            </MenuPopup>
        </Menu>
    );
}
