import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import SubmissionSheet, {
    PENDING_SUBMISSION_STORAGE_KEY,
    type SubmissionTarget,
} from './SubmissionSheet';
import { useViewerAuth } from '../contexts/ViewerAuthContext';

/**
 * Sprint 10 + 13 — resumes or cancels a server-stored submission draft after
 * the user returns from Discord OAuth. Mounted at the top level of PublicLayout.
 *
 * Two modes, one watcher:
 *   • ?submit-draft=<state>     — OAuth succeeded; open SubmissionSheet in
 *                                 auto-commit mode, POST /commit with the
 *                                 player token.
 *   • ?submit-cancelled=<state> — User clicked "Cancel" on Discord's OAuth
 *                                 screen (access_denied). Show a guest-or-discard
 *                                 modal; guest choice hits /commit-as-guest,
 *                                 discard calls DELETE on the draft.
 *
 * Flow:
 *   1. User submits anonymously, sees the collision prompt, clicks "Log in".
 *      SubmissionSheet stores the draft server-side, breadcrumbs `stateParam`
 *      in sessionStorage + `?submit-draft=<stateParam>` on the return URL.
 *   2. DiscordCallback lands the user at that URL on success, or rewrites it
 *      to `?submit-cancelled=<stateParam>` on access_denied.
 *   3. This watcher reads the query param (or sessionStorage fallback) and
 *      mounts the right UI.
 */

interface LocalDraft {
    stateParam: string;
    target: SubmissionTarget;
    createdAt: number;
}

function readSessionDraft(): LocalDraft | null {
    try {
        const raw = sessionStorage.getItem(PENDING_SUBMISSION_STORAGE_KEY);
        if (!raw) return null;
        return JSON.parse(raw) as LocalDraft;
    } catch {
        return null;
    }
}

type ResolvedDraft = { stateParam: string; target: SubmissionTarget; roomSlug?: string };

