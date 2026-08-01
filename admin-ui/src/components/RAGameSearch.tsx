import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Loader2, Check, Plus } from 'lucide-react';
import { getToken, getAnonUserId } from '../lib/api';

/**
 * RetroAchievements on-demand catalogue search (contract §4).
 *
 * ONE component, three surfaces — the Global Scoreboard's search empty state
 * (players), the room-admin add-game flow (`GameLibrary`), and the super-admin
 * catalogue panel (`GlobalCatalogue`). They differ only in which endpoint base
 * they hit and who is allowed to press the button; forking three near-copies is
 * exactly how three surfaces drift into three slightly different behaviours
 * (the backend made the same call — see `src/api/raCatalogueHandlers.ts`).
 *
 * Auth: the room/admin surfaces ride the admin Bearer that `lib/api` holds; the
 * global surface rides the PLAYER token, which `lib/api` knows nothing about.
 * Rather than route through `api.get`/`api.post` (which swallow the HTTP status
 * — and 422 vs 429 vs 400 are three different user-facing messages here), every
 * call is a raw `fetch` with headers built from whichever token applies.
 */

export interface RASearchResult {
    raGameId: number;
    title: string;
    consoleId: number;
    consoleName: string | null;
    iconUrl: string | null;
    numAchievements: number | null;
    numLeaderboards: number | null;
    inCatalogue: boolean;
    globalGameId: string | null;
    scoreEligibility: string | null;
}

interface RAMasterListStatus {
    total: number;
    lastSyncedAt: string | null;
    stale: boolean;
    syncing: boolean;
}

interface RAAttribution {
    source: string;
    url: string;
    label: string;
}

interface RASearchResponse {
    results: RASearchResult[];
    masterList: RAMasterListStatus;
    configured: boolean;
    attribution: RAAttribution;
}

/** Shape of a successful POST .../ra-catalogue/import/:raGameId. */
export interface RAImportedGame {
    id: string;
    name: string;
    [key: string]: unknown;
}

export interface RAImportResult {
    success: boolean;
    action: 'inserted' | 'updated';
    raGameId: number;
    scoreEligibility: string | null;
    leaderboardCount: number;
    game: RAImportedGame;
}

/**
 * Admin-only copy for the import-time verdict (contract §5: the eligibility
 * hint is a moderation signal for admins, never a label shown to players).
 */
const ELIGIBILITY_HINTS: Record<string, string> = {
    novelty: "RA boards suggest this isn't high-score-based",
    time: 'RA boards suggest this is time-based, not high-score-based',
};

function raEligibilityHint(verdict: string | null | undefined): string | null {
    if (!verdict) return null;
    return ELIGIBILITY_HINTS[verdict] || null;
}

interface Props {
    /**
     * Endpoint base under `/api`, without a trailing slash — one of
     * `/global/ra-catalogue`, `/rooms/${roomId}/ra-catalogue`,
     * `/admin/ra-catalogue`.
     */
    basePath: string;
    /** Which token to send. `player` reads `playerToken`; `admin` reads lib/api's. */
    authMode: 'admin' | 'player';
    /** Player JWT — required (and only read) when `authMode === 'player'`. */
    playerToken?: string | null;
    /** The search text. The surface owns the input; this component never renders one. */
    query: string;
    /**
     * Extra debounce applied to `query`. Pass 0 from a surface that already
     * debounces (the Global Scoreboard does) so a keystroke isn't delayed twice.
     */
    debounceMs?: number;
    /** False → rows render `loginPrompt` instead of an import button (guests). */
    canImport: boolean;
    /** Guest affordance, e.g. "Log in to add this game" wired to the login flow. */
    loginPrompt?: ReactNode;
    /** Copy on the import button. Defaults to the player-facing wording. */
    actionLabel?: string;
    /**
     * Section heading. The default is the player-facing prompt; an admin panel
     * that already announces itself passes something plainer rather than asking
     * the admin a question they just answered by opening the panel.
     */
    heading?: string;
    /** Link target for rows already in the catalogue. Omit to render plain text. */
    inCatalogueHref?: (globalGameId: string) => string;
    /**
     * Contract §5 — the eligibility verdict is an ADMIN signal. Leave false on
     * player surfaces.
     */
    showEligibility?: boolean;
    /**
     * True → an unconfigured server explains what to do about it (admins).
     * False → the whole section renders nothing (players can't act on it).
     */
    showConfigHint?: boolean;
    /** Fired after a successful import so the surface can refresh / select. */
    onImported?: (result: RAImportResult) => void;
    /** Minimum query length before a request goes out. */
    minChars?: number;
    /**
     * `card` (default) draws its own surface. `bare` drops the border/padding
     * for hosts that already provide one — the ⌘K palette dropdown, where a
     * nested card inside a card reads as a rendering bug.
     */
    variant?: 'card' | 'bare';
    className?: string;
}

