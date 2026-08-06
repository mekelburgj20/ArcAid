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
 * v2.79.0 (login mandate) — `SubmissionSheet` no longer has an anonymous
 * flow, so nothing in the app creates NEW drafts anymore (login is required
 * before the form ever renders, with nothing typed yet to preserve across an
 * OAuth round-trip). This watcher stays mounted only to resolve any draft
 * that was already in flight when this change deployed:
 *   • ?submit-draft=<state>     — OAuth succeeded; open SubmissionSheet in
 *                                 auto-commit mode, POST /commit with the
 *                                 player token.
 *   • ?submit-cancelled=<state> — User clicked "Cancel" on Discord's OAuth
 *                                 screen (access_denied). Offer to discard the
 *                                 saved draft (the "submit as guest" fallback
 *                                 this used to offer called a route that's
 *                                 gone now — every submission requires login).
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

    // Resolve cancel draft. Two paths:
    //   1. Explicit (v2.0.0): DiscordCallback set ?submit-cancelled=<state> after access_denied.
    //   2. Implicit (v2.0.1): user closed the Discord tab / hit the X — no redirect.
    //      They reach the origin URL some other way; sessionStorage still holds
    //      the breadcrumb. After a short settling delay we surface the modal
    //      so the draft doesn't silently expire.
    useEffect(() => {
        let cancelled = false;

        const resolveCancel = async (state: string) => {
            const local = readSessionDraft();
            if (local && local.stateParam === state) {
                if (!cancelled) setCancelDraft({ stateParam: state, target: local.target, roomSlug });
                return;
            }
            try {
                const res = await fetch(`/api/submission-drafts/${encodeURIComponent(state)}`);
                if (!res.ok) {
                    // Draft gone — clean up stale breadcrumb.
                    sessionStorage.removeItem(PENDING_SUBMISSION_STORAGE_KEY);
                    return;
                }
                const data = await res.json();
                if (!cancelled && data?.target) {
                    setCancelDraft({ stateParam: state, target: data.target as SubmissionTarget, roomSlug });
                }
            } catch { /* ignore */ }
        };

        if (cancelledState) {
            resolveCancel(cancelledState);
            return () => { cancelled = true; };
        }

        // Implicit-cancel detection: sessionStorage has a draft and we're NOT
        // in the middle of the commit path. Delay so a slow commit effect
        // running first (?submit-draft + token) gets a chance to claim it.
        if (!stateParam && !playerToken) {
            const local = readSessionDraft();
            if (local) {
                const timer = window.setTimeout(() => {
                    if (!cancelled) resolveCancel(local.stateParam);
                }, 800);
                return () => { cancelled = true; window.clearTimeout(timer); };
            }
        }

        return () => { cancelled = true; };
    }, [cancelledState, stateParam, playerToken, roomSlug]);

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
                                    {cancelDraft.target.gameName}
                                </span>{' '}
                                was not submitted — scores require login.
                            </p>
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
                        </div>
                    </div>
                </div>
            )}
        </>
    );
}
