import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Camera, Trash2, Keyboard, AlertTriangle, LogIn, UserX, Trophy } from 'lucide-react';
import NeonButton from './NeonButton';
import OnScreenKeyboard from './OnScreenKeyboard';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import { getPlatformDisplay } from '../lib/platforms';
import type { SubmitRank } from '../lib/api';

/**
 * Unified submission sheet (Sprint 3 + Sprint 10, plan §10 / §13 / §15).
 *
 * Targets (discriminated union):
 *   • tournament → POST /api/rooms/:roomId/submit-score/:gameName
 *   • freeplay   → POST /api/rooms/:roomId/freeplay-score
 *   • global     → POST /api/global/scores
 *
 * Sprint 10 additions:
 *   • Cooldown banner for locked tournament games (submission NOT blocked, §13).
 *   • Anonymous-collision claim prompt (§15): before an unauthenticated room
 *     submit, POST /submit/anonymous-check runs the nickname through the room's
 *     Discord guild. If a member matches, render the claim prompt so the user
 *     can log in (attributing the score) or continue as guest.
 *   • OAuth handoff: the "Log in" branch uploads the pending submission to
 *     /api/submission-drafts/:state (server-side, 5-min TTL) and stashes the
 *     state param in sessionStorage, then triggers Discord OAuth. On return,
 *     a PendingSubmissionWatcher re-mounts this sheet in auto-commit mode.
 */

export type SubmissionTarget =
    | {
          kind: 'tournament';
          roomId: string;
          gameName: string;
          gameStatus?: string;
          requirePhoto?: boolean;
      }
    | {
          kind: 'freeplay';
          roomId: string;
          globalGameId: string;
          gameName: string;
      }
    | {
          kind: 'global';
          globalGameId: string;
          gameName: string;
          presetDisplayName?: string;
      };

export interface SubmissionSheetProps {
    target: SubmissionTarget;
    onClose: () => void;
    onSubmitted?: () => void;
    /** Optional initial player-name override. */
    initialPlayerName?: string;
    /**
     * Sprint 10: when set, the sheet skips the form and immediately commits the
     * server-stored draft via POST /submission-drafts/:state/commit (runs after
     * the user returns from Discord OAuth). The sheet briefly shows progress
     * and closes on success.
     */
    commitDraftState?: string;
    /** Slug of the room the user is on — needed to kick off Discord OAuth. */
    roomSlug?: string;
    /**
     * v2.0.1: when true and the viewer has no player token, the sheet renders
     * a login-required state immediately instead of the form. Saves the user
     * from typing name+score+photo only to be rejected server-side.
     */
    requireLogin?: boolean;
}

type Phase =
    | 'form'
    | 'loginRequired'         // v2.0.1 — room requires login + viewer not authed
    | 'checkingCollision'     // running anonymous-check / name-check
    | 'claimPrompt'           // v2.0.0 Discord-guild-member nickname match
    | 'nameCollisionPrompt'   // v2.2.5 — name is taken by another claimant in this room
    | 'submitting'
    | 'committingDraft'
    | 'success'
    | 'error';

function canHaveAnonymousFlow(target: SubmissionTarget): boolean {
    // Global submissions already require Discord login — no anonymous prompt.
    return target.kind !== 'global';
}

function isCooldownLocked(target: SubmissionTarget): boolean {
    return target.kind === 'tournament' && !!target.gameStatus && target.gameStatus !== 'ACTIVE';
}

function photoRequired(target: SubmissionTarget): boolean {
    if (target.kind === 'freeplay' || target.kind === 'global') return true;
    return !!target.requirePhoto;
}

