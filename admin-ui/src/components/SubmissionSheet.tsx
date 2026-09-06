import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { X, Camera, Image as ImageIcon, Trash2, Keyboard, AlertTriangle, LogIn, UserCheck, Trophy } from 'lucide-react';
import NeonButton from './NeonButton';
import OnScreenKeyboard from './OnScreenKeyboard';
import ShareButton from './ShareButton';
import StarRating from './StarRating';
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
import { type SubmitRank } from '../lib/api';
import { playerApi } from '../lib/playerApi';
import { formatScore } from '../lib/format';
import { deleteAtCaret, insertAtCaret, readCaret } from '../lib/caretEdit';
import {
    digitsOnly,
    formatMagnitude,
    reformatScoreEdit,
    skipSeparatorBack,
} from '../lib/scoreInput';
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
          /**
           * v2.155.1 — the games row this card actually renders, when the
           * caller has it. A room can have two ACTIVE games sharing a name in
           * different tournaments (the ambiguous-active-games bug); passing
           * the card's own id lets the server's `SubmissionGameResolver` skip
           * the name lookup entirely and land the score on THIS card with no
           * ambiguity. Optional — omitted callers fall back to the
           * server-side name resolution exactly as before.
           */
          gameId?: string;
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

/**
 * The engine half of the same memory (owner request, 2026-08-30: "make them
 * default to their last selections").
 *
 * Engine was the half that never persisted — it only auto-locked when a game
 * supported exactly one — so a player on a multi-engine table re-answered
 * "what produced this score" on every single submission.
 */
const LAST_ENGINE_KEY = 'arcaid_last_engine';

/**
 * Per-game override, checked BEFORE the two global keys above.
 *
 * The global memory is the right default because engine and device describe
 * the player's rig, not the table. But a player who owns both a cabinet and a
 * PC plays specific tables on specific hardware, and for them a global memory
 * is wrong on every second submission — so the last choice is also recorded
 * per game and wins when present.
 */
const PROVENANCE_KEY_PREFIX = 'arcaid_last_provenance:';

interface RememberedProvenance {
    engine?: string;
    device?: string;
}

/**
 * Identifies the game for the per-game memory. Room targets key on
 * (room, lowercased name) rather than a game id because a tournament game row
 * is recreated on every rotation — keying on the id would forget the choice
 * the moment the table came round again, which is exactly when it is wanted.
 */
function provenanceKeyFor(target: SubmissionTarget): string {
    if (target.kind === 'global') return `${PROVENANCE_KEY_PREFIX}global:${target.globalGameId}`;
    if (target.kind === 'freeplay') return `${PROVENANCE_KEY_PREFIX}global:${target.globalGameId}`;
    return `${PROVENANCE_KEY_PREFIX}${target.roomId}:${target.gameName.toLowerCase()}`;
}

function readRememberedProvenance(target: SubmissionTarget): RememberedProvenance {
    try {
        const raw = localStorage.getItem(provenanceKeyFor(target));
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object') return {};
        const { engine, device } = parsed as RememberedProvenance;
        return {
            engine: typeof engine === 'string' ? engine : undefined,
            device: typeof device === 'string' ? device : undefined,
        };
    } catch {
        // Corrupt JSON or storage disabled — fall through to the global keys.
        return {};
    }
}

/**
 * Picks the first remembered value that the caller's option list actually
 * offers, per-game before global.
 *
 * `options` MUST be the same exclusion-filtered list the dropdown renders.
 * Passing an unfiltered list reintroduces the v2.95.1 field bug: a remembered
 * value the tournament excludes passes the membership test, becomes the
 * submitted value, and the <select> — whose options lack it — silently shows
 * something else, so the player sees "AtGames Cabinet" and the server is told
 * "pc". The submit then bounces with a rule violation nobody can explain.
 */
function rememberedChoice(options: string[], perGame: string | undefined, globalKey: string): string | null {
    if (perGame && options.includes(perGame)) return perGame;
    let stored: string | null;
    try {
        stored = localStorage.getItem(globalKey);
    } catch {
        // Storage disabled (private mode, blocked cookies) — no memory, no crash.
        stored = null;
    }
    if (stored && options.includes(stored)) return stored;
    return null;
}

/**
 * Identity P2 — the submit response offers an unclaimed iScored name when the
 * one the score landed under already carries synced history in the room (see
 * `IdentityClaimService.claimOfferForSubmit`). "Not me" is remembered per room
 * + name so the prompt doesn't reappear on every subsequent submission.
 */
