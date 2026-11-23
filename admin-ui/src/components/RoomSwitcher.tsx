import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown } from 'lucide-react';
import type { MemberRoom } from '../lib/landingRooms';
import { parseServerDate } from '../lib/format';
import type { EarlyPress, RoomSwitcherMenuProps, SwitcherMenuModel } from './RoomSwitcherMenu';

/**
 * G26 - the room name in the room nav, as a switcher: the room's logo and name
 * in one bordered button (the owner's "Arcaid standard") that opens the
 * Arcaid menu (`parts/Menu`) of the viewer's game rooms.
 *
 * The menu lists the room you are in first ("You are here", the logo's pink
 * triangle; it is never a link), then your other rooms, most recently active
 * first, then two quieter links: all game rooms and Manage my rooms. Signed
 * out, it says to sign in instead; with no other room, it says so and points
 * at the room list. A room is opened with a router link, so the page never
 * reloads.
 *
 * The trigger sits in the themed nav, so it takes the room theme's tokens; the
 * menu is the fixed-dark Arcaid look on every theme.
 *
 * The menu (base-ui) is NOT in the main bundle: `RoomSwitcherMenu` is a
 * `React.lazy` chunk. Until it arrives this draws the same button by hand (same
 * classes, name and ARIA), fetches the chunk when the browser is idle or the
 * moment a pointer or focus comes near the button, and remembers a press that
 * came first: the menu then opens as soon as it mounts, as base-ui opens it
 * (the press is replayed on base-ui's trigger), with focus kept on the button.
 * If the chunk cannot load (offline, a stale deploy), the button still works:
 * it goes to My Rooms (signed in) or the room list.
 */

export interface SwitcherCurrentRoom {
    slug: string;
    /** The room's own name (the menu row). */
    name: string;
    /** What the nav shows: the room's scoreboard title when it has one, else its name. */
    title: string;
    logoUrl: string | null;
    roomId: string | null;
}

interface RoomSwitcherProps {
    current: SwitcherCurrentRoom;
    /** The signed-in viewer's rooms (`useMyRooms`); empty for a guest. */
    rooms: MemberRoom[];
    loading: boolean;
    signedIn: boolean;
    /** `inline`: beside the logo on a wide screen; `brandrow`: the phone's centred row under the icons. */
    variant: 'inline' | 'brandrow';
}

let menuLoad: Promise<{ default: ComponentType<RoomSwitcherMenuProps> }> | null = null;
/** The chunk is in: a switcher mounted from now on (the next room page) starts as the menu. */
let menuReady = false;

/** One download for every switcher on the page. A failure is forgotten, so the next page tries again. */
function loadMenu() {
    menuLoad ??= import('./RoomSwitcherMenu').then(
        mod => {
            menuReady = true;
            return mod;
        },
        err => {
            menuLoad = null;
            throw err;
        },
    );
    return menuLoad;
}

const RoomSwitcherMenu = lazy(loadMenu);

/** When the browser is idle after mount (a fixed wait where it cannot say). */
function whenIdle(run: () => void): () => void {
    if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(run, { timeout: 4000 });
        return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 1500);
    return () => window.clearTimeout(id);
}

const SMALL_WORDS = /^(the|of|a|an)$/i;

/** First letters of up to two words, skipping "the", "of", "a". */
function initialsOf(name: string): string {
    const words = name.split(/\s+/).filter(Boolean);
    const picked = words.filter(w => !SMALL_WORDS.test(w)).slice(0, 2);
    const letters = (picked.length ? picked : words.slice(0, 2)).map(w => Array.from(w)[0] ?? '');
    return letters.join('').toUpperCase() || '?';
}

function activityTime(room: MemberRoom): number | null {
    return parseServerDate(room.lastActivityAt)?.getTime() ?? null;
}

