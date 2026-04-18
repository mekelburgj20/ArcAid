import { useCallback, useEffect, useState } from 'react';
import { UserCheck, UserPlus, Undo2, Lock, Clock } from 'lucide-react';
import { useRoom } from '../contexts/RoomContext';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';

/**
 * Sprint 11 — Admin Identity Management (plan §15, tmp/sprint-02-merge-model.md).
 *
 * Two sections:
 *   1. Pending Claims — active anonymous identities in this room, with preview
 *      + merge confirmation flow. Re-runs preview inside a transaction on
 *      confirm; if state drifted, the server returns 409 + refreshed preview.
 *   2. Audit Chain — all merge records, with reverse action and a drill-down
 *      dialog that renders the reversal preview (what moves back, what stays).
 *
 * Deliberately minimal UI — uses existing NeonCard/NeonButton + native markup.
 */

interface QueueEntry {
    id: number;
    serverNickname: string;
    guildId: string | null;
    firstSeenAt: string;
    status: string;
    anonymousScoreCount: number;
    potentialMatch: { discordUserId: string; username: string; avatarHash: string | null } | null;
}

interface FrozenGroup {
    tournamentId: string;
    tournamentName: string;
    completedAt: string;
    rowCount: number;
}

interface MergePreview {
    anonymousIdentityId: number;
    anonymousNickname: string;
    targetDiscordUserId: string;
    willMove: { submissions: string[]; community_scores: number[]; score_history: number[]; global_scores: string[] };
    frozenStay: FrozenGroup[];
    totalMovingRows: number;
    totalFrozenRows: number;
    previewHash: string;
}

interface ReversalPreview {
    mergeId: number;
    mergedAt: string;
    targetDiscordUserId: string;
    anonymousIdentityId: number;
    willReturn: { submissions: string[]; community_scores: number[]; score_history: number[]; global_scores: string[] };
    willStay: FrozenGroup[];
    totalReturningRows: number;
    totalStayingRows: number;
}

interface AuditEntry {
    id: number;
    anonymousIdentityId: number;
    targetDiscordUserId: string;
    adminDiscordUserId: string;
    createdAt: string;
    reversedAt: string | null;
    reversalAdminId: string | null;
    reason: string | null;
    anonymousNickname: string | null;
    anonymousStatus: string | null;
    targetUsername: string | null;
    summary: { moving: number; frozen: number };
}

type PreviewModalState =
    | { kind: 'merge'; queueEntry: QueueEntry; preview: MergePreview; targetUserId: string }
    | { kind: 'reverse'; auditEntry: AuditEntry; preview: ReversalPreview };

