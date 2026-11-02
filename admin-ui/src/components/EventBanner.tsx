import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import DismissibleNotice from './DismissibleNotice';
import { ROOM_NOTICE_DISMISSED_EVENT, dismissNotice, eventNoticeKey, isNoticeDismissed } from '../lib/roomNotices';

/**
 * Live/upcoming event banner for the room's public pages (v2.141.0).
 *
 * Before this, NOTHING player-facing linked to an event page — the only doors
 * were a link the host pasted by hand and the Discord announcement, so in a
 * room without Discord (or a quiet test event) players literally could not
 * find where to check in (owner, 2026-08-26). This is the discovery surface:
 * a player visits the scoreboard or lobby like they always do, sees the event,
 * taps through, checks in.
 *
 * Deliberately fetch-and-forget: public pages must render fine when the fetch
 * fails, and an extra card is decoration, never a dependency.
 *
 * W83 - each card can be dismissed (X, or a sideways swipe on touch) for 7
 * days. The dismissal is keyed on the card's STATE (`eventNoticeKey`), so a
 * dismissed upcoming event comes back when check-in opens or it goes live.
 */

interface EventRound {
    status: string;
    round_no: number;
    name: string;
    scheduled_start_at: string;
    scheduled_end_at: string;
}

interface EventTournament {
    id: string;
    name: string;
    format?: string;
    is_active: number;
    event_finished_at?: string | null;
    checkin_opens_at?: string | null;
    checkin_required?: number;
    rounds?: EventRound[];
}

interface BannerEvent {
    id: string;
    name: string;
    live: boolean;
    detail: string;
    /** Dismissal key - see `lib/roomNotices.ts`. */
    key: string;
}

function relative(iso: string): string {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return '';
    const min = Math.round(Math.abs(ms) / 60000);
    const stamp = min < 60
        ? `${Math.max(1, min)} min`
        : min < 48 * 60
            ? `${Math.round(min / 60)} hr`
            : `${Math.round(min / (24 * 60))} days`;
    return ms >= 0 ? `in ${stamp}` : `${stamp} ago`;
}

/**
 * v2.194.0 (W30) - leads with the TOURNAMENT name and shows the room beneath it
 * ("in <room>"): invitees took the room name for the tournament.
 */
export default function EventBanner({ roomId, roomSlug, roomName }: { roomId: string; roomSlug: string; roomName?: string }) {
    const [events, setEvents] = useState<BannerEvent[]>([]);

    useEffect(() => {
        if (!roomId) return;
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/rooms/${roomId}/tournaments`);
                if (!res.ok) return;
                const rows = (await res.json()) as EventTournament[];
                const now = Date.now();
                const found: BannerEvent[] = [];
                for (const t of rows) {
                    if (t.format !== 'event' || t.is_active !== 1 || t.event_finished_at) continue;
                    const rounds = t.rounds ?? [];
                    const liveRound = rounds.find(r => r.status === 'ACTIVE');
                    if (liveRound) {
                        found.push({
                            id: t.id, name: t.name, live: true, key: eventNoticeKey(t.id, true, false),
                            detail: `Round ${liveRound.round_no} — ${liveRound.name} · ends ${relative(liveRound.scheduled_end_at)}`,
                        });
                        continue;
                    }
                    const next = rounds.find(r => r.status === 'SCHEDULED' && Date.parse(r.scheduled_start_at) > now);
                    if (!next) continue;
                    const checkinOpen = !t.checkin_opens_at || Date.parse(t.checkin_opens_at) <= now;
                    const checkin = t.checkin_required === 1 && checkinOpen;
                    found.push({
                        id: t.id, name: t.name, live: false, key: eventNoticeKey(t.id, false, checkin),
                        detail: checkin
                            ? `Check-in open · round 1 starts ${relative(next.scheduled_start_at)}`
                            : `Round ${next.round_no} starts ${relative(next.scheduled_start_at)}`,
                    });
                }
                if (!cancelled) setEvents(found);
            } catch {
                // A public page never breaks over a missing banner.
            }
        })();
        return () => { cancelled = true; };
    }, [roomId]);

    // W83 - re-read dismissals when any room notice is dismissed.
    const [, setDismissTick] = useState(0);
    useEffect(() => {
        const onDismissed = () => setDismissTick(n => n + 1);
        window.addEventListener(ROOM_NOTICE_DISMISSED_EVENT, onDismissed);
        return () => window.removeEventListener(ROOM_NOTICE_DISMISSED_EVENT, onDismissed);
    }, []);

    const visible = events.filter(e => !isNoticeDismissed(roomId, e.key));
    if (visible.length === 0) return null;

    return (
        <div className="space-y-2" data-testid="event-banner">
            {visible.map(e => (
                <DismissibleNotice
                    key={e.key}
                    noticeKey={e.key}
                    onDismiss={() => dismissNotice(roomId, e.key)}
                    className="p-3 rounded border border-neon-cyan/40 bg-neon-cyan/10 hover:bg-neon-cyan/20 transition-colors"
                >
                    <Link
                        to={`/${roomSlug}/events/${e.id}`}
                        className="flex items-center gap-3"
                    >
                        <span className={`text-xs px-2 py-0.5 rounded border whitespace-nowrap ${
                            e.live
                                ? 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/40'
                                : 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/40'
                        }`}>{e.live ? 'LIVE' : 'EVENT'}</span>
                        <span className="min-w-0 flex-1">
                            {/* Titles wrap, never ellipsize - the card is narrow on desktop (W83). */}
                            <span className="block text-sm text-primary font-medium break-words">{e.name}</span>
                            <span className="block text-xs text-muted break-words" data-testid="event-banner-sub">
                                {roomName ? `in ${roomName} · ${e.detail}` : e.detail}
                            </span>
                        </span>
                        <span className="text-neon-cyan text-sm" aria-hidden>→</span>
                    </Link>
                </DismissibleNotice>
            ))}
        </div>
    );
}
