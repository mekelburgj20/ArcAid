import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import {
    CHANGE_HREF, ROOM_TOAST_HINT, ROOM_TOAST_LABEL, START_ATTEMPTS_NEEDED, attemptStartsNeeded, firstRoomToast,
    homeLines, roomLines, roomToastKeys, roomToastLines, roomToastMs,
    type Device, type Line, type Routing,
} from '../lib/witnessScoresGoTo';
import { useToast } from './Toast';
import {
    ATTEMPT_STARTS_CHANGED_EVENT, PRACTICE_MODE_ON_FOR, fetchRoomAttemptStarts, gamePageHref, practicingTables,
    type RoomAttemptStart,
} from '../lib/attemptStarts';
import {
    ROOM_NOTICE_DISMISSED_EVENT, deviceNoticeKey, dismissNotice, isNoticeDismissed, practiceNoticeKey, startsNoticeKey,
} from '../lib/roomNotices';
import DismissibleNotice from './DismissibleNotice';

/**
 * W27.3 (ADR 0033 §5) — "Your scores go to": one line per paired Arcaid Witness
 * device, so a player sees where their plays will count BEFORE they play, not
 * after (TomatoGrass's #1 ask from the Witness Weekend Showdown: the device
 * target was buried in Account Settings and "app-breaking when missed").
 *
 * - **Room pages** (`roomId` set): does this device send HERE? The answer comes
 *   from `GET /api/me/witness/routing`, which applies the ingest's own routing
 *   rule (`deviceRoutesTo`) to the device's effective target, so this line can
 *   never disagree with where a score goes. A device that does NOT send here
 *   is an amber line, with what to do about it. The devices that DO send here
 *   are confirmed by ONE "Arcaid Witness" toast on entering a room (owner
 *   2026-11-23: three standing lines at the top of every room page were
 *   clutter). Each device's answer is said once in this browser, in whichever
 *   room it is met first (remembered in localStorage, so neither a refresh nor
 *   the player's next room repeats it; owner 2026-11-24), said again only for
 *   an answer not said before (`firstRoomToast`), and gone by itself after a
 *   few seconds.
 *   Pressing the toast opens the player's device settings (`CHANGE_HREF`).
 *   W56: when a device sends here and a Limited-attempts table still needs the
 *   player's Start attempts press, one more amber line names those tables
 *   (from `GET /api/rooms/:roomId/attempt-starts/me`), each linking to its
 *   game page. It re-reads that list when a scoreboard card is pressed.
 *   W126: and one amber line names the tables the player is in PRACTICE MODE
 *   on (their attempts are paused there), from the same list, so a player who
 *   forgot to resume sees it on every room page before a game they meant to
 *   count. Dismissing it hides that pause only; the next pause shows it again.
 * - **Home page** (no `roomId`): where each device sends.
 *
 * W83 - on a ROOM page every line (each amber device line and the "Start
 * attempts needed on" line) has an X / touch swipe that hides it for 7 days.
 * The dismissal is keyed on the line's ANSWER (`lib/roomNotices.ts`), so a
 * changed routing answer or a changed table list shows the line again. The
 * home page keeps no X.
 *
 * Renders nothing for a guest or a player with no paired device, nothing on a
 * room page where every device sends here and no table needs a press, and
 * nothing once every room line is dismissed.
 */

