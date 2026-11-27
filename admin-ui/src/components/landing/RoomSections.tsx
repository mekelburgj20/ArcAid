import { startTransition, useCallback, useEffect, useRef, useState, type ComponentType } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink, Lock, MoreHorizontal } from 'lucide-react';
import { PanelGroup } from '../parts/Panel';
import Button, { ButtonLink } from '../parts/Button';
import { ListRow, ListRows } from '../parts/ListRow';
import { Skeleton, SkeletonRows } from '../parts/Skeleton';
import EmptyState from '../parts/EmptyState';
import LoadFailedNotice from '../LoadFailedNotice';
import WitnessScoresGoTo from '../WitnessScoresGoTo';
import { playerName } from '../ScoreboardComponents';
import { buttonClasses } from '../parts/buttonClasses';
import { lazyPart } from '../../lib/lazyPart';
import { formatScore, relativeTimeFrom, scoreTitle } from '../../lib/format';
import { roomInitials, type MemberRoom, type RoomCardData } from '../../lib/landingRooms';
import type { LoadPhase } from '../../lib/loadRetry';
import type { RoomMenuProps } from './RoomMenu';

/**
 * G35c - the landing page's two room sections, on the Arcaid look (the
 * mockup's layout, concept D for the rooms you have not joined):
 *
 * - `YourRooms`: a card per room you belong to (logo, name, players and
 *   active games when the room is listed, when you last played and how you
 *   joined), the whole card opening the room, and a ⋯ menu holding Leave room.
 *   This is what the retired My Rooms page did.
 * - `MoreRooms`: one kit panel per listed room you have not joined (all of
 *   them signed out), with up to three of the tables being played there now
 *   (`activeTables`, G35b) and View / Join, then a panel to create a room.
 *
 * Colours are the kit's (`--aw-*`, `index.css` "The landing page"); the
 * panels, lists, buttons, empty states and skeletons are the shared parts.
 */

type RoomMemberSource = 'submission' | 'admin_invite' | 'claim' | 'backfill' | 'self_join';

/** How you came to be in the room (the retired My Rooms page's words). */
const SOURCE_LABEL: Record<RoomMemberSource, string> = {
    submission: 'Submitted scores',
    admin_invite: 'Admin invite',
    claim: 'Claimed identity',
    backfill: 'Existing history',
    self_join: 'Joined',
};

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;

/** "12 players · 3 active games"; null when the listing withholds them (an approval room) or has none. */
function roomStats(room: Pick<RoomCardData, 'activePlayers' | 'activeGames' | 'joinPolicy'> | undefined): string | null {
    if (!room || room.activePlayers == null || room.activeGames == null || room.joinPolicy === 'approval') return null;
    return `${plural(room.activePlayers, 'player')} · ${plural(room.activeGames, 'active game')}`;
}

/** A room's logo tile, or its initials when it has none (or it fails to load). */
function RoomLogo({ src, name }: { src: string | null; name: string }) {
    const [broken, setBroken] = useState(false);
    return src && !broken ? (
        <span className="lp-logo" aria-hidden="true"><img src={src} alt="" onError={() => setBroken(true)} /></span>
    ) : (
        <span className="lp-logo lp-logo--init" aria-hidden="true">{roomInitials(name)}</span>
    );
}

// ── The ⋯ menu: base-ui stays off the main bundle (style guide "The Arcaid menu") ──

const roomMenuPart = lazyPart<{ default: ComponentType<RoomMenuProps> }>('landing-room-menu', () => import('./RoomMenu'));

/** When the browser is idle (a fixed wait where it cannot say). */
function whenIdle(run: () => void): () => void {
    if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(run, { timeout: 4000 });
        return () => window.cancelIdleCallback(id);
    }
    const id = window.setTimeout(run, 1500);
    return () => window.clearTimeout(id);
}

/**
 * The card's ⋯ button. Until the menu's chunk is in, it draws the same button
 * by hand: a press then waits for the chunk and opens the menu as it mounts;
 * if the chunk cannot load, the press asks to leave straight away (the menu's
 * one choice), so the button always works.
 */
