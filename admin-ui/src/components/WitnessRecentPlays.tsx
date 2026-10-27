import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Globe, AlertTriangle, XCircle, Trash2, RefreshCw } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';

/**
 * W27.2 (ADR 0033 §5) — "Where your plays went", under the player's paired
 * Witness devices on Account Settings.
 *
 * One row per play the player's devices reported: the table, the score, when,
 * and every place it went (counted in a tournament, the Global Scoreboard) or
 * why it did not count. The server reads the evidence trail (W29: every
 * outcome leaves a row; W27.1: a miss names the step), so a play that landed
 * nowhere is listed too — this is the answer to "I played and my score isn't
 * there".
 */

export type PlayDestination = {
    status: 'counted' | 'already_counted' | 'global' | 'already_global' | 'not_counted' | 'deleted' | 'not_recorded';
    tournamentName: string | null;
    roundNo: number | null;
    roomName: string | null;
    roomSlug: string | null;
    gameName: string | null;
    globalGameId: string | null;
    reason: string | null;
};

export type RecentPlay = {
    key: string;
    playedAt: string;
    tableName: string;
    score: number;
    deviceId: string;
    destinations: PlayDestination[];
};

const SHOWN = 8;

/** `2026-10-26 23:17:13` (SQLite UTC) → the viewer's local date and time. */
function whenText(playedAt: string): string {
    const ms = Date.parse(playedAt.includes('T') ? playedAt : `${playedAt.replace(' ', 'T')}Z`);
    if (!Number.isFinite(ms)) return playedAt;
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function boardText(d: PlayDestination): string {
    const t = d.tournamentName ?? d.gameName ?? 'a tournament';
    const round = d.roundNo != null ? ` round ${d.roundNo}` : '';
    return d.roomName ? `${t}${round} · ${d.roomName}` : `${t}${round}`;
}

function Destination({ d }: { d: PlayDestination }) {
    const boardLink = d.roomSlug && d.gameName ? `/${d.roomSlug}/games/${encodeURIComponent(d.gameName)}` : null;
    const globalLink = d.globalGameId ? `/games/${encodeURIComponent(d.globalGameId)}` : null;
    const chip = 'inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded';

    switch (d.status) {
        case 'counted':
        case 'already_counted': {
            const label = (
                <>
                    <CheckCircle2 size={12} aria-hidden="true" />
                    {d.status === 'counted' ? 'Counted' : 'Already counted'} · {boardText(d)}
                </>
            );
            return boardLink
                ? <Link to={boardLink} className={`${chip} bg-neon-green/10 text-neon-green hover:underline`}>{label}</Link>
                : <span className={`${chip} bg-neon-green/10 text-neon-green`}>{label}</span>;
        }
        case 'global':
        case 'already_global': {
            const label = (
                <>
                    <Globe size={12} aria-hidden="true" />
                    {d.status === 'global' ? 'Global Scoreboard' : 'Already on your Global Scoreboard'}
                </>
            );
            return globalLink
                ? <Link to={globalLink} className={`${chip} bg-neon-cyan/10 text-neon-cyan hover:underline`}>{label}</Link>
                : <span className={`${chip} bg-neon-cyan/10 text-neon-cyan`}>{label}</span>;
        }
        case 'not_counted':
            return (
                <span className={`${chip} bg-neon-amber/10 text-neon-amber`}>
                    <AlertTriangle size={12} aria-hidden="true" /> Not counted · {boardText(d)}
                </span>
            );
        case 'deleted':
            return (
                <span className={`${chip} bg-raised text-muted`}>
                    <Trash2 size={12} aria-hidden="true" /> You deleted this score
                </span>
            );
        default:
            return (
                <span className={`${chip} bg-neon-coral/10 text-neon-coral`}>
                    <XCircle size={12} aria-hidden="true" /> Not recorded
                </span>
            );
    }
}

/** The "why" lines under a play: one per destination that carries a reason. */
function reasonLines(play: RecentPlay): string[] {
    const out: string[] = [];
    for (const d of play.destinations) {
        if (!d.reason) continue;
        if (d.status === 'global' || d.status === 'already_global') out.push(`Didn't count in a tournament: ${d.reason}`);
        else out.push(d.reason.charAt(0).toUpperCase() + d.reason.slice(1));
    }
    return [...new Set(out)];
}

export default function WitnessRecentPlays({ playerToken }: { playerToken: string | null }) {
    const [plays, setPlays] = useState<RecentPlay[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [all, setAll] = useState(false);
    const [loading, setLoading] = useState(false);

    /** The list, or null when it could not be read. Sets no state itself. */
    const fetchPlays = useCallback(async (): Promise<RecentPlay[] | null> => {
        if (!playerToken) return null;
        try {
            const res = await fetch('/api/me/witness/plays?limit=30', { headers: { Authorization: `Bearer ${playerToken}` } });
            if (!res.ok) return null;
            const body = await res.json();
            return Array.isArray(body) ? body : [];
        } catch {
            return null;
        }
    }, [playerToken]);

    const apply = useCallback((list: RecentPlay[] | null) => {
        if (list) { setPlays(list); setFailed(false); } else { setFailed(true); }
    }, []);

    useEffect(() => {
        let live = true;
        void fetchPlays().then(list => { if (live) apply(list); });
        return () => { live = false; };
    }, [fetchPlays, apply]);

    const load = async () => {
        setLoading(true);
        apply(await fetchPlays());
        setLoading(false);
    };

    const shown = plays ? (all ? plays : plays.slice(0, SHOWN)) : [];

    return (
        <div className="mt-6" data-testid="witness-recent-plays">
            <div className="flex items-center justify-between mb-1">
                <h4 className="text-sm font-medium">Where your plays went</h4>
                <button
                    type="button"
                    onClick={() => void load()}
                    disabled={loading}
                    className="inline-flex items-center gap-1 text-xs text-muted hover:text-primary disabled:opacity-50"
                    aria-label="Refresh where your plays went"
                >
                    <RefreshCw size={12} aria-hidden="true" className={loading ? 'animate-spin' : ''} /> Refresh
                </button>
            </div>
            <p className="text-xs text-faint mb-2">
                Every game your devices reported, newest first: where it counted, or why it didn't.
            </p>
            {failed && <p className="text-xs text-neon-coral">Couldn't load your plays. Try Refresh.</p>}
            {plays && plays.length === 0 && !failed && (
                <p className="text-xs text-muted">No plays reported yet. Finish a game on a paired device and it shows up here.</p>
            )}
            {shown.length > 0 && (
                <ul className="divide-y divide-border border border-border rounded">
                    {shown.map(play => {
                        const why = reasonLines(play);
                        return (
                            <li key={play.key} className="px-3 py-2">
                                <div className="flex flex-wrap items-baseline gap-x-2">
                                    <span className="text-sm font-medium">{play.tableName}</span>
                                    <span className="text-sm tabular-nums" title={scoreTitle(play.score)}>{formatScore(play.score)}</span>
                                    <span className="text-xs text-faint ml-auto">{whenText(play.playedAt)}</span>
                                </div>
                                <div className="mt-1 flex flex-wrap gap-1.5">
                                    {play.destinations.map((d, i) => <Destination key={i} d={d} />)}
                                </div>
                                {why.map(line => (
                                    <p key={line} className="mt-1 text-xs text-muted">{line}</p>
                                ))}
                            </li>
                        );
                    })}
                </ul>
            )}
            {plays && plays.length > SHOWN && (
                <button
                    type="button"
                    onClick={() => setAll(v => !v)}
                    className="mt-2 text-xs text-muted hover:text-primary underline"
                >
                    {all ? 'Show fewer' : `Show all ${plays.length}`}
                </button>
            )}
        </div>
    );
}
