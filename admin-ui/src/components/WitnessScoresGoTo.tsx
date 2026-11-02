import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import {
    CHANGE_HREF, START_ATTEMPTS_NEEDED, attemptStartsNeeded, homeLines, roomLines,
    type Device, type Line, type Routing,
} from '../lib/witnessScoresGoTo';
import { ATTEMPT_STARTS_CHANGED_EVENT, fetchRoomAttemptStarts, gamePageHref, type RoomAttemptStart } from '../lib/attemptStarts';
import {
    ROOM_NOTICE_DISMISSED_EVENT, deviceNoticeKey, dismissNotice, isNoticeDismissed, startsNoticeKey,
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
 *   never disagree with where a score goes. A device that sends here is a quiet
 *   confirmation; one that does not is amber, with what to do about it.
 *   W56: when a device sends here and a Limited-attempts table still needs the
 *   player's Start attempts press, one more amber line names those tables
 *   (from `GET /api/rooms/:roomId/attempt-starts/me`), each linking to its
 *   game page. It re-reads that list when a scoreboard card is pressed.
 * - **Home page** (no `roomId`): where each device sends.
 *
 * W83 - on a ROOM page every line (each device line and the "Start attempts
 * needed on" line) has an X / touch swipe that hides it for 7 days. The
 * dismissal is keyed on the line's ANSWER (`lib/roomNotices.ts`), so a changed
 * routing answer or a changed table list shows the line again. The home page
 * keeps no X.
 *
 * Renders nothing for a guest or a player with no paired device, and nothing
 * once every room line is dismissed.
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
    const shownLines = roomId
        ? lines.filter(line => { const k = lineKey(line); return !k || !isNoticeDismissed(roomId, k); })
        : lines;
    const neededKey = needed ? startsNoticeKey(needed) : null;
    const showNeeded = !!needed && !(roomId && neededKey && isNoticeDismissed(roomId, neededKey));
    if (shownLines.length === 0 && !showNeeded) return null;

    const dismissible = (noticeKey: string | null, node: ReactNode, reactKey: string) => (roomId && noticeKey
        ? <DismissibleNotice key={reactKey} noticeKey={noticeKey} onDismiss={() => dismissNotice(roomId, noticeKey)}>{node}</DismissibleNotice>
        : <Fragment key={reactKey}>{node}</Fragment>);

    return (
        <div className={`space-y-1 ${className}`} data-testid="witness-scores-go-to">
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
                        {line.ok && !line.change && roomId && (
                            <> <Link to={CHANGE_HREF} className="underline hover:text-primary">Where your plays went</Link></>
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
        </div>
    );
}