/** Human copy for the non-2xx cases the import endpoints can return. */
function importErrorMessage(status: number, body: { error?: string } | null): string {
    if (status === 429) {
        return "You've added a lot of games recently — try again a little later.";
    }
    if (status === 422 || status === 400 || status === 404) {
        return body?.error || 'That game could not be imported.';
    }
    return body?.error || 'The import failed. Please try again in a moment.';
}

export default function RAGameSearch({
    basePath,
    authMode,
    playerToken,
    query,
    debounceMs = 300,
    canImport,
    loginPrompt,
    actionLabel = 'Add to Arcaid',
    heading = "Can't find it? Search RetroAchievements",
    inCatalogueHref,
    showEligibility = false,
    showConfigHint = false,
    onImported,
    minChars = 2,
    variant = 'card',
    className = '',
}: Props) {
    const shellClass = variant === 'bare'
        ? `px-4 py-3 ${className}`
        : `rounded-lg border border-border bg-surface p-4 ${className}`;
    const [debounced, setDebounced] = useState(query);
    const [data, setData] = useState<RASearchResponse | null>(null);
    const [loading, setLoading] = useState(false);
    const [importingId, setImportingId] = useState<number | null>(null);
    const [rowError, setRowError] = useState<{ raGameId: number; message: string } | null>(null);
    const abortRef = useRef<AbortController | null>(null);

    useEffect(() => {
        if (debounceMs <= 0) { setDebounced(query); return; }
        const t = window.setTimeout(() => setDebounced(query), debounceMs);
        return () => window.clearTimeout(t);
    }, [query, debounceMs]);

    /**
     * Headers are rebuilt per call from the raw token string rather than held in
     * a hook-returned object — depending on a `use*Headers()` result from a fetch
     * effect is the exact shape of the v2.18.1 infinite-fetch-loop bug.
     */
    const buildHeaders = useCallback((): Record<string, string> => {
        const headers: Record<string, string> = { 'x-user-id': getAnonUserId() };
        const token = authMode === 'player' ? playerToken : getToken();
        if (token) headers.Authorization = `Bearer ${token}`;
        return headers;
    }, [authMode, playerToken]);

    useEffect(() => {
        const trimmed = debounced.trim();
        if (trimmed.length < minChars) {
            setData(null);
            setLoading(false);
            return;
        }
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        fetch(`/api${basePath}/search?q=${encodeURIComponent(trimmed)}&limit=8`, {
            headers: buildHeaders(),
            signal: controller.signal,
        })
            .then(r => (r.ok ? r.json() : null))
            .then((payload: RASearchResponse | null) => {
                if (controller.signal.aborted) return;
                setData(payload);
            })
            .catch(() => {
                if (!controller.signal.aborted) setData(null);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [debounced, basePath, minChars, buildHeaders]);

    const handleImport = async (row: RASearchResult) => {
        if (importingId !== null) return;
        setImportingId(row.raGameId);
        setRowError(null);
        try {
            const res = await fetch(`/api${basePath}/import/${row.raGameId}`, {
                method: 'POST',
                headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
                body: '{}',
            });
            const body = await res.json().catch(() => null);
            if (!res.ok) {
                setRowError({ raGameId: row.raGameId, message: importErrorMessage(res.status, body) });
                return;
            }
            // Flip the row locally so it reads "In Arcaid ✓" without a refetch —
            // the surface's own refresh is about ITS list, not this one.
            setData(prev => prev && {
                ...prev,
                results: prev.results.map(r => (
                    r.raGameId === row.raGameId
                        ? {
                            ...r,
                            inCatalogue: true,
                            globalGameId: (body as RAImportResult).game?.id ?? null,
                            scoreEligibility: (body as RAImportResult).scoreEligibility ?? null,
                        }
                        : r
                )),
            });
            onImported?.(body as RAImportResult);
        } catch {
            setRowError({ raGameId: row.raGameId, message: 'Network error — please try again.' });
        } finally {
            setImportingId(null);
        }
    };

    const trimmed = debounced.trim();
    if (trimmed.length < minChars) return null;

    // Unconfigured: admins get something actionable, players get nothing at all
    // (a dead-end "unavailable" panel is worse than no panel).
    if (data && !data.configured) {
        if (!showConfigHint) return null;
        return (
            <div className={shellClass} data-testid="ra-search">
                <p className="text-sm text-muted">
                    RetroAchievements import isn't configured on this server. A super-admin can set
                    {' '}<span className="text-primary">RA_API_KEY</span> under Global Settings → Configuration.
                </p>
            </div>
        );
    }

    const results = data?.results ?? [];
    const building = Boolean(data?.masterList?.syncing) && results.length === 0;
    const nothing = !loading && !building && data !== null && results.length === 0;

    // Players never see an empty RA panel — it just adds noise under a search
    // that already said "no results". Admins do: it is the answer to "is the
    // index even working?".
    if (nothing && !showConfigHint) return null;

    return (
        <div className={shellClass} data-testid="ra-search">
            <div className="flex items-center gap-2 mb-3">
                <h3 className="font-display text-sm font-bold text-primary">{heading}</h3>
                {loading && <Loader2 className="h-3.5 w-3.5 animate-spin text-neon-cyan" aria-label="Searching" />}
            </div>

            {building ? (
                <p className="text-sm text-muted" data-testid="ra-building">
                    We're building the RetroAchievements index right now — try this search again in a
                    minute.
                </p>
            ) : nothing ? (
                <p className="text-sm text-muted" data-testid="ra-empty">
                    Nothing on RetroAchievements matches "{trimmed}".
                </p>
            ) : (
                <ul className="flex flex-col gap-2" data-testid="ra-results">
                    {results.map(row => {
                        const hint = showEligibility ? raEligibilityHint(row.scoreEligibility) : null;
                        const isImporting = importingId === row.raGameId;
                        const error = rowError?.raGameId === row.raGameId ? rowError.message : null;
                        return (
                            <li
                                key={row.raGameId}
                                data-testid="ra-result-row"
                                data-ra-game-id={row.raGameId}
                                className="flex items-center gap-3 rounded-md border border-border bg-raised px-3 py-2"
                            >
                                {row.iconUrl ? (
                                    <img
                                        src={row.iconUrl}
                                        alt=""
                                        loading="lazy"
                                        className="h-9 w-9 shrink-0 rounded object-cover bg-surface"
                                    />
                                ) : (
                                    <div className="h-9 w-9 shrink-0 rounded bg-surface" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="truncate text-sm font-medium text-primary">{row.title}</div>
                                    <div className="truncate text-[11px] text-muted">
                                        {row.consoleName || `Console ${row.consoleId}`}
                                        {row.numLeaderboards != null && (
                                            <>
                                                {' · '}
                                                {row.numLeaderboards} leaderboard{row.numLeaderboards === 1 ? '' : 's'}
                                            </>
                                        )}
                                    </div>
                                    {hint && (
                                        <div className="truncate text-[11px] text-faint" data-testid="ra-eligibility-hint">
                                            {hint}
                                        </div>
                                    )}
                                    {error && (
                                        <div className="text-[11px] text-neon-magenta" data-testid="ra-row-error">
                                            {error}
                                        </div>
                                    )}
                                </div>
                                <div className="shrink-0">
                                    {row.inCatalogue ? (
                                        row.globalGameId && inCatalogueHref ? (
                                            <a
                                                href={inCatalogueHref(row.globalGameId)}
                                                className="inline-flex items-center gap-1 text-[11px] font-medium text-neon-green hover:underline"
                                            >
                                                <Check className="h-3 w-3" aria-hidden="true" />
                                                In Arcaid
                                            </a>
                                        ) : (
                                            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-neon-green">
                                                <Check className="h-3 w-3" aria-hidden="true" />
                                                In Arcaid
                                            </span>
                                        )
                                    ) : canImport ? (
                                        <button
                                            type="button"
                                            onClick={() => handleImport(row)}
                                            disabled={importingId !== null}
                                            className="inline-flex items-center gap-1 rounded border border-neon-cyan/40 bg-neon-cyan/15 px-2.5 py-1.5 text-[11px] font-semibold text-neon-cyan transition-colors hover:bg-neon-cyan/25 disabled:opacity-40 disabled:cursor-not-allowed"
                                        >
                                            {isImporting ? (
                                                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                                            ) : (
                                                <Plus className="h-3 w-3" aria-hidden="true" />
                                            )}
                                            {isImporting ? 'Adding…' : actionLabel}
                                        </button>
                                    ) : (
                                        <div className="text-[11px] text-muted" data-testid="ra-login-prompt">
                                            {loginPrompt ?? 'Log in to add this game'}
                                        </div>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            )}

            {data?.attribution && (
                <p className="mt-3 text-[11px] text-faint">
                    <a
                        href={data.attribution.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-muted hover:underline"
                    >
                        {data.attribution.label}
                    </a>
                </p>
            )}
        </div>
    );
}
