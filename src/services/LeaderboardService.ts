import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { getNextRunTime } from '../utils/cronUtils.js';
import {
    UNKNOWN,
    deriveLegacyPlatform,
    mapLegacyPlatform,
    normalizeProvenanceToken,
} from '../utils/scoreProvenance.js';
import { resolveProfiles } from './PlayerProfileResolver.js';

/**
 * v2.0.3: translate stored catalogue paths (`data/catalogue-images/…`) to the
 * public HTTP URL (`/api/catalogue-images/…`). Leaves absolute URLs and other
 * paths untouched. Mirrors the frontend `toCatalogueUrl` helper.
 */
export function normalizeImageUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    const m = raw.match(/^\/?data\/catalogue-images\/(.+)$/);
    if (m) return `/api/catalogue-images/${m[1]}`;
    return raw.startsWith('/') ? raw : `/${raw}`;
}

export interface RankedEntry {
    rank: number;
    discord_user_id: string;
    iscored_username: string;
    /**
     * User-chosen global display name (from `user_profiles.display_name`).
     * Null when the user hasn't picked one — FE falls back to iscored_username.
     */
    display_name?: string | null;
    score: number;
    avatar_hash?: string | null;
    /**
     * v2.5.0: per-score platform stratification. `null` for legacy rows that
     * couldn't be backfilled (multi-platform games where the platform a player
     * actually used is unknowable retroactively).
     *
     * @deprecated v2.58.0 (ADR 0016) — `engine` + `device` are authoritative.
     * Retained because tournament `platform_rules` still read the legacy column
     * until the rules phase lands; do NOT derive display from it.
     */
    platform?: string | null;
    /**
     * v2.58.0 (ADR 0016): what produced the score. Determines comparability and
     * the fidelity category. Never null and never NULL in the DB — migration
     * 125 backfilled every row and every writer stamps it — but `'unknown'` is
     * a first-class value meaning "nobody recorded it".
     */
    engine?: string | null;
    /** v2.58.0 (ADR 0016): what it ran on. Provenance only, never a boundary. */
    device?: string | null;
    /**
     * v2.74.0 (S24.1) — full avatar URL for Google-linked users. `PlayerAvatar`
     * prefers it over `avatar_hash`. Null for Discord-only and anonymous rows.
     */
    avatar_url?: string | null;
    /**
     * v2.78.0 — read-time verified-checkmark resolution (S23.7 shipped the
     * admin verify/unverify loop; this is the deferred leaderboard-row
     * surfacing). True when ANY `score_history` event at this row's
     * `(iscored_username, score)` within the game's window has `verified_at`
     * set. Optional because not every `RankedEntry` producer resolves it
     * (e.g. `RoomScoresService`'s all-time page rankings) — only the paths
     * that route through `LeaderboardService.hydrate` set it.
     */
    verified?: boolean;
    /**
     * v2.108.0 — the `score_history.id` of the single best row this collapsed
     * entry was built from. What the per-row delete endpoint
     * (`DELETE /:roomId/score-history/:historyId`) needs to act on a card row
     * without a second round-trip. Optional because not every `RankedEntry`
     * producer resolves it.
     */
    history_id?: number | null;
    /**
     * v2.108.0 — `score_history.source` of that same best row
     * (`tournament` | `sync` | `community`). Shipped so the FE can label the
     * row; NOT a permission input — the server re-checks on delete.
     */
    source?: string | null;
    /**
     * v2.108.0 — the RAW `score_history.submitted_by_user_id`. This, and never
     * `discord_user_id`, is the ownership claim: `discord_user_id` is a
     * RESOLVED DISPLAY identity (an `iscored:*` synthetic can resolve through
     * someone's alias mapping), so gating self-delete on it would let an alias
     * holder delete rows they never submitted. Null for unattributed rows.
     */
    submitted_by_user_id?: string | null;
    /**
     * v2.109.0 (score-gesture-photos) — `score_history.photo_url` of the SAME
     * best row `history_id` points at. An identity-stable fact of that row
     * (never profile data), so it is safe in the cache under the S24.1
     * doctrine — see `CachedRankedRow`. Drives the quick-popup's camera glyph
     * + click-to-view-photo affordance on the MAIN ranked row.
     */
    photo_url?: string | null;
}

/**
 * What actually goes into `leaderboard_cache.rankings` — v2.74.0 (S24.1).
 *
 * IDENTITY-STABLE ONLY: no `display_name`, no `avatar_hash`, no `avatar_url`.
 * Those are joined on at read time by `resolveProfiles`, which is what lets a
 * rename or an avatar change appear on the next read without invalidating
 * anything. Re-introducing a name or an avatar into this shape re-introduces
 * the invalidation storm (and the "Global Scoreboard shows a stale avatar
 * forever" bug) that S24.1 removed — don't.
 */