interface ClaimOffer {
    iscoredUsername: string;
    syncScoreCount: number;
}

function claimDismissKey(roomId: string, iscoredUsername: string): string {
    return `arcaid_claim_offer_dismissed:${roomId}:${iscoredUsername.toLowerCase()}`;
}

/**
 * v2.131.0 — "How was <game>?" on the success card.
 *
 * Rating + comment reuse the EXISTING game-page endpoints; nothing new was
 * added server-side. Which pair fires is the same `global` vs. room split the
 * card's share/leaderboard links already make:
 *
 *   room (tournament | freeplay)
 *     GET/POST /api/rooms/:roomId/ratings/:gameName
 *     POST     /api/rooms/:roomId/games/:gameName/comments
 *   global
 *     GET/POST /api/global/games/:id/rating
 *     POST     /api/global/games/:id/comments
 *
 * The room rating GET is `optionalDiscordUser` and personalizes "your rating"
 * off the Bearer identity, falling back to `x-user-id` — the v2.86.0 raw-fetch
 * pattern `GameDetail` uses (deliberately NOT `lib/api.ts`, which attaches the
 * ADMIN token and a different anon id). Comments additionally carry the anon
 * `arcaid-user-id` uuid, which is what author-only delete keys on.
 */
interface GameRatingInfo {
    avg_rating: number;
    rating_count: number;
    user_rating: number | null;
}

/** Coerce a ratings response into `GameRatingInfo`; null when unusable. */
function parseRatingInfo(data: unknown): GameRatingInfo | null {
    if (!data || typeof data !== 'object') return null;
    const raw = data as Record<string, unknown>;
    const userRating = Number(raw.user_rating);
    return {
        avg_rating: Number(raw.avg_rating) || 0,
        rating_count: Number(raw.rating_count) || 0,
        user_rating: Number.isFinite(userRating) && userRating > 0 ? userRating : null,
    };
}

/** Anon uuid used for comment author-only delete — same key `GameDetail` reads. */
function anonCommentUserId(): string {
    const stored = localStorage.getItem('arcaid-user-id');
    if (stored) return stored;
    const id = typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    localStorage.setItem('arcaid-user-id', id);
    return id;
}

/** `GameCommentSchema` caps the body at 500 chars — mirrored on the textarea. */
const COMMENT_MAX_LENGTH = 500;

/**
 * v2.128.0 — belt-and-braces companion to the pointerup Done key in
 * `OnScreenKeyboard`. Any click that arrives within this window of the
 * keyboard closing is treated as spill-over from the touch that pressed Done
 * (a late synthetic click, a browser that fires compatibility events despite
 * the preventDefault, a stray tap on the button that just slid under the
 * finger) and is ignored by the submit handler. ~350ms is the same order as
 * the iOS double-tap-to-zoom delay the keyboard already fights.
 */
