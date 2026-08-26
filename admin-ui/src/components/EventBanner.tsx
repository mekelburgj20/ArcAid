import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

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

export default function EventBanner({ roomId, roomSlug }: { roomId: string; roomSlug: string }) {
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
                            id: t.id, name: t.name, live: true,
                            detail: `Round ${liveRound.round_no} — ${liveRound.name} · ends ${relative(liveRound.scheduled_end_at)}`,
                        });
                        continue;
                    }
                    const next = rounds.find(r => r.status === 'SCHEDULED' && Date.parse(r.scheduled_start_at) > now);
                    if (!next) continue;
                    const checkinOpen = !t.checkin_opens_at || Date.parse(t.checkin_opens_at) <= now;
                    found.push({
                        id: t.id, name: t.name, live: false,
                        detail: t.checkin_required === 1 && checkinOpen
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

    if (events.length === 0) return null;

    return (
        <div className="space-y-2 mb-4">
            {events.map(e => (
                <Link
                    key={e.id}
                    to={`/${roomSlug}/events/${e.id}`}
                    className="flex items-center gap-3 p-3 rounded border border-neon-cyan/40 bg-neon-cyan/10 hover:bg-neon-cyan/20 transition-colors"
                >
                    <span className={`text-xs px-2 py-0.5 rounded border whitespace-nowrap ${
                        e.live
                            ? 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/40'
                            : 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/40'
                    }`}>{e.live ? 'LIVE' : 'EVENT'}</span>
                    <span className="text-sm text-primary font-medium truncate">{e.name}</span>
                    <span className="text-xs text-muted truncate flex-1">{e.detail}</span>
                    <span className="text-neon-cyan text-sm" aria-hidden>→</span>
                </Link>
            ))}
        </div>
    );
}