interface CachedRankedRow {
    rank: number;
    /** The row's OWN discord id — possibly an `iscored:*` synthetic. Not resolved. */
    discord_user_id: string;
    /** `score_history.submitted_by_user_id`; null for unattributed rows. */
    submitted_by_user_id: string | null;
    iscored_username: string;
    score: number;
    platform: string | null;
    engine: string;
    device: string;
    /**
     * v2.108.0 — `score_history.id` of the best row in this partition, and its
     * `source`. Both are IDENTITY-STABLE facts about which row produced this
     * entry, so they belong in the cache under the S24.1 doctrine (unlike a
     * name or an avatar, they cannot change under the row without the row
     * itself changing, which already invalidates).
     */
    history_id: number | null;
    source: string | null;
    /** v2.109.0 (score-gesture-photos) — see the `RankedEntry` field doc. */
    photo_url: string | null;
}

/**
 * Cache envelope version. Bumped when the row shape changes so a cache written
 * by an older build is recognised as stale rather than silently rendered with
 * missing names — pre-S24 rows are bare ARRAYS, so `Array.isArray` alone is a
 * sufficient legacy test today, but the explicit version keeps the next shape
 * change from needing a new heuristic.
 *
 * v2 → v3 (v2.108.0): `history_id` + `source` added to `CachedRankedRow`. A v2
 * blob has neither, and a card row without a `history_id` cannot be deleted, so
 * a v2 blob must read as a MISS rather than render un-deletable rows.
 *
 * v3 → v4 (v2.109.0): `photo_url` added. A v3 blob has none, and the quick
 * popup's camera glyph / click-to-view affordance needs it on the main ranked
 * row, so a v3 blob must also read as a MISS.
 */
const CACHE_ENVELOPE_VERSION = 4;

interface CacheEnvelope {
    v: number;
    rows: CachedRankedRow[];
}

/** Parse a cached blob, returning null when it predates the S24.1 shape. */
function parseCacheEnvelope(raw: string): CachedRankedRow[] | null {
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || Array.isArray(parsed)) return null; // pre-S24.1 bare array
        const envelope = parsed as CacheEnvelope;
        if (envelope.v !== CACHE_ENVELOPE_VERSION || !Array.isArray(envelope.rows)) return null;
        return envelope.rows;
    } catch {
        return null;
    }
}

/**
 * The score_history window a game's rows were drawn from — v2.78.0. Exactly
 * the fields `queryRankedRows` filters on (minus `orphaned_at`, which is a
 * constant `IS NULL`). Used ONLY to scope the verified-checkmark lookup in
 * `resolveVerified` to the same window recalculate reads, so a row's
 * verified flag can never disagree with the predicate that produced the row.
 */
interface ScoreWindow {
    game_room_id: string | null;
    tournament_id: string | null;
    game_name: string;
}

export class LeaderboardService {
    /**
     * In-flight recalculations, keyed by game id — v2.74.0 (S24.3).
     *
     * N concurrent cold reads of the same game used to run N full recalculates
     * (a page load with 12 cards behind a cold cache, times every viewer who
     * hits refresh at the same moment). Sharing the promise makes all but the
     * first a free ride. Precedent: `RAImportService.inFlight`.
     */
    private static inFlightRecalc = new Map<string, Promise<CachedRankedRow[]>>();

    /**
     * In-flight provenance-filtered reads, keyed `(gameId, engine, device)` —
     * v2.74.0 (S24.3). `getForGameByProvenance` deliberately has NO persistent
     * cache (see its doc comment); dedup is orthogonal to that and just stops
     * simultaneous identical requests from each running the window query.
     */
    private static inFlightProvenance = new Map<string, Promise<CachedRankedRow[]>>();

    /**
     * Attach display identity + verified state to identity-stable rows
     * (v2.74.0 S24.1 for identity; v2.78.0 for `verified`). `windows` is
     * index-aligned with `rows` — one game's window per row, since
     * `getActiveLeaderboards` hydrates rows from many games in one call.
     * Pass as many rows at once as possible (batched, not per-row/per-game).
     */
    private static async hydrate(rows: CachedRankedRow[], windows: Array<ScoreWindow | null>): Promise<RankedEntry[]> {
        const [profiles, verifiedFlags] = await Promise.all([
            resolveProfiles(rows),
            this.resolveVerified(rows, windows),
        ]);
        return rows.map((row, i) => {
            const profile = profiles[i]!;
            return {
                rank: row.rank,
                discord_user_id: profile.discord_user_id,
                iscored_username: row.iscored_username,
                display_name: profile.display_name,
                score: row.score,
                avatar_hash: profile.avatar_hash,
                avatar_url: profile.avatar_url,
                platform: row.platform,
                engine: row.engine,
                device: row.device,
                verified: verifiedFlags[i]!,
                // v2.108.0 — pass through untouched. `submitted_by_user_id` is
                // the RAW column, deliberately not `profile.discord_user_id`
                // (that one is resolved for DISPLAY and is not an ownership
                // claim — see the `RankedEntry` field doc).
                history_id: row.history_id ?? null,
                source: row.source ?? null,
                submitted_by_user_id: row.submitted_by_user_id ?? null,
                // v2.109.0 — pass through untouched, same as history_id/source.
                photo_url: row.photo_url ?? null,
            };
        });
    }

