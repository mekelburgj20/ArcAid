import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Camera, Trash2, Keyboard, AlertTriangle, LogIn, UserCheck, Trophy } from 'lucide-react';
import NeonButton from './NeonButton';
import OnScreenKeyboard from './OnScreenKeyboard';
import ShareButton from './ShareButton';
import { useViewerAuth } from '../contexts/ViewerAuthContext';
import {
    enginesFromLegacyPlatforms,
    getDeviceDisplay,
    getEngineDisplay,
} from '../lib/scoreProvenance';
// The picker's option sets come from `lib/allowedProvenance`, which
// `GameInfoPopup`'s "What's allowed" section also imports — one derivation, so
// the card can never advertise an option this sheet refuses.
import {
    allowedDevicesForEngine,
    allowedEngines,
    parseSubmitPlatformsResponse,
} from '../lib/allowedProvenance';
import type { SubmitRank } from '../lib/api';
import { formatScore } from '../lib/format';
import { normalizePhotoFile } from '../lib/photoNormalize';

/**
 * Unified submission sheet (Sprint 3 + Sprint 10, plan §10 / §13 / §15;
 * login mandate v2.79.0).
 *
 * Targets (discriminated union):
 *   • tournament → POST /api/rooms/:roomId/submit-score/:gameName
 *   • freeplay   → POST /api/rooms/:roomId/freeplay-score
 *   • global     → POST /api/global/scores
 *
 * Sprint 10 additions:
 *   • Cooldown banner for locked tournament games (submission NOT blocked, §13).
 *
 * v2.79.0 (login mandate) — every target now requires a logged-in player
 * (Discord or Google); guest/anonymous submission is gone. When the viewer
 * has no player token the sheet shows `loginRequired` immediately on mount,
 * before the form ever renders — the same treatment `global` targets already
 * got. That upfront gate means there's no longer a "typed a score, then got
 * asked to log in" moment, so the old anonymous-collision claim prompt and
 * its OAuth-handoff draft-save machinery are gone from this component too.
 * The server-side draft/commit endpoints (`/api/submission-drafts/...`)
 * still exist for `PendingSubmissionWatcher` to resolve any in-flight draft
 * from before this change, but nothing in this file creates new ones.
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
     * v2.35.0 (Google login) — true when the room's DISCORD_ENABLED !== 'false'.
     * Drives the one-line "Sign in with Discord to get DM notifications and
     * tournament picks" nudge shown under the login buttons. Undefined/omitted
     * = nudge not shown (caller doesn't have this cheaply at hand).
     */
    discordEnabled?: boolean;
}

type Phase =
    | 'form'
    | 'loginRequired'         // v2.0.1 — viewer not authed (v2.79.0: every target now gates this way)
    | 'submitting'
    | 'committingDraft'
    | 'success'
    | 'error';

function isCooldownLocked(target: SubmissionTarget): boolean {
    return target.kind === 'tournament' && !!target.gameStatus && target.gameStatus !== 'ACTIVE';
}

function photoRequired(target: SubmissionTarget): boolean {
    if (target.kind === 'freeplay' || target.kind === 'global') return true;
    return !!target.requirePhoto;
}

// v2.79.0 (login mandate) — still exported for `PendingSubmissionWatcher`,
// which resolves any draft created before this change; nothing in this file
// creates new drafts anymore (that required the removed anonymous-collision
// claim flow), so `generateStateParam` itself is gone.
export const PENDING_SUBMISSION_STORAGE_KEY = 'arcaid_pending_submission';

/**
 * v2.53.0 (ADR 0016) — the player's last device choice, remembered across
 * submissions and pre-selected whenever it's compatible with the chosen engine.
 * The launch community is AtGames-first: without this they'd re-pick "AtGames
 * Cabinet" on every single score, which is exactly the "twice the work" failure
 * mode the two-question form has to avoid.
 */
const LAST_DEVICE_KEY = 'arcaid_last_device';

