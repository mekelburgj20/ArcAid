import { useEffect, useState } from 'react';
import { playerApi } from '../lib/playerApi';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { formatScore } from '../lib/format';

/**
 * Scores the player kept off the Global Scoreboard with the per-score box
 * ("Don't post this score to the global Arcaid scoreboard"), with a way back.
 *
 * Player client only (see lib/playerApi.ts). A posted row STAYS in the list for
 * this page visit, showing "On the Global Scoreboard" + Undo, so a mis-press is
 * reversible without a reload. Renders nothing while loading, on a load failure
 * or when the list is empty.
 */

interface PrivateScore {
    id: string;
    game_name: string;
    score: number;
    submitted_at: string;
    origin_room_name: string | null;
}

function whenText(at: string): string {
    const ms = Date.parse(at.includes('T') ? at : `${at.replace(' ', 'T')}Z`);
    if (!Number.isFinite(ms)) return at;
    return new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function GlobalPrivateScores() {
    const { playerToken } = useViewerAuth();
    const [scores, setScores] = useState<PrivateScore[] | null>(null);
    const [posted, setPosted] = useState<Record<string, boolean>>({});
    const [busy, setBusy] = useState<Record<string, boolean>>({});
    const [errors, setErrors] = useState<Record<string, string>>({});

    useEffect(() => {
        if (!playerToken) return;
        let cancelled = false;
        playerApi.get<{ scores?: PrivateScore[] }>('/me/global-scores/private', { token: playerToken })
            .then(r => { if (!cancelled) setScores(r?.scores ?? []); })
            .catch(() => { if (!cancelled) setScores(null); });
        return () => { cancelled = true; };
    }, [playerToken]);

    const change = async (id: string, share: boolean) => {
        setBusy(b => ({ ...b, [id]: true }));
        setErrors(e => ({ ...e, [id]: '' }));
        try {
            await playerApi.patch(`/me/global-scores/${encodeURIComponent(id)}`, { share_to_global: share }, { token: playerToken });
            setPosted(p => ({ ...p, [id]: share }));
        } catch (err) {
            setErrors(e => ({ ...e, [id]: (err as Error)?.message || 'Could not save that.' }));
        } finally {
            setBusy(b => ({ ...b, [id]: false }));
        }
    };

    if (!scores || scores.length === 0) return null;

    return (
        <div className="mt-4" data-testid="private-global-scores">
            <h3 className="text-sm font-medium mb-1">Scores you kept off the Global Scoreboard</h3>
            <p className="text-xs text-muted mb-2">
                These were submitted with "Don't post this score to the global Arcaid scoreboard" ticked.
                They still count in the room they were posted in.
            </p>
            <ul className="space-y-2">
                {scores.map(s => (
                    <li
                        key={s.id}
                        className="border border-border rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2"
                        data-testid={`private-score-${s.id}`}
                    >
                        <div className="min-w-0 flex-1 basis-48">
                            <p className="text-sm text-primary break-words">{s.game_name}</p>
                            <p className="text-xs text-muted break-words">
                                {formatScore(s.score)}
                                {s.origin_room_name ? ` · ${s.origin_room_name}` : ''}
                                {` · ${whenText(s.submitted_at)}`}
                            </p>
                            {errors[s.id] && <p className="text-xs text-neon-coral mt-1">{errors[s.id]}</p>}
                        </div>
                        {posted[s.id] ? (
                            <div className="flex items-center gap-2 text-xs">
                                <span className="text-neon-cyan">On the Global Scoreboard</span>
                                <button
                                    type="button"
                                    disabled={!!busy[s.id]}
                                    onClick={() => change(s.id, false)}
                                    className="text-muted underline disabled:opacity-50"
                                    data-testid={`undo-global-${s.id}`}
                                >
                                    Undo
                                </button>
                            </div>
                        ) : (
                            <button
                                type="button"
                                disabled={!!busy[s.id]}
                                onClick={() => change(s.id, true)}
                                className="text-xs px-3 py-1.5 rounded border border-neon-cyan/40 text-neon-cyan disabled:opacity-50"
                                data-testid={`post-global-${s.id}`}
                            >
                                Post to Global Scoreboard
                            </button>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