    /**
     * Batched `game_room_id`/`tournament_id`/`name` lookup for a set of game
     * ids — the SAME `LEFT JOIN` `runRecalculate`/`runProvenanceQuery` use to
     * build `gameMeta` before calling `queryRankedRows`. Reused verbatim here
     * (rather than threading `gameMeta` through every call site) so the
     * verified-lookup window can never drift from the window that produced
     * the rows. One query regardless of how many games are involved —
     * `getActiveLeaderboards` calls this once for a whole page.
     */
    private static async loadWindows(gameIds: string[]): Promise<Map<string, ScoreWindow>> {
        const map = new Map<string, ScoreWindow>();
        if (gameIds.length === 0) return map;
        const db = await getDatabase();
        const placeholders = gameIds.map(() => '?').join(',');
        const rows = await db.all(`
            SELECT g.id, g.name, g.tournament_id, t.game_room_id
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id IN (${placeholders})
        `, ...gameIds);
        for (const r of rows as any[]) {
            map.set(r.id, {
                game_room_id: r.game_room_id ?? null,
                tournament_id: r.tournament_id ?? null,
                game_name: r.name,
            });
        }
        return map;
    }

    /**
     * v2.78.0 — verified-checkmark read-time resolution (S23.7 shipped the
     * verify/unverify loop; this is the deferred leaderboard-row surfacing
     * that was blocked on S24.1's cache restructure).
     *
     * Mirrors the EXACT score_history window `queryRankedRows` filters on
     * (`game_room_id`, `submitted_during_tournament_id`, `LOWER(game_name)`,
     * `orphaned_at IS NULL`) so a row can never disagree with the predicate
     * that produced it — a row only exists here if `queryRankedRows` already
     * matched a score_history event at these exact (room, tournament, name)
     * values, so the `=` comparisons below (not `IS`) are safe: a NULL
     * `game_room_id`/`tournament_id` window would mean `queryRankedRows`
     * itself matched zero rows for that game, and `windows[i]` is simply not
     * consulted (rows.length is 0 for that game).
     *
     * Matches by `(LOWER(iscored_username), score)` within the window — the
     * same key `queryRankedRows`'s `ROW_NUMBER` partitions collapse to — and
     * is true when ANY score_history event at that key has `verified_at` set.
     *
     * Deliberately reads `score_history` at REQUEST time, never
     * `leaderboard_cache` — see the `CachedRankedRow` doc comment for why
     * verified state must never be baked into the cache JSON. ONE query for
     * the whole batch, grouped over the distinct windows present.
     */
    private static async resolveVerified(
        rows: CachedRankedRow[],
        windows: Array<ScoreWindow | null>,
    ): Promise<boolean[]> {
        if (rows.length === 0) return [];
        const db = await getDatabase();

        const windowKey = (w: ScoreWindow) => `${w.game_room_id ?? ''}\u0000${w.tournament_id ?? ''}\u0000${w.game_name.toLowerCase()}`;
        const uniqueWindows = new Map<string, ScoreWindow>();
        for (const w of windows) {
            if (w) uniqueWindows.set(windowKey(w), w);
        }
        if (uniqueWindows.size === 0) return rows.map(() => false);

        const clauses: string[] = [];
        const params: any[] = [];
        for (const w of uniqueWindows.values()) {
            clauses.push('(game_room_id = ? AND submitted_during_tournament_id = ? AND LOWER(game_name) = LOWER(?))');
            params.push(w.game_room_id, w.tournament_id, w.game_name);
        }

        const verifiedRows = await db.all(`
            SELECT game_room_id, submitted_during_tournament_id, LOWER(game_name) as game_name,
                   LOWER(iscored_username) as uname, score,
                   MAX(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END) as is_verified
            FROM score_history
            WHERE orphaned_at IS NULL AND (${clauses.join(' OR ')})
            GROUP BY game_room_id, submitted_during_tournament_id, LOWER(game_name), LOWER(iscored_username), score
        `, ...params);

        const verifiedSet = new Set<string>();
        for (const r of verifiedRows as any[]) {
            if (r.is_verified) {
                verifiedSet.add(`${r.game_room_id ?? ''}\u0000${r.submitted_during_tournament_id ?? ''}\u0000${r.game_name}\u0000${r.uname}\u0000${r.score}`);
            }
        }

        return rows.map((row, i) => {
            const w = windows[i];
            if (!w) return false;
            const key = `${w.game_room_id ?? ''}\u0000${w.tournament_id ?? ''}\u0000${w.game_name.toLowerCase()}\u0000${row.iscored_username.toLowerCase()}\u0000${row.score}`;
            return verifiedSet.has(key);
        });
    }

    /**
     * Recalculate and cache the leaderboard for a specific game.
     *
     * v2.1.0: tournament leaderboards now read from `score_history` filtered by
     * `submitted_during_tournament_id` (§13 refactor). Previously they read
     * `submissions`, which stores only the best-ever per player — incorrect for
     * tournament scoring, where the goal is "best score during *this* tournament
     * window", which may legitimately be below an all-time personal best.
     *
     * The `submissions` table is still written on every submit (dual-write) so
     * back-compat is preserved for anything still reading it directly, but the
     * canonical source for tournament card rankings is now score_history.
     */
    static async recalculate(gameId: string): Promise<RankedEntry[]> {
        const rows = await this.recalculateRows(gameId);
        const window = (await this.loadWindows([gameId])).get(gameId) ?? null;
        return this.hydrate(rows, rows.map(() => window));
    }

