import { getDatabase } from '../database/database.js';
import { RAApiClient, RA_MEDIA_BASE } from './RAApiClient.js';
import { SyncLogService } from './SyncLogService.js';
import { RA_CONSOLE_ENGINE_MAP } from '../utils/scoreProvenance.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';
import { nameRankSqlCase, nameRankSqlParams } from '../utils/searchRank.js';

/**
 * The RetroAchievements master list — a local, searchable shadow of RA's
 * per-console game lists (RA on-demand import, contract §2).
 *
 * RA has NO server-side search. The only way to offer "search
 * RetroAchievements" from an add-game flow is to hold a copy of the game lists
 * and search that, which is also what RA's own docs ask for: they explicitly
 * request that callers cache the game-list endpoint rather than re-pull it.
 *
 * `ra_games` is therefore a cache, not a data model. No FK points at it,
 * nothing depends on a row surviving, and a full re-sync is always safe.
 * Importing a game copies what it needs into `global_games` and from then on
 * the catalogue row stands alone.
 */

/** Source name on `sync_logs` — one row per run, like every other importer. */
export const RA_SYNC_SOURCE = 'ra_masterlist';

/** Fair-use pause between per-console list calls. */
const CONSOLE_PAUSE_MS = 300;

/**
 * How old the list may get before a search request triggers a refresh.
 * Seven days per the contract: RA adds achievement sets steadily but not
 * hourly, and the list is ~10-15k rows across 20 consoles — cheap to hold,
 * not cheap to re-pull on a whim.
 */
export const MASTER_LIST_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimum gap between AUTO-sync attempts, independent of staleness.
 *
 * Without it, a table that is empty because the sync keeps failing (bad key,
 * RA down) would kick off a fresh 20-console crawl on EVERY search request —
 * turning our own outage into a fair-use violation. Staleness says "a refresh
 * is due"; this says "we already tried recently, leave RA alone".
 */
export const AUTOSYNC_RETRY_COOLDOWN_MS = 60 * 60 * 1000;

/** Search result row, as the API ships it. */
export interface RASearchResult {
    raGameId: number;
    title: string;
    consoleId: number;
    consoleName: string | null;
    /** Absolute media URL, already host-prefixed. Null when RA had no icon. */
    iconUrl: string | null;
    numAchievements: number | null;
    numLeaderboards: number | null;
    /** True when a catalogue row already carries this `ra_id`. */
    inCatalogue: boolean;
    /** The catalogue row's id when `inCatalogue`, else null. */
    globalGameId: string | null;
    /** That row's stored verdict, when it has one. */
    scoreEligibility: string | null;
}

/** Freshness envelope returned alongside every search response. */
export interface RAMasterListStatus {
    total: number;
    lastSyncedAt: string | null;
    stale: boolean;
    /** True when a sync is running right now (including one this call kicked off). */
    syncing: boolean;
}

export interface RASyncResult {
    consoles: number;
    consolesFailed: number;
    imported: number;
    updated: number;
    removed: number;
    total: number;
    status: 'success' | 'partial';
}

export class RAMasterListService {
    /**
     * Guards against two syncs racing INSIDE one process. `sync_logs` guards
     * across processes (and is what the endpoint checks), but a promise is
     * what stops the lazy auto-sync from firing twice while the first is still
     * claiming its job row a few hundred ms in.
     */
    private static inFlight: Promise<RASyncResult> | null = null;

    /** Row count + freshness, without touching RA. */
    static async getStatus(): Promise<RAMasterListStatus> {
        const db = await getDatabase();
        const row = await db.get<{ total: number; last_synced: string | null }>(
            `SELECT COUNT(*) as total, MAX(synced_at) as last_synced FROM ra_games`,
        );
        const total = row?.total ?? 0;
        const lastSyncedAt = row?.last_synced ?? null;
        const active = await SyncLogService.getActiveRun(RA_SYNC_SOURCE);

        return {
            total,
            lastSyncedAt,
            stale: RAMasterListService.isStale(total, lastSyncedAt),
            syncing: !!active || RAMasterListService.inFlight !== null,
        };
    }

