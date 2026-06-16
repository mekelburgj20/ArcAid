import { useCallback, useEffect, useState } from 'react';
import { UserCheck, UserPlus, Undo2, Lock, Clock, ArrowRightLeft } from 'lucide-react';
import { useRoom } from '../contexts/RoomContext';
import { api } from '../lib/api';
import NeonCard from '../components/NeonCard';
import NeonButton from '../components/NeonButton';
import LoadingState from '../components/LoadingState';
import { useToast } from '../components/Toast';

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

/** Per-table rows-affected counts returned by the merge-player dry-run + commit. */
interface RenameRowsAffected {
    submissions: number;
    scores: number;
    community_scores: number;
    score_history: number;
    user_mappings: number;
    player_aliases: number;
}

/** Dry-run response from POST /rooms/:roomId/admin/merge-player?dryRun=true */
interface RenamePreview {
    dryRun: true;
    rowsAffected: RenameRowsAffected;
    total: number;
    globalIdentityWillUpdate: boolean;
}

/** Commit response from POST /rooms/:roomId/admin/merge-player */
interface RenameCommitResult {
    success: boolean;
    submissionsUpdated: number;
    scoresUpdated: number;
    rowsAffected: RenameRowsAffected;
    total: number;
    globalIdentityUpdated: boolean;
}

type PreviewModalState =
    | { kind: 'merge'; queueEntry: QueueEntry; preview: MergePreview; targetUserId: string }
    | { kind: 'reverse'; auditEntry: AuditEntry; preview: ReversalPreview }
    | { kind: 'rename'; fromUsername: string; toUsername: string; preview: RenamePreview };

