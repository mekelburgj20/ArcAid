import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { playerApi } from '../lib/playerApi';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

/**
 * "My Throwdowns" — the creator's own challenges (v2.136.0, ADR 0018).
 *
 * The original spec called for these to live "on the creator's profile under
 * Private Tournaments". Because a Throwdown is a room-less tournament rather
 * than a new kind of record, that list is simply
 * `tournaments WHERE created_by_user_id = me AND throwdown_code IS NOT NULL` —
 * no extra storage concept was needed to satisfy it.
 *
 * Read-only on purpose: a finished Throwdown's standings are frozen, and a live
 * one is managed from its own page.
 */

interface ThrowdownRow {
    id: string;
    name: string;
    code: string;
    startDate: string | null;
    endDate: string | null;
    finishedAt: string | null;
    url: string;
}

function state(row: ThrowdownRow, now = Date.now()): { label: string; className: string } {
    if (row.finishedAt) return { label: 'Finished', className: 'bg-border/40 text-muted border-border' };
    if (row.endDate && now >= Date.parse(row.endDate)) {
        // Past its window but not yet frozen — the per-minute tick has up to a
        // minute plus the grace to catch up, and saying "Finished" early would
        // contradict the page it links to.
        return { label: 'Wrapping up', className: 'bg-neon-cyan/15 text-neon-cyan border-neon-cyan/40' };
    }
    return { label: 'Live', className: 'bg-neon-magenta/15 text-neon-magenta border-neon-magenta/40' };
}

function when(row: ThrowdownRow): string {
    const iso = row.startDate;
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function ThrowdownsSection() {
    // PLAYER client — `api.*` would 401 and redirect to /superadmin.
    const { playerToken } = useViewerAuth();
    const [rows, setRows] = useState<ThrowdownRow[] | null>(null);

    useEffect(() => {
        if (!playerToken) return;
        playerApi.get<ThrowdownRow[]>('/me/throwdowns', { token: playerToken })
            // Shape-checked, not just error-checked. This section is one optional
            // block on a page full of important settings, and rendering
            // `rows.map` against a non-array response would white-screen the
            // WHOLE page — the failure mode is wildly out of proportion to what
            // is being displayed.
            .then(data => setRows(Array.isArray(data) ? data : []))
            .catch(() => setRows([]));
    }, [playerToken]);

    // Nothing to say to someone who has never started one — an empty box with
    // an explanation would just be clutter on a settings page.
    if (!Array.isArray(rows) || rows.length === 0) return null;

    return (
        <section>
            <h2 className="text-sm font-medium mb-2">My Throwdowns</h2>
            <p className="text-xs text-muted mb-3">
                Challenges you started. The link is all anyone needs to join.
            </p>
            <ul className="space-y-1">
                {rows.map(row => {
                    const chip = state(row);
                    return (
                        <li
                            key={row.id}
                            className="flex items-center gap-3 text-sm bg-surface border border-border rounded px-3 py-1.5 flex-wrap"
                        >
                            <Link to={row.url} className="text-primary no-underline hover:text-neon-cyan transition-colors truncate">
                                {row.name}
                            </Link>
                            <span className={`text-xs px-2 py-0.5 rounded border ${chip.className}`}>{chip.label}</span>
                            <span className="text-xs text-faint">{when(row)}</span>
                            <code className="ml-auto text-xs font-mono text-muted">{row.code}</code>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