    /** Empty counts as stale — there is nothing to search. */
    private static isStale(total: number, lastSyncedAt: string | null): boolean {
        if (total === 0 || !lastSyncedAt) return true;
        const ts = Date.parse(lastSyncedAt.includes('T') ? lastSyncedAt : `${lastSyncedAt}Z`);
        if (!Number.isFinite(ts)) return true;
        return Date.now() - ts > MASTER_LIST_MAX_AGE_MS;
    }

    /**
     * The lazy refresh gate, called by every search endpoint (contract §2:
     * "auto-sync AT MOST once/7d checked lazily when the search endpoint is
     * hit with a stale or empty table").
     *
     * Fire-and-forget by design. A full sync is 20 API calls plus ~10-15k
     * upserts; awaiting it would blow the request timeout of an interactive
     * search box. The caller instead gets `syncing: true` in the status
     * envelope and can tell the user the index is still building — which is
     * only ever visible on a genuinely cold table, since the 7-day gate means
     * a warm one refreshes in the background behind a search that already
     * answered.
     */
    static async ensureFresh(): Promise<RAMasterListStatus> {
        const status = await RAMasterListService.getStatus();
        if (!status.stale || status.syncing) return status;
        if (!RAApiClient.isConfigured()) return status;

        // Recently attempted? Then the staleness is not news — see
        // AUTOSYNC_RETRY_COOLDOWN_MS.
        const db = await getDatabase();
        const lastAttempt = await db.get<{ started_at: string }>(
            `SELECT started_at FROM sync_logs WHERE source = ? ORDER BY started_at DESC LIMIT 1`,
            RA_SYNC_SOURCE,
        );
        if (lastAttempt?.started_at) {
            const age = Date.now() - Date.parse(lastAttempt.started_at);
            if (Number.isFinite(age) && age < AUTOSYNC_RETRY_COOLDOWN_MS) return status;
        }

        logInfo('RA master list is stale — starting a background refresh.');
        void RAMasterListService.syncAll().catch(err => {
            logError('RA master list background sync failed:', err);
        });
        return { ...status, syncing: true };
    }

    /**
     * Pulls every mapped console's game list and reconciles `ra_games`.
     *
     * Single-flight: a second caller receives the first call's promise rather
     * than starting a competing crawl.
     *
     * Per-console reconciliation, and DELETION IS SCOPED TO CONSOLES THAT
     * FETCHED SUCCESSFULLY. A global "delete anything not seen this run" would
     * empty a console's rows whenever its one request failed — turning a
     * transient RA hiccup into a silent loss of a fifth of the searchable
     * index. A console we could not fetch keeps exactly what it had.
     */
    static async syncAll(opts?: { pauseMs?: number }): Promise<RASyncResult> {
        if (RAMasterListService.inFlight) return RAMasterListService.inFlight;
        const run = RAMasterListService.runSync(opts?.pauseMs ?? CONSOLE_PAUSE_MS).finally(() => {
            RAMasterListService.inFlight = null;
        });
        RAMasterListService.inFlight = run;
        return run;
    }

    /**
     * Resolves once no sync is in flight. `ensureFresh` deliberately does not
     * await the crawl it starts, which leaves a promise running past the
     * request that spawned it — this is how a caller that DOES need it
     * finished (a test, a graceful shutdown) waits without starting one.
     * Never throws: a failed background sync is already logged, and this
     * method's contract is "is it done", not "did it work".
     */
    static async settle(): Promise<void> {
        try {
            await RAMasterListService.inFlight;
        } catch {
            /* the sync's own error path already logged it */
        }
    }

