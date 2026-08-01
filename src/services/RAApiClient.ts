import { logInfo, logWarn } from '../utils/logger.js';

/**
 * RetroAchievements web API client (RA on-demand import, contract §1).
 *
 * Per-use, NOT a singleton — same shape as `IScoredApiClient`. It holds one
 * credential pair and nothing else, so constructing one per call costs
 * nothing and there is no shared mutable state to serialise.
 *
 * Raw `fetch` against five trivial GET endpoints rather than the official
 * `@retroachievements/api` package: the dependency buys nothing here (no auth
 * dance, no pagination protocol, no websockets), and staying on the raw
 * responses keeps the field names PascalCase-faithful to api-docs.retro
 * achievements.org, which is what the parsing guards below are written
 * against.
 *
 * ── The key is in the query string ──────────────────────────────────────────
 *
 * RA authenticates with `?y=<web API key>`. That is a materially different
 * hazard from a Bearer header: the secret rides in every URL, and a URL is
 * the single most-logged string in an HTTP client — request logs, retry
 * warnings, thrown `Error.message`, and `fetch`'s own network errors all
 * carry it. `scrubRaSecrets` is therefore applied to EVERY string this module
 * hands to the logger or puts in an Error, and the tests assert it. Nothing
 * in this file may log a raw URL.
 *
 * ── Fair use ────────────────────────────────────────────────────────────────
 *
 * RA publishes no numeric rate limit but explicitly asks callers to cache the
 * game-list endpoint rather than re-pull it. The master-list sync honours that
 * (7-day staleness gate, ~300ms between console calls); this client only
 * enforces the per-request retry policy.
 */

/** API host. Endpoints are flat PHP scripts directly under this root. */
const RA_API_BASE = 'https://retroachievements.org/API';

/**
 * Media host for `Image*` fields. RA returns those as SITE-RELATIVE paths
 * (`/Images/012345.png`); they only resolve against this host, not the API
 * host. Exported because the import service rehosts the artwork.
 */
export const RA_MEDIA_BASE = 'https://media.retroachievements.org';

/** Public game page, used as the catalogue row's `external_url`. */
export const RA_GAME_URL_BASE = 'https://retroachievements.org/game';

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * One retry, not five. Every call here is interactive: the master-list sync
 * is a button a super-admin is watching, and the import is a request a player
 * is waiting on. A long backoff ladder would turn a transient 429 into a
 * request timeout, which reads worse than a prompt "try again".
 */
const MAX_REQUEST_ATTEMPTS = 2;
const RETRY_BASE_MS = 750;
const RETRY_MAX_MS = 5_000;

/**
 * Removes the RA web API key from any string that may contain a request URL.
 *
 * Matches the `y=` query parameter in both the leading (`?y=`) and subsequent
 * (`&y=`) positions and replaces the VALUE only, so the remaining text still
 * says which endpoint and game id was involved — a scrubbed log line is still
 * a useful log line.
 *
 * Exported for the test that proves no log path leaks the key, and so callers
 * that build their own RA URLs can scrub before logging.
 */
