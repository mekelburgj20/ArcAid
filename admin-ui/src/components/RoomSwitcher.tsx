import { useId, useMemo } from 'react';
import { ChevronDown, LayoutGrid, SlidersHorizontal } from 'lucide-react';
import type { MemberRoom } from '../lib/landingRooms';
import { parseServerDate } from '../lib/format';
import {
    Menu, MenuFooter, MenuGroup, MenuHeading, MenuItem, MenuNote, MenuPopup, MenuSeparator,
    MenuSkeletonRow, MenuStaticRow, MenuTile, MenuTrigger,
} from './parts/Menu';

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
    const noteId = useId();

    const { others, isMember, count } = useMemo(() => {
        const isCurrent = (r: MemberRoom) =>
            (!!current.roomId && r.roomId === current.roomId) || r.slug.toLowerCase() === current.slug.toLowerCase();
        // A row with no slug (an optimistic join still in flight) has nowhere to link to.
        const listed = rooms.filter(r => r.slug);
        const rest = listed.filter(r => !isCurrent(r)).sort(byActivityThenName);
        const member = listed.some(isCurrent);
        return { others: rest, isMember: member, count: rest.length + (member ? 1 : 0) };
    }, [rooms, current.roomId, current.slug]);

    const listLoading = signedIn && loading;
    const noOtherRoom = signedIn && !listLoading && others.length === 0;

    return (
        <Menu>
            <MenuTrigger
                className={`room-switch room-switch--${variant}`}
                aria-label={`${current.title}, switch game room`}
                title={current.title}
            >
                {current.logoUrl ? (
                    <span className="room-switch__tile" aria-hidden="true"><img src={current.logoUrl} alt="" /></span>
                ) : (
                    <span className="room-switch__tile room-switch__tile--init" aria-hidden="true">{initialsOf(current.name)}</span>
                )}
                <span className="room-switch__name">{current.title}</span>
                <ChevronDown className="room-switch__chev" aria-hidden="true" />
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
                        media={<MenuTile src={current.logoUrl} initials={initialsOf(current.name)} />}
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
                            media={<MenuTile src={room.logoUrl} initials={initialsOf(room.name)} />}
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