export default function SubmissionSheet({
    target,
    onClose,
    onSubmitted,
    initialPlayerName,
    commitDraftState,
    roomSlug,
    discordEnabled,
}: SubmissionSheetProps) {
    const { discordUser, playerToken, loginWithDiscord, loginWithGoogle } = useViewerAuth();
    /**
     * v2.54.0 username lock — a logged-in viewer (Discord OR Google; both land
     * in `discordUser`/`playerToken`, the Google ids just carry a `google:`
     * prefix) submits under their canonical account name. The editable name
     * field is replaced with a read-only "Playing as …" chip, the client stops
     * posting a name at all, and the server resolves it.
     *
     * v2.79.0 (login mandate) — `isAuthedViewer` is now always true by the
     * time the form phase renders (see the `phase` initializer below), since
     * every submitter must be logged in; there is no longer a guest branch.
     */
    const isAuthedViewer = !!playerToken;
    const [playerName, setPlayerName] = useState(
        // Authed: always start from the account name, never a stale
        // localStorage/`initialPlayerName` value.
        (isAuthedViewer ? discordUser?.username : undefined) ??
            initialPlayerName ??
            discordUser?.username ??
            localStorage.getItem('arcaid-player-name') ??
            (target.kind === 'global' ? target.presetDisplayName ?? '' : ''),
    );
    const [score, setScore] = useState('');
    const [photoFile, setPhotoFile] = useState<File | null>(null);
    const [photoPreview, setPhotoPreview] = useState<string | null>(null);
    /** Set when a selected photo can't be used (unsupported format that also
     *  failed client-side re-encode — see `lib/photoNormalize.ts`). */
    const [photoError, setPhotoError] = useState<string | null>(null);
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
    /**
     * ADR 0016 catalogue phase §4 — `global_games.features`.
     *
     * The DEVICE half of the picker used to be derived from the platform list:
     * a `vpxs` id implied the AtGames device. The catalogue fold moved that
     * fact to `features`, so a folded row says `platforms:['vpx'],
     * features:['vpxs']` and the device list has to read it from there or an
     * AtGames-capable table quietly stops offering AtGames. The resolver
     * returns it; `devicesForEngineAndPlatforms` consumes it.
     */
    const [gameFeatures, setGameFeatures] = useState<string[]>([]);
    /**
     * ADR 0016 P2 §2 — the active tournament's two-axis rules, or `null` when
     * no tournament applies. Only `excluded` is read: `required` is a
     * game-level eligibility gate and must never filter the picker (ADR 0009).
     *
     * The engine axis is already reflected in `submittable` (the server strips
     * platforms of excluded engines), but the DEVICE axis is not — a device is
     * not a platform, so `devicesForEngineAndPlatforms` would happily offer
     * AtGames for a tournament that forbids it and the submit would be rejected
     * server-side. Filtering here keeps the picker and the validator agreeing.
     */
    const [excludedProvenance, setExcludedProvenance] =
        useState<{ engines: string[]; devices: string[] }>({ engines: [], devices: [] });
    /**
     * v2.53.0 (ADR 0016) — provenance is two answers now. The resolver endpoint
     * still speaks legacy platform ids; the engine/device option sets are
     * derived from them client-side via `lib/scoreProvenance`, which is a
     * parity-tested mirror of the backend module the submit handlers validate
     * against. Same input, same derivation, so the picker can never offer
     * something the server will reject.
     */
    const [engine, setEngine] = useState<string>('');
    const [device, setDevice] = useState<string>('');
    const [phase, setPhase] = useState<Phase>(() => {
        if (commitDraftState) return 'committingDraft';
        // v2.79.0 (login mandate) — every target requires login now; gate
        // upfront on mount, same treatment `global` targets already got (see
        // the file-level doc comment).
        if (!playerToken) return 'loginRequired';
        return 'form';
    });
    // S5 — submit-moment ranking shown on the persistent success card.
    const [submitRank, setSubmitRank] = useState<SubmitRank | null>(null);
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
                const resolved = parseSubmitPlatformsResponse(data);
                setSubmittablePlatforms(resolved.submittable);
                setFullGamePlatforms(resolved.platforms);
                setGameFeatures(resolved.features);
                setExcludedProvenance(resolved.exclusions);
                // Engine auto-locks when the game only supports one.
                const engines = allowedEngines(resolved.submittable, resolved.exclusions.engines);
                if (engines.length === 1) setEngine(engines[0]);
            } catch {
                if (cancelled) return;
                setSubmittablePlatforms([]);
                setGameFeatures([]);
                // Don't carry a previous target's exclusions into this one.
                setExcludedProvenance({ engines: [], devices: [] });
            }
        })();
        return () => { cancelled = true; };
    }, [target, commitDraftState]);

    const engineOptions = submittablePlatforms
        ? allowedEngines(submittablePlatforms, excludedProvenance.engines)
        : [];
    const deviceOptions = engine
        ? allowedDevicesForEngine(engine, submittablePlatforms ?? [], gameFeatures, excludedProvenance.devices)
        : [];

    /**
     * Device selection follows the engine: keep a still-valid choice, lock when
     * only one device can run the engine, otherwise fall back to the player's
     * remembered device — and clear the field when the new engine makes the old
     * device impossible.
     */
    useEffect(() => {
        if (!engine) return;
        // MUST be the same exclusion-aware list the dropdown renders
        // (`deviceOptions` above). Pre-v2.95.1 this used the UNFILTERED
        // `devicesForEngineAndPlatforms`, so a remembered device the
        // tournament EXCLUDES (e.g. last submit was on PC, this tournament
        // is AtGames-only) passed the membership check and became the
        // submitted value while the <select> — whose option list lacks it —
        // visually fell back to the first option. The player saw "AtGames
        // Cabinet", the server received "pc", and the submit bounced with
        // "PC is not allowed for this tournament" (RTX demo field report,
        // 2026-08-09).
        const options = allowedDevicesForEngine(engine, submittablePlatforms ?? [], gameFeatures, excludedProvenance.devices);
        if (options.length === 0) return;
        setDevice(prev => {
            if (prev && options.includes(prev)) return prev;
            if (options.length === 1) return options[0];
            const remembered = localStorage.getItem(LAST_DEVICE_KEY);
            if (remembered && options.includes(remembered)) return remembered;
            return '';
        });
    }, [engine, submittablePlatforms, gameFeatures, excludedProvenance]);

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

    const handlePhotoChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;
        setPhotoError(null);

        // Unsupported formats (e.g. an iPhone's default `image/heic` capture)
        // get re-encoded to JPEG on-device before we ever touch the network —
        // see `lib/photoNormalize.ts` for why.
        const normalized = await normalizePhotoFile(file);
        if (!normalized) {
            setPhotoError("That photo format isn't supported — please use a PNG or JPEG.");
            if (fileInputRef.current) fileInputRef.current.value = '';
            return;
        }

        if (photoPreview) URL.revokeObjectURL(photoPreview);
        setPhotoFile(normalized);
        setPhotoPreview(URL.createObjectURL(normalized));
    };

    const clearPhoto = () => {
        if (photoPreview) URL.revokeObjectURL(photoPreview);
        setPhotoFile(null);
        setPhotoPreview(null);
        setPhotoError(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    /**
     * POST the score as the logged-in viewer. `phase` gates this behind
     * `loginRequired` on mount (see the `phase` initializer above), so
     * `playerToken` — and therefore `isAuthedViewer` — is always true by the
     * time this can be called; the name field is never guest-editable.
     */
    const submitScoreNow = async () => {
        const scoreNum = parseInt(score, 10);
        if (isNaN(scoreNum) || scoreNum < 0) return;
        if (photoRequired(target) && !photoFile) return;
        // v2.53.0: both provenance axes must be resolved — guard against a stray
        // click before the picker has settled.
        if (!engine || !device) return;

        setPhase('submitting');
        setMessage(null);
        try {
            const formData = new FormData();
            formData.append('score', String(scoreNum));
            formData.append('engine', engine);
            formData.append('device', device);
            if (photoFile) formData.append('photo', photoFile);

            let url = '';
            const headers: Record<string, string> = {};
            if (playerToken) headers.Authorization = `Bearer ${playerToken}`;

            // v2.54.0 username lock: the name is resolved server-side for every
            // authed submitter, so the client never posts one — the room submit
            // schemas make `username` optional for exactly this, and the global
            // schema doesn't declare the field at all.
            if (target.kind === 'tournament') {
                if (excludeFromGlobal) formData.append('excludeGlobal', 'true');
                url = `/api/rooms/${target.roomId}/submit-score/${encodeURIComponent(target.gameName)}`;
            } else if (target.kind === 'freeplay') {
                formData.append('globalGameId', target.globalGameId);
                if (excludeFromGlobal) formData.append('excludeGlobal', 'true');
                url = `/api/rooms/${target.roomId}/freeplay-score`;
            } else {
                formData.append('globalGameId', target.globalGameId);
                formData.append('excludeFromGlobal', excludeFromGlobal ? 'true' : 'false');
                url = '/api/global/scores';
            }

            const res = await fetch(url, { method: 'POST', headers, body: formData });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error((data as { error?: string }).error || 'Submission failed');
            }

            // v2.2.5: store the *resolved* display name (server-assigned for an
            // authed submitter, possibly auto-suffixed) so the next session
            // prefills with the sticky identity.
            const responseData = data as { displayName?: string; suffixed?: boolean; requested?: string; rank?: SubmitRank | null };
            const resolvedName = responseData?.displayName || playerName.trim();
            localStorage.setItem('arcaid-player-name', resolvedName);
            setPlayerName(resolvedName);
            // Remember the device so the next submission pre-selects it.
            localStorage.setItem(LAST_DEVICE_KEY, device);
            // S5: capture the submit-moment rank (best-effort; null when the BE
            // couldn't compute it — the card falls back to a plain success line).
            setSubmitRank(responseData?.rank ?? null);
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

    const handleSubmitClick = async () => {
        const scoreNum = parseInt(score, 10);
        if (isNaN(scoreNum) || scoreNum < 0) return;
        if (photoRequired(target) && !photoFile) return;
        // v2.79.0 (login mandate): every submitter is authed by the time the
        // form can even render (see the `phase` initializer) — the server
        // resolves the canonical name and any suffixing, and the success card
        // reports the final name. No anonymous-collision check needed anymore.
        return submitScoreNow();
    };

    // useCallback (v2.100.5): OnScreenKeyboard is memo'd so the keyboard
    // subtree skips the whole-sheet re-render every keystroke triggers —
    // that only works if these handler identities are stable across renders.
    const handleKeyPress = useCallback((key: string) => {
        if (activeField === 'name') {
            setPlayerName(prev => prev + key);
            nameRef.current?.focus();
        } else if (activeField === 'score') {
            if (/\d/.test(key)) setScore(prev => prev + key);
            scoreRef.current?.focus();
        }
    }, [activeField]);

    const handleBackspace = useCallback(() => {
        if (activeField === 'name') setPlayerName(prev => prev.slice(0, -1));
        else if (activeField === 'score') setScore(prev => prev.slice(0, -1));
    }, [activeField]);

    const handleDone = useCallback(() => {
        setActiveField(null);
        setShowKeyboard(false);
    }, []);

    const needsPhoto = photoRequired(target);
    const cooldown = isCooldownLocked(target);
    const submitting = phase === 'submitting' || phase === 'committingDraft';
    // v2.53.0: picker must be resolved AND both provenance axes chosen.
    const platformsResolved = submittablePlatforms !== null;
    const provenanceChosen = engine.trim() !== '' && device.trim() !== '';
    // v2.79.0 (login mandate): every submitter is authed by the time the form
    // renders — there's no guest name field to gate on anymore.
    const canSubmit = score !== '' && !isNaN(parseInt(score, 10)) && parseInt(score, 10) >= 0
        && (!needsPhoto || !!photoFile) && platformsResolved && provenanceChosen && !submitting;
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

                        <div className="grid grid-cols-1 gap-2 pt-1">
                            {/* S16 — share the result (native share sheet, clipboard fallback).
                                Links to the game's leaderboard page; OG meta makes the unfurl rich. */}
                            {(target.kind === 'global' ? !!target.globalGameId : !!roomSlug) && (
                                <ShareButton
                                    title={`${target.gameName} · Arcaid`}
                                    text={
                                        submitRank?.rank === 1
                                            ? `I'm #1 on ${target.gameName}!`
                                            : submitRank?.rank != null
                                                ? `I'm #${submitRank.rank} of ${submitRank.totalPlayers} on ${target.gameName}!`
                                                : `I just posted a score on ${target.gameName}!`
                                    }
                                    path={
                                        target.kind === 'global'
                                            ? `/games/${target.globalGameId}`
                                            : `/${roomSlug}/games/${encodeURIComponent(target.gameName)}`
                                    }
                                    className="w-full px-4 py-2 rounded border border-neon-cyan/40 text-neon-cyan text-sm hover:bg-neon-cyan/10 transition-colors inline-flex items-center justify-center gap-2 cursor-pointer"
                                />
                            )}
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
                                    Scores tie to your account, so submitting requires a login. Log in to submit on <span className="text-primary font-medium">{target.gameName}</span>.
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
                                onClick={() => roomSlug && loginWithGoogle(roomSlug)}
                                disabled={!roomSlug}
                                className="w-full px-4 py-2 rounded border border-border bg-surface text-primary text-sm font-medium hover:bg-raised hover:border-border/80 transition-colors cursor-pointer inline-flex items-center justify-center gap-2"
                            >
                                <LogIn size={16} /> Log in with Google
                            </button>
                            {discordEnabled && (
                                <p className="text-[11px] text-faint text-center">
                                    Sign in with Discord to get DM notifications and tournament picks.
                                </p>
                            )}
                            <button
                                type="button"
                                onClick={onClose}
                                className="w-full px-4 py-2 rounded border border-border text-muted text-sm hover:text-primary hover:border-border/80 transition-colors cursor-pointer"
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                ) : (
                    <>
                        {/* overscroll-contain (v2.101.1): without it, a drag
                            that starts on the sheet can chain into the page
                            behind it and trigger iOS pull-to-refresh mid-entry
                            (tester field report — the keyboard fix's sibling). */}
                        <div className="flex-1 overflow-y-auto overscroll-contain px-4 py-4 space-y-4">
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
                                {/* v2.54.0 username lock (v2.79.0: unconditional — every
                                    submitter is authed by the time this form renders).
                                    Read-only identity chip: the name is fixed to the
                                    account, renames happen in Account Settings. The
                                    server may still resolve a slightly different name
                                    (e.g. an existing suffixed room claim) — the submit
                                    response carries the final `displayName` and the
                                    success card shows it. */}
                                <div className="px-3 py-2 bg-raised border border-border/60 rounded text-sm flex items-center gap-2">
                                    <UserCheck size={14} className="text-neon-cyan flex-shrink-0" />
                                    <span className="text-muted">Playing as</span>
                                    <span className="text-primary font-display font-bold truncate">
                                        {playerName || discordUser?.username || 'you'}
                                    </span>
                                </div>
                                <p className="text-[11px] text-faint mt-1">
                                    Not you?{' '}
                                    <Link
                                        to="/account/settings"
                                        className="text-neon-cyan hover:underline"
                                    >
                                        Change your display name in settings
                                    </Link>
                                    .
                                </p>
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

                            {/* v2.53.0 (ADR 0016): two questions, but never twice
                                the work. Engine first (what produced the score —
                                the only thing that decides comparability), then
                                device filtered by what can actually run it. Either
                                field auto-locks to a read-only chip when only one
                                option fits, and the device pre-selects the player's
                                last choice, so the common case is still zero taps. */}
                            <div>
                                <label className="text-xs text-faint block mb-1">Played on</label>
                                {submittablePlatforms === null ? (
                                    <div className="px-3 py-2 bg-raised border border-border rounded text-faint text-sm italic">
                                        Loading…
                                    </div>
                                ) : engineOptions.length === 0 ? (
                                    <div className="px-3 py-2 bg-neon-amber/10 border border-neon-amber/30 rounded text-neon-amber text-xs">
                                        Nothing is configured for this game yet. Submission is blocked — ask an admin.
                                    </div>
                                ) : engineOptions.length === 1 ? (
                                    <div className="px-3 py-2 bg-raised border border-border/60 rounded text-primary text-sm flex items-center gap-2">
                                        <span className="px-2 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan text-xs font-display">
                                            {getEngineDisplay(engineOptions[0])}
                                        </span>
                                        <span className="text-faint text-xs">
                                            {enginesFromLegacyPlatforms(fullGamePlatforms).length > 1
                                                ? '(the only one this tournament allows)'
                                                : '(the only one for this game)'}
                                        </span>
                                    </div>
                                ) : (
                                    <select
                                        value={engine}
                                        onChange={e => setEngine(e.target.value)}
                                        className="w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                                    >
                                        <option value="" disabled>Choose what you played…</option>
                                        {engineOptions.map(id => (
                                            <option key={id} value={id}>{getEngineDisplay(id)}</option>
                                        ))}
                                    </select>
                                )}
                            </div>

                            {submittablePlatforms !== null && engineOptions.length > 0 && (
                                <div>
                                    <label className="text-xs text-faint block mb-1">Device</label>
                                    {!engine ? (
                                        <div className="px-3 py-2 bg-raised border border-border rounded text-faint text-sm italic">
                                            Pick what you played first.
                                        </div>
                                    ) : deviceOptions.length === 1 ? (
                                        <div className="px-3 py-2 bg-raised border border-border/60 rounded text-primary text-sm flex items-center gap-2">
                                            <span className="px-2 py-0.5 rounded bg-neon-cyan/10 text-neon-cyan text-xs font-display">
                                                {getDeviceDisplay(deviceOptions[0])}
                                            </span>
                                            <span className="text-faint text-xs">
                                                (the only device that runs it)
                                            </span>
                                        </div>
                                    ) : (
                                        <select
                                            value={device}
                                            onChange={e => setDevice(e.target.value)}
                                            className="w-full px-3 py-2 bg-raised border border-border rounded text-primary text-sm focus:outline-none focus:border-neon-cyan transition-colors"
                                        >
                                            <option value="" disabled>Choose the device you played on…</option>
                                            {deviceOptions.map(id => (
                                                <option key={id} value={id}>{getDeviceDisplay(id)}</option>
                                            ))}
                                        </select>
                                    )}
                                </div>
                            )}

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
                                {photoError && (
                                    <p className="text-xs text-neon-amber mt-1">{photoError}</p>
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
                            ) : (
                                // v2.79.0 (login mandate): every room submitter is logged in
                                // now, so this is always the "logged-in" checkbox — the old
                                // guest note (scores never reach global) no longer applies.
                                <label className="flex items-center gap-2 text-xs text-muted cursor-pointer">
                                    <input
                                        type="checkbox"
                                        checked={excludeFromGlobal}
                                        onChange={e => setExcludeFromGlobal(e.target.checked)}
                                        className="rounded border-border"
                                    />
                                    Don't post this score to the global Arcaid scoreboard
                                </label>
                            )}

                            {message && (
                                <p className={`text-sm text-center ${message.type === 'success' ? 'text-neon-green' : message.type === 'error' ? 'text-neon-amber' : 'text-muted'}`}>
                                    {message.text}
                                </p>
                            )}

                            <NeonButton onClick={handleSubmitClick} disabled={!canSubmit} className="w-full">
                                {submitting ? 'Submitting…' : 'Submit Score'}
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