export function scrubRaSecrets(text: string): string {
    return String(text ?? '').replace(/([?&])y=[^&\s"']*/gi, '$1y=[REDACTED]');
}

/** A row from `API_GetGameList.php`. Extra fields are tolerated and ignored. */
export interface RAGameListEntry {
    ID: number;
    Title: string;
    ConsoleID: number;
    ConsoleName?: string | null;
    ImageIcon?: string | null;
    NumAchievements?: number | null;
    NumLeaderboards?: number | null;
    DateModified?: string | null;
}

/** The subset of `API_GetGameExtended.php` the catalogue actually consumes. */
export interface RAGameExtended {
    ID: number;
    Title: string;
    ConsoleID: number;
    ConsoleName?: string | null;
    Publisher?: string | null;
    Developer?: string | null;
    Genre?: string | null;
    Released?: string | null;
    ImageIcon?: string | null;
    ImageTitle?: string | null;
    ImageIngame?: string | null;
    ImageBoxArt?: string | null;
}

/** One board from `API_GetGameLeaderboards.php`. */
export interface RALeaderboard {
    ID: number;
    RankAsc?: boolean | null;
    Title?: string | null;
    Description?: string | null;
    Format?: string | null;
}

/** A console from `API_GetConsoleIDs.php`. */
export interface RAConsole {
    ID: number;
    Name: string;
}

/** Coerces an unknown value to a finite number, or null. */
function num(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '') {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/** Coerces an unknown value to a non-empty trimmed string, or null. */
function str(value: unknown): string | null {
    if (typeof value === 'string') {
        const t = value.trim();
        return t === '' ? null : t;
    }
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return null;
}

/**
 * Coerces RA's booleans. The API is PHP-backed and has historically shipped
 * `1`/`0` and `"true"`/`"false"` as well as real JSON booleans for the same
 * field, so all three are accepted rather than trusting one spelling.
 */
function bool(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
        const t = value.trim().toLowerCase();
        return t === '1' || t === 'true';
    }
    return false;
}

function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Full-jitter backoff, same shape as `IGDBImportService.backoffDelay`. */
function backoffDelay(attempt: number): number {
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/** Per RFC 9110: delta-seconds or an HTTP-date. Returns ms, or undefined. */
function parseRetryAfter(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(RETRY_MAX_MS, seconds * 1000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.min(RETRY_MAX_MS, Math.max(0, date - Date.now()));
    return undefined;
}

export class RAApiClient {
    private readonly apiKey: string;
    private readonly username: string | null;

    /**
     * Credentials default to the global settings (loaded into `process.env` at
     * boot by `SettingsService`, exactly like `OPDB_API_KEY`).
     *
     * @throws when no key is configured — callers surface that as an
     *         actionable 400 rather than letting RA answer "Access Denied".
     */
    constructor(opts?: { apiKey?: string; username?: string | null }) {
        const key = opts?.apiKey ?? process.env.RA_API_KEY ?? '';
        if (!key.trim()) {
            throw new Error(
                'RA_API_KEY is not configured. Add it under Global Settings → Configuration; ' +
                'any free RetroAchievements account can mint one at ' +
                'https://retroachievements.org/controlpanel.php.',
            );
        }
        this.apiKey = key.trim();
        this.username = (opts?.username ?? process.env.RA_USERNAME ?? '').trim() || null;
    }

    /** True when a key is configured — for the routes' upfront 400 check. */
    static isConfigured(): boolean {
        return !!(process.env.RA_API_KEY ?? '').trim();
    }

    /**
     * Builds an endpoint URL. `y` is appended LAST so a scrubbed log line
     * keeps every meaningful parameter visible ahead of the redaction.
     */
    private buildUrl(endpoint: string, params: Record<string, string | number>): string {
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(params)) qs.set(k, String(v));
        qs.set('y', this.apiKey);
        return `${RA_API_BASE}/${endpoint}?${qs.toString()}`;
    }

    /**
     * One RA GET with a bounded retry. Returns the parsed JSON body.
     *
     * 429 and 5xx are transient (honour `Retry-After` when present, else
     * jittered backoff); network failures and timeouts are treated the same.
     * Any other non-OK status throws immediately — retrying a 404 for a game
     * id that does not exist is pointless.
     *
     * RA answers a rejected key with a 200 carrying plain text ("Invalid API
     * Key"), not a 401, so `JSON.parse` is attempted on the TEXT rather than
     * via `resp.json()`: that is the only way to turn the rejection into a
     * message a human can act on instead of a raw `SyntaxError`. Same defect
     * class as `IScoredApiClient.submitScore`'s "Access Denied" handling.
     *
     * Every log line and every thrown message passes through
     * `scrubRaSecrets`. `label` (not the URL) is what identifies the call.
     */
    private async raFetch<T>(
        endpoint: string,
        params: Record<string, string | number>,
        label: string,
    ): Promise<T> {
        const url = this.buildUrl(endpoint, params);
        const safeUrl = scrubRaSecrets(url);
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
            let resp: Response;
            try {
                resp = await fetch(url, {
                    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                    headers: {
                        // RA's community guidance asks integrations to
                        // identify themselves. This is the one functional use
                        // of RA_USERNAME: the API itself authenticates on `y`
                        // alone, but a named UA is what lets RA's operators
                        // contact the right person if we misbehave.
                        'User-Agent': this.username
                            ? `Arcaid/1.0 (+https://arcaid.app; RA user ${this.username})`
                            : 'Arcaid/1.0 (+https://arcaid.app)',
                    },
                });
            } catch (err) {
                const message = scrubRaSecrets(err instanceof Error ? err.message : String(err));
                lastError = new Error(message);
                if (attempt >= MAX_REQUEST_ATTEMPTS) break;
                const wait = backoffDelay(attempt);
                logWarn(`RA ${label}: network failure (${message}); retrying in ${wait}ms.`);
                await delay(wait);
                continue;
            }

            if (resp.status === 429 || resp.status >= 500) {
                const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
                const body = scrubRaSecrets(await resp.text().catch(() => ''));
                lastError = new Error(`RA ${label} returned ${resp.status}: ${body.slice(0, 300)}`);
                if (attempt >= MAX_REQUEST_ATTEMPTS) break;
                const wait = retryAfter ?? backoffDelay(attempt);
                logWarn(
                    `RA ${label}: ${resp.status} ${resp.status === 429 ? '(rate limited)' : '(server error)'}; ` +
                    `retrying in ${wait}ms${retryAfter !== undefined ? ' per Retry-After' : ''}.`,
                );
                await delay(wait);
                continue;
            }

            const text = await resp.text();
            if (!resp.ok) {
                throw new Error(
                    `RA ${label} returned ${resp.status}: ${scrubRaSecrets(text).slice(0, 300)}`,
                );
            }

            try {
                return JSON.parse(text) as T;
            } catch {
                // A 200 that is not JSON is RA rejecting the request in prose.
                const snippet = scrubRaSecrets(text).trim().slice(0, 200);
                throw new Error(
                    `RA ${label} returned a non-JSON body (the API key is probably invalid or ` +
                    `revoked): "${snippet}". Request was ${safeUrl}`,
                );
            }
        }

        throw new Error(
            `RA ${label} failed after ${MAX_REQUEST_ATTEMPTS} attempt(s): ` +
            `${scrubRaSecrets(lastError?.message ?? 'unknown error')}`,
        );
    }

    /**
     * `API_GetGameList.php` — every game on one console.
     *
     * `f=1` restricts the answer to games with a REAL achievement set, which
     * is the whole point: RA's raw per-console list includes thousands of
     * empty stubs, and a stub is not something anyone wants to find in an
     * add-game search. `h=1` asks RA to include hashes-only entries' counts;
     * it is omitted deliberately (we want the curated list, not every ROM
     * variant).
     *
     * Rows missing an id or a title are dropped rather than passed on: the
     * master list is keyed on `ra_game_id`, so a row without one has nothing
     * to be keyed by.
     */
    async getGameList(consoleId: number): Promise<RAGameListEntry[]> {
        const raw = await this.raFetch<unknown>(
            'API_GetGameList.php',
            { i: consoleId, f: 1 },
            `GetGameList(console=${consoleId})`,
        );
        if (!Array.isArray(raw)) {
            throw new Error(`RA GetGameList(console=${consoleId}) did not return an array.`);
        }

        const out: RAGameListEntry[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') continue;
            const row = item as Record<string, unknown>;
            const id = num(row.ID);
            const title = str(row.Title);
            if (id == null || !title) continue;
            out.push({
                ID: id,
                Title: title,
                ConsoleID: num(row.ConsoleID) ?? consoleId,
                ConsoleName: str(row.ConsoleName),
                ImageIcon: str(row.ImageIcon),
                NumAchievements: num(row.NumAchievements),
                NumLeaderboards: num(row.NumLeaderboards),
                DateModified: str(row.DateModified),
            });
        }
        return out;
    }

    /** `API_GetGameExtended.php` — one game's metadata + artwork paths. */
    async getGameExtended(raGameId: number): Promise<RAGameExtended | null> {
        const raw = await this.raFetch<unknown>(
            'API_GetGameExtended.php',
            { i: raGameId },
            `GetGameExtended(game=${raGameId})`,
        );
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const row = raw as Record<string, unknown>;

        const id = num(row.ID);
        const title = str(row.Title);
        // RA answers an unknown id with `{"ID": null, ...}` rather than a 404.
        if (id == null || !title) return null;

        return {
            ID: id,
            Title: title,
            ConsoleID: num(row.ConsoleID) ?? 0,
            ConsoleName: str(row.ConsoleName),
            // Publisher/Developer/Genre are documented as frequently EMPTY.
            // `str` turns '' into null so the catalogue stores an honest NULL
            // instead of an empty-string manufacturer.
            Publisher: str(row.Publisher),
            Developer: str(row.Developer),
            Genre: str(row.Genre),
            Released: str(row.Released),
            ImageIcon: str(row.ImageIcon),
            ImageTitle: str(row.ImageTitle),
            ImageIngame: str(row.ImageIngame),
            ImageBoxArt: str(row.ImageBoxArt),
        };
    }

    /**
     * `API_GetGameLeaderboards.php` — every board for one game, paginated.
     *
     * RA wraps this one in `{Count, Total, Results:[…]}` (unlike the flat
     * arrays above), and both shapes are accepted here so a future flattening
     * on RA's side does not break the importer. Pages at `c=500` until the
     * results run out or `Total` is reached; `MAX_PAGES` bounds it because a
     * malformed `Total` must not spin forever.
     */
    async getGameLeaderboards(raGameId: number): Promise<RALeaderboard[]> {
        const PAGE_SIZE = 500;
        const MAX_PAGES = 20;
        const out: RALeaderboard[] = [];
        let offset = 0;

        for (let page = 0; page < MAX_PAGES; page++) {
            const raw = await this.raFetch<unknown>(
                'API_GetGameLeaderboards.php',
                { i: raGameId, c: PAGE_SIZE, o: offset },
                `GetGameLeaderboards(game=${raGameId}, o=${offset})`,
            );

            let results: unknown[];
            let total: number | null = null;
            if (Array.isArray(raw)) {
                results = raw;
            } else if (raw && typeof raw === 'object') {
                const wrapper = raw as Record<string, unknown>;
                results = Array.isArray(wrapper.Results) ? wrapper.Results : [];
                total = num(wrapper.Total);
            } else {
                break;
            }

            for (const item of results) {
                if (!item || typeof item !== 'object') continue;
                const row = item as Record<string, unknown>;
                const id = num(row.ID);
                if (id == null) continue;
                out.push({
                    ID: id,
                    RankAsc: bool(row.RankAsc),
                    Title: str(row.Title),
                    Description: str(row.Description),
                    Format: str(row.Format),
                });
            }

            offset += results.length;
            if (results.length < PAGE_SIZE) break;
            if (total != null && offset >= total) break;
        }

        return out;
    }

    /**
     * `API_GetConsoleIDs.php` — RA's own console list.
     *
     * Not needed to import anything; it exists so `RA_CONSOLE_ENGINE_MAP` can
     * be checked against the source of truth the way
     * `IGDBImportService.verifyPlatformIds` checks the IGDB platform ids.
     * Three of those were simply WRONG and nothing anywhere said so — the
     * import happily mislabelled every game it touched. Never throws on
     * disagreement; a rename is not a reason to refuse to sync.
     */
    async getConsoleIds(): Promise<RAConsole[]> {
        const raw = await this.raFetch<unknown>('API_GetConsoleIDs.php', {}, 'GetConsoleIDs');
        if (!Array.isArray(raw)) return [];
        const out: RAConsole[] = [];
        for (const item of raw) {
            if (!item || typeof item !== 'object') continue;
            const row = item as Record<string, unknown>;
            const id = num(row.ID);
            const name = str(row.Name);
            if (id == null || !name) continue;
            out.push({ ID: id, Name: name });
        }
        return out;
    }

    /**
     * Absolute URL for one of RA's site-relative `Image*` paths, or null.
     *
     * RA ships these as `/Images/012345.png`. A caller that forgets the media
     * host gets a 404 from the API host, which is the kind of failure that
     * shows up as a silently missing image weeks later.
     */
    static mediaUrl(imagePath: string | null | undefined): string | null {
        const path = (imagePath ?? '').trim();
        if (!path) return null;
        if (/^https?:\/\//i.test(path)) return path;
        return `${RA_MEDIA_BASE}${path.startsWith('/') ? '' : '/'}${path}`;
    }

    /**
     * Logs how `RA_CONSOLE_ENGINE_MAP` compares to RA's live console list.
     * Cheap, one request, best-effort — see `getConsoleIds`.
     */
    async verifyConsoleMap(map: Record<number, string>): Promise<Array<{ id: number; raName: string }>> {
        const mismatches: Array<{ id: number; raName: string }> = [];
        try {
            const consoles = await this.getConsoleIds();
            if (consoles.length === 0) return mismatches;
            const byId = new Map(consoles.map(c => [c.ID, c.Name]));
            for (const idStr of Object.keys(map)) {
                const id = Number(idStr);
                const raName = byId.get(id);
                if (!raName) {
                    logWarn(`RA console check: mapped console id ${id} (engine "${map[id]}") is not in RA's console list.`);
                    mismatches.push({ id, raName: '(absent)' });
                }
            }
            if (mismatches.length === 0) {
                logInfo(`RA console check: all ${Object.keys(map).length} mapped console ids exist upstream.`);
            }
        } catch (err) {
            logWarn('RA console check skipped (request failed):', scrubRaSecrets(String(err)));
        }
        return mismatches;
    }
}