    private static async runSync(pauseMs: number): Promise<RASyncResult> {
        const db = await getDatabase();
        const consoleIds = Object.keys(RA_CONSOLE_ENGINE_MAP).map(Number).sort((a, b) => a - b);
        const client = new RAApiClient();

        const errors: string[] = [];
        let imported = 0;
        let updated = 0;
        let removed = 0;
        let fetched = 0;
        let consolesDone = 0;
        let consolesFailed = 0;

        const syncLogId = await SyncLogService.start(RA_SYNC_SOURCE, {
            targetFingerprint: `consoles:${consoleIds.join(',')}`,
        });

        try {
            logInfo(`RA master list sync: starting across ${consoleIds.length} console(s).`);

            for (const consoleId of consoleIds) {
                if (pauseMs > 0 && consolesDone + consolesFailed > 0) {
                    // Fair use — RA asks callers to be gentle with this one.
                    await new Promise(resolve => setTimeout(resolve, pauseMs));
                }

                let rows;
                try {
                    rows = await client.getGameList(consoleId);
                } catch (err) {
                    consolesFailed++;
                    const message = `RA console ${consoleId} list failed: ${err instanceof Error ? err.message : String(err)}`;
                    errors.push(message);
                    logWarn(message);
                    continue;
                }

                // Which of this console's rows we already hold, read ONCE.
                // Cheaper than asking per row, and it makes the
                // inserted-vs-updated split a fact rather than an inference:
                // sqlite reports 1 change for an INSERT and for a DO UPDATE
                // alike, so `changes` cannot tell them apart.
                const existingIds = new Set(
                    (await db.all<Array<{ ra_game_id: number }>>(
                        `SELECT ra_game_id FROM ra_games WHERE console_id = ?`, consoleId,
                    )).map(r => r.ra_game_id),
                );

                const seen: number[] = [];
                const now = new Date().toISOString();

                for (const row of rows) {
                    seen.push(row.ID);
                    if (existingIds.has(row.ID)) updated++;
                    else imported++;
                    await db.run(
                        `INSERT INTO ra_games (
                            ra_game_id, console_id, console_name, title, normalized_title,
                            image_icon, num_achievements, num_leaderboards, date_modified, synced_at
                         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT(ra_game_id) DO UPDATE SET
                            console_id = excluded.console_id,
                            console_name = excluded.console_name,
                            title = excluded.title,
                            normalized_title = excluded.normalized_title,
                            image_icon = excluded.image_icon,
                            num_achievements = excluded.num_achievements,
                            num_leaderboards = excluded.num_leaderboards,
                            date_modified = excluded.date_modified,
                            synced_at = excluded.synced_at`,
                        row.ID, row.ConsoleID, row.ConsoleName ?? null,
                        row.Title, normalizeGameName(row.Title),
                        row.ImageIcon ?? null,
                        row.NumAchievements ?? null, row.NumLeaderboards ?? null,
                        row.DateModified ?? null, now,
                    );
                }

                // Reconcile: drop rows RA no longer lists for THIS console.
                if (seen.length > 0) {
                    const placeholders = seen.map(() => '?').join(',');
                    const del = await db.run(
                        `DELETE FROM ra_games WHERE console_id = ? AND ra_game_id NOT IN (${placeholders})`,
                        consoleId, ...seen,
                    );
                    removed += del.changes ?? 0;
                } else {
                    // RA answered, and answered with nothing. That is a real
                    // state for a console with no achievement sets, but it is
                    // also what a subtly-broken response looks like — so log
                    // it and leave the existing rows alone rather than
                    // deleting a console's entire list on an empty answer.
                    logWarn(`RA console ${consoleId} returned an empty game list — keeping existing rows.`);
                }

                fetched += rows.length;
                consolesDone++;
                await SyncLogService.recordProgress(syncLogId, {
                    pagesDone: consolesDone + consolesFailed,
                    recordsFetched: fetched,
                    expectedTotal: null,
                });
                logInfo(`RA master list: console ${consoleId} → ${rows.length} game(s).`);
            }

            const totalRow = await db.get<{ total: number }>(`SELECT COUNT(*) as total FROM ra_games`);
            const total = totalRow?.total ?? 0;

            const status: 'success' | 'partial' = consolesFailed > 0 ? 'partial' : 'success';
            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: imported,
                records_updated: updated,
                records_skipped: 0,
                records_fetched: fetched,
                errors: errors.length > 0 ? errors : undefined,
            });

            logInfo(
                `RA master list sync complete: ${total} row(s) across ${consolesDone} console(s)` +
                `${consolesFailed > 0 ? `, ${consolesFailed} console(s) failed` : ''} — ${status}`,
            );

