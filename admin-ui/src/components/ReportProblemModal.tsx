import { useState } from 'react';
import { X } from 'lucide-react';
import NeonButton from './NeonButton';

/**
 * Report-a-problem (v2.25.0) — public form modal for disputing catalogue
 * game metadata. Discord-authed only (pass playerToken); logged-out viewers
 * get a login prompt instead of the form. POSTs to
 * /api/global/games/:id/feedback; reports land in the super-admin queue on
 * /admin/catalogue.
 */
interface ReportProblemModalProps {
    globalGameId: string;
    gameName: string;
    playerToken: string | null;
    onClose: () => void;
}

const FIELD_OPTIONS: Array<{ value: string; label: string }> = [
    { value: 'name', label: 'Game name is wrong' },
    { value: 'manufacturer', label: 'Manufacturer is wrong' },
    { value: 'year', label: 'Year is wrong' },
    { value: 'platforms', label: 'Platforms are wrong' },
    { value: 'artwork', label: 'Artwork is wrong / missing' },
    { value: 'duplicate', label: 'This is a duplicate of another game' },
    { value: 'not_score_eligible', label: "Not score-eligible (game isn't score-based)" },
    { value: 'other', label: 'Something else' },
];

/**
 * Contract §5 — the eligibility flag disputes whether the game belongs here at
 * all, so there is nothing to "suggest" and no source to cite. Requiring prose
 * to file it would suppress exactly the reports the super-admin wants. The
 * server's zod refine carries the same exemption; keep the two in step.
 */
const NO_DETAIL_REQUIRED = new Set(['not_score_eligible']);

const inputClass =
    'w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm ' +
    'focus:outline-none focus:border-neon-cyan transition-colors';

export default function ReportProblemModal({ globalGameId, gameName, playerToken, onClose }: ReportProblemModalProps) {
    const [field, setField] = useState('manufacturer');
    const [suggested, setSuggested] = useState('');
    const [note, setNote] = useState('');
    const [phase, setPhase] = useState<'form' | 'submitting' | 'success'>('form');
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async () => {
        if (!playerToken) return;
        if (!NO_DETAIL_REQUIRED.has(field) && !suggested.trim() && !note.trim()) {
            setError('Add a suggested correction or a note so admins know what to look at.');
            return;
        }
        setError(null);
        setPhase('submitting');
        try {
            const res = await fetch(`/api/global/games/${globalGameId}/feedback`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${playerToken}`,
                },
                body: JSON.stringify({
                    field,
                    suggested_value: suggested.trim() || undefined,
                    note: note.trim() || undefined,
                }),
            });
            if (res.ok) {
                setPhase('success');
                return;
            }
            const body = await res.json().catch(() => null);
            setError(body?.error || `Report failed (${res.status})`);
            setPhase('form');
        } catch {
            setError('Network error — please try again.');
            setPhase('form');
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm p-4" onClick={onClose}>
            <div className="bg-surface border border-border rounded-lg p-6 w-full max-w-md shadow-2xl" onClick={e => e.stopPropagation()}>
                <div className="flex items-start justify-between gap-3 mb-1">
                    <h3 className="font-display text-lg font-bold text-primary">Report a problem</h3>
                    <button onClick={onClose} className="text-muted hover:text-primary transition-colors" aria-label="Close">
                        <X size={18} />
                    </button>
                </div>
                <p className="text-muted text-sm mb-4">{gameName}</p>

                {!playerToken ? (
                    <p className="text-sm text-muted">
                        Log in with Discord (top of the page) to report a problem with this game's info.
                    </p>
                ) : phase === 'success' ? (
                    <div className="space-y-4">
                        <p className="text-neon-green text-sm">
                            Thanks — your report is in. An admin will review it and either fix the entry or
                            note where the data comes from.
                        </p>
                        <div className="flex justify-end">
                            <NeonButton onClick={onClose}>Done</NeonButton>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div>
                            <label className="block text-xs text-muted uppercase tracking-wider mb-1">What's wrong?</label>
                            <select value={field} onChange={e => setField(e.target.value)} className={inputClass}>
                                {FIELD_OPTIONS.map(o => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </select>
                        </div>
                        {field === 'not_score_eligible' ? (
                            <p className="text-xs text-muted">
                                Flags this game for a moderator to look at — nothing is removed
                                automatically. Add a note below if there's something specific they
                                should know.
                            </p>
                        ) : (
                            <div>
                                <label className="block text-xs text-muted uppercase tracking-wider mb-1">
                                    Suggested correction <span className="normal-case">(optional)</span>
                                </label>
                                <input
                                    value={suggested}
                                    onChange={e => setSuggested(e.target.value)}
                                    maxLength={300}
                                    placeholder={field === 'duplicate' ? 'Name of the game it duplicates' : 'e.g. Bally, 1995, …'}
                                    className={inputClass}
                                />
                            </div>
                        )}
                        <div>
                            <label className="block text-xs text-muted uppercase tracking-wider mb-1">
                                Note <span className="normal-case">(optional — why / source)</span>
                            </label>
                            <textarea
                                value={note}
                                onChange={e => setNote(e.target.value)}
                                maxLength={1000}
                                rows={3}
                                placeholder="e.g. IPDB lists this as Bally 1995: https://…"
                                className={inputClass}
                            />
                        </div>
                        {error && <p className="text-neon-red text-sm">{error}</p>}
                        <div className="flex justify-end gap-3 pt-1">
                            <NeonButton variant="ghost" onClick={onClose}>Cancel</NeonButton>
                            <NeonButton onClick={handleSubmit} disabled={phase === 'submitting'}>
                                {phase === 'submitting' ? 'Sending…' : 'Send report'}
                            </NeonButton>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
