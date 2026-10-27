import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ShieldCheck, AlertTriangle } from 'lucide-react';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { CHANGE_HREF, homeLines, roomLines, type Device, type Line, type Routing } from '../lib/witnessScoresGoTo';

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
 * - **Home page** (no `roomId`): where each device sends.
 *
 * Renders nothing for a guest or a player with no paired device.
 */

export default function WitnessScoresGoTo({ roomId, className = '' }: { roomId?: string | null; className?: string }) {
    const { playerToken } = useViewerAuth();
    const [lines, setLines] = useState<Line[]>([]);

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
                setLines(roomId ? roomLines(rows as Routing[]) : homeLines(rows as Device[]));
            })
            .catch(() => { if (live) setLines([]); });
        return () => { live = false; };
    }, [playerToken, roomId]);

    if (!playerToken || lines.length === 0) return null;
    return (
        <div className={`space-y-1 ${className}`} data-testid="witness-scores-go-to">
            {lines.map(line => (
                <p
                    key={line.key}
                    className={`flex items-start gap-1.5 text-xs ${line.ok ? 'text-muted' : 'text-neon-amber'}`}
                >
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
            ))}
        </div>
    );
}