function RoomMoreButton({ roomName, onLeave }: { roomName: string; onLeave: () => void }) {
    const [mod, setMod] = useState(() => roomMenuPart.loaded());
    const [press, setPress] = useState(false);
    const [focusHand, setFocusHand] = useState(false);
    const [failed, setFailed] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const liveRef = useRef(true);
    useEffect(() => {
        liveRef.current = true;
        return () => { liveRef.current = false; };
    }, []);

    const arrive = useCallback((m: { default: ComponentType<RoomMenuProps> }) => {
        if (!liveRef.current) return;
        setFocusHand(document.activeElement === buttonRef.current);
        startTransition(() => setMod(m));
    }, []);
    const warm = useCallback(() => { roomMenuPart.load().then(arrive, () => {}); }, [arrive]);

    useEffect(() => (mod ? undefined : whenIdle(warm)), [mod, warm]);

    const Real = mod?.default;
    if (Real) return <Real roomName={roomName} onLeave={onLeave} openOnMount={press} focusOnMount={focusHand} />;
    return (
        <button
            ref={buttonRef}
            type="button"
            className="lp-room__more"
            aria-label={`More for ${roomName}`}
            aria-haspopup={failed ? undefined : 'menu'}
            aria-expanded={failed ? undefined : false}
            onPointerEnter={warm}
            onFocus={warm}
            onClick={() => {
                if (failed) {
                    onLeave();
                    return;
                }
                setPress(true);
                roomMenuPart.load().then(arrive, () => {
                    if (!liveRef.current) return;
                    setFailed(true);
                    onLeave();
                });
            }}
        >
            <MoreHorizontal aria-hidden="true" />
        </button>
    );
}

// ── Your rooms ──

function YourRoomCard({ room, listed, listedReady, onLeave }: {
    room: MemberRoom;
    listed: RoomCardData | undefined;
    listedReady: boolean;
    onLeave: (room: MemberRoom) => void;
}) {
    // Counts from the room list when the room is in it; "Unlisted room" only once the list has answered.
    const stats = listed ? roomStats(listed) : listedReady ? 'Unlisted room' : null;
    const played = relativeTimeFrom(room.lastActivityAt);
    const source = SOURCE_LABEL[room.source as RoomMemberSource] ?? null;
    const caption = [played && `You played ${played}`, source].filter(Boolean).join(' · ');
    return (
        <li className="lp-room" data-testid="landing-my-room">
            <RoomLogo src={room.logoUrl ?? listed?.logoUrl ?? null} name={room.name} />
            <div className="lp-room__text">
                {/* The name's link covers the card (`::after`); the ⋯ button sits above it. */}
                <Link to={`/${room.slug}`} className="lp-room__name">{room.name}</Link>
                {stats && <span className="lp-room__stats">{stats}</span>}
                {caption && <span className="lp-room__cap">{caption}</span>}
            </div>
            <RoomMoreButton roomName={room.name} onLeave={() => onLeave(room)} />
        </li>
    );
}

/**
 * Signed in only. Skipped when you have no room (once that is known); a
 * skeleton until the read answers, `LoadFailedNotice` while it is retrying.
 */
