import { useState } from 'react';
import { Dialog } from './parts/Dialog';
import Button from './parts/Button';
import { Select, TextArea, TextInput } from './parts/Field';

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

    const footer = !playerToken ? (
        <Button variant="secondary" onClick={onClose}>Close</Button>
    ) : phase === 'success' ? (
        <Button onClick={onClose}>Done</Button>
    ) : (
        <>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={phase === 'submitting'}>
                {phase === 'submitting' ? 'Sending…' : 'Send report'}
            </Button>
        </>
    );

    return (
        <Dialog
            open
            onOpenChange={o => { if (!o) onClose(); }}
            tone="cyan"
            label="Report"
            title="Report a problem"
            description={gameName}
            sheet
            footer={footer}
        >
            {!playerToken ? (
                <p className="text-sm text-muted">
                    Log in with Discord (top of the page) to report a problem with this game's info.
                </p>
            ) : phase === 'success' ? (
                <p className="text-neon-cyan text-sm">
                    Thanks — your report is in. An admin will review it and either fix the entry or
                    note where the data comes from.
                </p>
            ) : (
                <div className="space-y-3">
                    <Select id="report-problem-field" label="What's wrong?" value={field} onChange={e => setField(e.target.value)}>
                        {FIELD_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))}
                    </Select>
                    {field === 'not_score_eligible' ? (
                        <p className="text-xs text-muted">
                            Flags this game for a moderator to look at — nothing is removed
                            automatically. Add a note below if there's something specific they
                            should know.
                        </p>
                    ) : (
                        <TextInput
                            id="report-problem-suggested"
                            label="Suggested correction"
                            optional
                            value={suggested}
                            onChange={e => setSuggested(e.target.value)}
                            maxLength={300}
                            placeholder={field === 'duplicate' ? 'Name of the game it duplicates' : 'e.g. Bally, 1995, …'}
                        />
                    )}
                    <TextArea
                        id="report-problem-note"
                        label="Note"
                        optional
                        hint="Why, or where the right answer comes from."
                        value={note}
                        onChange={e => setNote(e.target.value)}
                        maxLength={1000}
                        rows={3}
                        placeholder="e.g. IPDB lists this as Bally 1995: https://…"
                    />
                    {error && <p className="ink-danger text-sm">{error}</p>}
                </div>
            )}
        </Dialog>
    );
}
