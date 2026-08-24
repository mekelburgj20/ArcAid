import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';
import ShareButton from '../components/ShareButton';
import { useRoom } from '../contexts/RoomContext';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { api } from '../lib/api';

/**
 * `/:slug/events/:id` — the public face of a Live Event (v2.135.0, ADR 0017).
 *
 * This is the page a player lands on from a shared link, a scoreboard card, or
 * a Discord announcement, and it answers the three questions they have, in
 * order: *is it on yet*, *am I in*, and *where do I stand*.
 *
 * It is also the surface P5's Throwdowns reuse — a room-less challenge renders
 * this same component against a room-less event — so nothing here may assume
 * the room context beyond what the API already returns.
 */

interface ScoreRow {
    rank: number;
    identity_key: string;
    iscored_username: string;
    display_name: string | null;
    score: number;
    created_at: string | null;
    elapsed_sec: number | null;
    flagged: boolean;
    participant: boolean;
}

interface RoundBoard {
    roundNo: number;
    gameId: string;
    gameName: string;
    status: string;
    scheduledStartAt: string;
    scheduledEndAt: string;
    scores: ScoreRow[];
}

interface StandingRow {
    rank: number;
    identity_key: string;
    iscored_username: string;
    display_name: string | null;
    roundScores: Array<number | null>;
    total: number;
    roundsPlayed: number;
    flagged: boolean;
}

interface EventPayload {
    event: {
        id: string;
        name: string;
        state: 'upcoming' | 'checkin' | 'live' | 'between_rounds' | 'finished' | 'cancelled';
        aggregateMethod: 'best' | 'average' | 'sum';
        minElapsedSec: number | null;
        endGraceSec: number | null;
        startDate: string | null;
        endDate: string | null;
        finishedAt: string | null;
    };
    now: string;
    checkin: {
        opensAt: string | null;
        closesAt: string | null;
        required: boolean;
        count: number;
        viewerCheckedIn: boolean;
    };
    rounds: RoundBoard[];
    standings: {
        aggregateMethod: 'best' | 'average' | 'sum';
        checkinRequired: boolean;
        roundNumbers: number[];
        standings: StandingRow[];
        incomplete: StandingRow[];
    } | null;
    viewer: {
        canCheckIn: boolean;
        reason: 'LOGIN_REQUIRED' | 'ALREADY_CHECKED_IN' | 'CHECKIN_CLOSED' | null;
    };
}

const name = (r: { display_name: string | null; iscored_username: string }) =>
    r.display_name || r.iscored_username;