export function YourRooms({ rooms, listedById, listedReady, phase, onRetry, onLeave }: {
    /** Already in order: most recently active first. */
    rooms: MemberRoom[];
    listedById: Map<string, RoomCardData>;
    listedReady: boolean;
    phase: LoadPhase;
    onRetry: () => void;
    onLeave: (room: MemberRoom) => void;
}) {
    if (phase === 'ready' && rooms.length === 0) return null;
    return (
        <PanelGroup id="your-rooms" tone="cyan" title="Your rooms">
            {/* W27.3 - where each paired Arcaid Witness device sends its scores (`/api/me/witness/devices`), with Change. */}
            <WitnessScoresGoTo className="lp-witness lg:col-span-2" />
            <div className="lg:col-span-2 min-w-0">
                {phase === 'loading' ? (
                    <div className="lp-mine" role="status" aria-busy="true">
                        <span className="sr-only">Loading your rooms</span>
                        {[0, 1, 2, 3].map(i => (
                            <div key={i} className="lp-room lp-room--skel" aria-hidden="true">
                                <Skeleton className="lp-logo" width={52} height={52} />
                                <span className="lp-room__text">
                                    <Skeleton width="62%" height={15} />
                                    <Skeleton width="80%" height={12} style={{ marginTop: 8 }} />
                                    <Skeleton width="48%" height={11} style={{ marginTop: 8 }} />
                                </span>
                            </div>
                        ))}
                    </div>
                ) : phase === 'retrying' ? (
                    <LoadFailedNotice what="your rooms" onRetry={onRetry} testId="your-rooms-failed" className="py-6" />
                ) : (
                    <ul className="lp-mine" aria-label="Your rooms">
                        {rooms.map(room => (
                            <YourRoomCard
                                key={room.roomId}
                                room={room}
                                listed={listedById.get(room.roomId)}
                                listedReady={listedReady}
                                onLeave={onLeave}
                            />
                        ))}
                    </ul>
                )}
            </div>
        </PanelGroup>
    );
}

// ── More game rooms (concept D, "What's on") ──