    /**
     * `recalculate`'s identity-stable half: runs the ranking query, writes the
     * cache, returns the rows WITHOUT names/avatars (v2.74.0, S24.1).
     *
     * Split out so `getActiveLeaderboards` can recalculate several games and
     * then hydrate the entire page in ONE batch, instead of paying a profile
     * lookup per game. Deduped per game id (S24.3).
     */
    private static async recalculateRows(gameId: string): Promise<CachedRankedRow[]> {
        const existing = this.inFlightRecalc.get(gameId);
        if (existing) return existing;
        const run = this.runRecalculate(gameId)
            .finally(() => { this.inFlightRecalc.delete(gameId); });
        this.inFlightRecalc.set(gameId, run);
        return run;
    }

    private static async runRecalculate(gameId: string): Promise<CachedRankedRow[]> {
        const db = await getDatabase();

        // Resolve the game's tournament + room scope so we can filter score_history correctly.
        const gameMeta = await db.get(`
            SELECT g.id, g.name, g.tournament_id, t.game_room_id
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id = ?
        `, gameId);
        if (!gameMeta) {
            // Game not found — cache an empty ranking so callers don't thrash on retries.
            await this.writeCache(gameId, []);
            return [];
        }

        const rankings = await this.queryRankedRows(gameMeta, [], []);
        await this.writeCache(gameId, rankings);

        logInfo(`Leaderboard recalculated for game ${gameId}: ${rankings.length} entries`);
        return rankings;
    }

    private static async writeCache(gameId: string, rows: CachedRankedRow[]): Promise<void> {
        const db = await getDatabase();
        const envelope: CacheEnvelope = { v: CACHE_ENVELOPE_VERSION, rows };
        await db.run(
            `INSERT OR REPLACE INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, ?, ?)`,
            gameId, JSON.stringify(envelope), new Date().toISOString()
        );
    }