/** `+MM:SS` since the round opened — the number that makes a fast score visible. */
function elapsed(sec: number | null): string {
    if (sec == null) return '';
    const clamped = Math.max(0, sec);
    return `+${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** Live countdown to an instant. Ticks once a second; empty once passed. */
function useCountdown(target: string | null): string {
    const [, force] = useState(0);
    useEffect(() => {
        if (!target) return;
        const id = setInterval(() => force(n => n + 1), 1000);
        return () => clearInterval(id);
    }, [target]);
    if (!target) return '';
    const diff = Date.parse(target) - Date.now();
    if (Number.isNaN(diff) || diff <= 0) return '';
    const total = Math.floor(diff / 1000);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0
        ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
        : `${m}:${String(s).padStart(2, '0')}`;
}

const STATE_CHIP: Record<EventPayload['event']['state'], { label: string; className: string }> = {
    live: { label: 'LIVE', className: 'bg-neon-magenta/20 text-neon-magenta border-neon-magenta/40' },
    checkin: { label: 'CHECK-IN OPEN', className: 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40' },
    between_rounds: { label: 'BETWEEN ROUNDS', className: 'bg-neon-cyan/20 text-neon-cyan border-neon-cyan/40' },
    upcoming: { label: 'UPCOMING', className: 'bg-neon-amber/20 text-neon-amber border-neon-amber/40' },
    finished: { label: 'FINISHED', className: 'bg-border/40 text-muted border-border' },
    cancelled: { label: 'CANCELLED', className: 'bg-border/40 text-muted border-border' },
};

export default function EventDetail() {
    const { roomSlug, roomId } = useRoom();
    const { id } = useParams<{ id: string }>();
    const { discordUser, loginWithDiscord } = useViewerAuth();
    const [data, setData] = useState<EventPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [checkingIn, setCheckingIn] = useState(false);
    const [error, setError] = useState('');
    const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

    const load = useCallback(async () => {
        if (!roomId || !id) return;
        try {
            setData(await api.get<EventPayload>(`/rooms/${roomId}/events/${id}`));
        } catch {
            setNotFound(true);
        } finally {
            setLoading(false);
        }
    }, [roomId, id]);

    useEffect(() => { void load(); }, [load]);

    // While the event is running, scores are landing — poll so the boards move
    // without the player reloading. Stops once the result is frozen.
    const isRunning = !!data && ['checkin', 'live', 'between_rounds'].includes(data.event.state);
    useEffect(() => {
        clearInterval(pollRef.current);
        if (!isRunning) return;
        pollRef.current = setInterval(() => { void load(); }, 20_000);
        return () => clearInterval(pollRef.current);
    }, [isRunning, load]);

    const liveRound = data?.rounds.find(r => r.status === 'ACTIVE')
        ?? data?.rounds.find(r => r.status === 'SCHEDULED')
        ?? null;
    const countdownTarget = liveRound
        ? (liveRound.status === 'ACTIVE' ? liveRound.scheduledEndAt : liveRound.scheduledStartAt)
        : null;
    const countdown = useCountdown(countdownTarget);

    const checkIn = async () => {
        if (!roomId || !id) return;
        setCheckingIn(true);
        setError('');
        try {
            await api.post(`/rooms/${roomId}/events/${id}/checkin`, {});
            await load();
        } catch (err) {
            // The server's message is the useful one here ("Check-in closed when
            // round 1 started. Ask an admin to add you.") — surface it verbatim.
            setError((err as Error)?.message || 'Could not check you in.');
        } finally {
            setCheckingIn(false);
        }
    };

    const backLink = (
        <Link
            to={`/${roomSlug}`}
            className="inline-flex items-center gap-1 text-sm text-muted hover:text-neon-cyan transition-colors no-underline"
        >
            <ChevronLeft size={16} />
            Scoreboard
        </Link>
    );

    if (loading) {
        return (
            <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
                {backLink}
                <div className="flex justify-center py-12">
                    <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
                </div>
            </main>
        );
    }

    if (notFound || !data) {
        return (
            <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
                {backLink}
                <p className="text-muted text-center py-12">Event not found.</p>
            </main>
        );
    }

    const { event, checkin, rounds, standings, viewer } = data;
    const chip = STATE_CHIP[event.state];
    const totalRounds = rounds.length;

    return (
        <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6">
            {backLink}

            <header className="mt-3 mb-6">
                <div className="flex items-center gap-2 flex-wrap">
                    <h1 className="font-display text-xl sm:text-2xl font-bold text-primary min-w-0 break-words">
                        {event.name}
                    </h1>
                    <span className={`text-xs px-2 py-0.5 rounded border font-display tracking-wider ${chip.className}`}>
                        {chip.label}
                    </span>
                    <ShareButton
                        title={event.name}
                        text={`${event.name} on Arcaid`}
                        path={`/${roomSlug}/events/${event.id}`}
                        className="ml-auto"
                        showLabel={false}
                    />
                </div>

                {liveRound && countdown && (
                    <p className="text-sm text-muted mt-2">
                        {liveRound.status === 'ACTIVE'
                            ? <>Round {liveRound.roundNo} of {totalRounds} on <span className="text-primary">{liveRound.gameName}</span> — <span className="text-neon-magenta font-mono">{countdown}</span> left</>
                            : <>Round {liveRound.roundNo} of {totalRounds} on <span className="text-primary">{liveRound.gameName}</span> starts in <span className="text-neon-cyan font-mono">{countdown}</span></>}
                    </p>
                )}
                {event.state === 'finished' && (
                    <p className="text-sm text-muted mt-2">
                        Final standings — ranked by {event.aggregateMethod === 'best' ? 'best single round'
                            : event.aggregateMethod === 'sum' ? 'total across all rounds' : 'average across all rounds'}.
                    </p>
                )}
            </header>

            {/* Check-in */}
            {checkin.required && event.state !== 'finished' && event.state !== 'cancelled' && (
                <section className="mb-6 p-4 rounded border border-border bg-surface">
                    <div className="flex items-center gap-3 flex-wrap">
                        <div className="min-w-0">
                            {/* The headline must agree with the action beside
                                it: telling someone to "check in to play" next
                                to "check-in has closed" is the kind of
                                contradiction that makes a page feel broken. */}
                            <p className="text-sm text-primary">
                                {checkin.viewerCheckedIn
                                    ? "You're checked in."
                                    : viewer.reason === 'CHECKIN_CLOSED'
                                        ? 'Check-in for this event is closed.'
                                        : 'Check in to play — only checked-in players count.'}
                            </p>
                            <p className="text-xs text-faint mt-0.5">
                                {checkin.count} checked in
                                {checkin.closesAt && viewer.reason !== 'CHECKIN_CLOSED' && ' · closes when round 1 starts'}
                            </p>
                        </div>
                        <div className="ml-auto">
                            {viewer.canCheckIn && (
                                <button
                                    type="button" onClick={checkIn} disabled={checkingIn}
                                    className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors disabled:opacity-50"
                                >{checkingIn ? 'Checking in…' : 'Check in'}</button>
                            )}
                            {!discordUser && viewer.reason === 'LOGIN_REQUIRED' && (
                                <button
                                    type="button" onClick={() => loginWithDiscord(roomSlug ?? '', `/${roomSlug}/events/${event.id}`)}
                                    className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors"
                                >Log in to check in</button>
                            )}
                            {viewer.reason === 'CHECKIN_CLOSED' && !checkin.viewerCheckedIn && (
                                <span className="text-xs text-neon-amber">Check-in has closed — ask an admin to add you.</span>
                            )}
                        </div>
                    </div>
                    {error && <p className="text-xs text-neon-magenta mt-2">{error}</p>}
                </section>
            )}

            {/* Standings */}
            {standings && standings.standings.length > 0 && (
                <section className="mb-6">
                    <h2 className="font-display text-sm font-bold uppercase tracking-wider text-muted mb-2">Standings</h2>
                    <div className="overflow-x-auto rounded border border-border">
                        <table className="w-full text-sm">
                            <thead>
                                <tr className="text-xs uppercase tracking-wider text-muted border-b border-border">
                                    <th className="text-left py-2 px-3 font-display">#</th>
                                    <th className="text-left py-2 px-3 font-display">Player</th>
                                    {standings.roundNumbers.map(n => (
                                        <th key={n} className="text-right py-2 px-3 font-display whitespace-nowrap">R{n}</th>
                                    ))}
                                    <th className="text-right py-2 px-3 font-display">
                                        {standings.aggregateMethod === 'sum' ? 'Total'
                                            : standings.aggregateMethod === 'average' ? 'Average' : 'Best'}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {standings.standings.map(row => (
                                    <tr key={row.identity_key} className="border-b border-border/50 last:border-0">
                                        <td className="py-2 px-3 text-muted font-mono">{row.rank}</td>
                                        <td className="py-2 px-3 text-primary truncate max-w-[10rem]">
                                            {name(row)}
                                            {row.flagged && <span className="ml-1 text-neon-amber" title="One or more scores arrived unusually fast">⚡</span>}
                                        </td>
                                        {row.roundScores.map((s, i) => (
                                            <td key={i} className="py-2 px-3 text-right font-mono text-muted">
                                                {s == null ? '—' : <span title={scoreTitle(s)}>{formatScore(s)}</span>}
                                            </td>
                                        ))}
                                        <td className="py-2 px-3 text-right font-mono text-primary" title={scoreTitle(Math.round(row.total))}>
                                            {formatScore(Math.round(row.total))}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    {standings.incomplete.length > 0 && (
                        <div className="mt-2 text-xs text-faint">
                            <p className="mb-1">
                                Not ranked — an average needs a score in every round:
                            </p>
                            <p className="text-muted">
                                {standings.incomplete.map(r => `${name(r)} (${r.roundsPlayed}/${standings.roundNumbers.length})`).join(' · ')}
                            </p>
                        </div>
                    )}
                </section>
            )}

            {/* Per-round boards */}
            <section className="space-y-4">
                {rounds.map(round => (
                    <div key={round.gameId} className="rounded border border-border overflow-hidden">
                        <div className="flex items-center gap-2 px-3 py-2 bg-surface border-b border-border flex-wrap">
                            <span className="text-xs font-display uppercase tracking-wider text-muted">Round {round.roundNo}</span>
                            <span className="text-sm text-primary">{round.gameName}</span>
                            <span className={`text-xs px-2 py-0.5 rounded border ${
                                round.status === 'ACTIVE' ? 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/40'
                                    : round.status === 'SCHEDULED' ? 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/40'
                                        : 'bg-border/30 text-muted border-border'
                            }`}>
                                {round.status === 'ACTIVE' ? 'Live' : round.status === 'SCHEDULED' ? 'Not started' : 'Finished'}
                            </span>
                        </div>
                        {round.scores.length === 0 ? (
                            <p className="text-sm text-faint px-3 py-4">
                                {round.status === 'SCHEDULED' ? 'This round has not started yet.' : 'No scores in this round.'}
                            </p>
                        ) : (
                            <table className="w-full text-sm">
                                <tbody>
                                    {round.scores.map(row => (
                                        <tr
                                            key={row.identity_key}
                                            /* A score from someone who never checked in stays visible — it
                                               happened — but is greyed so it reads as out of competition. */
                                            className={`border-b border-border/50 last:border-0 ${row.participant ? '' : 'opacity-45'}`}
                                        >
                                            <td className="py-2 px-3 text-muted font-mono w-8">{row.rank}</td>
                                            <td className="py-2 px-3 text-primary truncate">
                                                {name(row)}
                                                {!row.participant && <span className="ml-1 text-xs text-faint">(not checked in)</span>}
                                            </td>
                                            <td className="py-2 px-3 text-right font-mono text-faint whitespace-nowrap w-24">
                                                {elapsed(row.elapsed_sec)}
                                                {row.flagged && (
                                                    <span className="ml-1 text-neon-amber" title="Posted unusually soon after the round opened">⚡</span>
                                                )}
                                            </td>
                                            <td className="py-2 px-3 text-right font-mono text-primary w-28" title={scoreTitle(row.score)}>
                                                {formatScore(row.score)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        )}
                    </div>
                ))}
            </section>
        </main>
    );
}