function RoomPanel({ room, signedIn, pending, onJoin, onAskJoin }: {
    room: RoomCardData;
    signedIn: boolean;
    pending: boolean;
    onJoin: (room: RoomCardData) => void;
    onAskJoin: (room: RoomCardData) => void;
}) {
    const approval = room.joinPolicy === 'approval';
    // The listing withholds an approval room's counts (they read 0), so it says how to get in instead.
    const caption = roomStats(room) ?? (approval ? 'Approval to join' : null);
    const tables = (room.activeTables ?? []).slice(0, 3);
    const titleId = `lp-room-${room.id}`;
    // A phone's touch target is 44 px; the button keeps its own size above that.
    const touch = 'max-sm:min-h-11';
    return (
        <article className="aw-panel lp-won__room" aria-labelledby={titleId} data-testid="landing-room-panel">
            <div className="lp-won__head">
                <RoomLogo src={room.logoUrl} name={room.name} />
                <div className="min-w-0">
                    <h3 id={titleId} className="lp-won__name">{room.name}</h3>
                    {caption && <p className="lp-won__cap">{caption}</p>}
                </div>
            </div>
            {room.description && <p className="lp-won__desc">{room.description}</p>}
            <p className="aw-label lp-won__label">On now</p>
            {approval ? (
                <p className="lp-won__note">
                    <Lock aria-hidden="true" className="lp-won__lock" />
                    <span>This room approves its members. Ask to join to see its tables.</span>
                </p>
            ) : tables.length === 0 ? (
                // No `activeTables` (a server from before G35b) reads the same as none being played.
                <p className="lp-won__note">No tables running right now</p>
            ) : (
                <ListRows label={`On now in ${room.name}`} testId="landing-on-now">
                    {tables.map(t => (
                        <ListRow
                            key={t.gameId}
                            href={`/${room.slug}/games/${encodeURIComponent(t.name)}`}
                            name={t.name}
                            tile={t.imageUrl ? <img src={t.imageUrl} alt="" /> : roomInitials(t.name)}
                            caption={t.leaderName ? `${playerName({ iscored_username: t.leaderName })} leads` : undefined}
                            trailing={t.topScore != null
                                ? <span className="lp-score" title={scoreTitle(t.topScore)}>{formatScore(t.topScore)}</span>
                                : undefined}
                        />
                    ))}
                </ListRows>
            )}
            <div className="lp-won__foot">
                {room.discordInviteUrl && (
                    // The room's Discord server, as the cards before G35c had it: quieter than View / Join, on the left.
                    <a
                        href={room.discordInviteUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={`${buttonClasses('secondary', 'sm')} no-underline lp-won__discord ${touch}`}
                        aria-label={`Join Discord for ${room.name} (opens in a new tab)`}
                    >
                        Join Discord
                        <ExternalLink aria-hidden="true" size={13} />
                    </a>
                )}
                {signedIn ? (
                    <>
                        <ButtonLink to={`/${room.slug}`} variant="secondary" className={touch} aria-label={`View ${room.name}`}>View</ButtonLink>
                        {approval && pending ? (
                            <Button disabled className={touch} aria-label={`Request sent to ${room.name}`}>Request sent</Button>
                        ) : (
                            <Button
                                className={touch}
                                aria-label={`${approval ? 'Ask to join' : 'Join'} ${room.name}`}
                                onClick={() => (approval ? onAskJoin(room) : onJoin(room))}
                            >
                                {approval ? 'Ask to join' : 'Join'}
                            </Button>
                        )}
                    </>
                ) : (
                    <ButtonLink to={`/${room.slug}`} className={touch} aria-label={`View ${room.name}`}>View</ButtonLink>
                )}
            </div>
        </article>
    );
}

/** The room list's skeleton: three panels in the shape of a room panel. */
function RoomPanelsSkeleton() {
    return (
        <div className="lp-won" role="status" aria-busy="true">
            <span className="sr-only">Loading the game rooms</span>
            {[0, 1, 2].map(i => (
                <div key={i} className="aw-panel lp-won__room" aria-hidden="true">
                    <div className="lp-won__head">
                        <Skeleton className="lp-logo" width={52} height={52} />
                        <span className="min-w-0">
                            <Skeleton width="64%" height={16} />
                            <Skeleton width="52%" height={11} style={{ marginTop: 8 }} />
                        </span>
                    </div>
                    <Skeleton width="86%" height={13} style={{ marginTop: 14 }} />
                    <div className="mt-4"><SkeletonRows count={3} label="" /></div>
                </div>
            ))}
        </div>
    );
}

export function MoreRooms({ signedIn, rooms, listedCount, phase, onRetry, pending, onJoin, onAskJoin }: {
    signedIn: boolean;
    /** The listed rooms you have not joined, already in order. */
    rooms: RoomCardData[];
    /** How many rooms the listing holds (yours included), for the empty state's words. */
    listedCount: number;
    phase: LoadPhase;
    onRetry: () => void;
    /** Approval rooms asked to join in this visit. */
    pending: Set<string>;
    onJoin: (room: RoomCardData) => void;
    onAskJoin: (room: RoomCardData) => void;
}) {
    const empty = rooms.length === 0;
    return (
        <PanelGroup
            id="more-rooms"
            tone="pink"
            title={signedIn ? 'More game rooms' : 'Game rooms'}
            sub={signedIn ? 'Rooms you have not joined yet.' : 'Pick a room to see its leaderboards, or start your own.'}
        >
            <div className="lg:col-span-2 min-w-0">
                {phase === 'loading' ? (
                    <RoomPanelsSkeleton />
                ) : phase === 'retrying' ? (
                    <LoadFailedNotice what="the game rooms" onRetry={onRetry} testId="more-rooms-failed" />
                ) : (
                    <div className="lp-won">
                        {rooms.map(room => (
                            <RoomPanel
                                key={room.id}
                                room={room}
                                signedIn={signedIn}
                                pending={pending.has(room.id)}
                                onJoin={onJoin}
                                onAskJoin={onAskJoin}
                            />
                        ))}
                        <div className="aw-panel lp-won__room lp-won__new">
                            <EmptyState
                                tone="pink"
                                title={!empty ? 'Create a game room' : signedIn && listedCount > 0 ? "You're in every listed game room." : 'No game rooms are listed yet.'}
                                action={<ButtonLink to="/create-room" className="max-sm:min-h-11">Create a room</ButtonLink>}
                            >
                                {empty ? 'Start one for your crew: your own tournaments and leaderboards.' : 'Run your own tournaments and leaderboards for your crew.'}
                            </EmptyState>
                        </div>
                    </div>
                )}
            </div>
        </PanelGroup>
    );
}