function generateStateParam(): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
    return `st_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Local score formatter — there is no shared export; this mirrors the
 * scoreboard/ScoreList.tsx variant (≥1T → "X.XT", else locale-grouped).
 */
function formatScore(n: number): string {
    if (n >= 1_000_000_000_000) return `${(n / 1_000_000_000_000).toFixed(1)}T`;
    return n.toLocaleString();
}

export const PENDING_SUBMISSION_STORAGE_KEY = 'arcaid_pending_submission';

/** Guest-conversion CTA cadence — show the Discord login pitch on every Nth guest submit. */
const GUEST_CTA_EVERY_N = 3;
const GUEST_SUBMIT_COUNT_KEY = 'arcaid_guest_submit_count';

export default function SubmissionSheet({
    target,
    onClose,
    onSubmitted,
    initialPlayerName,
    commitDraftState,
    roomSlug,
    requireLogin,
}: SubmissionSheetProps) {
    const { discordUser, playerToken, loginWithDiscord } = useViewerAuth();
    const [playerName, setPlayerName] = useState(
        initialPlayerName ??
            discordUser?.username ??
            localStorage.getItem('arcaid-player-name') ??
            (target.kind === 'global' ? target.presetDisplayName ?? '' : ''),
    );
    const [score, setScore] = useState('');
    const [photoFile, setPhotoFile] = useState<File | null>(null);
    const [photoPreview, setPhotoPreview] = useState<string | null>(null);
    const [excludeFromGlobal, setExcludeFromGlobal] = useState(false);
    // v2.5.0: per-score platform stratification. `null` until the resolver
    // endpoint replies. `[]` means the resolver returned no submittable
    // platforms (game has no platforms or active tournament excluded all).
    const [submittablePlatforms, setSubmittablePlatforms] = useState<string[] | null>(null);
    /**
     * Full pre-rule platform set for the game (catalogue ∪ room tags). Used
     * only to disambiguate the single-platform chip's caption: "only platform
     * for this game" (game truly has one) vs "only platform allowed by this
     * tournament" (game has many, tournament rules narrowed to one).
     */
    const [fullGamePlatforms, setFullGamePlatforms] = useState<string[]>([]);
    const [platform, setPlatform] = useState<string>('');
    const [phase, setPhase] = useState<Phase>(() => {
        if (commitDraftState) return 'committingDraft';
        // v2.0.1: pre-form login gate when room requires auth and viewer isn't authenticated.
        if (requireLogin && !playerToken && target.kind !== 'global') return 'loginRequired';
        return 'form';
    });
    const [matchedNickname, setMatchedNickname] = useState<string | null>(null);
    // S5 — submit-moment ranking shown on the persistent success card.
    const [submitRank, setSubmitRank] = useState<SubmitRank | null>(null);
    // S5 — number of guest submits so far (drives the every-Nth login CTA).
    const [guestCount, setGuestCount] = useState<number>(() => {
        const raw = localStorage.getItem(GUEST_SUBMIT_COUNT_KEY);
        const n = raw ? parseInt(raw, 10) : 0;
        return Number.isFinite(n) ? n : 0;
    });
    // v2.2.5 — pre-submit name collision prompt state.
    const [collisionRequested, setCollisionRequested] = useState<string>('');
    const [collisionInput, setCollisionInput] = useState<string>('');
    const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
    const [activeField, setActiveField] = useState<'name' | 'score' | null>(null);
    const [showKeyboard, setShowKeyboard] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const scoreRef = useRef<HTMLInputElement>(null);
    const backdropMouseDown = useRef(false);
    const draftCommittedRef = useRef(false);

    const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);

    useEffect(() => {
        return () => {
            if (photoPreview) URL.revokeObjectURL(photoPreview);
        };
    }, [photoPreview]);

    // v2.5.0: fetch the submittable platform set from the resolver endpoint.
    // - tournament/freeplay: scoped by roomId+gameName, intersected with
    //   active tournament rules.
    // - global: read straight from global_games.platforms.
    // Resolver runs once on mount per target.
    useEffect(() => {
        if (commitDraftState) return; // draft-commit path skips the form entirely.
        let cancelled = false;
        (async () => {
            const params = new URLSearchParams();
            if (target.kind === 'global') {
                params.set('globalGameId', target.globalGameId);
            } else {
                params.set('roomId', target.roomId);
                params.set('gameName', target.gameName);
            }
            try {
                const res = await fetch(`/api/submit/platforms?${params.toString()}`);
                const data = await res.json().catch(() => ({}));
                if (cancelled) return;
                const list: string[] = Array.isArray(data?.submittable) ? data.submittable : [];
                const fullList: string[] = Array.isArray(data?.platforms) ? data.platforms : [];
                setSubmittablePlatforms(list);
                setFullGamePlatforms(fullList);
                // Auto-fill when the picker has only one option.
                if (list.length === 1) setPlatform(list[0]);
            } catch {
                if (!cancelled) setSubmittablePlatforms([]);
            }
        })();
        return () => { cancelled = true; };
    }, [target, commitDraftState]);

    // Sprint 10 OAuth-return flow: commit a server-stored draft and close.
    useEffect(() => {
        if (!commitDraftState || draftCommittedRef.current) return;
        if (!playerToken) {
            // Can't commit without auth — likely OAuth failed or cancelled. Surface to user.
            setPhase('error');
            setMessage({ text: 'Log in did not complete. The pending score was discarded.', type: 'error' });
            return;
        }
        draftCommittedRef.current = true;
        (async () => {
            try {
                const res = await fetch(`/api/submission-drafts/${encodeURIComponent(commitDraftState)}/commit`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${playerToken}` },
                });
                if (!res.ok) {
                    const data = await res.json().catch(() => ({ error: 'Draft could not be committed.' }));
                    throw new Error((data as { error?: string }).error || 'Draft could not be committed.');
                }
                // S5: the commit endpoint returns the same shape (incl. rank) as the
                // direct submit paths. Route into the persistent success card.
                const commitData = await res.json().catch(() => ({} as { rank?: SubmitRank | null }));
                setSubmitRank((commitData as { rank?: SubmitRank | null })?.rank ?? null);
                setPhase('success');
                setMessage({ text: 'Score submitted!', type: 'success' });
            } catch (err) {
                setPhase('error');
                setMessage({ text: err instanceof Error ? err.message : 'Draft submit failed', type: 'error' });
            }
        })();
    }, [commitDraftState, playerToken]);

    const handlePhotoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        if (photoPreview) URL.revokeObjectURL(photoPreview);
        setPhotoFile(file);
        setPhotoPreview(URL.createObjectURL(file));
    };

    const clearPhoto = () => {
        if (photoPreview) URL.revokeObjectURL(photoPreview);
        setPhotoFile(null);
        setPhotoPreview(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    /**
     * Ensure a persisted anon-id so first-claim-wins can key on it.
     * Generated lazily on first submit, same UUID across page reloads.
     */
    const ensureAnonId = (): string => {
        let anonId = localStorage.getItem('arcaid_anon_id');
        if (!anonId) {
            anonId = typeof crypto !== 'undefined' && 'randomUUID' in crypto
                ? crypto.randomUUID()
                : `anon_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
            localStorage.setItem('arcaid_anon_id', anonId);
        }
        return anonId;
    };

    /** POST score directly as-the-current-user (authenticated or anonymous). */
    const submitScoreNow = async (overrideName?: string) => {
        const trimmedName = (overrideName ?? playerName).trim();
        const scoreNum = parseInt(score, 10);
        if (!trimmedName || isNaN(scoreNum) || scoreNum < 0) return;
        if (photoRequired(target) && !photoFile) return;
        if (!platform) return; // v2.5.0: picker hasn't been resolved yet — guard against stray click.

        setPhase('submitting');
        setMessage(null);
        try {
            const formData = new FormData();
            formData.append('score', String(scoreNum));
            formData.append('platform', platform);
            if (photoFile) formData.append('photo', photoFile);

            let url = '';
            const headers: Record<string, string> = {};
            headers['x-user-id'] = ensureAnonId();
            if (playerToken) headers.Authorization = `Bearer ${playerToken}`;

            if (target.kind === 'tournament') {
                formData.append('username', trimmedName);
                if (excludeFromGlobal) formData.append('excludeGlobal', 'true');
                url = `/api/rooms/${target.roomId}/submit-score/${encodeURIComponent(target.gameName)}`;
            } else if (target.kind === 'freeplay') {
                formData.append('username', trimmedName);
                formData.append('globalGameId', target.globalGameId);
                if (excludeFromGlobal) formData.append('excludeGlobal', 'true');
                url = `/api/rooms/${target.roomId}/freeplay-score`;
            } else {
                formData.append('displayName', trimmedName);
                formData.append('globalGameId', target.globalGameId);
                formData.append('excludeFromGlobal', excludeFromGlobal ? 'true' : 'false');
                url = '/api/global/scores';
            }

            const res = await fetch(url, { method: 'POST', headers, body: formData });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error((data as { error?: string }).error || 'Submission failed');
            }

            // v2.2.5: store the *resolved* display name (may differ from what was
            // typed if the server auto-suffixed it) so the next session prefills
            // with the sticky identity, not the now-stale request.
            const responseData = data as { displayName?: string; suffixed?: boolean; requested?: string; rank?: SubmitRank | null };
            const resolvedName = responseData?.displayName || trimmedName;
            localStorage.setItem('arcaid-player-name', resolvedName);
            setPlayerName(resolvedName);
            // S5: capture the submit-moment rank (best-effort; null when the BE
            // couldn't compute it — the card falls back to a plain success line).
            setSubmitRank(responseData?.rank ?? null);
            // S5: count guest submits so the success card can pitch login every Nth time.
            if (!playerToken) {
                setGuestCount(prev => {
                    const next = prev + 1;
                    localStorage.setItem(GUEST_SUBMIT_COUNT_KEY, String(next));
                    return next;
                });
            }
            setPhase('success');
            const successText = responseData?.suffixed && responseData.displayName && responseData.requested
                ? `Submitted as ${responseData.displayName} — "${responseData.requested}" is already in use in this room.`
                : 'Score submitted!';
            setMessage({ text: successText, type: 'success' });
            // S5: the success phase now persists until the user dismisses it
            // (Done button / View leaderboard nav) — no auto-close timer.
        } catch (err) {
            setPhase('error');
            setMessage({ text: err instanceof Error ? err.message : 'Submission failed', type: 'error' });
        }
    };

    /**
     * v2.2.5 — pre-submit name availability check. If the name is taken by
     * another claimant in this room, surface the collision prompt with the
     * server's suggested alternative. Otherwise submit normally. Failures
     * fall through to a direct submit (server will auto-suffix as fallback).
     */
    const runNameCheckThenSubmit = async (nameToUse: string) => {
        if (!canHaveAnonymousFlow(target)) return submitScoreNow(nameToUse);
        const trimmed = nameToUse.trim();
        if (!trimmed) return;
        const roomId = target.kind === 'tournament' || target.kind === 'freeplay' ? target.roomId : '';
        if (!roomId) return submitScoreNow(nameToUse);
        setPhase('checkingCollision');
        setMessage(null);
        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            headers['x-user-id'] = ensureAnonId();
            if (playerToken) headers.Authorization = `Bearer ${playerToken}`;
            const res = await fetch(`/api/rooms/${roomId}/submit/name-check`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: trimmed }),
            });
            const data = await res.json().catch(() => ({ available: true }));
            if (!res.ok || data?.available) {
                return submitScoreNow(trimmed);
            }
            setCollisionRequested(trimmed);
            setCollisionInput(typeof data.suggestion === 'string' && data.suggestion.length ? data.suggestion : `${trimmed}_2`);
            setPhase('nameCollisionPrompt');
        } catch {
            // Name-check failure shouldn't block the submit — fall through.
            return submitScoreNow(trimmed);
        }
    };

    const handleSubmitClick = async () => {
        const trimmedName = playerName.trim();
        const scoreNum = parseInt(score, 10);
        if (!trimmedName || isNaN(scoreNum) || scoreNum < 0) return;
        if (photoRequired(target) && !photoFile) return;

        // Authenticated users and global submissions bypass the Discord-guild
        // claim prompt. They still run through runNameCheckThenSubmit so
        // a Discord user re-submitting under a name owned by someone else in
        // this room also gets the pre-submit collision prompt (v2.2.5).
        if (playerToken || !canHaveAnonymousFlow(target)) {
            return runNameCheckThenSubmit(trimmedName);
        }

        // Anonymous room submit: first check for a Discord-guild member matching
        // this name (v2.0.0 claim prompt). If no guild match, fall through to
        // the room-level name-availability check (v2.2.5).
        setPhase('checkingCollision');
        setMessage(null);
        try {
            const roomId = target.kind === 'tournament' || target.kind === 'freeplay' ? target.roomId : '';
            const res = await fetch(`/api/rooms/${roomId}/submit/anonymous-check`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: trimmedName }),
            });
            const data = await res.json().catch(() => ({ match: false }));
            if (data?.match && typeof data.serverNickname === 'string') {
                setMatchedNickname(data.serverNickname);
                setPhase('claimPrompt');
                return;
            }
            // No guild match — run the room-level name-check.
            return runNameCheckThenSubmit(trimmedName);
        } catch {
            // If the check fails we don't want to block the submission. Fall through
            // to the name-check path; if that also fails, submitScoreNow handles it.
            return runNameCheckThenSubmit(trimmedName);
        }
    };

    /** Claim prompt "Log in" path: save draft server-side + sessionStorage, then OAuth. */
    const handleLogInClaim = async () => {
        if (!roomSlug) {
            setPhase('error');
            setMessage({ text: 'Login is unavailable for this submission surface.', type: 'error' });
            return;
        }
        const trimmedName = playerName.trim();
        const scoreNum = parseInt(score, 10);
        const stateParam = generateStateParam();

        try {
            // Server-side draft (authoritative storage of the photo + fields)
            const formData = new FormData();
            formData.append('target', JSON.stringify(target));
            formData.append('playerName', trimmedName);
            formData.append('score', String(scoreNum));
            if (photoFile) formData.append('photo', photoFile);
            if (excludeFromGlobal) formData.append('excludeFromGlobal', 'true');
            // v2.5.0: stash the chosen platform so the post-OAuth commit handler
            // can replay it through the same submit endpoint that now requires it.
            if (platform) formData.append('platform', platform);
            const res = await fetch(`/api/submission-drafts/${encodeURIComponent(stateParam)}`, {
                method: 'POST',
                body: formData,
            });
            if (!res.ok) throw new Error('Could not save your score before logging in.');

            // Client-side breadcrumb so the landing page can auto-resume without
            // needing the stateParam on the URL. TTL is enforced server-side too.
            sessionStorage.setItem(
                PENDING_SUBMISSION_STORAGE_KEY,
                JSON.stringify({
                    stateParam,
                    target,
                    createdAt: Date.now(),
                }),
            );

            // Return to the current URL with a marker so the watcher opens the sheet.
            const returnUrl = new URL(window.location.href);
            returnUrl.searchParams.set('submit-draft', stateParam);
            localStorage.setItem('arcaid_player_return', returnUrl.pathname + returnUrl.search);
            await loginWithDiscord(roomSlug, returnUrl.pathname + returnUrl.search);
            // loginWithDiscord navigates away — no further UI updates needed.
        } catch (err) {
            setPhase('error');
            setMessage({ text: err instanceof Error ? err.message : 'Login flow failed', type: 'error' });
        }
    };

    const handleKeyPress = (key: string) => {
        if (activeField === 'name') {
            setPlayerName(prev => prev + key);
            nameRef.current?.focus();
        } else if (activeField === 'score') {
            if (/\d/.test(key)) setScore(prev => prev + key);
            scoreRef.current?.focus();
        }
    };

    const handleBackspace = () => {
        if (activeField === 'name') setPlayerName(prev => prev.slice(0, -1));
        else if (activeField === 'score') setScore(prev => prev.slice(0, -1));
    };

    const handleDone = () => {
        setActiveField(null);
        setShowKeyboard(false);
    };

    const needsPhoto = photoRequired(target);
    const cooldown = isCooldownLocked(target);
    const submitting = phase === 'submitting' || phase === 'checkingCollision' || phase === 'committingDraft';
    // v2.5.0: picker must be resolved AND platform chosen before we allow submit.
    const platformsResolved = submittablePlatforms !== null;
    const platformChosen = platform.trim() !== '';
    const canSubmit = playerName.trim() && score && !isNaN(parseInt(score, 10)) && parseInt(score, 10) >= 0
        && (!needsPhoto || !!photoFile) && platformsResolved && platformChosen && !submitting;
    const nameLabel = target.kind === 'global' ? 'Display Name' : 'Player Name';

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="submission-sheet-title"
            className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-deep/80 backdrop-blur-sm"
            onMouseDown={e => { backdropMouseDown.current = e.target === e.currentTarget; }}
            onClick={e => { if (e.target === e.currentTarget && backdropMouseDown.current) onClose(); }}
        >
            <div
                className="bg-surface border border-border rounded-t-xl sm:rounded-lg shadow-2xl w-full sm:max-w-md overflow-hidden flex flex-col max-h-[90vh]"
                onClick={e => e.stopPropagation()}
            >
                <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
                    <h3 id="submission-sheet-title" className="font-display font-bold text-primary truncate">
                        {target.gameName}
                    </h3>
                    <button
                        type="button"
                        onClick={onClose}
                        aria-label="Close"
                        className="text-muted hover:text-primary transition-colors cursor-pointer"
                    >
                        <X size={20} />
                    </button>
                </div>

                {phase === 'committingDraft' ? (
                    <div className="px-4 py-10 text-center space-y-3">
                        <div className="w-8 h-8 border-2 border-neon-cyan/30 border-t-neon-cyan rounded-full animate-spin mx-auto" />
                        <p className="text-muted text-sm">Submitting your score as {discordUser?.username ?? 'you'}…</p>
                    </div>
                ) : phase === 'success' ? (
                    <div className="px-4 py-8 text-center space-y-4">
                        {submitRank === null || submitRank.rank == null ? (
                            /* Best-effort fallback — BE returned null or an
                               all-null result (rank couldn't be computed).
                               Preserve the suffixed-name message text. */
                            <p className="text-neon-green font-display text-sm">{message?.text ?? 'Score submitted!'}</p>
                        ) : submitRank.rank === 1 ? (
                            /* New high score — amber/gold treatment. */
                            <div className="space-y-2">
                                <div className="w-12 h-12 rounded-full bg-neon-amber/10 border border-neon-amber/40 text-neon-amber flex items-center justify-center mx-auto">
                                    <Trophy size={22} />
                                </div>
                                <p className="text-neon-amber font-display font-bold text-lg">New high score!</p>
                                <p className="text-sm text-primary">You are #1 of {submitRank.totalPlayers}</p>
                                {message?.type === 'success' && message.text !== 'Score submitted!' && (
                                    <p className="text-xs text-muted">{message.text}</p>
                                )}
                            </div>
                        ) : (
                            /* Ranked below #1. */
                            <div className="space-y-2">
                                <div className="w-12 h-12 rounded-full bg-neon-cyan/10 border border-neon-cyan/40 text-neon-cyan flex items-center justify-center mx-auto">
                                    <Trophy size={22} />
                                </div>
                                <p className="text-primary font-display font-bold text-lg">
                                    You are #{submitRank.rank} of {submitRank.totalPlayers}
                                </p>
                                {submitRank.gapToNext != null && submitRank.gapToNext > 0 && (
                                    <p className="text-sm text-neon-cyan">{formatScore(submitRank.gapToNext)} to next rank</p>
                                )}
                                {submitRank.gapToFirst != null && submitRank.gapToFirst > 0 && (
                                    <p className="text-xs text-muted">{formatScore(submitRank.gapToFirst)} behind #1</p>
                                )}
                                {message?.type === 'success' && message.text !== 'Score submitted!' && (
                                    <p className="text-xs text-muted">{message.text}</p>
                                )}
                            </div>
                        )}

                        {/* S5 guest-conversion CTA — every Nth guest submit. */}
                        {!playerToken && roomSlug && guestCount % GUEST_CTA_EVERY_N === 0 && (
                            <NeonButton
                                onClick={() => loginWithDiscord(roomSlug)}
                                className="w-full inline-flex items-center justify-center gap-2"
                            >
                                <LogIn size={16} /> Log in with Discord to claim your scores and get dethrone alerts
                            </NeonButton>
                        )}

                        <div className="grid grid-cols-1 gap-2 pt-1">
                            {/* View leaderboard — room GameDetail for tournament/freeplay,
                                global game detail for global submissions. */}
                            {target.kind === 'global' ? (
                                <Link
                                    to={`/games/${target.globalGameId}`}
                                    onClick={onClose}
                                    className="w-full px-4 py-2 rounded border border-neon-cyan/40 text-neon-cyan text-sm hover:bg-neon-cyan/10 transition-colors text-center"
                                >
                                    View leaderboard
                                </Link>
                            ) : roomSlug ? (
                                <Link
                                    to={`/${roomSlug}/games/${encodeURIComponent(target.gameName)}`}
                                    onClick={onClose}
                                    className="w-full px-4 py-2 rounded border border-neon-cyan/40 text-neon-cyan text-sm hover:bg-neon-cyan/10 transition-colors text-center"
                                >
                                    View leaderboard
                                </Link>
                            ) : null}
                            {/* Done — explicit dismissal. onSubmitted is the
                                caller's terminal action (every provider closes or
                                navigates: setX(null) / navigate), so we call it
                                INSTEAD of onClose to avoid a follow-on nav
                                clobbering ScoreSubmit's deep-link. Callers that
                                omit onSubmitted (PendingSubmissionWatcher) fall
                                back to onClose so Done still dismisses the sheet. */}
                            <NeonButton onClick={() => (onSubmitted ?? onClose)()} className="w-full">
                                Done
                            </NeonButton>
                        </div>
                    </div>
                ) : phase === 'error' ? (
                    <div className="px-4 py-8 text-center space-y-4">
                        <p className="text-neon-amber text-sm">{message?.text ?? 'Submission failed.'}</p>
                        <NeonButton onClick={() => { setPhase('form'); setMessage(null); }} className="w-full">
                            Try Again
                        </NeonButton>
                    </div>
                ) : phase === 'loginRequired' ? (
                    <div className="px-4 py-6 space-y-4">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan flex items-center justify-center flex-shrink-0">
                                <LogIn size={18} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-primary font-display font-bold mb-1">
                                    Log in to submit a score
                                </p>
                                <p className="text-xs text-muted leading-relaxed">
                                    This room requires a Discord login for score submissions. Log in to submit on <span className="text-primary font-medium">{target.gameName}</span>.
                                </p>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-2">
                            <NeonButton
                                onClick={() => roomSlug && loginWithDiscord(roomSlug)}
                                disabled={!roomSlug}
                                className="w-full inline-flex items-center justify-center gap-2"
                            >
                                <LogIn size={16} /> Log in with Discord
                            </NeonButton>
                            <button
                                type="button"
                                onClick={onClose}
                                className="w-full px-4 py-2 rounded border border-border text-muted text-sm hover:text-primary hover:border-border/80 transition-colors cursor-pointer"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : phase === 'claimPrompt' ? (
                    <div className="px-4 py-6 space-y-4">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full bg-neon-cyan/10 border border-neon-cyan/30 text-neon-cyan flex items-center justify-center flex-shrink-0">
                                <LogIn size={18} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-primary font-display font-bold mb-1">
                                    Is this you?
                                </p>
                                <p className="text-xs text-muted leading-relaxed">
                                    <span className="text-neon-cyan font-medium">{matchedNickname}</span> is
                                    already a member of this Discord server. Log in to claim this score so it
                                    ties to your account, or continue as a guest and submit anonymously.
                                </p>
                            </div>
                        </div>
                        <div className="grid grid-cols-1 gap-2">
                            <NeonButton onClick={handleLogInClaim} className="w-full inline-flex items-center justify-center gap-2">
                                <LogIn size={16} /> Log in with Discord
                            </NeonButton>
                            <button
                                type="button"
                                onClick={() => runNameCheckThenSubmit(playerName)}
                                className="w-full px-4 py-2 rounded border border-border text-muted text-sm hover:text-primary hover:border-border/80 transition-colors cursor-pointer inline-flex items-center justify-center gap-2"
                            >
                                <UserX size={14} /> Continue as guest
                            </button>
                        </div>
                    </div>
                ) : phase === 'nameCollisionPrompt' ? (
                    /* v2.2.5 — pre-submit collision prompt. Editable input
                       pre-filled with the server's next-free suggestion; user
                       can accept or type something else. "Submit" re-runs the
                       check against whatever's currently in the field. */
                    <div className="px-4 py-6 space-y-4">
                        <div className="flex items-start gap-3">
                            <div className="w-10 h-10 rounded-full bg-neon-amber/10 border border-neon-amber/30 text-neon-amber flex items-center justify-center flex-shrink-0">
                                <AlertTriangle size={18} />
                            </div>
                            <div className="flex-1">
                                <p className="text-sm text-primary font-display font-bold mb-1">
                                    Name already in use
                                </p>
                                <p className="text-xs text-muted leading-relaxed">
                                    <span className="text-neon-amber font-medium">{collisionRequested}</span>{' '}
                                    is taken in this room. Pick a different name to submit under, or accept
                                    the suggestion below.
                                </p>
                            </div>
                        </div>
                        <div>
                            <label className="text-xs text-faint block mb-1">Name</label>
                            <input
                                type="text"
                                value={collisionInput}
                                onChange={e => setCollisionInput(e.target.value)}
                                className="w-full px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                                maxLength={100}
                                autoFocus
                            />
                        </div>
                        <div className="grid grid-cols-1 gap-2">
                            <NeonButton
                                onClick={() => {
                                    const next = collisionInput.trim();
                                    if (!next) return;
                                    // Re-run the check with the edited name. If it's free,
                                    // submits directly; if still taken, prompt refreshes
                                    // with a new suggestion.
                                    runNameCheckThenSubmit(next);
                                }}
                                disabled={!collisionInput.trim()}
                                className="w-full"
                            >
                                Submit as {collisionInput.trim() || '—'}
                            </NeonButton>
                            <button
                                type="button"
                                onClick={() => setPhase('form')}
                                className="w-full px-4 py-2 rounded border border-border text-muted text-sm hover:text-primary hover:border-border/80 transition-colors cursor-pointer"
                            >
                                Back
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
                            {cooldown && (
                                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-neon-amber/10 border border-neon-amber/30">
                                    <AlertTriangle size={14} className="text-neon-amber flex-shrink-0 mt-0.5" />
                                    <p className="text-xs text-neon-amber leading-relaxed">
                                        This score won't count toward the active tournament (cooldown). It still posts to the room leaderboard.
                                    </p>
                                </div>
                            )}

                            <div>
                                <label className="text-xs text-faint block mb-1">{nameLabel}</label>
                                <div className="flex gap-1">
                                    {/* On touch devices the in-app OnScreenKeyboard drives
                                        input; inputMode='none' keeps the field focusable
                                        (so handleKeyPress's nameRef.current?.focus() works)
                                        while suppressing the native OS keyboard. type='text'
                                        + onChange are retained so hardware keyboards and
                                        paste still work on desktop and mobile. Mirrors the
                                        score-field pattern below; gated on isTouchDevice so
                                        desktop focus/toggle behavior is unchanged. */}
                                    <input
                                        ref={nameRef}
                                        type="text"
                                        inputMode={isTouchDevice ? 'none' : undefined}
                                        value={playerName}
                                        onChange={e => setPlayerName(e.target.value)}
                                        onFocus={() => { setActiveField('name'); if (isTouchDevice) setShowKeyboard(true); }}
                                        placeholder="Your name"
                                        className="flex-1 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                                        maxLength={100}
                                    />
                                    {!isTouchDevice && (
                                        <button
                                            type="button"
                                            onClick={() => { setActiveField('name'); setShowKeyboard(!showKeyboard); }}
                                            className="px-2 text-muted hover:text-neon-cyan transition-colors cursor-pointer"
                                            title="Toggle on-screen keyboard"
                                        >
                                            <Keyboard size={18} />
                                        </button>
                                    )}
                                </div>
                            </div>

                            <div>
                                <label className="text-xs text-faint block mb-1">Score</label>
                                <div className="flex gap-1">
                                    {/* On touch devices we drive input via the in-app
                                        OnScreenKeyboard (opens on focus below) and
                                        suppress the OS keypad — type=number +
                                        inputMode=numeric both force iOS Safari to
                                        show the native keypad, which covered the
                                        score photo. type=text + inputMode=none is
                                        the cross-browser way to keep the field
                                        focusable without summoning a virtual
                                        keyboard. Desktop keeps numeric for the
                                        spinner / hardware-keypad behavior. */}
                                    <input
                                        ref={scoreRef}
                                        type={isTouchDevice ? 'text' : 'number'}
                                        inputMode={isTouchDevice ? 'none' : 'numeric'}
                                        value={score}
                                        onChange={e => setScore(isTouchDevice ? e.target.value.replace(/\D/g, '') : e.target.value)}
                                        onFocus={() => { setActiveField('score'); if (isTouchDevice) setShowKeyboard(true); }}
                                        placeholder="0"
                                        min="0"
                                        className="flex-1 px-3 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                                    />
                                    {!isTouchDevice && (
                                        <button
                                            type="button"
                                            onClick={() => { setActiveField('score'); setShowKeyboard(!showKeyboard); }}
                                            className="px-2 text-muted hover:text-neon-cyan transition-colors cursor-pointer"
                                            title="Toggle on-screen keyboard"
                                        >
                                            <Keyboard size={18} />
                                        </button>
                                    )}
                                </div>
                            </div>

                            {/* v2.5.0: per-score platform picker. Renders in three states:
                                - resolving: shimmer text while /api/submit/platforms loads
                                - 1 platform: read-only chip (auto-filled, locked)
                                - 2+ platforms: required dropdown
                                If the resolver returned []  show an error — game has no platforms. */}
                            <div>
                                <label className="text-xs text-faint block mb-1">Platform</label>
                                {submittablePlatforms === null ? (
                                    <div className="px-3 py-2 bg-raised border border-border rounded text-faint text-sm italic">
                                        Loading platforms…
                                    </div>
                                ) : submittablePlatforms.length === 0 ? (
                                    <div className="px-3 py-2 bg-neon-amber/10 border border-neon-amber/30 rounded text-neon-amber text-xs">
                                        No platforms configured for this game. Submission is blocked — ask an admin.
                                    </div>
                                ) : submittablePlatforms.length === 1 ? (
                                    <div className="px-3 py-2 bg-raised border border-border/60 rounded text-primary text-sm flex items-center gap-2">
                                        <span className="px-2 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan text-xs font-display">
                                            {getPlatformDisplay(submittablePlatforms[0])}
                                        </span>
                                        <span className="text-faint text-xs">
                                            {fullGamePlatforms.length > 1
                                                ? '(only platform allowed by this tournament)'
                                                : '(only platform for this game)'}
                                        </span>
                                    </div>
                                ) : (
                                    <select
                                        value={platform}
                                        onChange={e => setPlatform(e.target.value)}
                                        className="w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                                    >
                                        <option value="" disabled>Choose the platform you played on…</option>
                                        {submittablePlatforms.map(p => (
                                            <option key={p} value={p}>{getPlatformDisplay(p)}</option>
                                        ))}
                                    </select>
                                )}
                            </div>

                            <div>
                                <label className="text-xs text-faint block mb-1">
                                    Photo {needsPhoto ? <span className="text-neon-amber">(required)</span> : '(optional)'}
                                </label>
                                <input
                                    ref={fileInputRef}
                                    type="file"
                                    accept="image/*"
                                    onChange={handlePhotoChange}
                                    className="hidden"
                                />
                                {photoPreview ? (
                                    <div className="relative inline-block">
                                        <img src={photoPreview} alt="Score photo" className="w-full max-h-48 object-contain rounded-lg border border-border" />
                                        <button
                                            type="button"
                                            onClick={clearPhoto}
                                            aria-label="Remove photo"
                                            className="absolute top-1 right-1 bg-deep/80 rounded-full p-1 text-muted hover:text-neon-amber transition-colors cursor-pointer"
                                        >
                                            <Trash2 size={16} />
                                        </button>
                                    </div>
                                ) : (
                                    <button
                                        type="button"
                                        onClick={() => fileInputRef.current?.click()}
                                        className="w-full flex items-center justify-center gap-2 px-4 py-6 border-2 border-dashed border-border rounded-lg text-muted hover:text-neon-cyan hover:border-neon-cyan/30 transition-colors cursor-pointer"
                                    >
                                        <Camera size={20} />
                                        <span className="text-sm">Take or choose photo</span>
                                    </button>
                                )}
                                {needsPhoto && !photoFile && (
                                    <p className="text-xs text-neon-amber mt-1">A photo is required to submit your score.</p>
                                )}
                            </div>

                            {target.kind === 'global' ? (
                                <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={excludeFromGlobal}
                                        onChange={e => setExcludeFromGlobal(e.target.checked)}
                                        className="rounded border-border"
                                    />
                                    Submit privately (not shown on the public global scoreboard)
                                </label>
                            ) : playerToken ? (
                                <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={excludeFromGlobal}
                                        onChange={e => setExcludeFromGlobal(e.target.checked)}
                                        className="rounded border-border"
                                    />
                                    Don't post this score to the global ArcAid scoreboard
                                </label>
                            ) : (
                                /* v2.2.0: guest scores never reach global. Replace the
                                   exclude-from-global checkbox with a clear note + login CTA so
                                   the user understands the consequence before they submit. */
                                <div className="flex items-start gap-2 px-3 py-2 rounded-lg bg-neon-cyan/5 border border-neon-cyan/20">
                                    <UserX size={14} className="text-neon-cyan flex-shrink-0 mt-0.5" />
                                    <div className="flex-1 text-xs text-muted leading-relaxed">
                                        Submitting as a guest — this score posts to the room only.{' '}
                                        {roomSlug ? (
                                            <button
                                                type="button"
                                                onClick={() => loginWithDiscord(roomSlug)}
                                                className="text-neon-cyan hover:underline cursor-pointer bg-transparent border-0 p-0 inline"
                                            >
                                                Log in with Discord
                                            </button>
                                        ) : (
                                            <span className="text-neon-cyan">Log in with Discord</span>
                                        )}{' '}
                                        to also include it on the global ArcAid leaderboard.
                                    </div>
                                </div>
                            )}

                            {message && (
                                <p className={`text-sm text-center ${message.type === 'success' ? 'text-neon-green' : message.type === 'error' ? 'text-neon-amber' : 'text-muted'}`}>
                                    {message.text}
                                </p>
                            )}

                            <NeonButton onClick={handleSubmitClick} disabled={!canSubmit} className="w-full">
                                {phase === 'checkingCollision' ? 'Checking…' : submitting ? 'Submitting…' : 'Submit Score'}
                            </NeonButton>
                        </div>

                        {showKeyboard && activeField && (
                            <OnScreenKeyboard
                                mode={activeField === 'score' ? 'numeric' : 'alpha'}
                                onKeyPress={handleKeyPress}
                                onBackspace={handleBackspace}
                                onDone={handleDone}
                            />
                        )}
                    </>
                )}
            </div>
        </div>
    );
}