/** Newest activity first, rooms with none last, then by name. */
function byActivityThenName(a: MemberRoom, b: MemberRoom): number {
    const ta = activityTime(a);
    const tb = activityTime(b);
    if (ta !== tb) {
        if (ta == null) return 1;
        if (tb == null) return -1;
        return tb - ta;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export default function RoomSwitcher({ current, rooms, loading, signedIn, variant }: RoomSwitcherProps) {
    const navigate = useNavigate();

    const model = useMemo((): SwitcherMenuModel => {
        const isCurrent = (r: MemberRoom) =>
            (!!current.roomId && r.roomId === current.roomId) || r.slug.toLowerCase() === current.slug.toLowerCase();
        // A row with no slug (an optimistic join still in flight) has nowhere to link to.
        const listed = rooms.filter(r => r.slug);
        const others = listed.filter(r => !isCurrent(r)).sort(byActivityThenName);
        const isMember = listed.some(isCurrent);
        const listLoading = signedIn && loading;
        return {
            current: { name: current.name, logoUrl: current.logoUrl, initials: initialsOf(current.name) },
            others: others.map(r => ({ roomId: r.roomId, slug: r.slug, name: r.name, logoUrl: r.logoUrl, initials: initialsOf(r.name) })),
            signedIn,
            listLoading,
            noOtherRoom: signedIn && !listLoading && others.length === 0,
            isMember,
            count: others.length + (isMember ? 1 : 0),
        };
    }, [rooms, loading, signedIn, current.roomId, current.slug, current.name, current.logoUrl]);

    // 'button' until the menu chunk is in; 'failed' if it could not be loaded.
    const [phase, setPhase] = useState<'button' | 'menu' | 'failed'>(() => (menuReady ? 'menu' : 'button'));
    const pressRef = useRef<EarlyPress | null>(null);
    const pointerTypeRef = useRef<string | null>(null);
    const focusHandOffRef = useRef(false);
    const fallbackPath = signedIn ? '/my-rooms' : '/';
    const fallbackRef = useRef(fallbackPath);
    useEffect(() => { fallbackRef.current = fallbackPath; }, [fallbackPath]);

    const warm = useCallback(() => {
        if (phase !== 'button') return;
        loadMenu().then(
            // A transition: React keeps this button on screen until the menu can replace it.
            () => startTransition(() => setPhase('menu')),
            () => {
                setPhase('failed');
                if (pressRef.current) {
                    pressRef.current = null;
                    navigate(fallbackRef.current);
                }
            },
        );
    }, [phase, navigate]);

    useEffect(() => (phase === 'button' ? whenIdle(warm) : undefined), [phase, warm]);

    const activate = (press: EarlyPress) => {
        if (phase === 'failed') {
            navigate(fallbackPath);
            return;
        }
        pressRef.current = press;
        warm();
    };

    // Read by the menu as it mounts (after this button has left the page): was
    // the button focused, and was it pressed? Each is handed over once.
    const takeHandOff = useCallback(() => {
        const handOff = { focus: focusHandOffRef.current, press: pressRef.current };
        focusHandOffRef.current = false;
        pressRef.current = null;
        return handOff;
    }, []);

    // Runs as the hand-drawn button leaves the page, while it can still hold focus.
    const buttonRef = useCallback((el: HTMLButtonElement | null) => {
        if (!el) return;
        return () => { focusHandOffRef.current = document.activeElement === el; };
    }, []);

    const triggerClassName = `room-switch room-switch--${variant}`;
    const triggerLabel = `${current.title}, switch game room`;
    const face = (
        <>
            {current.logoUrl ? (
                <span className="room-switch__tile" aria-hidden="true"><img src={current.logoUrl} alt="" /></span>
            ) : (
                <span className="room-switch__tile room-switch__tile--init" aria-hidden="true">{model.current.initials}</span>
            )}
            <span className="room-switch__name">{current.title}</span>
            <ChevronDown className="room-switch__chev" aria-hidden="true" />
        </>
    );

    const button = (
        <button
            ref={buttonRef}
            type="button"
            className={triggerClassName}
            aria-label={triggerLabel}
            title={current.title}
            aria-haspopup="menu"
            aria-expanded="false"
            onPointerEnter={warm}
            onFocus={warm}
            onTouchStart={warm}
            onPointerDown={(e: PointerEvent<HTMLButtonElement>) => {
                pointerTypeRef.current = e.pointerType || 'mouse';
                warm();
            }}
            // Enter and Space reach a button as a click with no pointer (`detail` 0), as do screen readers.
            onClick={(e: MouseEvent<HTMLButtonElement>) => activate(
                e.detail === 0 ? { kind: 'click' } : { kind: 'pointer', pointerType: pointerTypeRef.current ?? 'mouse' },
            )}
            onKeyDown={(e: KeyboardEvent<HTMLButtonElement>) => {
                if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
                e.preventDefault();
                activate({ kind: 'key', key: e.key });
            }}
        >
            {face}
        </button>
    );

    return (
        // Always mounted, so the transition above keeps the button instead of showing a fallback.
        <Suspense fallback={button}>
            {phase === 'menu' ? (
                <RoomSwitcherMenu
                    model={model}
                    variant={variant}
                    triggerClassName={triggerClassName}
                    triggerLabel={triggerLabel}
                    triggerTitle={current.title}
                    face={face}
                    takeHandOff={takeHandOff}
                />
            ) : button}
        </Suspense>
    );
}
