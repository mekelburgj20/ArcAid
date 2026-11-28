import { useCallback, useEffect, useState } from 'react';
import { History, RefreshCw } from 'lucide-react';
import { formatScore, scoreTitle } from '../lib/format';
import { reasonLines, sittingCause, whenText, type DeviceSitting } from '../lib/witnessPlays';
import { Destination } from './WitnessRecentPlays';

/**
 * W131.3 (ADR 0045, docs/shared-device-plan.md §7) - "Plays on this device",
 * under a SHARED Witness device on Account Settings: every play on the device
 * since you joined it, whoever it went to (ruling 6: everyone on a device sees
 * all its plays), grouped by sitting. Each sitting names who the plays went to
 * and what decided it (`sittingCause`): the Playing as choice (who made it, on
 * the cabinet or the web), the player the device itself named, or "nobody had
 * chosen".
 *
 * This is the audit half of W131; moving a play to the right person (both
 * agree) is W131.4.
 */

const SHOWN = 4;

export default function WitnessDevicePlays({ deviceId, deviceType, playerToken }: {
    deviceId: string;
    deviceType?: 'atgames' | 'desktop';
    playerToken: string | null;
}) {
    const what = deviceType === 'desktop' ? 'PC' : 'cabinet';
    const [open, setOpen] = useState(false);
    const [sittings, setSittings] = useState<DeviceSitting[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(false);
    const [all, setAll] = useState(false);

    /** The sittings, or null when they could not be read. Sets no state itself. */
    const fetchSittings = useCallback(async (): Promise<DeviceSitting[] | null> => {
        if (!playerToken) return null;
        try {
            const res = await fetch(`/api/me/witness/devices/${encodeURIComponent(deviceId)}/plays?limit=60`, {
                headers: { Authorization: `Bearer ${playerToken}` },
            });
            const body = res.ok ? await res.json() : null;
            return body && Array.isArray(body.sittings) ? body.sittings : null;
        } catch {
            return null;
        }
    }, [deviceId, playerToken]);

    const apply = useCallback((list: DeviceSitting[] | null) => {
        if (list) { setSittings(list); setFailed(false); } else { setFailed(true); }
    }, []);

    useEffect(() => {
        if (!open) return;
        let live = true;
        void fetchSittings().then(list => { if (live) apply(list); });
        return () => { live = false; };
    }, [open, fetchSittings, apply]);

    const reload = async () => {
        setLoading(true);
        apply(await fetchSittings());
        setLoading(false);
    };

    const shown = sittings ? (all ? sittings : sittings.slice(0, SHOWN)) : [];

    return (
        <div className="mt-2" data-testid={`witness-device-plays-${deviceId}`}>
            <div className="flex items-center gap-3">
                <button
                    type="button"
                    onClick={() => setOpen(v => !v)}
                    aria-expanded={open}
                    className="inline-flex items-center gap-1 text-xs text-muted hover:text-primary cursor-pointer"
                >
                    <History size={12} aria-hidden="true" />
                    {open ? 'Hide plays on this device' : `Plays on this ${what}`}
                </button>
                {open && (
                    <button
                        type="button"
                        onClick={() => void reload()}
                        disabled={loading}
                        className="inline-flex items-center gap-1 text-xs text-muted hover:text-primary disabled:opacity-50 cursor-pointer"
                        aria-label="Refresh plays on this device"
                    >
                        <RefreshCw size={12} aria-hidden="true" className={loading ? 'animate-spin' : ''} /> Refresh
                    </button>
                )}
            </div>

            {open && (
                <div className="mt-2">
                    <p className="text-xs text-faint mb-2">
                        Every game on this {what} since you joined it, newest first, and who it went to. Everyone on
                        the {what} sees this list.
                    </p>
                    {failed && <p className="text-xs ink-danger">Couldn't load the plays. Try Refresh.</p>}
                    {!sittings && !failed && <p className="text-xs text-muted">Loading…</p>}
                    {sittings && sittings.length === 0 && !failed && (
                        <p className="text-xs text-muted">No plays on this {what} since you joined it yet.</p>
                    )}
                    {shown.length > 0 && (
                        <ol className="space-y-2">
                            {shown.map(s => (
                                <li key={`${s.plays[0]?.key ?? ''}|${s.userId}`} className="border border-border rounded" data-testid="witness-sitting">
                                    <div className="px-3 py-1.5 bg-raised border-b border-border">
                                        <p className="text-sm">
                                            <span className="text-primary font-medium">{s.isYou ? 'You' : (s.label || 'A player')}</span>
                                            <span className="text-xs text-faint ml-2">
                                                {s.plays.length === 1 ? '1 game' : `${s.plays.length} games`}
                                            </span>
                                        </p>
                                        <p className="text-xs text-muted">{sittingCause(s, what)}</p>
                                    </div>
                                    <ul className="divide-y divide-border">
                                        {s.plays.map(play => (
                                            <li key={play.key} className="px-3 py-2">
                                                <div className="flex flex-wrap items-baseline gap-x-2">
                                                    <span className="text-sm font-medium">{play.tableName}</span>
                                                    <span className="text-sm tabular-nums" title={scoreTitle(play.score)}>{formatScore(play.score)}</span>
                                                    {play.attribution === 'fallback' && (
                                                        <span
                                                            className="text-xs text-faint"
                                                            title={`The ${what} did not report its clock, so this went to whoever was playing when it arrived.`}
                                                        >
                                                            by arrival time
                                                        </span>
                                                    )}
                                                    <span className="text-xs text-faint ml-auto">{whenText(play.receivedAt)}</span>
                                                </div>
                                                <div className="mt-1 flex flex-wrap gap-1.5">
                                                    {play.destinations.map((d, i) => <Destination key={i} d={d} whose={play.isYou ? undefined : (play.label || 'A player')} />)}
                                                </div>
                                                {reasonLines(play).map(line => (
                                                    <p key={line} className="mt-1 text-xs text-muted">{line}</p>
                                                ))}
                                            </li>
                                        ))}
                                    </ul>
                                </li>
                            ))}
                        </ol>
                    )}
                    {sittings && sittings.length > SHOWN && (
                        <button
                            type="button"
                            onClick={() => setAll(v => !v)}
                            className="mt-2 text-xs text-muted hover:text-primary underline cursor-pointer"
                        >
                            {all ? 'Show fewer' : `Show all ${sittings.length} sittings`}
                        </button>
                    )}
                </div>
            )}
        </div>
    );
}
