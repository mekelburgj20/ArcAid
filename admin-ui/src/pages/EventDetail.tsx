import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';
import ShareButton from '../components/ShareButton';
import { useOptionalRoom } from '../contexts/RoomContext';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { ApiError } from '../lib/api';
import { playerApi } from '../lib/playerApi';

/**
 * `/:slug/events/:id` — the public face of a Live Event (v2.135.0, ADR 0017).
 *
 * This is the page a player lands on from a shared link, a scoreboard card, or
 * a Discord announcement, and it answers the three questions they have, in
 * order: *is it on yet*, *am I in*, and *where do I stand*.
 *
 * It renders BOTH shapes of event (v2.136.0, ADR 0018):
 *
 *   - a **hosted Tournament Event** at `/:slug/events/:id`, inside a room; and
 *   - a **Throwdown** at `/throwdown/:code`, which has no room at all.
 *
 * That is why the room context is read optionally and every room-specific
 * affordance is conditional. Keeping one component was the point of making a
 * Throwdown the same object as an event — a second copy of the boards, the
 * standings and the countdown would drift within a release.
 */

/**
 * The Arcaid Witness verdict for one AtGames-sourced score (v2.145.0, P8).
 * Optional throughout: absent on every non-AtGames row, and on any board
 * rendered from a result frozen before v2.145.0.
 */
interface WitnessVerdict {
    status: 'verified' | 'flagged' | 'unwitnessed';
    launchTs: number | null;
    exitTs: number | null;
    durationSec: number | null;
    table: string | null;
}

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
    witness?: WitnessVerdict | null;
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
    /** Resolved submitter id — used to tell the winner from everyone else. */
    discord_user_id: string;
    iscored_username: string;
    display_name: string | null;
    roundScores: Array<number | null>;
    total: number;
    roundsPlayed: number;
    flagged: boolean;
    /** Any counted round score whose table was launched before the round opened. */
    witnessFlagged?: boolean;
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
        /** Throwdowns only: the viewer may post a score right now. */
        canSubmit?: boolean;
    };
}

interface EventDetailProps {
    /**
     * Present = render as a Throwdown, reading `/api/throwdowns/:code` instead
     * of the room-scoped event endpoint. Absent = hosted event in a room.
     */
    throwdownCode?: string;
}

const name = (r: { display_name: string | null; iscored_username: string }) =>
    r.display_name || r.iscored_username;