export default function Identity() {
    const { roomId } = useRoom();
    const [queue, setQueue] = useState<QueueEntry[]>([]);
    const [audit, setAudit] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<PreviewModalState | null>(null);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [targetInput, setTargetInput] = useState<Record<number, string>>({});

    const refresh = useCallback(async () => {
        if (!roomId) return;
        setLoading(true);
        setError(null);
        try {
            const [q, a] = await Promise.all([
                api.get<QueueEntry[]>(`/rooms/${roomId}/admin/identity/queue`),
                api.get<AuditEntry[]>(`/rooms/${roomId}/admin/identity/audit?limit=100`),
            ]);
            setQueue(q);
            setAudit(a);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load identity data');
        } finally {
            setLoading(false);
        }
    }, [roomId]);

    useEffect(() => { refresh(); }, [refresh]);

    const openMergePreview = async (q: QueueEntry) => {
        const targetUserId = (targetInput[q.id] || q.potentialMatch?.discordUserId || '').trim();
        if (!targetUserId) {
            setError('Pick a target Discord user ID (or use the suggested match).');
            return;
        }
        try {
            const preview = await api.post<MergePreview>(`/rooms/${roomId}/admin/identity/preview`, {
                anonymousIdentityId: q.id,
                targetUserId,
            });
            setModal({ kind: 'merge', queueEntry: q, preview, targetUserId });
            setReason('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Preview failed');
        }
    };

    const openReversalPreview = async (entry: AuditEntry) => {
        try {
            const { reversalPreview } = await api.get<{ record: AuditEntry; reversalPreview: ReversalPreview | null }>(
                `/rooms/${roomId}/admin/identity/${entry.id}`,
            );
            if (!reversalPreview) {
                setError('No reversal preview available (merge already reversed?).');
                return;
            }
            setModal({ kind: 'reverse', auditEntry: entry, preview: reversalPreview });
            setReason('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Could not load reversal preview');
        }
    };

    const confirmMerge = async () => {
        if (!modal || modal.kind !== 'merge') return;
        setSubmitting(true);
        try {
            await api.post(`/rooms/${roomId}/admin/identity/merge`, {
                anonymousIdentityId: modal.queueEntry.id,
                targetUserId: modal.targetUserId,
                reason: reason || undefined,
                previewHash: modal.preview.previewHash,
            });
            setModal(null);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Merge failed');
        } finally {
            setSubmitting(false);
        }
    };

    const confirmReverse = async () => {
        if (!modal || modal.kind !== 'reverse') return;
        setSubmitting(true);
        try {
            await api.post(`/rooms/${roomId}/admin/identity/${modal.auditEntry.id}/reverse`, {
                reason: reason || undefined,
            });
            setModal(null);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Reverse failed');
        } finally {
            setSubmitting(false);
        }
    };

    if (loading) return <LoadingState message="Loading identity records…" />;

    return (
        <div className="space-y-6 max-w-5xl">
            <header>
                <h1 className="font-display text-2xl text-primary mb-1">Identity</h1>
                <p className="text-xs text-muted">
                    Claim anonymous scores for Discord users or reverse a prior merge.
                    Completed tournaments freeze attribution — frozen rows cannot be moved.
                </p>
            </header>

            {error && (
                <div className="px-3 py-2 rounded bg-neon-amber/10 border border-neon-amber/30 text-xs text-neon-amber">
                    {error}
                </div>
            )}

            <NeonCard glowColor="cyan">
                <h2 className="font-display text-sm text-primary mb-3 inline-flex items-center gap-2">
                    <UserPlus size={16} /> Pending Claims
                    <span className="text-xs text-muted font-normal">({queue.length})</span>
                </h2>
                {queue.length === 0 ? (
                    <p className="text-xs text-muted py-4">No active anonymous identities.</p>
                ) : (
                    <div className="divide-y divide-border/30">
                        {queue.map(q => {
                            const draftTarget = targetInput[q.id] ?? '';
                            return (
                                <div key={q.id} className="py-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                                    <div className="min-w-0">
                                        <p className="text-sm text-primary font-medium break-words">
                                            "{q.serverNickname}"
                                            <span className="text-xs text-muted ml-2">
                                                · {q.anonymousScoreCount} anonymous community score{q.anonymousScoreCount === 1 ? '' : 's'}
                                            </span>
                                        </p>
                                        <p className="text-xs text-muted mt-0.5 break-words">
                                            First seen {new Date(q.firstSeenAt).toLocaleDateString()}
                                            {q.potentialMatch && (
                                                <> · Potential match: <span className="text-neon-cyan">@{q.potentialMatch.username}</span></>
                                            )}
                                        </p>
                                        <input
                                            type="text"
                                            value={draftTarget}
                                            onChange={e => setTargetInput(s => ({ ...s, [q.id]: e.target.value }))}
                                            placeholder={q.potentialMatch?.discordUserId ?? 'Target Discord user ID'}
                                            className="mt-2 w-full px-2 py-1 text-xs rounded border border-border bg-surface text-primary placeholder:text-faint"
                                        />
                                    </div>
                                    <NeonButton onClick={() => openMergePreview(q)} className="text-xs px-3 py-1.5 w-full sm:w-auto">
                                        Preview merge →
                                    </NeonButton>
                                </div>
                            );
                        })}
                    </div>
                )}
            </NeonCard>

            <NeonCard glowColor="magenta">
                <h2 className="font-display text-sm text-primary mb-3 inline-flex items-center gap-2">
                    <UserCheck size={16} /> Audit Chain
                    <span className="text-xs text-muted font-normal">({audit.length})</span>
                </h2>
                {audit.length === 0 ? (
                    <p className="text-xs text-muted py-4">No merges recorded in this room yet.</p>
                ) : (
                    <div className="divide-y divide-border/30 text-xs">
                        {audit.map(a => (
                            <div key={a.id} className="py-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-center">
                                <div className="min-w-0">
                                    <p className="text-sm text-primary break-words">
                                        <span className="text-muted">{new Date(a.createdAt).toLocaleString()}</span>
                                        {' · '}
                                        "{a.anonymousNickname ?? '?'}" → <span className="text-neon-cyan">@{a.targetUsername ?? a.targetDiscordUserId}</span>
                                        {a.reversedAt && (
                                            <span className="ml-2 px-1.5 py-0.5 rounded bg-neon-amber/10 text-neon-amber text-[10px] uppercase tracking-wider">Reversed</span>
                                        )}
                                    </p>
                                    <p className="text-muted mt-0.5 break-words">
                                        {a.summary.moving} row{a.summary.moving === 1 ? '' : 's'} moved
                                        {a.summary.frozen > 0 && <> · {a.summary.frozen} frozen tournament{a.summary.frozen === 1 ? '' : 's'}</>}
                                        {a.reason && <> · <em>{a.reason}</em></>}
                                    </p>
                                </div>
                                {!a.reversedAt ? (
                                    <button
                                        onClick={() => openReversalPreview(a)}
                                        className="inline-flex items-center justify-center gap-1 w-full sm:w-auto px-3 py-1.5 rounded border border-border text-xs text-muted hover:text-neon-amber hover:border-neon-amber/40 cursor-pointer"
                                    >
                                        <Undo2 size={12} /> Reverse…
                                    </button>
                                ) : (
                                    <span className="inline-flex items-center justify-center sm:justify-start gap-1 text-[10px] text-muted">
                                        <Lock size={12} /> reversed {a.reversedAt ? new Date(a.reversedAt).toLocaleDateString() : ''}
                                    </span>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </NeonCard>

            {modal && <PreviewModal
                state={modal}
                reason={reason}
                setReason={setReason}
                submitting={submitting}
                onClose={() => setModal(null)}
                onConfirm={modal.kind === 'merge' ? confirmMerge : confirmReverse}
            />}
        </div>
    );
}

function PreviewModal({
    state,
    reason,
    setReason,
    submitting,
    onClose,
    onConfirm,
}: {
    state: PreviewModalState;
    reason: string;
    setReason: (s: string) => void;
    submitting: boolean;
    onClose: () => void;
    onConfirm: () => void;
}) {
    const isMerge = state.kind === 'merge';
    const title = isMerge
        ? `Merge "${state.preview.anonymousNickname}" → @${(state as any).targetUserId}`
        : `Reverse merge #${state.preview.mergeId}`;
    const movingCount = isMerge ? state.preview.totalMovingRows : state.preview.totalReturningRows;
    const frozenGroups = isMerge ? state.preview.frozenStay : state.preview.willStay;
    const frozenCount = isMerge ? state.preview.totalFrozenRows : state.preview.totalStayingRows;
    const confirmLabel = isMerge ? 'Confirm merge' : 'Reverse merge';

    return (
        <div
            role="dialog"
            aria-modal="true"
            className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm px-4"
            onClick={e => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
                <div className="px-4 py-3 border-b border-border/30 flex items-center justify-between">
                    <h3 className="font-display text-sm font-bold text-primary truncate">{title}</h3>
                </div>
                <div className="px-4 py-4 space-y-3 text-xs">
                    <div className="px-3 py-2 rounded bg-neon-cyan/5 border border-neon-cyan/20">
                        <p className="text-primary">
                            <strong className="text-neon-cyan">{movingCount}</strong> score{movingCount === 1 ? '' : 's'} will{' '}
                            {isMerge ? <>attribute to <span className="text-neon-cyan">@{(state as any).targetUserId}</span></> : 'return to the anonymous identity'}.
                        </p>
                    </div>
                    {frozenCount > 0 && (
                        <div className="px-3 py-2 rounded bg-neon-amber/5 border border-neon-amber/20">
                            <p className="text-neon-amber inline-flex items-center gap-1">
                                <Clock size={12} />
                                {frozenCount} row{frozenCount === 1 ? ' stays' : 's stay'} put — frozen by completed tournament{frozenGroups.length === 1 ? '' : 's'}
                            </p>
                            <ul className="mt-1 list-disc list-inside space-y-0.5 text-muted">
                                {frozenGroups.map(g => (
                                    <li key={g.tournamentId}>
                                        {g.tournamentName} (closed {new Date(g.completedAt).toLocaleDateString()}) — {g.rowCount} row{g.rowCount === 1 ? '' : 's'}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                    <div>
                        <label className="block text-xs text-faint mb-1">Reason (optional)</label>
                        <input
                            type="text"
                            value={reason}
                            onChange={e => setReason(e.target.value)}
                            placeholder="Context for the audit log"
                            className="w-full px-2 py-1 text-xs rounded border border-border bg-raised text-primary placeholder:text-faint"
                        />
                    </div>
                </div>
                <div className="px-4 py-3 border-t border-border/30 flex items-center justify-end gap-2">
                    <button onClick={onClose} disabled={submitting} className="px-3 py-1.5 text-xs text-muted hover:text-primary cursor-pointer">
                        Cancel
                    </button>
                    <NeonButton onClick={onConfirm} disabled={submitting} className="text-xs px-3 py-1.5">
                        {submitting ? 'Working…' : confirmLabel}
                    </NeonButton>
                </div>
            </div>
        </div>
    );
}
