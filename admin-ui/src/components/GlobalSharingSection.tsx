import { useEffect, useState } from 'react';
import { playerApi } from '../lib/playerApi';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import GlobalPrivateScores from './GlobalPrivateScores';
import Panel from './parts/Panel';

/**
 * "Share my scores to the Global Scoreboard" (v2.137.0).
 *
 * Default ON, which is what every existing player already gets — the stored
 * column is NULL until somebody opts out, so nothing had to guess at intent
 * during the migration.
 *
 * The preference is resolved SERVER-side at submit time, not by defaulting a
 * checkbox: **Discord `/submit-score` has no checkbox**, so the account setting
 * is the only thing that can speak for the player there. A client-only default
 * would apply on the web and be silently ignored in Discord — the exact
 * inconsistency this control exists to remove.
 *
 * A per-submission choice still wins: the submit sheet seeds its box from this
 * value and always sends it explicitly, so an opted-out player can still share
 * one particular score.
 */
export default function GlobalSharingSection() {
    // The PLAYER client, not `api.*` — see lib/playerApi.ts. Using the admin
    // client here 401'd and bounced players to /superadmin from their own
    // Account Settings page (live incident, 2026-08-25).
    const { playerToken } = useViewerAuth();
    const [share, setShare] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        if (!playerToken) return;
        playerApi.get<{ share_to_global?: boolean }>('/me/preferences', { token: playerToken })
            .then(p => setShare(p?.share_to_global !== false))
            // Show the default rather than an empty box: this control is
            // informational until the player touches it.
            .catch(() => setShare(true));
    }, [playerToken]);

    const toggle = async (next: boolean) => {
        const previous = share;
        setShare(next);
        setSaving(true);
        setError('');
        try {
            await playerApi.post('/me/preferences', { share_to_global: next }, { token: playerToken });
        } catch (err) {
            // Roll back so the switch never shows a state the server rejected.
            setShare(previous ?? true);
            setError((err as Error)?.message || 'Could not save that.');
        } finally {
            setSaving(false);
        }
    };

    // This section renders only after the preference loads, so the browser's own
    // anchor jump (`#global-sharing`, linked from the submit sheet) has nothing
    // to land on at first paint.
    const rendered = share !== null;
    useEffect(() => {
        if (rendered && window.location.hash === '#global-sharing') {
            document.getElementById('global-sharing')?.scrollIntoView({ block: 'start' });
        }
    }, [rendered]);

    if (share === null) return null;

    return (
        <Panel id="global-sharing" title="Global Scoreboard">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input
                    type="checkbox" checked={share} disabled={saving}
                    onChange={e => toggle(e.target.checked)}
                    className="accent-neon-cyan"
                    data-testid="share-to-global"
                />
                <span className="text-primary">Share my scores to the Global Scoreboard</span>
            </label>
            <p className="text-xs text-muted mt-2">
                On by default, and it covers <strong>every</strong> score you earn — tournaments,
                events, Throwdowns, and scores your paired cabinet reports on its own. Wherever you
                played it, the world gets to see it.
            </p>
            <p className="text-xs text-muted mt-2">
                Turn it off and your scores stay where they were posted — including scores from
                Discord and from a cabinet, neither of which has a per-score option. You can still
                share one particular score by ticking the box when you submit it by hand.
            </p>
            <GlobalPrivateScores />
            {error && <p className="text-xs text-neon-coral mt-2">{error}</p>}
        </Panel>
    );
}