export default function WitnessScoresGoTo({
    roomId, roomSlug, className = '',
}: { roomId?: string | null; roomSlug?: string | null; className?: string }) {
    const { playerToken } = useViewerAuth();
    const [lines, setLines] = useState<Line[]>([]);
    const [routing, setRouting] = useState<Routing[]>([]);
    // Tagged with the room it was read for, so a room change never shows the
    // previous room's tables while the new list loads.
    const [attemptStarts, setAttemptStarts] = useState<{ roomId: string; games: RoomAttemptStart[] } | null>(null);
    // W83 - bumped to re-read dismissals when any room notice is dismissed.
    const [, setDismissTick] = useState(0);
    // Read through a ref so the routing read below never re-runs for a new `toast` function.
    const { toast } = useToast();
    const toastRef = useRef(toast);
    useEffect(() => { toastRef.current = toast; }, [toast]);

    useEffect(() => {
        if (!playerToken) return;
        let live = true;
        const url = roomId
            ? `/api/me/witness/routing?roomId=${encodeURIComponent(roomId)}`
            : '/api/me/witness/devices';
        fetch(url, { headers: { Authorization: `Bearer ${playerToken}` } })
            .then(res => (res.ok ? res.json() : []))
            .then(body => {
                if (!live) return;
                const rows = Array.isArray(body) ? body : [];
                setRouting(roomId ? rows as Routing[] : []);
                setLines(roomId ? roomLines(rows as Routing[]) : homeLines(rows as Device[]));
                // Said here, from the answer just read for THIS room, never from state
                // (which still holds the last room's lines while a new room loads).
                if (roomId) {
                    const said = roomToastLines(rows as Routing[]);
                    if (said.length > 0 && firstRoomToast(roomToastKeys(rows as Routing[]))) {
                        toastRef.current(said.join('\n'), 'success', {
                            label: ROOM_TOAST_LABEL, durationMs: roomToastMs(said.length),
                            href: CHANGE_HREF, hrefHint: ROOM_TOAST_HINT,
                        });
                    }
                }
            })
            .catch(() => { if (live) { setLines([]); setRouting([]); } });
        return () => { live = false; };
    }, [playerToken, roomId]);

    // W56 — the room's Start attempts list; re-read after a card press.
    useEffect(() => {
        if (!playerToken || !roomId) return;
        let live = true;
        const load = () => {
            fetchRoomAttemptStarts(roomId, playerToken).then(games => { if (live) setAttemptStarts({ roomId, games }); });
        };
        load();
        window.addEventListener(ATTEMPT_STARTS_CHANGED_EVENT, load);
        return () => { live = false; window.removeEventListener(ATTEMPT_STARTS_CHANGED_EVENT, load); };
    }, [playerToken, roomId]);

    useEffect(() => {
        if (!roomId) return;
        const onDismissed = () => setDismissTick(n => n + 1);
        window.addEventListener(ROOM_NOTICE_DISMISSED_EVENT, onDismissed);
        return () => window.removeEventListener(ROOM_NOTICE_DISMISSED_EVENT, onDismissed);
    }, [roomId]);

    if (!playerToken || lines.length === 0) return null;
    const needed = roomId && attemptStarts?.roomId === roomId ? attemptStartsNeeded(routing, attemptStarts.games) : null;

    // Room mode: each device line's dismissal key is built from its routing answer.
    const lineKey = (line: Line): string | null => {
        if (!roomId) return null;
        const r = routing.find(x => x.deviceId === line.key);
        return r ? deviceNoticeKey(r) : null;
    };
    // Room mode: a device that sends here was said by the toast; only the amber lines stay on the page.
    const shownLines = roomId
        ? lines.filter(line => { if (line.ok) return false; const k = lineKey(line); return !k || !isNoticeDismissed(roomId, k); })
        : lines;
    const neededKey = needed ? startsNoticeKey(needed) : null;
    const showNeeded = !!needed && !(roomId && neededKey && isNoticeDismissed(roomId, neededKey));
    // W126 - the tables the player is practicing on. Like the Start line, only
    // when a device of theirs sends here (otherwise no play counts here anyway).
    const practicing = roomId && attemptStarts?.roomId === roomId && routing.some(r => r.sendsHere !== 'no')
        ? practicingTables(attemptStarts.games)
        : null;
    const practiceKey = practicing
        ? practiceNoticeKey(practicing.map(g => ({ gameId: g.gameId, pausedTs: g.practice?.pausedTs ?? null })))
        : null;
    const showPractice = !!practicing && !(roomId && practiceKey && isNoticeDismissed(roomId, practiceKey));
    if (shownLines.length === 0 && !showNeeded && !showPractice) return null;

    const dismissible = (noticeKey: string | null, node: ReactNode, reactKey: string) => (roomId && noticeKey
        ? <DismissibleNotice key={reactKey} noticeKey={noticeKey} onDismiss={() => dismissNotice(roomId, noticeKey)} className="w-fit max-w-full sm:max-w-2xl">{node}</DismissibleNotice>
        : <Fragment key={reactKey}>{node}</Fragment>);

    return (
        <div className={`basis-full space-y-1 ${className}`} data-testid="witness-scores-go-to">
            {shownLines.map(line => dismissible(lineKey(line), (
                <p className={`flex items-start gap-1.5 text-xs ${line.ok ? 'text-muted' : 'text-neon-amber'}`}>
                    {/* The icon never wraps away from its text (a phone broke it onto its own line). */}
                    {line.ok
                        ? <ShieldCheck size={13} aria-hidden="true" className="mt-px text-neon-green shrink-0" />
                        : <AlertTriangle size={13} aria-hidden="true" className="mt-px shrink-0" />}
                    <span>
                        {line.text}
                        {line.change && (
                            <> <Link to={CHANGE_HREF} className="underline hover:text-primary">Change</Link></>
                        )}
                    </span>
                </p>
            ), line.key))}
            {showNeeded && needed && dismissible(neededKey, (
                <p className="flex items-start gap-1.5 text-xs text-neon-amber" data-testid="attempt-starts-needed">
                    <AlertTriangle size={13} aria-hidden="true" className="mt-px shrink-0" />
                    <span>
                        {START_ATTEMPTS_NEEDED}{' '}
                        {needed.map((name, i) => (
                            <Fragment key={name}>
                                {i > 0 && ', '}
                                {roomSlug
                                    ? <Link to={gamePageHref(roomSlug, name)} className="underline hover:text-primary">{name}</Link>
                                    : name}
                            </Fragment>
                        ))}
                    </span>
                </p>
            ), 'attempt-starts-needed')}
            {showPractice && practicing && dismissible(practiceKey, (
                <p className="flex items-start gap-1.5 text-xs text-neon-amber" data-testid="practice-mode-on">
                    <AlertTriangle size={13} aria-hidden="true" className="mt-px shrink-0" />
                    <span>
                        {PRACTICE_MODE_ON_FOR}{' '}
                        {practicing.map((g, i) => (
                            <Fragment key={g.gameId}>
                                {i > 0 && ', '}
                                {roomSlug
                                    ? <Link to={gamePageHref(roomSlug, g.gameName)} className="underline hover:text-primary">{g.gameName}</Link>
                                    : g.gameName}
                            </Fragment>
                        ))}
                        . Games you start there do not count until you press Resume attempts.
                    </span>
                </p>
            ), 'practice-mode-on')}
        </div>
    );
}
