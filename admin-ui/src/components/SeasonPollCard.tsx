import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Check, ExternalLink, Vote } from 'lucide-react';
import { useViewerAuth, usePlayerHeaders } from '../contexts/ViewerAuthContext';
import LoginButtons from './LoginButtons';
import { applyVote, closesInLabel, type SeasonOpenPoll, type SeasonSummary } from '../lib/seasonPoll';

/**
 * Season table poll on the room's public LOBBY (Season format, plan §8.3).
 *
 * A Season is a rotation tournament whose next table is chosen by a community
 * poll. Arcaid posts the poll to Discord and mirrors it here so a player who
 * never opens Discord can still vote. This card is a NOTICE at the top of the
 * Lobby, not a hero: one bordered block, single column, quiet colours.
 *
 * Mount points (owner ruling 2026-10-18, first Seasons demo — "it belongs in
 * the Lobby"; on the Scores page it pushed the card rail down):
 *   - `SeasonPollCards` (default export) — the voting card, on `pages/Lobby.tsx`.
 *   - `SeasonPollLobbyNudge` — a one-line "Vote in the Lobby →" pointer on
 *     `pages/Scoreboard.tsx`, so the poll is still discoverable from Scores.
 *   Both share `fetchOpenSeasonPolls`, so they cannot disagree about whether a
 *   poll is open.
 *
 * Data flow:
 *   - `GET /tournaments` decides whether to render at all (`season.open_poll_id`).
 *     One open poll per room is the normal case; several render stacked.
 *   - `GET /tournaments/:id/season` gives candidates + tally + `my_vote`
 *     (the player token is sent so `my_vote` fills).
 *   - Vote = POST `{position}`, withdraw = DELETE. Tapping a different row
 *     re-votes; tapping the chosen row withdraws. Optimistic, rolled back on error.
 *   - The PAGE owns liveness: `refreshKey` is bumped by the mounting page's
 *     `season:poll` socket handler (on `room:<id>`) and by its `useLiveRefresh`
 *     callback, so there is no second socket subscription or refresh hook in here.
 *
 * Raw `fetch` with the player token (not `lib/api`), same as every other
 * public-page call: `api.*` carries the admin token and bounces a 401 to the
 * admin login, which is wrong for a player on a public page.
 */

interface TournamentListRow {
    id: string;
    season?: { open_poll_id: string | null } | null;
}

interface CardProps {
    summary: SeasonSummary & { open_poll: SeasonOpenPoll };
    now: number;
    loggedIn: boolean;
    busy: boolean;
    error: string | null;
    showLogin: boolean;
    onTap: (position: number) => void;
    onLoginDiscord: () => void;
    onLoginGoogle: () => void;
}

