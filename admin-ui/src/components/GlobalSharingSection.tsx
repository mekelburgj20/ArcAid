import { useEffect, useState } from 'react';
import { api } from '../lib/api';

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
    const [share, setShare] = useState<boolean | null>(null);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState('');

    useEffect(() => {
        api.get<{ share_to_global?: boolean }>('/me/preferences')
            .then(p => setShare(p?.share_to_global !== false))
            // Show the default rather than an empty box: this control is
            // informational until the player touches it.
            .catch(() => setShare(true));
    }, []);

    const toggle = async (next: boolean) => {
        const previous = share;
        setShare(next);
        setSaving(true);
        setError('');
        try {
            await api.post('/me/preferences', { share_to_global: next });
        } catch (err) {
            // Roll back so the switch never shows a state the server rejected.
            setShare(previous ?? true);
            setError((err as Error)?.message || 'Could not save that.');
        } finally {
            setSaving(false);
        }
    };

    if (share === null) return null;

    return (
        <section>
            <h2 className="text-sm font-medium mb-2">Global Scoreboard</h2>
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
                On by default. Turn it off and your room scores stay in the room they were
                posted in — including scores you submit from Discord, which has no per-score
                option. You can still share an individual score by ticking the box when you submit.
            </p>
            {error && <p className="text-xs text-neon-magenta mt-2">{error}</p>}
        </section>
    );
}
