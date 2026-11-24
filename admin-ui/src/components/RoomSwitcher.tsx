import { lazy, startTransition, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type FocusEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { ChevronDown, Trophy } from 'lucide-react';
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
 * classes, name and ARIA) and fetches the chunk when the browser is idle or the
 * moment a pointer or focus comes near the button.
 *
 * A press that comes first is remembered and replayed on base-ui's trigger when
 * the menu mounts, but only while it still means "open the menu": a second
 * press, focus moving to something else, a press anywhere else, a route change,
 * unmounting or 5 seconds each forget it. If the chunk cannot load (offline, a
 * stale deploy), the button stays; it tries again on the next hover, focus,
 * touch, press or route change, and a press whose load fails goes to My Rooms
 * (signed in) or the room list instead.
 *
 * The Global Scoreboard is a place in the same list (owner 2026-11-23): on a
 * room, a "Global Scoreboard" row follows the rooms, for every viewer. The
 * Global Scoreboard's own header shows this switcher to a signed-in viewer
 * with Global as the current place (`kind: 'global'`); its tile is the trophy
 * icon, as Global has no logo.
 */

export interface SwitcherCurrentRoom {
    /** `global`: the Global Scoreboard, a place with no room (an empty slug and no room id). Absent means a room. */
    kind?: 'room' | 'global';
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

type MenuModule = { default: ComponentType<RoomSwitcherMenuProps> };

let menuLoad: Promise<MenuModule> | null = null;
/** The chunk is in: a switcher mounted from now on starts as the menu. */
let menuReady = false;
let failures = 0;
let failedChunkUrl: string | null = null;

/** The chunk's URL from the browser's failure message (Chrome and Firefox name it; Safari does not). */
function chunkUrlOf(err: unknown): string | null {
    const message = err instanceof Error ? err.message : String(err);
    // A module script's URL only, never some other link in the message.
    return /https?:\/\/[^\s'"?#]+\.(?:m?js|[jt]sx?)(?=[\s'"?#]|$)/.exec(message)?.[0] ?? null;
}

/**
 * A browser keeps a failed module fetch in its module map and refuses the same
 * URL again without asking the network (Chromium, checked 2026-11-23), so a
 * retry asks for the chunk under a new URL. Its own imports keep their normal
 * URLs, so React and the rest stay the same instances.
 */
function importMenu(): Promise<MenuModule> {
    if (failures > 0 && failedChunkUrl) {
        return import(/* @vite-ignore */ `${failedChunkUrl}?retry=${failures}`) as Promise<MenuModule>;
    }
    return import('./RoomSwitcherMenu');
}

/** One download for every switcher on the page; after a failure the next call tries again. */
function loadMenu(): Promise<MenuModule> {
    menuLoad ??= importMenu().then(
        mod => {
            menuReady = true;
            return mod;
        },
        err => {
            menuLoad = null;
            failures += 1;
            failedChunkUrl = chunkUrlOf(err) ?? failedChunkUrl;
            throw err;
        },
    );
    return menuLoad;
}

const RoomSwitcherMenu = lazy(loadMenu);

/** An early press is forgotten after this long: a menu opening much later would surprise. */
const PRESS_KEPT_MS = 5000;

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
    const location = useLocation();

    const isGlobal = current.kind === 'global';
    const model = useMemo((): SwitcherMenuModel => {
        // Global is no room, and an empty slug never names one.
        const currentSlug = isGlobal ? '' : current.slug.toLowerCase();
        const isCurrent = (r: MemberRoom) =>
            !isGlobal && ((!!current.roomId && r.roomId === current.roomId) || (!!currentSlug && r.slug.toLowerCase() === currentSlug));
        // A row with no slug (an optimistic join still in flight) has nowhere to link to.
        const listed = rooms.filter(r => r.slug);
        const others = listed.filter(r => !isCurrent(r)).sort(byActivityThenName);
        const isMember = listed.some(isCurrent);
        const listLoading = signedIn && loading;
        return {
            current: { kind: isGlobal ? 'global' : 'room', name: current.name, logoUrl: current.logoUrl, initials: initialsOf(current.name) },
            others: others.map(r => ({ roomId: r.roomId, slug: r.slug, name: r.name, logoUrl: r.logoUrl, initials: initialsOf(r.name) })),
            showGlobal: !isGlobal,
            signedIn,
            listLoading,
            noOtherRoom: signedIn && !listLoading && others.length === 0,
            isMember,
            // Rooms only: the Global row is a place, not one of your rooms.
            count: others.length + (isMember ? 1 : 0),
        };
    }, [rooms, loading, signedIn, isGlobal, current.roomId, current.slug, current.name, current.logoUrl]);

    // 'button' until the menu chunk is in; 'failed' after a load failed (and until a retry succeeds).
    const [phase, setPhase] = useState<'button' | 'menu' | 'failed'>(() => (menuReady ? 'menu' : 'button'));
    const mountedRef = useRef(false);
    const loadingRef = useRef(false);
    const buttonElRef = useRef<HTMLButtonElement | null>(null);
    const focusHandOffRef = useRef(false);
    const fallbackPath = signedIn ? '/my-rooms' : '/';
    const fallbackRef = useRef(fallbackPath);
    useEffect(() => { fallbackRef.current = fallbackPath; }, [fallbackPath]);

    // The waiting press, and how to forget it (its timer and its outside-press listeners go with it).
    const pressRef = useRef<EarlyPress | null>(null);
    const forgetPressRef = useRef<() => void>(() => {});
    const forgetPress = useCallback(() => forgetPressRef.current(), []);
    const rememberPress = useCallback((press: EarlyPress) => {
        forgetPressRef.current();
        pressRef.current = press;
        const onPressElsewhere = (e: Event) => {
            const el = buttonElRef.current;
            if (!el || !(e.target instanceof Node) || !el.contains(e.target)) forget();
        };
        const timer = window.setTimeout(() => forget(), PRESS_KEPT_MS);
        document.addEventListener('pointerdown', onPressElsewhere, true);
        document.addEventListener('touchstart', onPressElsewhere, true);
        function forget() {
            pressRef.current = null;
            window.clearTimeout(timer);
            document.removeEventListener('pointerdown', onPressElsewhere, true);
            document.removeEventListener('touchstart', onPressElsewhere, true);
            forgetPressRef.current = () => {};
        }
        forgetPressRef.current = forget;
    }, []);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            forgetPress();
        };
    }, [forgetPress]);

    const warm = useCallback(() => {
        if (phase === 'menu' || loadingRef.current) return;
        loadingRef.current = true;
        loadMenu().then(
            () => {
                loadingRef.current = false;
                // A transition: React keeps this button on screen until the menu can replace it.
                if (mountedRef.current) startTransition(() => setPhase('menu'));
            },
            () => {
                loadingRef.current = false;
                if (!mountedRef.current) return;
                setPhase('failed');
                // Only a press that is still waiting for this load goes elsewhere instead.
                if (pressRef.current) {
                    forgetPress();
                    navigate(fallbackRef.current);
                }
            },
        );
    }, [phase, navigate, forgetPress]);

    useEffect(() => (phase === 'button' ? whenIdle(warm) : undefined), [phase, warm]);

    // A route change forgets a waiting press, and gives a failed load another try.
    const locationKeyRef = useRef(location.key);
    useEffect(() => {
        if (locationKeyRef.current === location.key) return;
        locationKeyRef.current = location.key;
        forgetPress();
        if (phase === 'failed') warm();
    }, [location.key, phase, warm, forgetPress]);

    const activate = (press: EarlyPress) => {
        // A second press before the menu is in is "never mind", as a second press on an open menu closes it.
        if (pressRef.current) {
            forgetPress();
            return;
        }
        rememberPress(press);
        warm();
    };

    // Read by the menu as it mounts (after this button has left the page): was
    // the button focused, and is a press still waiting? Each is handed over once.
    const takeHandOff = useCallback(() => {
        const handOff = { focus: focusHandOffRef.current, press: pressRef.current };
        focusHandOffRef.current = false;
        forgetPress();
        return handOff;
    }, [forgetPress]);

    // Its cleanup runs as the hand-drawn button leaves the page, while it can still hold focus.
    const buttonRef = useCallback((el: HTMLButtonElement | null) => {
        if (!el) return;
        buttonElRef.current = el;
        return () => {
            focusHandOffRef.current = document.activeElement === el;
            if (buttonElRef.current === el) buttonElRef.current = null;
        };
    }, []);

    // `room-switch--global`: Global's name is never capped (its header has no nav items to make room for).
    const triggerClassName = `room-switch room-switch--${variant}${isGlobal ? ' room-switch--global' : ''}`;
    const triggerLabel = `${current.title}, switch game room`;
    const face = (
        <>
            {isGlobal ? (
                // Global has no logo: the trophy, the icon the room nav's "Global" item wears.
                <span className="room-switch__tile room-switch__tile--icon" aria-hidden="true"><Trophy /></span>
            ) : current.logoUrl ? (
                <span className="room-switch__tile" aria-hidden="true"><img src={current.logoUrl} alt="" /></span>
            ) : (
                <span className="room-switch__tile room-switch__tile--init" aria-hidden="true">{model.current.initials}</span>
            )}
            <span className="room-switch__name">{current.title}</span>
            <ChevronDown className="room-switch__chev" aria-hidden="true" />
        </>
    );

    const failed = phase === 'failed';
    const button = (
        <button
            ref={buttonRef}
            type="button"
            className={triggerClassName}
            aria-label={triggerLabel}
            title={current.title}
            // While the menu cannot load, the button is a way to a page, not a menu.
            aria-haspopup={failed ? undefined : 'menu'}
            aria-expanded={failed ? undefined : false}
            onPointerEnter={warm}
            onFocus={warm}
            onTouchStart={warm}
            onPointerDown={warm}
            onBlur={(e: FocusEvent<HTMLButtonElement>) => {
                // Focus moved on to something else: the viewer has moved on. (Leaving the
                // window, or this button leaving the page at the swap, has no relatedTarget.)
                if (e.relatedTarget && e.relatedTarget !== e.currentTarget) forgetPress();
            }}
            // Enter and Space reach a button as a click with no pointer (`detail` 0), as do screen readers.
            // A press whose pointer goes down on this button and up after the swap is lost: press again.
            onClick={(e: MouseEvent<HTMLButtonElement>) => activate(e.detail === 0 ? { kind: 'click' } : { kind: 'pointer' })}
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