const KEYBOARD_CLOSE_LATCH_MS = 350;

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
    /**
     * v2.137.0 — seeded from the player's account preference so the box shows
     * what will actually happen, and ALWAYS sent explicitly (see the submit
     * handler). Without the explicit send, a player who had opted out globally
     * could never share a single score: unchecking the box would omit the field
     * and the server would fall back to their opt-out.
     */
    const [excludeFromGlobal, setExcludeFromGlobal] = useState(false);
    // v2.5.0: per-score platform stratification. `null` until the resolver
    // endpoint replies. `[]` means the resolver returned no submittable
    // platforms (game has no platforms or active tournament excluded all).
    const [submittablePlatforms, setSubmittablePlatforms] = useState<string[] | null>(null);

    useEffect(() => {
        // MUST use the player client. `api.*` is the ADMIN client: it sends a
        // token a player does not have and, on the resulting 401, navigates to
        // /superadmin — which is what broke the "+" button for logged-in
        // players in v2.137.0. A failure here just leaves the default (share).
        if (!playerToken) return;
        playerApi.get<{ share_to_global?: boolean }>('/me/preferences', { token: playerToken })
            .then(p => { if (p?.share_to_global === false) setExcludeFromGlobal(true); })
            .catch(() => { /* keep the default */ });
    }, [playerToken]);
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
    // Identity P2 — claim prompt on the success card (room targets only).
    const [claimOffer, setClaimOffer] = useState<ClaimOffer | null>(null);
    const [claimBusy, setClaimBusy] = useState(false);
    const [claimMsg, setClaimMsg] = useState<{ ok: boolean; text: string } | null>(null);
    /**
     * v2.131.0 — rate + comment on the success card. `ratingInfo` stays null
     * until the GET lands, and the whole block is gated on it: a 401 / network
     * failure simply never renders it, so nothing can get between the player
     * and Done.
     */
    const [ratingInfo, setRatingInfo] = useState<GameRatingInfo | null>(null);
    const [ratingError, setRatingError] = useState<string | null>(null);
    const [ratingThanks, setRatingThanks] = useState(false);
    const [commentState, setCommentState] = useState<'closed' | 'open' | 'posted'>('closed');
    const [commentText, setCommentText] = useState('');
    const [commentPosting, setCommentPosting] = useState(false);
    const [commentError, setCommentError] = useState<string | null>(null);
    /**
     * The name the score actually landed under (server-resolved, possibly
     * auto-suffixed) — used as the comment's `display_name` so the comment and
     * the score read as the same person on the game page.
     */
    const [submittedAs, setSubmittedAs] = useState<string | null>(null);
    const [message, setMessage] = useState<{ text: string; type: 'success' | 'error' | 'info' } | null>(null);
    const [activeField, setActiveField] = useState<'name' | 'score' | null>(null);
    const [showKeyboard, setShowKeyboard] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);
    // Separate ref for the capture input — see the comment at the inputs.
    const cameraInputRef = useRef<HTMLInputElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const scoreRef = useRef<HTMLInputElement>(null);
    const backdropMouseDown = useRef(false);
    const draftCommittedRef = useRef(false);
    /** Timestamp of the last on-screen-keyboard close — see KEYBOARD_CLOSE_LATCH_MS. */
    const keyboardClosedAt = useRef(0);
    /** Caret position to restore after React commits a keypad-driven edit (v2.128.0). */
    const pendingCaret = useRef<{ field: 'name' | 'score'; pos: number } | null>(null);
    /**
     * v2.131.0 — Done may fire mid-request (the rating/comment POSTs are
     * fire-and-forget relative to the sheet's lifecycle), so every async
     * continuation below checks this before touching state.
     */
    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);

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
        const remembered0 = readRememberedProvenance(target);
        (async () => {
            const params = new URLSearchParams();
            if (target.kind === 'global') {
                params.set('globalGameId', target.globalGameId);
            } else {
                params.set('roomId', target.roomId);
                params.set('gameName', target.gameName);
                // v2.155.2 — the card's own game id, when the caller has it,
                // so the picker resolves against the SAME game the score
                // will be written to (a room can have two ACTIVE games
                // sharing this name in different tournaments).
                if (target.kind === 'tournament' && target.gameId) {
                    params.set('gameId', target.gameId);
                }
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
                // Engine auto-locks when the game only supports one; otherwise
                // it pre-selects the player's remembered choice (per-game
                // first, then their last submission anywhere). `engines` is
                // already exclusion-filtered — see `rememberedChoice`.
                const engines = allowedEngines(resolved.submittable, resolved.exclusions.engines);
                if (engines.length === 1) {
                    setEngine(engines[0]);
                } else {
                    const remembered = rememberedChoice(engines, remembered0.engine, LAST_ENGINE_KEY);
                    if (remembered) setEngine(remembered);
                }
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
            // Per-game choice first, then the global "last device anywhere"
            // key that has backed this since v2.53.0.
            return rememberedChoice(options, readRememberedProvenance(target).device, LAST_DEVICE_KEY) ?? '';
        });
    }, [engine, submittablePlatforms, gameFeatures, excludedProvenance, target]);

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

    /** Room the claim would be filed in — `global` targets have none. */
    const claimRoomId = target.kind === 'global' ? null : target.roomId;

    /**
     * POST the score as the logged-in viewer. `phase` gates this behind
     * `loginRequired` on mount (see the `phase` initializer above), so
     * `playerToken` — and therefore `isAuthedViewer` — is always true by the
     * time this can be called; the name field is never guest-editable.
     */
    const submitScoreNow = async () => {
        const scoreNum = parseInt(digitsOnly(score), 10);
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
                formData.append('excludeGlobal', excludeFromGlobal ? 'true' : 'false');
                if (target.gameId) formData.append('gameId', target.gameId);
                url = `/api/rooms/${target.roomId}/submit-score/${encodeURIComponent(target.gameName)}`;
            } else if (target.kind === 'freeplay') {
                formData.append('globalGameId', target.globalGameId);
                formData.append('excludeGlobal', excludeFromGlobal ? 'true' : 'false');
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
            const responseData = data as {
                displayName?: string; suffixed?: boolean; requested?: string;
                rank?: SubmitRank | null; claimOffer?: ClaimOffer | null;
            };
            const resolvedName = responseData?.displayName || playerName.trim();
            localStorage.setItem('arcaid-player-name', resolvedName);
            setPlayerName(resolvedName);
            // v2.131.0: the success card's comment posts under this same name.
            setSubmittedAs(resolvedName);
            // Remember the provenance so the next submission pre-selects it:
            // globally (the player's rig) and against this game (the override
            // for someone who plays this table on different hardware). Wrapped
            // because a storage quota error must never fail a submitted score.
            try {
                localStorage.setItem(LAST_DEVICE_KEY, device);
                localStorage.setItem(LAST_ENGINE_KEY, engine);
                localStorage.setItem(provenanceKeyFor(target), JSON.stringify({ engine, device }));
            } catch { /* memory is a convenience; the score is already in. */ }
            // S5: capture the submit-moment rank (best-effort; null when the BE
            // couldn't compute it — the card falls back to a plain success line).
            setSubmitRank(responseData?.rank ?? null);
            // Identity P2: only room targets carry an offer, and a name the
            // player already said "not me" to never asks again.
            const offer = responseData?.claimOffer;
            if (offer?.iscoredUsername && claimRoomId
                && !localStorage.getItem(claimDismissKey(claimRoomId, offer.iscoredUsername))) {
                setClaimOffer(offer);
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

    /** Identity P2 — file the claim. Outcome copy mirrors Account Settings. */
    const acceptClaimOffer = async () => {
        if (!claimOffer || !claimRoomId || !playerToken) return;
        setClaimBusy(true);
        setClaimMsg(null);
        try {
            const res = await fetch(`/api/rooms/${claimRoomId}/identity/claims`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${playerToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ iscoredUsername: claimOffer.iscoredUsername }),
            });
            const data = await res.json().catch(() => ({}));
            if (res.ok) {
                const outcome = data as { result?: string; matchedOn?: string };
                setClaimMsg({
                    ok: true,
                    text: outcome.result === 'auto_approved'
                        ? `Linked — that matched ${outcome.matchedOn}.`
                        : outcome.result === 'already_yours'
                            ? 'You already hold that name.'
                            : 'Sent to a room admin for review.',
                });
            } else {
                setClaimMsg({ ok: false, text: (data as { error?: string }).error ?? 'Could not claim that name.' });
            }
        } catch {
            setClaimMsg({ ok: false, text: 'Network error.' });
        }
        setClaimBusy(false);
    };

    const dismissClaimOffer = () => {
        if (claimOffer && claimRoomId) {
            localStorage.setItem(claimDismissKey(claimRoomId, claimOffer.iscoredUsername), new Date().toISOString());
        }
        setClaimOffer(null);
    };

    // ─── v2.131.0 — rate + comment from the success card ───

    /** Endpoint for the rating GET/POST — room vs. global, same split as the card's links. */
    const ratingUrl = target.kind === 'global'
        ? `/api/global/games/${target.globalGameId}/rating`
        : `/api/rooms/${target.roomId}/ratings/${encodeURIComponent(target.gameName)}`;
    /** Endpoint for the comment POST. */
    const commentUrl = target.kind === 'global'
        ? `/api/global/games/${target.globalGameId}/comments`
        : `/api/rooms/${target.roomId}/games/${encodeURIComponent(target.gameName)}/comments`;
    /** Where "see it on the game page" goes — null when the caller gave us no slug. */
    const gamePagePath = target.kind === 'global'
        ? `/games/${target.globalGameId}`
        : roomSlug
            ? `/${roomSlug}/games/${encodeURIComponent(target.gameName)}`
            : null;

    /**
     * Viewer headers for the rating calls. The Bearer token is what the POST
     * authorizes on and what the GET prefers for "your rating"; `x-user-id`
     * (the viewer's discordId, NOT the anon uuid) is the tokenless fallback
     * the room GET reads — see `GameDetail`'s v2.86.0 comment.
     */
    const viewerDiscordId = discordUser?.discordId ?? null;
    const ratingHeaders = useCallback((json = false): Record<string, string> => {
        const headers: Record<string, string> = {};
        if (json) headers['Content-Type'] = 'application/json';
        if (playerToken) headers.Authorization = `Bearer ${playerToken}`;
        if (viewerDiscordId) headers['x-user-id'] = viewerDiscordId;
        return headers;
    }, [playerToken, viewerDiscordId]);

    /**
     * Pull the current rating once the success card appears. Anything other
     * than a clean 200 leaves `ratingInfo` null, which hides the whole block —
     * the deliberate degrade path (401, banned viewer, network blip).
     */
    useEffect(() => {
        if (phase !== 'success') return;
        const ac = new AbortController();
        (async () => {
            try {
                const res = await fetch(ratingUrl, { headers: ratingHeaders(), signal: ac.signal });
                if (!res.ok) return;
                const data = await res.json().catch(() => null);
                if (ac.signal.aborted || !mountedRef.current) return;
                const parsed = parseRatingInfo(data);
                if (parsed) setRatingInfo(parsed);
            } catch { /* aborted or offline — block stays hidden */ }
        })();
        return () => ac.abort();
    }, [phase, ratingUrl, ratingHeaders]);

    /**
     * Optimistic star tap: paint the new rating immediately, POST, then take
     * the server's aggregate. A failure reverts and says so inline; the rating
     * is never required and never blocks Done.
     */
    const rateGame = async (value: number) => {
        if (!ratingInfo || !playerToken) return;
        const previous = ratingInfo;
        setRatingInfo({ ...previous, user_rating: value });
        setRatingError(null);
        setRatingThanks(false);
        try {
            const res = await fetch(ratingUrl, {
                method: 'POST',
                headers: ratingHeaders(true),
                body: JSON.stringify({ rating: value }),
            });
            if (!res.ok) throw new Error('rejected');
            const data = await res.json().catch(() => null);
            if (!mountedRef.current) return;
            setRatingInfo(parseRatingInfo(data) ?? { ...previous, user_rating: value });
            setRatingThanks(true);
        } catch {
            if (!mountedRef.current) return;
            setRatingInfo(previous);
            setRatingError("Couldn't save that rating.");
        }
    };

    /** Post the optional comment to the game page. Failures stay inline. */
    const postComment = async () => {
        const body = commentText.trim();
        const name = (submittedAs ?? discordUser?.username ?? '').trim().slice(0, 50);
        if (!body || !name || commentPosting) return;
        setCommentPosting(true);
        setCommentError(null);
        try {
            const headers = ratingHeaders(true);
            // Author-only delete on the game page keys on the anon uuid.
            headers['x-user-id'] = anonCommentUserId();
            const res = await fetch(commentUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify({ display_name: name, type: 'comment', body }),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error((err as { error?: string }).error || 'Could not post that comment.');
            }
            if (!mountedRef.current) return;
            setCommentText('');
            setCommentState('posted');
        } catch (err) {
            if (!mountedRef.current) return;
            setCommentError(err instanceof Error ? err.message : 'Could not post that comment.');
        } finally {
            if (mountedRef.current) setCommentPosting(false);
        }
    };

    const handleSubmitClick = async () => {
        // v2.128.0 latch (owner Android field report): the on-screen keyboard
        // sits directly over this button, so the touch that closes it must
        // never be able to submit. `OnScreenKeyboard`'s Done already waits for
        // pointerup + suppresses compatibility mouse events; this is the
        // second gate for anything that still slips through.
        if (Date.now() - keyboardClosedAt.current < KEYBOARD_CLOSE_LATCH_MS) return;
        const scoreNum = parseInt(digitsOnly(score), 10);
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
        // { preventScroll: true } (v2.102.1, tester field report round 3):
        // this sheet is a `fixed inset-0` overlay, and iOS Safari's response
        // to focusing an input inside a fixed layer is to scroll the PAGE
        // BEHIND it to the top — so every keypress yanked the view to the
        // top of the page and the player had to scroll back down between
        // digits. preventScroll keeps the caret in the field without letting
        // iOS "helpfully" scroll anything into view (the field is already
        // visible — the tap that produced this keypress was inside the sheet).
        //
        // v2.128.0 (owner Android field report): the keypad SPLICES at the
        // native caret instead of appending. On touch the score field is
        // `type=text inputMode=none`, so tapping mid-value really does move
        // the caret — the old `prev + key` ignored it and the digit "jumped
        // to the end". `readCaret` returns null where the browser won't
        // report a selection (desktop's `type=number`), which falls back to
        // the append behaviour verbatim.
        if (activeField === 'name') {
            const el = nameRef.current;
            const edit = insertAtCaret(playerName, readCaret(el), key);
            setPlayerName(edit.next);
            if (edit.caret !== null) pendingCaret.current = { field: 'name', pos: edit.caret };
            el?.focus({ preventScroll: true });
        } else if (activeField === 'score') {
            const el = scoreRef.current;
            if (/\d/.test(key)) {
                // Splice into the GROUPED value the caret indexes, then
                // re-group — inserting a digit can add a separator ahead of
                // the caret, so the position has to be re-derived from the
                // digit count rather than nudged by one.
                const edit = insertAtCaret(score, readCaret(el), key);
                const regrouped = reformatScoreEdit(edit.next, edit.caret);
                setScore(regrouped.value);
                if (regrouped.caret !== null) pendingCaret.current = { field: 'score', pos: regrouped.caret };
            }
            el?.focus({ preventScroll: true });
        }
    }, [activeField, playerName, score]);

    const handleBackspace = useCallback(() => {
        if (activeField === 'name') {
            const edit = deleteAtCaret(playerName, readCaret(nameRef.current));
            setPlayerName(edit.next);
            if (edit.caret !== null) pendingCaret.current = { field: 'name', pos: edit.caret };
        } else if (activeField === 'score') {
            // Step the caret back over any separator first, or the backspace
            // deletes a comma the re-group immediately restores and the key
            // looks broken.
            const edit = deleteAtCaret(score, skipSeparatorBack(score, readCaret(scoreRef.current)));
            const regrouped = reformatScoreEdit(edit.next, edit.caret);
            setScore(regrouped.value);
            if (regrouped.caret !== null) pendingCaret.current = { field: 'score', pos: regrouped.caret };
        }
    }, [activeField, playerName, score]);

    /**
     * Restores the caret after a keypad-driven edit commits. It has to run
     * AFTER React writes the new value to the DOM (writing `input.value`
     * collapses the caret to the end), which is exactly what a layout effect
     * guarantees — a plain effect would let the browser paint the wrong caret
     * for a frame. No dependency array on purpose: the ref is consumed
     * whenever it is set, on whichever render carries the new value.
     */
    useLayoutEffect(() => {
        const pending = pendingCaret.current;
        if (!pending) return;
        pendingCaret.current = null;
        const el = pending.field === 'name' ? nameRef.current : scoreRef.current;
        if (!el) return;
        const pos = Math.max(0, Math.min(pending.pos, el.value.length));
        try {
            el.setSelectionRange(pos, pos);
        } catch {
            // Selection APIs are unavailable on some input types — harmless.
        }
    });

    const handleDone = useCallback(() => {
        // Arm the submit latch BEFORE the keyboard unmounts (see
        // KEYBOARD_CLOSE_LATCH_MS and handleSubmitClick).
        keyboardClosedAt.current = Date.now();
        setActiveField(null);
        setShowKeyboard(false);
    }, []);

    /**
     * v2.128.0: Enter inside the score field must never submit. There is no
     * <form> here today, so nothing does — but an IME/hardware Enter on a
     * phone with a Bluetooth keyboard is the classic way that comes back the
     * moment someone wraps this in one. Enter closes the on-screen keyboard
     * and blurs instead, which is what the key means here.
     */
    /**
     * Hardware-keyboard / paste path. The browser has already written a raw
     * value that may contain the separators we rendered plus whatever was
     * typed; re-group it and put the caret back where the digits say it
     * belongs.
     *
     * The one case the browser gets wrong on its own is backspacing over a
     * separator: it removes the comma, the re-group restores it, and the value
     * is unchanged. Detected here as "the edit shortened the string but left
     * the digits alone", and resolved by dropping the digit in front instead —
     * the same rule `skipSeparatorBack` applies on the keypad path.
     */
    const handleScoreChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value;
        const caret = e.target.selectionStart;
        let nextRaw = raw;
        let nextCaret = caret;
        const deletedSomething = raw.length < score.length;
        if (deletedSomething && digitsOnly(raw) === digitsOnly(score) && caret !== null && caret > 0) {
            nextRaw = raw.slice(0, caret - 1) + raw.slice(caret);
            nextCaret = caret - 1;
        }
        const regrouped = reformatScoreEdit(nextRaw, nextCaret);
        setScore(regrouped.value);
        if (regrouped.caret !== null) pendingCaret.current = { field: 'score', pos: regrouped.caret };
    }, [score]);

    const handleScoreKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        if (showKeyboard) {
            handleDone();
            e.currentTarget.blur();
        }
    }, [showKeyboard, handleDone]);

    const needsPhoto = photoRequired(target);
    const cooldown = isCooldownLocked(target);
    const submitting = phase === 'submitting' || phase === 'committingDraft';
    // v2.53.0: picker must be resolved AND both provenance axes chosen.
    const platformsResolved = submittablePlatforms !== null;
    const provenanceChosen = engine.trim() !== '' && device.trim() !== '';
    // v2.79.0 (login mandate): every submitter is authed by the time the form
    // renders — there's no guest name field to gate on anymore.
    // `score` holds the GROUPED string, so every numeric read strips it first.
    const scoreDigits = digitsOnly(score);
    const scoreMagnitude = formatMagnitude(scoreDigits);
    const canSubmit = scoreDigits !== '' && !isNaN(parseInt(scoreDigits, 10)) && parseInt(scoreDigits, 10) >= 0
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
                    /* v2.131.0: the rate/comment block can push this past a
                       short viewport when a claim offer is also showing, so the
                       success card scrolls rather than clipping Done. */
                    <div className="px-4 py-6 text-center space-y-4 overflow-y-auto overscroll-contain">
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

                        {/* Identity P2 — the name this score landed under already
                            carries unclaimed iScored-synced scores in this room.
                            Offering the link here is the one moment the player
                            can see both halves of their split identity. */}
                        {claimOffer && (
                            <div className="text-left px-3 py-3 rounded-lg bg-neon-cyan/5 border border-neon-cyan/30 space-y-2">
                                <p className="text-xs text-primary leading-relaxed break-words">
                                    There are already scores here under{' '}
                                    <span className="font-display font-bold text-neon-cyan">{claimOffer.iscoredUsername}</span>
                                    , synced from iScored. Is that you?
                                </p>
                                {claimMsg ? (
                                    <p className={`text-xs ${claimMsg.ok ? 'text-neon-green' : 'text-neon-amber'}`}>
                                        {claimMsg.text}
                                    </p>
                                ) : (
                                    <div className="grid grid-cols-1 gap-2">
                                        <NeonButton onClick={acceptClaimOffer} disabled={claimBusy} className="w-full">
                                            {claimBusy ? 'Linking…' : 'Yes — link it to my account'}
                                        </NeonButton>
                                        <button
                                            type="button"
                                            onClick={dismissClaimOffer}
                                            disabled={claimBusy}
                                            className="w-full px-4 py-2 rounded border border-border text-muted text-sm hover:text-primary hover:border-border/80 transition-colors cursor-pointer"
                                        >
                                            Not me
                                        </button>
                                    </div>
                                )}
                            </div>
                        )}

                        {/* v2.131.0 — "the perfect time to rate a game is right
                            after you've just played it" (owner, 2026-08-22).
                            Both halves are optional and both degrade to nothing:
                            the block only exists once the rating GET succeeds,
                            and neither POST can hold up Done. The comment editor
                            expands IN PLACE OF the caption row so the block's
                            height barely moves and Done stays above the fold on
                            a 390×844 screen. */}
                        {ratingInfo && (
                            <div className="text-left px-3 py-2.5 rounded-lg bg-raised/40 border border-border/60 space-y-2">
                                <div className="flex items-center justify-between gap-3">
                                    <p className="text-xs text-muted leading-snug break-words min-w-0">
                                        How was <span className="text-primary font-medium">{target.gameName}</span>?
                                    </p>
                                    <div className="flex-shrink-0">
                                        <StarRating
                                            rating={ratingInfo.user_rating ?? 0}
                                            onRate={rateGame}
                                            size="md"
                                        />
                                    </div>
                                </div>

                                {commentState === 'closed' && (
                                    <div className="flex items-center justify-between gap-2">
                                        <p className="text-[11px] leading-tight min-w-0">
                                            {ratingError ? (
                                                <span className="text-neon-amber">{ratingError}</span>
                                            ) : ratingThanks ? (
                                                <span className="text-neon-green">Thanks!</span>
                                            ) : ratingInfo.rating_count > 0 ? (
                                                <span className="text-muted">
                                                    avg ★ {ratingInfo.avg_rating.toFixed(1)} · {ratingInfo.rating_count}{' '}
                                                    {ratingInfo.rating_count === 1 ? 'rating' : 'ratings'}
                                                </span>
                                            ) : null}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => setCommentState('open')}
                                            className="text-[11px] text-neon-cyan hover:underline flex-shrink-0 cursor-pointer"
                                        >
                                            Add a comment
                                        </button>
                                    </div>
                                )}

                                {commentState === 'open' && (
                                    <div className="space-y-1.5">
                                        {/* Native keyboard on purpose — the on-screen
                                            keypad is numeric and belongs to the score
                                            field only (v2.128.0). */}
                                        <textarea
                                            value={commentText}
                                            onChange={e => setCommentText(e.target.value.slice(0, COMMENT_MAX_LENGTH))}
                                            maxLength={COMMENT_MAX_LENGTH}
                                            rows={3}
                                            autoFocus
                                            aria-label="Comment"
                                            placeholder={`Anything to say about ${target.gameName}?`}
                                            className="w-full px-2.5 py-2 bg-raised border border-border rounded text-primary placeholder-faint text-xs leading-relaxed focus:outline-none focus:border-neon-cyan transition-colors resize-none"
                                        />
                                        <div className="flex items-center justify-between gap-2">
                                            <span className="text-[11px] text-faint flex-shrink-0">
                                                {commentText.length}/{COMMENT_MAX_LENGTH}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    onClick={() => { setCommentState('closed'); setCommentError(null); }}
                                                    disabled={commentPosting}
                                                    className="text-[11px] text-muted hover:text-primary transition-colors cursor-pointer"
                                                >
                                                    Cancel
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={postComment}
                                                    disabled={commentPosting || !commentText.trim()}
                                                    className="px-2.5 py-1 rounded border border-neon-cyan/40 text-neon-cyan text-[11px] hover:bg-neon-cyan/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                                                >
                                                    {commentPosting ? 'Posting…' : 'Post comment'}
                                                </button>
                                            </div>
                                        </div>
                                        {commentError && (
                                            <p className="text-[11px] text-neon-amber">{commentError}</p>
                                        )}
                                    </div>
                                )}

                                {commentState === 'posted' && (
                                    <p className="text-[11px] text-neon-green">
                                        Posted —{' '}
                                        {gamePagePath ? (
                                            <Link to={gamePagePath} onClick={onClose} className="text-neon-cyan hover:underline">
                                                see it on the game page
                                            </Link>
                                        ) : (
                                            <span className="text-muted">it's on the game page</span>
                                        )}
                                    </p>
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
                                        keyboard.

                                        Desktop is type=text too as of the
                                        comma-grouping change: type=number refuses
                                        to hold a value containing separators (it
                                        reports the field as empty), and it is the
                                        one input type whose `selectionStart`
                                        throws, so it could never have had a
                                        caret-aware edit either. inputMode=numeric
                                        still asks a hybrid device for a keypad;
                                        the lost spinner is no loss on an
                                        eleven-digit field. */}
                                    <input
                                        ref={scoreRef}
                                        type="text"
                                        inputMode={isTouchDevice ? 'none' : 'numeric'}
                                        autoComplete="off"
                                        value={score}
                                        onChange={handleScoreChange}
                                        onKeyDown={handleScoreKeyDown}
                                        onFocus={() => { setActiveField('score'); if (isTouchDevice) setShowKeyboard(true); }}
                                        placeholder="0"
                                        aria-describedby={scoreMagnitude ? 'score-magnitude' : undefined}
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
                                {/* The digit-count check. Grouping proves the
                                    separators are well-formed, not that the
                                    magnitude is the one you meant — an extra
                                    zero still reads as a plausible comma
                                    pattern. "6.66 billion" does not. */}
                                {scoreMagnitude && (
                                    <p id="score-magnitude" className="text-xs text-faint mt-1" aria-live="polite">
                                        {scoreMagnitude}
                                    </p>
                                )}
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
                                {/* Two inputs, one handler (v2.141.1). A single
                                    capture-less input reads as "Take or choose"
                                    on iOS (native sheet offers both) but on
                                    Android 13+ the system photo picker it opens
                                    has NO camera tile at all — the button
                                    promised a camera it couldn't deliver (owner
                                    report, 2026-08-26). `capture` opens the
                                    camera directly on BOTH platforms, so the
                                    choice moves into our own two buttons. */}
                                <input
                                    ref={cameraInputRef}
                                    type="file"
                                    accept="image/*"
                                    capture="environment"
                                    onChange={handlePhotoChange}
                                    className="hidden"
                                />
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
                                    <div className="flex gap-2">
                                        <button
                                            type="button"
                                            onClick={() => cameraInputRef.current?.click()}
                                            className="flex-1 flex items-center justify-center gap-2 px-4 py-6 border-2 border-dashed border-border rounded-lg text-muted hover:text-neon-cyan hover:border-neon-cyan/30 transition-colors cursor-pointer"
                                        >
                                            <Camera size={20} />
                                            <span className="text-sm">Take photo</span>
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => fileInputRef.current?.click()}
                                            className="flex-1 flex items-center justify-center gap-2 px-4 py-6 border-2 border-dashed border-border rounded-lg text-muted hover:text-neon-cyan hover:border-neon-cyan/30 transition-colors cursor-pointer"
                                        >
                                            <ImageIcon size={20} />
                                            <span className="text-sm">Choose photo</span>
                                        </button>
                                    </div>
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
