import { GlobalGameService, GlobalGameInput } from './GlobalGameService.js';
import { SyncLogService, SyncCheckpoint } from './SyncLogService.js';
import { IGDB_PLATFORM_MAP, IGDB_PLATFORM_NAMES, IGDB_TARGET_PLATFORMS } from '../utils/platformMapping.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { getDatabase } from '../database/database.js';
import fs from 'fs';
import path from 'path';

/** Twitch OAuth token response */
interface TwitchToken {
    access_token: string;
    expires_in: number;
    token_type: string;
}

/** IGDB game response */
interface IGDBGame {
    id: number;
    name: string;
    slug?: string;
    url?: string;
    summary?: string;
    first_release_date?: number;
    category?: number;
    platforms?: number[];
    genres?: number[];
    themes?: number[];
    game_modes?: number[];
    cover?: { image_id: string };
    involved_companies?: Array<{ company: { name: string }; developer: boolean }>;
    rating?: number;
    total_rating?: number;
    videos?: Array<{ video_id: string; name?: string }>;
    [key: string]: any;
}

/** IGDB genre/theme lookup */
interface IGDBMeta {
    id: number;
    name: string;
}

/** A cover to fetch in the background pass, queued during the metadata pass. */
interface PendingCover {
    igdbId: number;
    imageId: string;
    name: string;
}

const IGDB_API = 'https://api.igdb.com/v4';
const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const BATCH_SIZE = 500;
const RATE_LIMIT_DELAY_MS = 260; // ~4 req/sec

/**
 * Transport retry policy. IGDB rate-limits at 4 req/sec and returns 429 when
 * exceeded; it also 5xxs occasionally under load. Both are transient, and a
 * multi-hour crawl WILL meet them — the previous code threw on the first one
 * and lost the entire run.
 */