export function SeasonPollCard({ summary, now, loggedIn, busy, error, showLogin, onTap, onLoginDiscord, onLoginGoogle }: CardProps) {
    const poll = summary.open_poll;
    const maxVotes = poll.candidates.reduce((m, c) => Math.max(m, c.votes), 0);
    const closes = closesInLabel(poll.closes_at, now);
    const hasVote = poll.my_vote !== null;

    return (
        <section
            aria-label={`${summary.name} table poll`}
            className="rounded-lg border border-border/60 bg-surface p-3 sm:p-4"
        >
            <div className="flex items-start gap-2 mb-3">
                <Vote size={16} className="text-neon-cyan mt-0.5 flex-shrink-0" aria-hidden />
                <div className="min-w-0 flex-1">
                    <p className="text-xs text-muted break-words">{summary.name}</p>
                    <h2 className="text-sm font-semibold text-primary break-words">{poll.question}</h2>
                </div>
            </div>

            <ul className="space-y-1.5" role="list">
                {poll.candidates.map(c => {
                    const mine = poll.my_vote === c.position;
                    const pct = poll.total_votes > 0 ? (c.votes / poll.total_votes) * 100 : 0;
                    const leading = maxVotes > 0 && c.votes === maxVotes;
                    return (
                        <li key={c.position}>
                            <button
                                type="button"
                                onClick={() => onTap(c.position)}
                                disabled={busy}
                                aria-pressed={mine}
                                aria-label={`${c.game_name}, ${c.votes} vote${c.votes === 1 ? '' : 's'}${mine ? ', your vote — tap to withdraw' : ''}`}
                                className={`relative w-full min-h-11 text-left rounded border px-3 py-2 overflow-hidden transition-colors cursor-pointer disabled:cursor-wait ${
                                    mine
                                        ? 'border-neon-cyan/60 bg-neon-cyan/10'
                                        : 'border-border/50 bg-raised hover:border-neon-cyan/40'
                                }`}
                            >
                                {/* Proportional bar behind the row text. */}
                                <span
                                    aria-hidden
                                    className={`absolute inset-y-0 left-0 ${mine ? 'bg-neon-cyan/15' : 'bg-primary/5'}`}
                                    style={{ width: `${pct}%` }}
                                    data-testid={`season-poll-bar-${c.position}`}
                                />
                                <span className="relative flex items-start gap-2">
                                    <span className="w-4 flex-shrink-0 pt-0.5">
                                        {mine && <Check size={14} className="text-neon-cyan" aria-hidden />}
                                    </span>
                                    <span className={`flex-1 min-w-0 text-sm break-words ${mine ? 'text-neon-cyan font-medium' : leading ? 'text-primary font-medium' : 'text-primary'}`}>
                                        {c.game_name}
                                    </span>
                                    <span className="flex-shrink-0 text-xs text-muted tabular-nums pt-0.5">
                                        {c.votes}
                                    </span>
                                </span>
                            </button>
                        </li>
                    );
                })}
            </ul>

            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                <span>{poll.total_votes} vote{poll.total_votes === 1 ? '' : 's'}</span>
                {closes && <span>{closes}</span>}
                {hasVote && <span className="text-faint">Change vote: tap another table · tap yours to withdraw</span>}
                {poll.discord_url && (
                    <a
                        href={poll.discord_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ml-auto inline-flex items-center gap-1 min-h-11 text-neon-cyan hover:underline"
                    >
                        Vote on Discord instead <ExternalLink size={12} aria-hidden />
                    </a>
                )}
            </div>

            {error && <p className="mt-2 text-xs text-neon-magenta" role="alert">{error}</p>}

            {showLogin && !loggedIn && (
                <div className="mt-3 pt-3 border-t border-border/40">
                    <p className="text-xs text-muted mb-2">Log in to vote. Your vote ties to your account.</p>
                    <LoginButtons
                        onDiscordLogin={onLoginDiscord}
                        onGoogleLogin={onLoginGoogle}
                        label="Log in"
                        vertical
                        buttonClassName="min-h-11"
                    />
                </div>
            )}
        </section>
    );
}

type OpenSummary = SeasonSummary & { open_poll: SeasonOpenPoll };

const MINUTE_MS = 60_000;

/**
 * Open-poll discovery shared by the card container and the Scores-page nudge.
 * Returns null when the tournament list itself could not be read (callers keep
 * whatever they had); a failed per-season fetch just drops that season.
 */
async function fetchOpenSeasonPolls(roomId: string, headers: Record<string, string>): Promise<OpenSummary[] | null> {
    try {
        const res = await fetch(`/api/rooms/${roomId}/tournaments`, { headers });
        if (!res.ok) return null;
        const rows = (await res.json()) as TournamentListRow[];
        const ids = (Array.isArray(rows) ? rows : []).filter(t => t.season?.open_poll_id).map(t => t.id);
        const found = await Promise.all(ids.map(async id => {
            try {
                const r = await fetch(`/api/rooms/${roomId}/tournaments/${id}/season`, { headers });
                if (!r.ok) return null;
                const s = (await r.json()) as SeasonSummary;
                return s.open_poll ? (s as OpenSummary) : null;
            } catch {
                return null;
            }
        }));
        return found.filter((s): s is OpenSummary => s !== null);
    } catch {
        // Decoration, never a dependency.
        return null;
    }
}

/** "Week 6 table poll is open" for a Season (progress present), else generic. */
function nudgeLabel(summaries: OpenSummary[]): string {
    if (summaries.length > 1) return `${summaries.length} table polls are open`;
    const s = summaries[0];
    const isSeason = s.progress !== null && s.progress !== undefined;
    return isSeason && s.open_poll.slot_no ? `Week ${s.open_poll.slot_no} table poll is open` : 'Table poll is open';
}

/**
 * One slim line on the Scores page pointing at the Lobby, where the voting
 * card lives (owner ruling 2026-10-18). Renders nothing without an open poll.
 * Liveness is the page's, exactly as for the card: bump `refreshKey`.
 */
export function SeasonPollLobbyNudge({ roomId, roomSlug, refreshKey = 0 }: { roomId: string; roomSlug: string; refreshKey?: number }) {
    const { playerToken } = useViewerAuth();
    const playerHeaders = usePlayerHeaders();
    const headersRef = useRef(playerHeaders);
    useEffect(() => { headersRef.current = playerHeaders; });
    const [summaries, setSummaries] = useState<OpenSummary[]>([]);

    useEffect(() => {
        if (!roomId) return;
        let cancelled = false;
        fetchOpenSeasonPolls(roomId, headersRef.current).then(found => {
            if (!cancelled && found) setSummaries(found);
        });
        return () => { cancelled = true; };
    }, [roomId, refreshKey, playerToken]);

    if (summaries.length === 0 || !roomSlug) return null;
    return (
        <div
            className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border border-border/60 bg-surface px-3 py-1.5 text-xs text-muted"
            data-testid="season-poll-lobby-nudge"
        >
            <Vote size={14} className="text-neon-cyan flex-shrink-0" aria-hidden />
            <span className="break-words">{nudgeLabel(summaries)}</span>
            <Link to={`/${roomSlug}/lobby`} className="ml-auto inline-flex items-center min-h-11 sm:min-h-0 text-neon-cyan hover:underline">
                Vote in the Lobby →
            </Link>
        </div>
    );
}

/**
 * Container: finds every season with an open poll in the room and renders one
 * card per poll. Renders nothing when there is none (or when a fetch fails —
 * a public page never breaks over a missing notice).
 */
export default function SeasonPollCards({ roomId, roomSlug, refreshKey = 0 }: { roomId: string; roomSlug: string; refreshKey?: number }) {
    const { playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
    const playerHeaders = usePlayerHeaders();
    const location = useLocation();
    const [summaries, setSummaries] = useState<OpenSummary[]>([]);
    const [now, setNow] = useState(() => Date.now());
    const [busy, setBusy] = useState<string | null>(null);
    const [errors, setErrors] = useState<Record<string, string>>({});
    const [loginFor, setLoginFor] = useState<string | null>(null);
    // Latest headers without making the load effect depend on a fresh object
    // every render (usePlayerHeaders returns a new object each call).
    const headersRef = useRef(playerHeaders);
    useEffect(() => { headersRef.current = playerHeaders; });

    const load = useCallback(async (signal: { cancelled: boolean }) => {
        if (!roomId) return;
        const found = await fetchOpenSeasonPolls(roomId, headersRef.current);
        if (found && !signal.cancelled) setSummaries(found);
    }, [roomId]);

    useEffect(() => {
        const signal = { cancelled: false };
        load(signal);
        return () => { signal.cancelled = true; };
    }, [load, refreshKey, playerToken]);

    // Re-render the countdown each minute; only while something is showing.
    useEffect(() => {
        if (summaries.length === 0) return;
        const id = setInterval(() => setNow(Date.now()), MINUTE_MS);
        return () => clearInterval(id);
    }, [summaries.length]);

    const replacePoll = (tournamentId: string, poll: SeasonOpenPoll) =>
        setSummaries(list => list.map(s => (s.tournament_id === tournamentId ? { ...s, open_poll: poll } : s)));

    const tap = async (summary: OpenSummary, position: number) => {
        if (!playerToken) {
            setLoginFor(summary.tournament_id);
            return;
        }
        if (busy) return;
        const before = summary.open_poll;
        const next = before.my_vote === position ? null : position;
        const tid = summary.tournament_id;
        replacePoll(tid, applyVote(before, next));
        setErrors(e => { const copy = { ...e }; delete copy[tid]; return copy; });
        setBusy(tid);
        try {
            const url = `/api/rooms/${roomId}/season-polls/${before.id}/vote`;
            const res = next === null
                ? await fetch(url, { method: 'DELETE', headers: headersRef.current })
                : await fetch(url, {
                    method: 'POST',
                    headers: { ...headersRef.current, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ position: next }),
                });
            if (!res.ok) {
                let body: { error?: string; code?: string } = {};
                try { body = await res.json(); } catch { /* non-JSON */ }
                const msg = body.code === 'POLL_NOT_OPEN'
                    ? 'This poll has closed.'
                    : res.status === 401
                        ? 'Your login expired. Log in again to vote.'
                        : body.error || 'Could not save your vote. Try again.';
                throw new Error(msg);
            }
        } catch (err) {
            replacePoll(tid, before);
            setErrors(e => ({ ...e, [tid]: err instanceof Error ? err.message : 'Could not save your vote. Try again.' }));
            // A closed poll should disappear rather than sit there refusing taps.
            const signal = { cancelled: false };
            load(signal);
        } finally {
            setBusy(null);
        }
    };

    if (summaries.length === 0) return null;

    const returnPath = location.pathname + location.search;
    return (
        <div className="space-y-2 mb-4">
            {summaries.map(s => (
                <SeasonPollCard
                    key={s.open_poll.id}
                    summary={s}
                    now={now}
                    loggedIn={!!playerToken}
                    busy={busy === s.tournament_id}
                    error={errors[s.tournament_id] ?? null}
                    showLogin={loginFor === s.tournament_id}
                    onTap={position => tap(s, position)}
                    onLoginDiscord={() => roomSlug && loginWithDiscord(roomSlug, returnPath)}
                    onLoginGoogle={() => roomSlug && loginWithGoogle(roomSlug, returnPath)}
                />
            ))}
        </div>
    );
}