    /**
     * Best-score-per-player from score_history for this tournament window.
     *
     * PARTITION collapses by submitted_by_user_id (Discord linkage) when set,
     * else by anon name — so a user with multiple aliases under one Discord ID
     * renders as one leaderboard row, while pure-anon submissions still
     * partition per-name. ROW_NUMBER picks the highest-scoring row in the
     * partition; its iscored_username is the displayed alias when no
     * user_profiles.display_name is set.
     *
     * v2.74.0 (S24.1): the `user_mappings` / `user_profiles` joins that used to
     * live here moved to read time (`resolveProfiles`) so the cached rows are
     * identity-stable. `submitted_by_user_id` and the RAW per-row discord id
     * are both projected because the read-time resolver needs both legs.
     */
    private static async queryRankedRows(
        gameMeta: { name: string; tournament_id: string | null; game_room_id: string | null },
        extraClauses: string[],
        extraParams: any[],
    ): Promise<CachedRankedRow[]> {
        const db = await getDatabase();
        const entries = await db.all(`
            SELECT
                best.discord_user_id,
                best.submitted_by_user_id,
                best.iscored_username,
                best.score,
                best.platform,
                best.engine,
                best.device,
                best.history_id,
                best.source,
                best.photo_url
            FROM (
                SELECT
                    iscored_username,
                    discord_user_id,
                    submitted_by_user_id,
                    score,
                    platform,
                    engine,
                    device,
                    -- v2.108.0: the id + source of THIS row, which the
                    -- ROW_NUMBER below elects as the partition's best. The
                    -- per-row delete acts on exactly this score_history row.
                    id as history_id,
                    source,
                    -- v2.109.0 (score-gesture-photos): same row, its photo.
                    photo_url,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM score_history
                WHERE game_room_id = ?
                  AND submitted_during_tournament_id = ?
                  AND LOWER(game_name) = LOWER(?)
                  AND orphaned_at IS NULL
                  ${extraClauses.join('\n                  ')}
            ) best
            WHERE best.rn = 1
            ORDER BY best.score DESC
        `, gameMeta.game_room_id, gameMeta.tournament_id, gameMeta.name, ...extraParams);

        return entries.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id || '',
            submitted_by_user_id: e.submitted_by_user_id || null,
            iscored_username: e.iscored_username || 'Unknown',
            score: e.score,
            platform: e.platform || null,
            engine: e.engine || UNKNOWN,
            device: e.device || UNKNOWN,
            history_id: e.history_id ?? null,
            source: e.source ?? null,
            photo_url: e.photo_url ?? null,
        }));
    }

    /**
     * Get cached leaderboard, recalculating if stale or missing.
     */
    static async getForGame(gameId: string): Promise<RankedEntry[]> {
        const db = await getDatabase();
        const cached = await db.get('SELECT rankings, generated_at FROM leaderboard_cache WHERE game_id = ?', gameId);

        const rows = cached ? parseCacheEnvelope(cached.rankings) : null;
        // A pre-S24.1 cache blob (bare array with names baked in) reads as
        // `null` and falls through to one recalculate, after which the row is
        // in the new shape. No migration needed — the cache is derived state.
        const finalRows = rows ?? await this.recalculateRows(gameId);
        const window = (await this.loadWindows([gameId])).get(gameId) ?? null;
        return this.hydrate(finalRows, finalRows.map(() => window));
    }

    /**
     * v2.58.0 (ADR 0016): same shape as getForGame, filtered by engine and/or
     * device. Bypasses the cache because the cache stores the unfiltered "All"
     * view — a player's best may be on a different engine than the one being
     * queried, so post-cache JS filtering would mis-rank.
     *
     * ## Why this replaced the platform filter
     *
     * The v2.5.0 predecessor filtered `UPPER(platform) = UPPER(?)` — a raw
     * string compare with NO alias folding — while `getDistinctPlatforms` DID
     * fold via `normalizePlatform`. A tab could therefore be labelled `vpx`
     * from rows stored as `VPX`, and then query a value matching nothing. The
     * two halves are now built from the same columns, so the class of bug is
     * gone by construction, not by keeping two normalisers in step.
     *
     * `engine = 'unknown'` is a legitimate filter value, not an escape hatch:
     * it selects exactly the rows whose provenance was never recorded, which is
     * what the "Unspecified" tab shows. Any OTHER engine excludes them, per
     * ADR 0016 — an unknown-engine score is not evidence of a VPX score.
     *
     * ## Why there is no legacy `platform` fallback
     *
     * Migration 125 backfilled `engine`/`device` on every pre-existing row and
     * asserts a zero-NULL post-condition; every writer since v2.53.0 stamps
     * both. So no row is reachable through `platform` that is not reachable
     * through `engine`, and a fallback could only ever re-introduce the
     * unfolded-compare bug.
     */
    static async getForGameByProvenance(
        gameId: string,
        filter: { engine?: string | null; device?: string | null },
    ): Promise<RankedEntry[]> {
        const engine = normalizeProvenanceToken(filter.engine);
        const device = normalizeProvenanceToken(filter.device);
        if (!engine && !device) return this.getForGame(gameId);

        // S24.3 — dedup identical concurrent requests. The cache bypass above
        // is deliberate and unchanged; this only prevents two simultaneous
        // readers of the SAME filtered board from both running the query.
        const key = `${gameId}::${engine ?? ''}::${device ?? ''}`;
        const existing = this.inFlightProvenance.get(key);
        const run = existing ?? this.runProvenanceQuery(gameId, engine, device)
            .finally(() => { this.inFlightProvenance.delete(key); });
        if (!existing) this.inFlightProvenance.set(key, run);

        const rows = await run;
        const window = (await this.loadWindows([gameId])).get(gameId) ?? null;
        return this.hydrate(rows, rows.map(() => window));
    }

    private static async runProvenanceQuery(
        gameId: string,
        engine: string | null,
        device: string | null,
    ): Promise<CachedRankedRow[]> {
        const db = await getDatabase();
        const gameMeta = await db.get(`
            SELECT g.id, g.name, g.tournament_id, t.game_room_id
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id = ?
        `, gameId);
        if (!gameMeta) return [];

        const clauses: string[] = [];
        const params: any[] = [];
        if (engine) {
            clauses.push('AND LOWER(COALESCE(engine, ?)) = ?');
            params.push(UNKNOWN, engine);
        }
        if (device) {
            clauses.push('AND LOWER(COALESCE(device, ?)) = ?');
            params.push(UNKNOWN, device);
        }

        return this.queryRankedRows(gameMeta, clauses, params);
    }

    /**
     * Deprecated `?platform=` entry point, kept working for bookmarks and the
     * Discord/OG links that already carry one. Maps the legacy token through
     * `LEGACY_PLATFORM_MAP` and filters on the axes it implies — so `?platform=vpxs`
     * now correctly resolves to engine `vpx` on device `atgames`.
     *
     * @deprecated v2.58.0 — use `getForGameByProvenance`.
     */
    static async getForGameByPlatform(gameId: string, platform: string): Promise<RankedEntry[]> {
        const { engine, device } = mapLegacyPlatform(platform);
        return this.getForGameByProvenance(gameId, {
            engine: engine === UNKNOWN ? null : engine,
            device: device === UNKNOWN ? null : device,
        });
    }

    /**
     * v2.58.0 (ADR 0016): the distinct engines and devices present on this
     * game's leaderboard (within the active tournament window). Drives the
     * GameDetail tab strip.
     *
     * Read off the SAME columns `getForGameByProvenance` filters on, which is
     * the point: every value returned here is guaranteed to match rows when fed
     * back through the filter. The predecessor returned alias-folded values from
     * a column the filter compared raw, so a tab could match zero rows.
     *
     * `'unknown'` IS included when present — it is a real, and on production the
     * most common, provenance state (63 of ~120 rows). Hiding it would leave a
     * majority of scores unreachable from the tab strip; the FE renders it as
     * "Unspecified". Devices are reported separately and are never a
     * comparability boundary — the FE uses them for secondary filtering only.
     */
    static async getDistinctProvenance(gameId: string): Promise<{ engines: string[]; devices: string[] }> {
        const db = await getDatabase();
        const gameMeta = await db.get(`
            SELECT g.name, g.tournament_id, t.game_room_id
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id = ?
        `, gameId);
        if (!gameMeta) return { engines: [], devices: [] };

        const rows = await db.all(`
            SELECT DISTINCT
                LOWER(COALESCE(engine, ?)) as engine,
                LOWER(COALESCE(device, ?)) as device
            FROM score_history
            WHERE game_room_id = ?
              AND submitted_during_tournament_id = ?
              AND LOWER(game_name) = LOWER(?)
              AND orphaned_at IS NULL
        `, UNKNOWN, UNKNOWN, gameMeta.game_room_id, gameMeta.tournament_id, gameMeta.name);

        const engines: string[] = [];
        const devices: string[] = [];
        for (const r of rows as Array<{ engine: string; device: string }>) {
            if (r.engine && !engines.includes(r.engine)) engines.push(r.engine);
            if (r.device && r.device !== UNKNOWN && !devices.includes(r.device)) devices.push(r.device);
        }
        // Known engines first (alphabetical), 'unknown' last — an "Unspecified"
        // tab reads as a residual bucket, not a peer of the real engines.
        engines.sort((a, b) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : a.localeCompare(b)));
        devices.sort();
        return { engines, devices };
    }

    /**
     * Legacy platform ids for the deprecated `distinctPlatforms` response field.
     *
     * DERIVED from `getDistinctProvenance` rather than queried independently, so
     * it cannot disagree with the engines the tab strip and the filter use —
     * which is exactly how the old label/query mismatch arose.
     *
     * @deprecated v2.58.0 — use `getDistinctProvenance`.
     */
    static async getDistinctPlatforms(gameId: string): Promise<string[]> {
        const { engines, devices } = await this.getDistinctProvenance(gameId);
        const out: string[] = [];
        for (const engine of engines) {
            if (engine === UNKNOWN) continue;
            const legacy = deriveLegacyPlatform(engine, (devices.length === 1 ? devices[0] : UNKNOWN) ?? UNKNOWN);
            if (legacy && !out.includes(legacy)) out.push(legacy);
        }
        return out;
    }

    /**
     * Invalidate cache for a game (call after new score submission).
     */
    static async invalidate(gameId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', gameId);
    }

    /**
     * Invalidate all cached leaderboards.
     */
    static async invalidateAll(): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM leaderboard_cache');
    }

    /**
     * Get leaderboards for all active games, optionally filtered by game room.
     */
    static async getActiveLeaderboards(gameRoomId?: string): Promise<Array<{ gameId: string; gameName: string; displayName: string | null; tournamentName: string; tournamentType: string; imageUrl: string | null; gameStatus: string; catalogueStyleId: string | null; logoStyleId: string | null; bgStyleId: string | null; styleHeaderDisabled: boolean; externalUrl: string | null; notes: string | null; rankings: RankedEntry[]; nextMaintenanceAt: string | null; globalGameId: string | null }>> {
        const db = await getDatabase();

        const roomFilter = gameRoomId ? ' AND t.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        // 1. All ACTIVE games always show
        // v2.0.2: two-level globalGameId resolution so card title → /games/:id?from=:slug
        // routes correctly. Resolution order:
        //   a. games.global_game_id     (explicit per-game link)
        //   b. global_games.id via case-insensitive name match (approved only)
        // Matches the resolution used by All Games search.
        const activeGames = await db.all(`
            SELECT g.id, g.name as game_name, g.display_name, g.status, t.name as tournament_name, t.type as tournament_type,
                   -- v2.4.0: per-game display_order takes precedence (pinned games
                   -- set their own), falling back to tournament order, then 9999.
                   COALESCE(g.display_order, t.display_order, 9999) as display_order,
                   -- v2.4.0: pinned games are those with no tournament attribution.
                   CASE WHEN g.tournament_id IS NULL THEN 1 ELSE 0 END as is_pinned,
                   COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                   g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                   g.tournament_id, g.external_url, g.notes,
                   -- v2.74.0 (S24.4): cadence + owning room ride along on the
                   -- row that needs them. Pre-S24 this method issued one
                   -- SELECT cadence, game_room_id FROM tournaments WHERE id = ?
                   -- per distinct tournament on the page, plus one TIMEZONE
                   -- lookup inside that loop — a guaranteed N+1 on every
                   -- scoreboard render. The join was already here.
                   t.cadence as tournament_cadence, t.game_room_id as tournament_game_room_id,
                   COALESCE(g.global_game_id, gg.id) as global_game_id,
                   sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                   sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'
            LEFT JOIN style_catalogue sc_bg ON g.bg_style_id = sc_bg.id
            LEFT JOIN style_catalogue sc_logo ON g.logo_style_id = sc_logo.id
            LEFT JOIN style_catalogue sc_cat ON g.catalogue_style_id = sc_cat.id
            WHERE g.status = 'ACTIVE'${roomFilter}
            GROUP BY COALESCE(g.tournament_id, g.id), g.name
            ORDER BY display_order ASC, g.start_date ASC
        `, ...roomParams);

        // 2. COMPLETED games only if the tournament's cleanup_rule retains them
        const tournamentQuery = gameRoomId
            ? `SELECT id, name, type, cleanup_rule, COALESCE(display_order, 9999) as display_order
               FROM tournaments WHERE is_active = 1 AND game_room_id = ?`
            : `SELECT id, name, type, cleanup_rule, COALESCE(display_order, 9999) as display_order
               FROM tournaments WHERE is_active = 1`;

        const tournaments = gameRoomId
            ? await db.all(tournamentQuery, gameRoomId)
            : await db.all(tournamentQuery);

        // v2.74.0 (S24.4): ONE window-function query replaces the two per-
        // tournament COMPLETED-games queries that used to run inside this loop.
        // `retain` caps at N most-recent per tournament, `scheduled` takes them
        // all — both are just a different predicate on the same ROW_NUMBER, so
        // the branch moves from SQL into a filter here.
        const retainCapByTournament = new Map<string, number>(); // Infinity == scheduled
        const tournamentMeta = new Map<string, { name: string; type: string; display_order: number }>();
        for (const t of tournaments) {
            let rule: { mode: string; count?: number } = { mode: 'retain', count: 0 };
            try { rule = JSON.parse(t.cleanup_rule || '{}'); } catch {}

            if (rule.mode === 'immediate' || (rule.mode === 'retain' && (rule.count || 0) === 0)) {
                continue; // No completed games visible
            }
            if (rule.mode === 'retain' && (rule.count || 0) > 0) {
                retainCapByTournament.set(t.id, rule.count!);
            } else if (rule.mode === 'scheduled') {
                retainCapByTournament.set(t.id, Number.POSITIVE_INFINITY);
            } else {
                continue;
            }
            tournamentMeta.set(t.id, { name: t.name, type: t.type, display_order: t.display_order });
        }

        const retainedGames: any[] = [];
        if (retainCapByTournament.size > 0) {
            const retainIds = [...retainCapByTournament.keys()];
            const retainPlaceholders = retainIds.map(() => '?').join(',');
            const completedRows = await db.all(`
                SELECT * FROM (
                    SELECT g.id, g.name as game_name, g.display_name, g.status, g.tournament_id,
                           COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                           g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                           g.external_url, g.notes, g.end_date,
                           COALESCE(g.global_game_id, gg.id) as global_game_id,
                           sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                           sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header,
                           ROW_NUMBER() OVER (
                               PARTITION BY g.tournament_id ORDER BY g.end_date DESC
                           ) as rn
                    FROM games g
                    LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'
                    LEFT JOIN style_catalogue sc_bg ON g.bg_style_id = sc_bg.id
                    LEFT JOIN style_catalogue sc_logo ON g.logo_style_id = sc_logo.id
                    LEFT JOIN style_catalogue sc_cat ON g.catalogue_style_id = sc_cat.id
                    WHERE g.tournament_id IN (${retainPlaceholders}) AND g.status = 'COMPLETED'
                )
                ORDER BY tournament_id, rn
            `, ...retainIds);

            for (const row of completedRows) {
                const cap = retainCapByTournament.get(row.tournament_id);
                if (cap === undefined || row.rn > cap) continue;
                const meta = tournamentMeta.get(row.tournament_id)!;
                retainedGames.push({
                    ...row,
                    tournament_name: meta.name,
                    tournament_type: meta.type,
                    display_order: meta.display_order,
                    // Completed rows never carry cadence (nextMaintenanceAt is
                    // ACTIVE-only), so leave the cadence columns absent — the
                    // ACTIVE branch below is what reads them.
                });
            }
        }

        // Combine and sort: active first, then retained completed
        const allGames = [...activeGames, ...retainedGames]
            .sort((a, b) => (a.display_order - b.display_order) || 0);

        // Deduplicate by game name + tournament
        const seen = new Set<string>();
        const deduped = allGames.filter(g => {
            const key = `${g.tournament_name}:${g.game_name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        // Batch-load cached leaderboards (avoid N+1 per-game queries)
        const gameIds = deduped.map(g => g.id);
        const placeholders = gameIds.map(() => '?').join(',');
        const cachedRows = gameIds.length > 0
            ? await db.all(
                `SELECT game_id, rankings FROM leaderboard_cache WHERE game_id IN (${placeholders})`,
                ...gameIds
            )
            : [];
        const cacheMap = new Map<string, CachedRankedRow[]>();
        for (const r of cachedRows as any[]) {
            const rows = parseCacheEnvelope(r.rankings);
            // A pre-S24.1 blob is treated as a miss and recalculated below.
            if (rows) cacheMap.set(r.game_id, rows);
        }

        // v2.74.0 (S24.1): resolve names/avatars for the WHOLE page in one
        // batch after the cache reads, instead of a profile join per
        // recalculated game. The per-miss recalculate is now rare (profile
        // edits no longer nuke the table) and is deduped by `recalculateRows`.
        const rowsByGame = new Map<string, CachedRankedRow[]>();
        for (const game of deduped) {
            const cached = cacheMap.get(game.id);
            rowsByGame.set(game.id, cached ?? await this.recalculateRows(game.id));
        }
        // v2.78.0: one batched window lookup for the whole page, feeding the
        // verified-checkmark resolution inside `hydrate` — see `loadWindows`.
        const windowByGame = await this.loadWindows(gameIds);
        const flatRows: CachedRankedRow[] = [];
        const flatWindows: Array<ScoreWindow | null> = [];
        for (const game of deduped) {
            const rows = rowsByGame.get(game.id)!;
            const window = windowByGame.get(game.id) ?? null;
            for (const row of rows) { flatRows.push(row); flatWindows.push(window); }
        }
        const flatHydrated = await this.hydrate(flatRows, flatWindows);
        const rankingsByGame = new Map<string, RankedEntry[]>();
        let cursor = 0;
        for (const game of deduped) {
            const count = rowsByGame.get(game.id)!.length;
            rankingsByGame.set(game.id, flatHydrated.slice(cursor, cursor + count));
            cursor += count;
        }

        // v2.74.0 (S24.4): cadence now rides on the ACTIVE-games row (see the
        // main SELECT), and the per-tournament room TIMEZONE lookup that used
        // to sit inside this loop is one batched query over the distinct rooms.
        const cadenceRaw = new Map<string, { cron: string; timezone: string | null; roomId: string | null }>();
        for (const game of activeGames as any[]) {
            if (!game.tournament_id || cadenceRaw.has(game.tournament_id) || !game.tournament_cadence) continue;
            try {
                const cadenceObj = JSON.parse(game.tournament_cadence);
                if (cadenceObj?.cron) {
                    cadenceRaw.set(game.tournament_id, {
                        cron: cadenceObj.cron,
                        timezone: cadenceObj.timezone || null,
                        roomId: game.tournament_game_room_id || null,
                    });
                }
            } catch { /* malformed cadence JSON — no maintenance countdown */ }
        }
        const tzRoomIds = [...new Set([...cadenceRaw.values()].map(c => c.roomId).filter(Boolean))] as string[];
        const roomTzById = new Map<string, string>();
        if (tzRoomIds.length > 0) {
            const tzPlaceholders = tzRoomIds.map(() => '?').join(',');
            const tzRows = await db.all(
                `SELECT game_room_id, value FROM game_room_settings
                 WHERE key = 'TIMEZONE' AND game_room_id IN (${tzPlaceholders})`,
                ...tzRoomIds
            );
            for (const r of tzRows as any[]) {
                if (r.value) roomTzById.set(r.game_room_id, r.value);
            }
        }
        const cadenceMap = new Map<string, { cron: string; timezone: string }>();
        for (const [tid, c] of cadenceRaw) {
            // Precedence is unchanged: per-room TIMEZONE wins over the cadence's
            // own timezone, which wins over BOT_TIMEZONE, which wins over the
            // hardcoded default.
            const roomTz = c.roomId ? roomTzById.get(c.roomId) : undefined;
            const tz = roomTz || c.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
            cadenceMap.set(tid, { cron: c.cron, timezone: tz });
        }

        const results = [];
        for (const game of deduped) {
            const rankings = rankingsByGame.get(game.id) ?? [];

            // Compute next maintenance time for active games
            let nextMaintenanceAt: string | null = null;
            if (game.status === 'ACTIVE' && game.tournament_id) {
                const cadenceInfo = cadenceMap.get(game.tournament_id);
                if (cadenceInfo) {
                    const nextRun = getNextRunTime(cadenceInfo.cron, cadenceInfo.timezone);
                    if (nextRun) nextMaintenanceAt = nextRun.toISOString();
                }
            }

            results.push({
                gameId: game.id,
                gameName: game.game_name,
                displayName: game.display_name || null,
                tournamentName: game.tournament_name || 'Untracked',
                tournamentType: game.tournament_type || '',
                // v2.4.0: pinned games (no tournament) render with a "Pinned"
                // chip instead of the tournament badge. Clients use this flag.
                isPinned: game.is_pinned === 1,
                // v2.0.3: normalize catalogue paths to their public URL so cards
                // render the image directly. `data/catalogue-images/...` → `/api/catalogue-images/...`.
                imageUrl: normalizeImageUrl(game.image_url),
                gameStatus: game.status || 'ACTIVE',
                catalogueStyleId: game.catalogue_style_id || null,
                logoStyleId: game.logo_style_id || null,
                bgStyleId: game.bg_style_id || null,
                styleHeaderDisabled: game.style_header_disabled === 1,
                bgHasBg: game.bg_has_bg ?? null,
                logoHasHeader: game.logo_has_header ?? null,
                catHasBg: game.cat_has_bg ?? null,
                catHasHeader: game.cat_has_header ?? null,
                externalUrl: game.external_url || null,
                notes: game.notes || null,
                rankings,
                nextMaintenanceAt,
                globalGameId: game.global_game_id || null,
            });
        }
        return results;
    }
}