const MAX_REQUEST_ATTEMPTS = 5;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * A run that fetches less than this fraction of the count endpoint's answer
 * did not finish, whatever the loop thought. 2% of slack absorbs the genuine
 * race between the count and the crawl (IGDB's catalogue changes under us).
 */
const COMPLETION_THRESHOLD = 0.98;

/** Cap on errors retained in the sync log — the tail is summarised instead. */
const MAX_STORED_ERRORS = 100;

/** Background cover-download pass — mirrors VpsImportService's pass. */
const IMAGE_CONCURRENCY = 8;
const IMAGE_TIMEOUT_MS = 20_000;
const IMAGE_PROGRESS_EVERY = 200;

/**
 * Downloads an IGDB cover image to local disk. Returns the relative path, or
 * undefined on any failure (a missing cover must never fail a game's import).
 *
 * Idempotent: an already-downloaded file is reported without re-fetching, so
 * a resumed or repeated run costs nothing for covers it already has.
 */
async function downloadCover(imageId: string, gameId: number): Promise<string | undefined> {
    const relPath = `data/catalogue-images/igdb/${gameId}.jpg`;
    try {
        const dir = path.join(process.cwd(), 'data', 'catalogue-images', 'igdb');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        const filePath = path.join(dir, `${gameId}.jpg`);
        if (fs.existsSync(filePath)) return relPath;

        const url = `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
        if (!resp.ok) {
            logWarn(`IGDB cover download for game ${gameId} returned ${resp.status}.`);
            return undefined;
        }

        const buffer = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        return relPath;
    } catch (err) {
        // Was a bare `catch { return undefined }` — a systematic failure
        // (network down, disk full, every request timing out) produced a run
        // with zero covers and not one line explaining why.
        logWarn(`IGDB cover download failed for game ${gameId}:`, err);
        return undefined;
    }
}

/**
 * Delays execution for rate limiting.
 */
function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Full jitter exponential backoff. Jitter matters more than the exponent here:
 * without it, concurrent retries re-collide in lockstep at every step.
 */
function backoffDelay(attempt: number): number {
    const ceiling = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + Math.random() * (ceiling / 2));
}

/**
 * Parses a Retry-After header. Per RFC 9110 it is either delta-seconds or an
 * HTTP-date; both appear in the wild. Returns ms, or undefined when absent or
 * unparseable, in which case the caller falls back to its own backoff.
 */
function parseRetryAfter(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.min(RETRY_MAX_MS, seconds * 1000);
    }
    const date = Date.parse(header);
    if (Number.isFinite(date)) {
        return Math.min(RETRY_MAX_MS, Math.max(0, date - Date.now()));
    }
    return undefined;
}

/** Retains the first MAX_STORED_ERRORS errors plus a count of the rest. */
function boundErrors(errors: string[], overflow: number): string[] {
    if (overflow <= 0) return errors;
    return [...errors, `... and ${overflow} more error(s) not stored`];
}

export class IGDBImportService {
    /**
     * Gets or refreshes the Twitch OAuth token for IGDB API access.
     * Stores token in settings table for persistence.
     */
    static async getAccessToken(): Promise<string> {
        const clientId = process.env.TWITCH_CLIENT_ID;
        const clientSecret = process.env.TWITCH_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
            throw new Error('TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET must be configured for IGDB import.');
        }

        // Check for cached token
        const db = await getDatabase();
        const tokenRow = await db.get("SELECT value FROM settings WHERE key = 'TWITCH_ACCESS_TOKEN'");
        const expiryRow = await db.get("SELECT value FROM settings WHERE key = 'TWITCH_TOKEN_EXPIRES_AT'");

        if (tokenRow && expiryRow) {
            const expiresAt = new Date(expiryRow.value);
            const oneHourFromNow = new Date(Date.now() + 3600000);
            if (expiresAt > oneHourFromNow) {
                return tokenRow.value;
            }
        }

        // Refresh token
        logInfo('IGDB: refreshing Twitch OAuth token...');
        const resp = await fetch(TWITCH_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                grant_type: 'client_credentials',
            }),
        });

        if (!resp.ok) {
            throw new Error(`Twitch token refresh failed: ${resp.status} ${await resp.text()}`);
        }

        const token: TwitchToken = await resp.json();
        const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString();

        // Store in settings
        await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('TWITCH_ACCESS_TOKEN', ?)", token.access_token);
        await db.run("INSERT OR REPLACE INTO settings (key, value) VALUES ('TWITCH_TOKEN_EXPIRES_AT', ?)", expiresAt);

        logInfo('IGDB: Twitch token refreshed, expires at ' + expiresAt);
        return token.access_token;
    }

    /**
     * Issues one IGDB API request with an Apicalypse body, retrying transient
     * failures. Returns the parsed body — shape is the caller's business
     * (`/games` answers an array, `/games/count` answers an object).
     *
     * Retry policy:
     *   - 429 and 5xx are transient. Honour Retry-After when present,
     *     otherwise exponential backoff with jitter, up to
     *     MAX_REQUEST_ATTEMPTS, then throw with the last response body.
     *   - Network-level failures (DNS, reset, timeout) are treated the same.
     *   - 401 means the cached token went bad. Clear it and retry ONCE with a
     *     fresh one. `authAttempt` bounds that: previously this recursed
     *     unconditionally, so a client id/secret that Twitch accepts but IGDB
     *     rejects produced infinite recursion instead of an error anyone could
     *     act on.
     *   - Any other non-OK status is a real error (bad query, 404) and throws
     *     immediately — retrying a malformed Apicalypse query is pointless.
     */
    private static async igdbFetch<T>(
        endpoint: string,
        query: string,
        opts?: { authAttempt?: number },
    ): Promise<T> {
        const authAttempt = opts?.authAttempt ?? 0;
        let lastError: Error | undefined;

        for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
            const accessToken = await this.getAccessToken();
            const clientId = process.env.TWITCH_CLIENT_ID!;

            let resp: Response;
            try {
                resp = await fetch(`${IGDB_API}/${endpoint}`, {
                    method: 'POST',
                    headers: {
                        'Client-ID': clientId,
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'text/plain',
                    },
                    body: query,
                });
            } catch (err) {
                lastError = err instanceof Error ? err : new Error(String(err));
                if (attempt >= MAX_REQUEST_ATTEMPTS) break;
                const wait = backoffDelay(attempt);
                logWarn(
                    `IGDB ${endpoint}: network failure (${lastError.message}); ` +
                    `retrying in ${wait}ms (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS}).`,
                );
                await delay(wait);
                continue;
            }

            if (resp.status === 401) {
                const db = await getDatabase();
                await db.run("DELETE FROM settings WHERE key = 'TWITCH_ACCESS_TOKEN'");
                await db.run("DELETE FROM settings WHERE key = 'TWITCH_TOKEN_EXPIRES_AT'");
                if (authAttempt >= 1) {
                    throw new Error(
                        `IGDB ${endpoint} returned 401 twice, with a freshly-minted Twitch token the second time. ` +
                        `The token is being issued but IGDB will not accept it — check that TWITCH_CLIENT_ID and ` +
                        `TWITCH_CLIENT_SECRET belong to the same Twitch application and that the application is ` +
                        `still active at https://dev.twitch.tv/console/apps.`,
                    );
                }
                logWarn(`IGDB ${endpoint}: 401 — cached token cleared, retrying once with a fresh token.`);
                return this.igdbFetch<T>(endpoint, query, { authAttempt: authAttempt + 1 });
            }

            if (resp.status === 429 || resp.status >= 500) {
                const retryAfter = parseRetryAfter(resp.headers.get('retry-after'));
                const body = await resp.text().catch(() => '');
                lastError = new Error(`IGDB API ${endpoint} returned ${resp.status}: ${body}`);
                if (attempt >= MAX_REQUEST_ATTEMPTS) break;
                const wait = retryAfter ?? backoffDelay(attempt);
                logWarn(
                    `IGDB ${endpoint}: ${resp.status} ${resp.status === 429 ? '(rate limited)' : '(server error)'}; ` +
                    `retrying in ${wait}ms (attempt ${attempt}/${MAX_REQUEST_ATTEMPTS})` +
                    `${retryAfter !== undefined ? ' per Retry-After' : ''}.`,
                );
                await delay(wait);
                continue;
            }

            if (!resp.ok) {
                throw new Error(`IGDB API ${endpoint} returned ${resp.status}: ${await resp.text()}`);
            }

            return resp.json() as Promise<T>;
        }

        throw new Error(
            `IGDB API ${endpoint} failed after ${MAX_REQUEST_ATTEMPTS} attempts: ${lastError?.message ?? 'unknown error'}`,
        );
    }

    /**
     * Makes an IGDB API request with Apicalypse query body.
     */
    private static async igdbRequest<T>(endpoint: string, query: string): Promise<T[]> {
        return this.igdbFetch<T[]>(endpoint, query);
    }

    /**
     * Fetches genre names from IGDB.
     */
    private static async fetchGenres(): Promise<Map<number, string>> {
        const genres = await this.igdbRequest<IGDBMeta>('genres', 'fields id, name; limit 500;');
        await delay(RATE_LIMIT_DELAY_MS);
        return new Map(genres.map(g => [g.id, g.name]));
    }

    /**
     * Fetches theme names from IGDB.
     */
    private static async fetchThemes(): Promise<Map<number, string>> {
        const themes = await this.igdbRequest<IGDBMeta>('themes', 'fields id, name; limit 500;');
        await delay(RATE_LIMIT_DELAY_MS);
        return new Map(themes.map(t => [t.id, t.name]));
    }

    /**
     * Fetches game mode names from IGDB.
     */
    private static async fetchGameModes(): Promise<Map<number, string>> {
        const modes = await this.igdbRequest<IGDBMeta>('game_modes', 'fields id, name; limit 500;');
        await delay(RATE_LIMIT_DELAY_MS);
        return new Map(modes.map(m => [m.id, m.name]));
    }

    /**
     * Verifies our hard-coded platform ids against IGDB's live `/platforms`
     * rows and WARNs on any disagreement. One cheap request at run start.
     *
     * This exists because three ids in IGDB_PLATFORM_MAP were simply wrong
     * (51 was Famicom Disk System, not TurboGrafx-16; 67 Intellivision, not
     * Jaguar; 87 Virtual Boy, not 3DO) and nothing anywhere would ever have
     * said so — the import happily mislabelled every game it touched. Never
     * aborts: a name IGDB has since reworded is not a reason to refuse to run.
     */
    static async verifyPlatformIds(): Promise<Array<{ id: number; expected: string; actual: string }>> {
        const ids = Object.keys(IGDB_PLATFORM_MAP).map(Number);
        const mismatches: Array<{ id: number; expected: string; actual: string }> = [];
        try {
            const rows = await this.igdbRequest<IGDBMeta>(
                'platforms',
                `fields id, name; where id = (${ids.join(',')}); limit ${ids.length};`,
            );
            await delay(RATE_LIMIT_DELAY_MS);

            const byId = new Map(rows.map(r => [r.id, r.name]));
            for (const id of ids) {
                const expected = IGDB_PLATFORM_NAMES[id];
                const actual = byId.get(id);
                if (!actual) {
                    logWarn(`IGDB platform check: id ${id} (${IGDB_PLATFORM_MAP[id]}) was not returned by /platforms.`);
                    continue;
                }
                if (!expected) continue;
                const same = actual.trim().toLowerCase() === expected.trim().toLowerCase();
                if (!same) {
                    mismatches.push({ id, expected, actual });
                    logWarn(
                        `IGDB platform check MISMATCH: id ${id} maps to canonical "${IGDB_PLATFORM_MAP[id]}" ` +
                        `and we expected IGDB to call it "${expected}", but IGDB says "${actual}". ` +
                        `Verify src/utils/platformMapping.ts before trusting this run's platform tags.`,
                    );
                }
            }
            if (mismatches.length === 0) {
                logInfo(`IGDB platform check: all ${ids.length} mapped platform ids match IGDB's own names.`);
            }
        } catch (err) {
            logWarn('IGDB platform check skipped (verification request failed):', err);
        }
        return mismatches;
    }

    /**
     * The Apicalypse WHERE clause shared by the crawl and its count. Kept in
     * one place so the denominator can never describe a different population
     * than the pages do, and so the checkpoint fingerprint means something.
     *
     * Apicalypse operators on array fields (verified via live API testing):
     *   `platforms = (x,y,z)` means "contains ANY of x, y, z" (what we want)
     *   `platforms = [x,y,z]` means "contains ALL of x AND y AND z" (impossible)
     * Omitting `status = 0` because IGDB leaves status NULL for most released
     * games — filtering would exclude ~99% of results.
     * IGDB deprecated `category` in favour of `game_type`. Most released games
     * now have `category` NULL, so `where category = 0` returned zero rows.
     * game_type = 0 means "main_game" (excludes DLC, expansions, bundles, mods).
     */
    private static buildWhereClause(): string {
        return `platforms = (${IGDB_TARGET_PLATFORMS.join(',')}) & game_type = 0`;
    }

    /**
     * Total rows the crawl should see, from IGDB's own count endpoint.
     *
     * This is the denominator that makes "the loop stopped" distinguishable
     * from "the crawl finished". Previously a short page was taken as proof of
     * the end of the result set, so ANY hiccup that truncated a page ended the
     * run and reported success. Returns null when the count is unavailable —
     * in which case we simply cannot make that judgement and say so.
     */
    private static async fetchExpectedTotal(whereClause: string): Promise<number | null> {
        try {
            const result = await this.igdbFetch<{ count?: number }>('games/count', `where ${whereClause};`);
            await delay(RATE_LIMIT_DELAY_MS);
            const count = result?.count;
            if (typeof count !== 'number' || !Number.isFinite(count)) return null;
            return count;
        } catch (err) {
            logWarn('IGDB: count query failed; run completeness cannot be verified.', err);
            return null;
        }
    }

    /**
     * Background cover pass. Mirrors `VpsImportService.downloadImagesInBackground`:
     * bounded concurrency, per-request timeout, skip already-downloaded files,
     * progress every 200, write paths back with `updateBySourceId`.
     *
     * Covers were previously downloaded inline in the row loop — one serial
     * HTTP round trip per game, in front of the upsert. On a catalogue this
     * size that alone is most of the run's wall-clock, and every image stall
     * held up metadata that had already been fetched.
     */
    private static async downloadCoversInBackground(
        covers: PendingCover[],
        syncLogId?: string,
    ): Promise<{ downloaded: number }> {
        if (covers.length === 0) return { downloaded: 0 };
        logInfo(`IGDB Import: metadata pass complete. Downloading ${covers.length} cover(s)...`);

        let processed = 0;
        let successes = 0;

        const tasks = covers.map(cover => async () => {
            try {
                const localPath = await downloadCover(cover.imageId, cover.igdbId);
                if (localPath) {
                    await GlobalGameService.updateBySourceId('igdb', cover.igdbId, {
                        local_image_path: localPath,
                    });
                    successes++;
                }
            } catch (err) {
                logError(`IGDB cover pass failed for "${cover.name}" (${cover.igdbId}):`, err);
            } finally {
                processed++;
                if (processed % IMAGE_PROGRESS_EVERY === 0) {
                    logInfo(`IGDB cover downloads: ${processed}/${covers.length} processed (${successes} successful)`);
                    // Keep the job's heartbeat alive through the image pass, or
                    // the single-flight guard would judge a working run dead.
                    if (syncLogId) {
                        await SyncLogService.recordProgress(syncLogId, {}).catch(() => { /* non-fatal */ });
                    }
                }
            }
        });

        const running: Set<Promise<void>> = new Set();
        for (const task of tasks) {
            const p = task().then(() => { running.delete(p); });
            running.add(p);
            if (running.size >= IMAGE_CONCURRENCY) {
                await Promise.race(running);
            }
        }
        await Promise.all(running);

        logInfo(`IGDB cover downloads complete: ${successes}/${covers.length} succeeded.`);
        return { downloaded: successes };
    }

    /**
     * Translates one IGDB game row into a catalogue upsert input, or null when
     * it carries no platform we recognise.
     */
    private static toGlobalGameInput(
        game: IGDBGame,
        maps: { genres: Map<number, string>; themes: Map<number, string>; gameModes: Map<number, string> },
        opts: { status: 'approved' | 'pending' },
    ): GlobalGameInput | null {
        const platforms = (game.platforms || [])
            .map(pid => IGDB_PLATFORM_MAP[pid])
            .filter((p): p is string => !!p);

        if (platforms.length === 0) return null;

        const isArcade = game.platforms?.includes(52);
        const type = isArcade ? 'arcade' : 'video_game';
        const subtype = isArcade ? 'arcade' : (game.platforms?.includes(6) ? 'pc' : 'console');

        const gameThemes: string[] = [];
        for (const gid of game.genres || []) {
            const name = maps.genres.get(gid);
            if (name) gameThemes.push(name);
        }
        for (const tid of game.themes || []) {
            const name = maps.themes.get(tid);
            if (name && !gameThemes.includes(name)) gameThemes.push(name);
        }

        const features: string[] = [];
        for (const mid of game.game_modes || []) {
            const name = maps.gameModes.get(mid);
            if (name) features.push(name.toLowerCase().replace(/\s+/g, '_'));
        }

        const designers: string[] = [];
        for (const ic of game.involved_companies || []) {
            if (ic.developer && ic.company?.name) designers.push(ic.company.name);
        }

        let year: number | undefined;
        if (game.first_release_date) {
            year = new Date(game.first_release_date * 1000).getFullYear();
        }

        const tutorialUrls = (game.videos || []).map(v => ({
            title: v.name,
            youtubeId: v.video_id,
        }));

        return {
            name: game.name,
            year,
            type,
            subtype,
            platforms,
            themes: gameThemes,
            designers,
            features,
            igdb_id: game.id,
            external_url: game.url,
            description: game.summary,
            source_rating: game.total_rating || game.rating,
            tutorial_urls: tutorialUrls.length > 0 ? tutorialUrls : undefined,
            imported_from: 'igdb',
            status: opts.status,
        };
    }

    /**
     * Bulk seeds the global catalogue from IGDB for arcade + retro console
     * platforms. Pages of 500, rate-limited to ~4 req/sec, checkpointed.
     *
     * Paging is KEYSET (`where id > lastId ... sort id asc`), not offset.
     * Offset paging cannot be resumed — page N's contents depend on every page
     * before it, so a run that dies at page 60 has to redo 30,000 rows to get
     * back where it was, and IGDB degrades badly at high offsets anyway. With
     * a keyset cursor the only state a resume needs is one integer, persisted
     * after every page.
     *
     * Rows land as `status = 'pending'`, NOT approved. A bulk crawl of this
     * size is a proposal, not a fact: room-facing surfaces read approved rows
     * only, so the catalogue stays exactly as it is until a super-admin works
     * the approvals queue.
     *
     * @param options.limit   Cap total rows fetched (for sampled dev imports).
     * @param options.restart Ignore any resumable checkpoint and crawl from
     *                        the start.
     */
    static async importFromIGDB(options?: { limit?: number; restart?: boolean }): Promise<{
        imported: number;
        updated: number;
        skipped: number;
        total: number;
        resumed: boolean;
        expectedTotal: number | null;
        status: 'success' | 'partial';
    }> {
        const limit = options?.limit;
        const whereClause = this.buildWhereClause();

        // The checkpoint is only valid against the query that produced it —
        // see SyncLogService.findResumable.
        const fingerprint = whereClause;

        const checkpoint: SyncCheckpoint | null = options?.restart
            ? null
            : await SyncLogService.findResumable('igdb', fingerprint);

        if (options?.restart) {
            logInfo('IGDB Import: restart requested — ignoring any resumable checkpoint.');
        }

        const errors: string[] = [];
        let errorOverflow = 0;
        const recordError = (msg: string) => {
            logError(msg);
            if (errors.length < MAX_STORED_ERRORS) errors.push(msg);
            else errorOverflow++;
        };

        let expectedTotal: number | null = checkpoint?.expectedTotal ?? null;
        let syncLogId: string | undefined;
        // Mirrored out of the loop so the error path can persist the counts it
        // got to — `complete` overwrites them, and zeroing them would leave a
        // resumable cursor attached to counters that had forgotten the work.
        let inserted = checkpoint?.imported ?? 0;
        let updated = checkpoint?.updated ?? 0;
        let skipped = checkpoint?.skipped ?? 0;
        let totalFetched = checkpoint?.recordsFetched ?? 0;

        try {
            logInfo(
                checkpoint
                    ? `IGDB Import: resuming from checkpoint (id > ${checkpoint.lastId}, ` +
                      `${checkpoint.recordsFetched} row(s) already fetched over ${checkpoint.pagesDone} page(s)).`
                    : 'IGDB Import: starting bulk seed...',
            );

            // Claim the job row FIRST. Everything below makes API calls that
            // take seconds, and until the row exists the endpoint's
            // single-flight guard has nothing to see — two quick clicks would
            // both get past it and start duplicate crawls.
            syncLogId = await SyncLogService.start('igdb', {
                expectedTotal,
                targetFingerprint: fingerprint,
                resumeFrom: checkpoint,
            });

            // Cheap correctness check on our own platform table before we act
            // on it for tens of thousands of rows.
            await this.verifyPlatformIds();

            if (expectedTotal == null) {
                expectedTotal = await this.fetchExpectedTotal(whereClause);
                await SyncLogService.recordProgress(syncLogId, { expectedTotal });
            }
            logInfo(
                expectedTotal != null
                    ? `IGDB Import: source reports ${expectedTotal} matching game(s).`
                    : 'IGDB Import: source count unavailable — completeness will not be verified.',
            );

            const genreMap = await this.fetchGenres();
            const themeMap = await this.fetchThemes();
            const gameModeMap = await this.fetchGameModes();
            const maps = { genres: genreMap, themes: themeMap, gameModes: gameModeMap };

            let lastId = checkpoint?.lastId ?? 0;
            let pagesDone = checkpoint?.pagesDone ?? 0;

            // `limit` caps THIS run's fetches, not the cumulative resumed total
            // — a sampled top-up asked for 500 rows means 500 more rows.
            const fetchedThisRun = () => totalFetched - (checkpoint?.recordsFetched ?? 0);
            const covers: PendingCover[] = [];

            while (true) {
                const remaining = limit ? Math.max(0, limit - fetchedThisRun()) : BATCH_SIZE;
                if (limit && remaining === 0) break;
                const batchSize = limit ? Math.min(BATCH_SIZE, remaining) : BATCH_SIZE;

                const query = `
                    fields name, slug, url, summary, first_release_date, game_type, platforms,
                           genres, themes, game_modes, cover.image_id,
                           involved_companies.company.name, involved_companies.developer,
                           rating, total_rating, videos.video_id, videos.name;
                    where id > ${lastId} & ${whereClause};
                    sort id asc;
                    limit ${batchSize};
                `;

                const games = await this.igdbRequest<IGDBGame>('games', query);
                await delay(RATE_LIMIT_DELAY_MS);

                if (games.length === 0) break;
                totalFetched += games.length;
                pagesDone++;
                logInfo(
                    `IGDB Import: processing page ${pagesDone} (${games.length} games, id > ${lastId}` +
                    `${expectedTotal != null ? `, ${totalFetched}/${expectedTotal}` : ''})`,
                );

                for (const game of games) {
                    try {
                        const input = this.toGlobalGameInput(game, maps, { status: 'pending' });
                        if (!input) {
                            skipped++;
                            continue;
                        }

                        const result = await GlobalGameService.upsert(input);
                        if (result.action === 'inserted') inserted++;
                        else if (result.action === 'updated') updated++;
                        else skipped++;

                        // Queue the cover for the background pass rather than
                        // fetching it here — see downloadCoversInBackground.
                        if (game.cover?.image_id) {
                            covers.push({ igdbId: game.id, imageId: game.cover.image_id, name: game.name });
                        }
                    } catch (err) {
                        recordError(`Failed to import IGDB game "${game.name}" (${game.id}): ${err}`);
                        skipped++;
                    }
                }

                // Advance the cursor to the highest id this page delivered.
                // `sort id asc` makes that the last element, but take the max
                // explicitly — a cursor that goes backwards would loop forever.
                lastId = games.reduce((max, g) => (g.id > max ? g.id : max), lastId);

                // Checkpoint AFTER the page's rows are committed, so a crash
                // between pages resumes at a boundary we know was fully
                // processed. Re-processing a page would be harmless anyway
                // (upsert is idempotent), but the counts would double-count.
                await SyncLogService.recordProgress(syncLogId, {
                    lastId,
                    pagesDone,
                    recordsFetched: totalFetched,
                    imported: inserted,
                    updated,
                    skipped,
                    expectedTotal,
                });

                if (limit && fetchedThisRun() >= limit) break;

                // A short page is a HINT that we reached the end, not proof —
                // the completeness check below is what decides. Keep the exit
                // (there is nothing after the last id) but stop treating it as
                // a guarantee of success.
                if (games.length < batchSize) break;
            }

            await this.downloadCoversInBackground(covers, syncLogId);

            // Completeness. A sampled run (`limit`) is expected to stop early,
            // so it is exempt; a resumed run is judged on the cumulative total,
            // which is what `totalFetched` already carries.
            const shortfall =
                !limit && expectedTotal != null && totalFetched < expectedTotal * COMPLETION_THRESHOLD;
            if (shortfall) {
                recordError(
                    `Run ended with ${totalFetched} of ~${expectedTotal} expected rows ` +
                    `(${((totalFetched / expectedTotal!) * 100).toFixed(1)}%). Marked partial — ` +
                    `re-run the sync to resume from the checkpoint.`,
                );
            }

            const status: 'success' | 'partial' =
                shortfall || errors.length > 0 || errorOverflow > 0 ? 'partial' : 'success';

            logInfo(
                `IGDB Import: inserted ${inserted}, updated ${updated}, skipped ${skipped}, ` +
                `total fetched ${totalFetched}${expectedTotal != null ? ` of ~${expectedTotal}` : ''} — ${status}`,
            );

            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: inserted,
                records_updated: updated,
                records_skipped: skipped,
                records_fetched: totalFetched,
                errors: errors.length > 0 ? boundErrors(errors, errorOverflow) : undefined,
            });

            return {
                imported: inserted,
                updated,
                skipped,
                total: totalFetched,
                resumed: !!checkpoint,
                expectedTotal,
                status,
            };
        } catch (err) {
            logError('IGDB Import failed:', err);
            if (syncLogId) {
                // The checkpoint columns are left as the last page wrote them
                // and the counts are carried through, so this failure is
                // resumable rather than a total loss — `findResumable` treats
                // an `error` row with a cursor as pick-up-able.
                await SyncLogService.complete(syncLogId, {
                    status: 'error',
                    records_imported: inserted,
                    records_updated: updated,
                    records_skipped: skipped,
                    records_fetched: totalFetched,
                    errors: boundErrors([...errors, String(err)], errorOverflow),
                });
            }
            throw err;
        }
    }
}