            return { consoles: consolesDone, consolesFailed, imported, updated, removed, total, status };
        } catch (err) {
            logError('RA master list sync failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                records_fetched: fetched,
                errors: [...errors, String(err)],
            });
            throw err;
        }
    }

    /**
     * Normalized-title contains match against the master list.
     *
     * Matching goes through `normalizeGameName` — the SAME normalizer the
     * catalogue dedup uses — on both sides, so "Donkey Kong Jr." finds
     * "Donkey Kong Jr" and the search agrees with what an import would
     * consider a name match. A raw-title LIKE runs alongside it so a query
     * whose punctuation the normalizer strips entirely still matches
     * something.
     *
     * Ordering (search-relevance work package, 2026-08-13) is the shared
     * 5-tier scheme from `searchRank.ts` — exact / starts-with-word /
     * contains-word / substring / no match — evaluated over the raw title,
     * taking the BETTER of that and a punctuation-insensitive exact match on
     * `normalized_title` (so "Donkey Kong Jr" still ranks "Donkey Kong Jr."
     * as tier 0 despite the stored period) via `MIN(...)` of the two CASE
     * expressions. Inside each tier, games with more leaderboards sort
     * first — kept from the pre-existing 3-tier scheme — since a game RA
     * tracks boards for is the likelier target of a score-keeping app's
     * search; title alphabetical is the final tie-break.
     *
     * The `inCatalogue` annotation is the point of the LEFT JOIN: the UI shows
     * "already available" instead of an Import button, and a player cannot
     * trigger a redundant import from the Global Scoreboard.
     */
    static async search(query: string, limit = 25): Promise<RASearchResult[]> {
        const raw = (query ?? '').trim();
        if (!raw) return [];

        const db = await getDatabase();
        const normalized = normalizeGameName(raw);
        // `\` escapes so a user typing % or _ searches for the character
        // rather than matching everything.
        const escape = (s: string) => s.replace(/[\\%_]/g, c => `\\${c}`);
        const needle = escape(normalized || raw.toLowerCase());
        const rawNeedle = escape(raw.toLowerCase());

        const rows = await db.all<Array<{
            ra_game_id: number;
            console_id: number;
            console_name: string | null;
            title: string;
            normalized_title: string;
            image_icon: string | null;
            num_achievements: number | null;
            num_leaderboards: number | null;
            global_game_id: string | null;
            score_eligibility: string | null;
        }>>(
            `SELECT
                r.ra_game_id, r.console_id, r.console_name, r.title, r.normalized_title,
                r.image_icon, r.num_achievements, r.num_leaderboards,
                gg.id as global_game_id,
                gg.score_eligibility
             FROM ra_games r
             LEFT JOIN global_games gg ON gg.ra_id = r.ra_game_id
             WHERE r.normalized_title LIKE ? ESCAPE '\\'
                OR LOWER(r.title) LIKE ? ESCAPE '\\'
             ORDER BY
                MIN(
                    CASE WHEN r.normalized_title = ? THEN 0 ELSE 4 END,
                    ${nameRankSqlCase('r.title')}
                ),
                COALESCE(r.num_leaderboards, 0) DESC,
                r.title COLLATE NOCASE ASC
             LIMIT ?`,
            `%${needle}%`, `%${rawNeedle}%`,
            normalized, ...nameRankSqlParams(raw),
            Math.min(Math.max(limit, 1), 100),
        );

        return rows.map(r => ({
            raGameId: r.ra_game_id,
            title: r.title,
            consoleId: r.console_id,
            consoleName: r.console_name,
            iconUrl: RAApiClient.mediaUrl(r.image_icon),
            numAchievements: r.num_achievements,
            numLeaderboards: r.num_leaderboards,
            inCatalogue: !!r.global_game_id,
            globalGameId: r.global_game_id,
            scoreEligibility: r.score_eligibility,
        }));
    }

    /** One master-list row by RA id, or undefined. */
    static async getByRaId(raGameId: number): Promise<{
        ra_game_id: number;
        console_id: number;
        console_name: string | null;
        title: string;
    } | undefined> {
        const db = await getDatabase();
        return db.get(
            `SELECT ra_game_id, console_id, console_name, title FROM ra_games WHERE ra_game_id = ?`,
            raGameId,
        );
    }
}

export { RA_MEDIA_BASE };