export default function Identity() {
    const { roomId } = useRoom();
    const { toast } = useToast();
    const [queue, setQueue] = useState<QueueEntry[]>([]);
    const [audit, setAudit] = useState<AuditEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [modal, setModal] = useState<PreviewModalState | null>(null);
    const [reason, setReason] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [targetInput, setTargetInput] = useState<Record<number, string>>({});
    const [mergeFrom, setMergeFrom] = useState('');
    const [mergeTo, setMergeTo] = useState('');
    const [renaming, setRenaming] = useState(false);

    // Step 1 — DRY-RUN preview. Replaces the old blind window.confirm() commit.
    const previewRenamePlayer = async () => {
        if (!roomId) return;
        const from = mergeFrom.trim();
        const to = mergeTo.trim();
        if (!from || !to) return;
        setError(null);
        setRenaming(true);
        try {
            const preview = await api.post<RenamePreview>(
                `/rooms/${roomId}/admin/merge-player?dryRun=true`,
                { fromUsername: from, toUsername: to },
            );
            setModal({ kind: 'rename', fromUsername: from, toUsername: to, preview });
            setReason('');
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Rename preview failed');
        } finally {
            setRenaming(false);
        }
    };

    // Step 2 — COMMIT the rename after the preview is reviewed.
    const confirmRename = async () => {
        if (!roomId || !modal || modal.kind !== 'rename') return;
        setSubmitting(true);
        try {
            const result = await api.post<RenameCommitResult>(
                `/rooms/${roomId}/admin/merge-player`,
                { fromUsername: modal.fromUsername, toUsername: modal.toUsername, reason: reason || undefined },
            );
            setModal(null);
            setMergeFrom('');
            setMergeTo('');
            toast(
                `Renamed: ${result.submissionsUpdated} submission${result.submissionsUpdated === 1 ? '' : 's'}, ${result.scoresUpdated} score${result.scoresUpdated === 1 ? '' : 's'} updated`,
                'success',
            );
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Rename failed');
        } finally {
            setSubmitting(false);
        }
    };

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
                    Manage player identity in this room: rename or merge usernames across all scores,
                    claim anonymous scores for Discord users, or reverse a prior merge.
                    Completed tournaments freeze attribution — frozen rows cannot be moved.
                </p>
            </header>

            {error && (
                <div className="px-3 py-2 rounded bg-neon-amber/10 border border-neon-amber/30 text-xs text-neon-amber">
                    {error}
                </div>
            )}

            <NeonCard glowColor="amber">
                <h2 className="font-display text-sm text-primary mb-2 inline-flex items-center gap-2">
                    <ArrowRightLeft size={16} /> Merge / Rename Player
                </h2>
                <p className="text-xs text-muted mb-3">
                    Rename a player or merge two usernames into one. Updates submissions, scores, and user mappings.
                    If the name was also wrong on iScored, fix it there first to prevent re-importing the old name on next sync.
                </p>
                <div className="flex flex-wrap items-end gap-3">
                    <div>
                        <label className="text-xs text-faint block mb-1">From (old/wrong name)</label>
                        <input
                            type="text"
                            placeholder="mekelburj"
                            value={mergeFrom}
                            onChange={e => setMergeFrom(e.target.value)}
                            className="w-48 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                        />
                    </div>
                    <div>
                        <label className="text-xs text-faint block mb-1">To (correct name)</label>
                        <input
                            type="text"
                            placeholder="mekelburgj"
                            value={mergeTo}
                            onChange={e => setMergeTo(e.target.value)}
                            className="w-48 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                        />
                    </div>
                    <NeonButton
                        variant="secondary"
                        disabled={renaming || !mergeFrom.trim() || !mergeTo.trim()}
                        onClick={previewRenamePlayer}
                    >
                        {renaming ? 'Previewing…' : 'Preview rename →'}
                    </NeonButton>
                </div>
            </NeonCard>

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
                onConfirm={
                    modal.kind === 'merge' ? confirmMerge
                        : modal.kind === 'reverse' ? confirmReverse
                            : confirmRename
                }
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
    let title: string;
    let confirmLabel: string;
    if (state.kind === 'rename') {
        title = `Rename "${state.fromUsername}" → "${state.toUsername}"`;
        confirmLabel = 'Confirm rename';
    } else if (state.kind === 'merge') {
        title = `Merge "${state.preview.anonymousNickname}" → @${state.targetUserId}`;
        confirmLabel = 'Confirm merge';
    } else {
        title = `Reverse merge #${state.preview.mergeId}`;
        confirmLabel = 'Reverse merge';
    }

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
                    {state.kind === 'rename' ? (
                        <RenamePreviewBody state={state} />
                    ) : (
                        <MovePreviewBody state={state} />
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

/** Per-table rows-affected body for the rename dry-run preview. */
function RenamePreviewBody({ state }: { state: Extract<PreviewModalState, { kind: 'rename' }> }) {
    const { rowsAffected, total, globalIdentityWillUpdate } = state.preview;
    const rows: { label: string; count: number }[] = [
        { label: 'Submissions', count: rowsAffected.submissions },
        { label: 'Scores', count: rowsAffected.scores },
        { label: 'Community scores', count: rowsAffected.community_scores },
        { label: 'Score history', count: rowsAffected.score_history },
        { label: 'User mappings', count: rowsAffected.user_mappings },
        { label: 'Player aliases', count: rowsAffected.player_aliases },
    ];
    return (
        <>
            <p className="text-muted">
                Records to rewrite from <span className="text-primary">"{state.fromUsername}"</span> to{' '}
                <span className="text-neon-cyan">"{state.toUsername}"</span> in this room:
            </p>
            <div className="space-y-1.5">
                {rows.map(r => (
                    <div
                        key={r.label}
                        className="px-3 py-2 rounded bg-neon-cyan/5 border border-neon-cyan/20 flex items-center justify-between"
                    >
                        <span className="text-muted">{r.label}</span>
                        <strong className="text-neon-cyan">{r.count}</strong>
                    </div>
                ))}
            </div>
            <div className="px-3 py-2 rounded bg-neon-cyan/10 border border-neon-cyan/30 flex items-center justify-between">
                <span className="text-primary font-medium">Total rows affected</span>
                <strong className="text-neon-cyan">{total}</strong>
            </div>
            {!globalIdentityWillUpdate && (
                <div className="px-3 py-2 rounded bg-neon-amber/5 border border-neon-amber/20">
                    <p className="text-neon-amber inline-flex items-center gap-1">
                        <Clock size={12} />
                        Global identity (user mappings &amp; player aliases) stays put — requires a super-admin.
                    </p>
                </div>
            )}
        </>
    );
}

/** Moving-rows + frozen-tournament body shared by the merge and reverse previews. */
function MovePreviewBody({ state }: { state: Extract<PreviewModalState, { kind: 'merge' | 'reverse' }> }) {
    const movingCount = state.kind === 'merge' ? state.preview.totalMovingRows : state.preview.totalReturningRows;
    const frozenGroups = state.kind === 'merge' ? state.preview.frozenStay : state.preview.willStay;
    const frozenCount = state.kind === 'merge' ? state.preview.totalFrozenRows : state.preview.totalStayingRows;
    return (
        <>
            <div className="px-3 py-2 rounded bg-neon-cyan/5 border border-neon-cyan/20">
                <p className="text-primary">
                    <strong className="text-neon-cyan">{movingCount}</strong> score{movingCount === 1 ? '' : 's'} will{' '}
                    {state.kind === 'merge'
                        ? <>attribute to <span className="text-neon-cyan">@{state.targetUserId}</span></>
                        : 'return to the anonymous identity'}.
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
        </>
    );
}