/** `+MM:SS` since the round opened — the number that makes a fast score visible. */
function elapsed(sec: number | null): string {
    if (sec == null) return '';
    const clamped = Math.max(0, sec);
    return `+${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** `4m 12s` / `47s` — how long the witness saw the table open. */
function playDuration(sec: number): string {
    const clamped = Math.max(0, Math.floor(sec));
    const m = Math.floor(clamped / 60);
    return m > 0 ? `${m}m ${clamped % 60}s` : `${clamped}s`;
}

/**
 * The Arcaid Witness badge for one score (v2.145.0, P8).
 *
 * A BADGE, never a gate — nothing here changes a rank. `unwitnessed` is the
 * neutral default (most players have no paired cabinet), so it renders as quiet
 * grey text and never as a warning.
 */
function WitnessBadge({ witness }: { witness?: WitnessVerdict | null }) {
    if (!witness) return null;
    if (witness.status === 'verified') {
        const played = witness.durationSec != null ? ` · ${playDuration(witness.durationSec)} of play` : '';
        return (
            <span
                className="ml-1 text-neon-green"
                title={`Witnessed: launched inside the round window${played}`}
            >✓</span>
        );
    }
    if (witness.status === 'flagged') {
        return (
            <span
                className="ml-1 text-neon-amber"
                title="Witness: this table was launched before the round opened"
            >⚠</span>
        );
    }
    return (
        <span
            className="ml-1 text-faint text-xs"
            title="No cabinet witness for this score — most players have no paired cabinet"
        >unwitnessed</span>
    );
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

export default function EventDetail({ throwdownCode }: EventDetailProps = {}) {
    // A Throwdown has no room, so this must not be the throwing `useRoom()`.
    const room = useOptionalRoom();
    const roomSlug = room?.roomSlug;
    const roomId = room?.roomId;
    const { id } = useParams<{ id: string }>();
    // PLAYER client throughout: `api.*` is the admin one, and its 401 handler
    // navigates to /superadmin — nonsense for a player, and the cause of the
    // 2026-08-25 incident. See lib/playerApi.ts.
    const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
    const isThrowdown = !!throwdownCode;
    const navigate = useNavigate();
    const [scoreDraft, setScoreDraft] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [nextGame, setNextGame] = useState('');
    const [starting, setStarting] = useState(false);
    const [notice, setNotice] = useState('');
    const [data, setData] = useState<EventPayload | null>(null);
    const [loading, setLoading] = useState(true);
    const [notFound, setNotFound] = useState(false);
    const [checkingIn, setCheckingIn] = useState(false);
    const [error, setError] = useState('');
    const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

    const load = useCallback(async () => {
        const path = throwdownCode
            ? `/throwdowns/${encodeURIComponent(throwdownCode)}`
            : (roomId && id ? `/rooms/${roomId}/events/${id}` : null);
        if (!path) return;
        try {
            // Readable signed-out — the token is passed when present so the
            // viewer's own check-in state comes back.
            setData(await playerApi.get<EventPayload>(path, { token: playerToken }));
        } catch {
            setNotFound(true);
        } finally {
            setLoading(false);
        }
    }, [roomId, id, throwdownCode, playerToken]);

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
            await playerApi.post(`/rooms/${roomId}/events/${id}/checkin`, {}, { token: playerToken });
            await load();
        } catch (err) {
            // The server's message is the useful one here ("Check-in closed when
            // round 1 started. Ask an admin to add you.") — surface it verbatim.
            setError((err as Error)?.message || 'Could not check you in.');
        } finally {
            setCheckingIn(false);
        }
    };

    /** Post a score straight into a Throwdown — there is no room submit sheet. */
    const submitScore = async () => {
        const value = Number(scoreDraft.replace(/[^0-9]/g, ''));
        if (!throwdownCode || !Number.isFinite(value) || value <= 0) return;
        setSubmitting(true);
        setError('');
        try {
            await playerApi.post(`/throwdowns/${encodeURIComponent(throwdownCode)}/scores`, { score: value }, { token: playerToken });
            setScoreDraft('');
            await load();
        } catch (err) {
            setError((err as Error)?.message || 'Could not submit that score.');
        } finally {
            setSubmitting(false);
        }
    };

    /**
     * Start the follow-up Throwdown.
     *
     * `rematchOf` makes it FIRST-CLICK-WINS server-side: if someone already
     * started the rematch, the API answers 409 with THEIR code, and the right
     * behaviour is to send this player to that one rather than show an error —
     * two rematches of the same challenge would split the field in half.
     */
    const startFollowUp = async (gameName: string) => {
        if (!data || !gameName.trim()) return;
        setStarting(true);
        setError('');
        setNotice('');
        try {
            const res = await playerApi.post<{ code: string }>('/throwdowns', {
                gameName: gameName.trim(),
                durationMinutes: 60,
                rematchOf: data.event.id,
            }, { token: playerToken });
            navigate(`/throwdown/${res.code}`);
        } catch (err) {
            const body = err instanceof ApiError ? err.body as { code?: string; existingCode?: string } : null;
            if (body?.code === 'REMATCH_EXISTS' && body.existingCode) {
                setNotice('Someone already started the rematch — taking you there.');
                navigate(`/throwdown/${body.existingCode}`);
                return;
            }
            setError((err as Error)?.message || 'Could not start that.');
        } finally {
            setStarting(false);
        }
    };

    // Throwdown mode renders with no surrounding layout, so this page's own
    // top edge must clear the status-bar/notch safe area (viewport-fit=cover).
    // Under PublicLayout (/:slug/events/:id) the layout's nav already does.
    const mainStyle = isThrowdown
        ? { paddingTop: 'max(1.5rem, env(safe-area-inset-top))' }
        : undefined;

    const backLink = (
        <Link
            to={roomSlug ? `/${roomSlug}` : '/scoreboard'}
            className="inline-flex items-center gap-1 text-sm text-muted hover:text-neon-cyan transition-colors no-underline"
        >
            <ChevronLeft size={16} />
            {roomSlug ? 'Scoreboard' : 'Arcaid'}
        </Link>
    );

    if (loading) {
        return (
            <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6" style={mainStyle}>
                {backLink}
                <div className="flex justify-center py-12">
                    <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin" />
                </div>
            </main>
        );
    }

    if (notFound || !data) {
        return (
            <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6" style={mainStyle}>
                {backLink}
                <p className="text-muted text-center py-12">
                    {isThrowdown
                        ? 'That Throwdown link is not valid — it may have been mistyped.'
                        : 'Event not found.'}
                </p>
            </main>
        );
    }

    const { event, checkin, rounds, standings, viewer } = data;
    const chip = STATE_CHIP[event.state];
    const totalRounds = rounds.length;

    return (
        <main className="max-w-4xl mx-auto px-4 sm:px-6 py-6" style={mainStyle}>
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
                        text={isThrowdown
                            ? `Beat me on ${event.name} — Arcaid Throwdown`
                            : `${event.name} on Arcaid`}
                        path={isThrowdown ? `/throwdown/${throwdownCode}` : `/${roomSlug}/events/${event.id}`}
                        className="ml-auto"
                        showLabel={false}
                    />
                </div>

                {liveRound && countdown && (
                    <p className="text-sm text-muted mt-2">
                        {/* A single-round event (every Throwdown) needs no round
                            number, and its title is already the game — saying
                            "Round 1 of 1 on Medieval Madness" under a heading
                            reading "Medieval Madness" is pure noise. */}
                        {totalRounds > 1 && (
                            <>Round {liveRound.roundNo} of {totalRounds} on <span className="text-primary">{liveRound.gameName}</span>{' '}</>
                        )}
                        {liveRound.status === 'ACTIVE'
                            ? <>{totalRounds > 1 ? '— ' : ''}<span className="text-neon-magenta font-mono">{countdown}</span> left</>
                            : <>{totalRounds > 1 ? 'starts in ' : 'Starts in '}<span className="text-neon-cyan font-mono">{countdown}</span></>}
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
                                <span className="flex gap-2 flex-wrap">
                                    <button
                                        type="button" onClick={() => loginWithDiscord(roomSlug ?? '', `/${roomSlug}/events/${event.id}`)}
                                        className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors"
                                    >Log in with Discord</button>
                                    <button
                                        type="button" onClick={() => loginWithGoogle(roomSlug ?? '', `/${roomSlug}/events/${event.id}`)}
                                        className="px-4 py-2 rounded border border-border bg-raised text-primary text-sm hover:border-neon-cyan transition-colors"
                                    >Log in with Google</button>
                                </span>
                            )}
                            {viewer.reason === 'CHECKIN_CLOSED' && !checkin.viewerCheckedIn && (
                                <span className="text-xs text-neon-amber">Check-in has closed — ask an admin to add you.</span>
                            )}
                        </div>
                    </div>
                    {error && <p className="text-xs text-neon-magenta mt-2">{error}</p>}
                </section>
            )}

            {/* Throwdown scoring. A hosted event uses the room's submission sheet
                (photo rules, platform pickers, iScored sync); a Throwdown has
                none of that machinery, so posting a score is one field. */}
            {isThrowdown && event.state !== 'finished' && (
                <section className="mb-6 p-4 rounded border border-border bg-surface">
                    {data.viewer.canSubmit ? (
                        <div className="flex items-end gap-3 flex-wrap">
                            <div className="flex-1 min-w-[10rem]">
                                <label className="block text-xs font-display uppercase tracking-wider text-muted mb-1.5">
                                    Your score
                                </label>
                                <input
                                    type="text" inputMode="numeric" value={scoreDraft}
                                    onChange={e => setScoreDraft(e.target.value)}
                                    onKeyDown={e => { if (e.key === 'Enter') void submitScore(); }}
                                    placeholder="e.g. 184220450"
                                    className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm font-mono focus:outline-none focus:border-neon-cyan transition-colors"
                                />
                            </div>
                            <button
                                type="button" onClick={submitScore}
                                disabled={submitting || !scoreDraft.trim()}
                                className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors disabled:opacity-50"
                            >{submitting ? 'Posting…' : 'Post score'}</button>
                        </div>
                    ) : (
                        <div className="flex items-center gap-3 flex-wrap">
                            <p className="text-sm text-primary">Log in to post a score.</p>
                            <span className="ml-auto flex gap-2 flex-wrap">
                                <button
                                    type="button"
                                    onClick={() => loginWithDiscord('__global__', `/throwdown/${throwdownCode}`)}
                                    className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors"
                                >Log in with Discord</button>
                                <button
                                    type="button"
                                    onClick={() => loginWithGoogle('__global__', `/throwdown/${throwdownCode}`)}
                                    className="px-4 py-2 rounded border border-border bg-raised text-primary text-sm hover:border-neon-cyan transition-colors"
                                >Log in with Google</button>
                            </span>
                        </div>
                    )}
                    {error && <p className="text-xs text-neon-magenta mt-2">{error}</p>}
                </section>
            )}

            {/* What happens next, once a Throwdown is over. The winner picks a
                NEW game (that is the point of a challenge back); everyone else
                gets a one-click rematch on the same one. */}
            {isThrowdown && event.state === 'finished' && discordUser && (() => {
                const champion = standings?.standings[0];
                const viewerWon = !!champion && champion.discord_user_id === discordUser.discordId;
                const played = standings?.standings.some(r => r.discord_user_id === discordUser.discordId);
                if (!played) return null;
                return (
                    <section className="mb-6 p-4 rounded border border-border bg-surface">
                        {viewerWon ? (
                            <div className="flex items-end gap-3 flex-wrap">
                                <div className="flex-1 min-w-[10rem]">
                                    <p className="text-sm text-primary mb-1.5">You won. Challenge them back —</p>
                                    <input
                                        type="text" value={nextGame}
                                        onChange={e => setNextGame(e.target.value)}
                                        onKeyDown={e => { if (e.key === 'Enter') void startFollowUp(nextGame); }}
                                        placeholder="pick a different game"
                                        className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                                    />
                                </div>
                                <button
                                    type="button" onClick={() => startFollowUp(nextGame)}
                                    disabled={starting || !nextGame.trim()}
                                    className="px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors disabled:opacity-50"
                                >{starting ? 'Starting…' : 'Challenge back'}</button>
                            </div>
                        ) : (
                            <div className="flex items-center gap-3 flex-wrap">
                                <p className="text-sm text-primary">
                                    {champion ? `${name(champion)} took it.` : 'That one is over.'} Want another go?
                                </p>
                                <button
                                    type="button" onClick={() => startFollowUp(event.name)}
                                    disabled={starting}
                                    className="ml-auto px-4 py-2 rounded border border-neon-cyan bg-neon-cyan/15 text-neon-cyan text-sm hover:bg-neon-cyan/25 transition-colors disabled:opacity-50"
                                >{starting ? 'Starting…' : 'Rematch'}</button>
                            </div>
                        )}
                        {notice && <p className="text-xs text-neon-cyan mt-2">{notice}</p>}
                        {error && <p className="text-xs text-neon-magenta mt-2">{error}</p>}
                    </section>
                );
            })()}

            {/* Standings */}
            {/* With one round the standings ARE the round board — same players,
                same order, same numbers in two tables. Only show them once a
                second round makes the aggregate say something new. */}
            {standings && standings.standings.length > 0 && standings.roundNumbers.length > 1 && (
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
                                            {row.witnessFlagged && <span className="ml-1 text-neon-amber" title="A cabinet witness saw a table launched before its round opened">⚠</span>}
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
                            /* The witness badge adds a variable-width column on
                               a table that already fills a phone — scroll it
                               inside its own box rather than pushing the page. */
                            <div className="overflow-x-auto">
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
                                                <WitnessBadge witness={row.witness} />
                                            </td>
                                            <td className="py-2 px-3 text-right font-mono text-primary w-28" title={scoreTitle(row.score)}>
                                                {formatScore(row.score)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            </div>
                        )}
                    </div>
                ))}
            </section>
        </main>
    );
}