export default function PendingSubmissionWatcher({ roomSlug }: { roomSlug?: string }) {
    const { playerToken } = useViewerAuth();
    const [searchParams, setSearchParams] = useSearchParams();
    const [commitDraft, setCommitDraft] = useState<ResolvedDraft | null>(null);
    const [cancelDraft, setCancelDraft] = useState<ResolvedDraft | null>(null);
    const [cancelBusy, setCancelBusy] = useState(false);
    const [cancelError, setCancelError] = useState<string | null>(null);

    const stateParam = searchParams.get('submit-draft');
    const cancelledState = searchParams.get('submit-cancelled');

    // Resolve commit draft on successful OAuth return.
    useEffect(() => {
        if (!stateParam || !playerToken) return;
        let cancelled = false;
        (async () => {
            const local = readSessionDraft();
            if (local && local.stateParam === stateParam) {
                if (!cancelled) setCommitDraft({ stateParam, target: local.target, roomSlug });
                return;
            }
            try {
                const res = await fetch(`/api/submission-drafts/${encodeURIComponent(stateParam)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled && data?.target) {
                    setCommitDraft({ stateParam, target: data.target as SubmissionTarget, roomSlug });
                }
            } catch {
                /* draft missing or expired — silently drop */
            }
        })();
        return () => { cancelled = true; };
    }, [stateParam, playerToken, roomSlug]);

    // Resolve cancel draft when OAuth was aborted.
    useEffect(() => {
        if (!cancelledState) return;
        let cancelled = false;
        (async () => {
            const local = readSessionDraft();
            if (local && local.stateParam === cancelledState) {
                if (!cancelled) setCancelDraft({ stateParam: cancelledState, target: local.target, roomSlug });
                return;
            }
            try {
                const res = await fetch(`/api/submission-drafts/${encodeURIComponent(cancelledState)}`);
                if (!res.ok) return;
                const data = await res.json();
                if (!cancelled && data?.target) {
                    setCancelDraft({ stateParam: cancelledState, target: data.target as SubmissionTarget, roomSlug });
                }
            } catch { /* ignore */ }
        })();
        return () => { cancelled = true; };
    }, [cancelledState, roomSlug]);

    const clearCommit = () => {
        setCommitDraft(null);
        sessionStorage.removeItem(PENDING_SUBMISSION_STORAGE_KEY);
        const next = new URLSearchParams(searchParams);
        next.delete('submit-draft');
        setSearchParams(next, { replace: true });
    };

    const clearCancel = () => {
        setCancelDraft(null);
        sessionStorage.removeItem(PENDING_SUBMISSION_STORAGE_KEY);
        const next = new URLSearchParams(searchParams);
        next.delete('submit-cancelled');
        setSearchParams(next, { replace: true });
    };

    const handleGuestSubmit = async () => {
        if (!cancelDraft) return;
        setCancelBusy(true);
        setCancelError(null);
        try {
            const res = await fetch(
                `/api/submission-drafts/${encodeURIComponent(cancelDraft.stateParam)}/commit-as-guest`,
                { method: 'POST' },
            );
            if (!res.ok) {
                const data = await res.json().catch(() => ({ error: 'Guest submission failed.' }));
                throw new Error(data.error || 'Guest submission failed.');
            }
            clearCancel();
        } catch (err) {
            setCancelError(err instanceof Error ? err.message : 'Guest submission failed.');
        } finally {
            setCancelBusy(false);
        }
    };

    const handleDiscard = async () => {
        if (!cancelDraft) return;
        setCancelBusy(true);
        try {
            await fetch(`/api/submission-drafts/${encodeURIComponent(cancelDraft.stateParam)}`, {
                method: 'DELETE',
            });
        } catch { /* best effort */ }
        clearCancel();
        setCancelBusy(false);
    };

    return (
        <>
            {commitDraft && (
                <SubmissionSheet
                    target={commitDraft.target}
                    commitDraftState={commitDraft.stateParam}
                    roomSlug={commitDraft.roomSlug}
                    onClose={clearCommit}
                />
            )}

            {cancelDraft && (
                <div
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="oauth-cancel-title"
                    className="fixed inset-0 z-50 flex items-center justify-center bg-deep/80 backdrop-blur-sm px-4"
                >
                    <div className="bg-surface border border-border rounded-lg shadow-2xl w-full max-w-md overflow-hidden">
                        <div className="px-4 py-3 border-b border-border/30">
                            <h3 id="oauth-cancel-title" className="font-display text-sm font-bold text-primary">
                                Login cancelled
                            </h3>
                        </div>
                        <div className="px-4 py-4 text-xs text-muted space-y-3">
                            <p>
                                You cancelled the Discord login. Your score for{' '}
                                <span className="text-primary font-medium">
                                    {cancelDraft.target.kind === 'global' ? cancelDraft.target.gameName : cancelDraft.target.gameName}
                                </span>{' '}
                                is still saved. Submit it as a guest instead?
                            </p>
                            {cancelError && (
                                <p className="text-neon-amber">{cancelError}</p>
                            )}
                        </div>
                        <div className="px-4 py-3 border-t border-border/30 flex items-center justify-end gap-2">
                            <button
                                type="button"
                                onClick={handleDiscard}
                                disabled={cancelBusy}
                                className="px-3 py-1.5 text-xs rounded border border-border text-muted hover:text-neon-amber hover:border-neon-amber/40 transition-colors cursor-pointer disabled:opacity-50"
                            >
                                Discard
                            </button>
                            <button
                                type="button"
                                onClick={handleGuestSubmit}
                                disabled={cancelBusy}
                                className="px-4 py-1.5 text-xs rounded border border-neon-cyan/40 bg-neon-cyan/10 text-neon-cyan hover:bg-neon-cyan/20 transition-colors cursor-pointer disabled:opacity-50"
                            >
                                {cancelBusy ? 'Submitting…' : 'Submit as guest'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
