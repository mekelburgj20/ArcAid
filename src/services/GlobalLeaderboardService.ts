import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

export interface GlobalRankedEntry {
    rank: number;
    discord_user_id: string;
    iscored_username: string;
    /** User-chosen global display name (from `user_profiles.display_name`); null when unset. */
    display_name?: string | null;
    score: number;
    photo_url: string | null;
    submitted_at: string;
    origin_type: string;
    origin_game_room_id: string | null;
    origin_room_name: string | null;
    /** Sprint 12 — supports the RoomTag badge on Global Scoreboard rows. */
    origin_room_slug: string | null;
    origin_room_logo_url: string | null;
    /** Sprint 13 — optional admin-set short label; null falls back to slug-derived. */
    origin_room_short_tag: string | null;
    avatar_hash: string | null;
    score_id: string;
    /**
     * v2.5.1: per-row platform stamp shown on the Global Scoreboard's per-game
     * leaderboard. `null` for legacy rows (multi-platform games where a
     * specific platform couldn't be inferred at backfill time).
     */
    platform: string | null;
}

/**
 * Leaderboard for a global game. Scope is either 'global' (all rooms combined)
 * or a specific game_room_id (filter to scores that originated in that room).
 *
 * Cached per (global_game_id, scope) in global_leaderboard_cache.
 */
export class GlobalLeaderboardService {
    /**
     * Recalculate and cache the leaderboard for a single global game.
     *
     * Groups by LOWER(iscored_username), takes MAX(score) per player. Soft-deleted
     * scores and exclude_from_global rows are filtered. For room-scoped views,
     * only scores that originated in that room are included (origin_game_room_id).
     */
    static async recalculate(globalGameId: string, scope: string = 'global'): Promise<GlobalRankedEntry[]> {
        const db = await getDatabase();

        const isGlobal = scope === 'global';
        // For global scope, respect exclude_from_global. For room scope, show everything
        // (a user opted out of global, but their room submission still counts in the room).
        const excludeFilter = isGlobal ? 'AND exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];

        // Pull all non-deleted scores for the game, pick best per player, enrich with avatar + room name.
        // Partition collapses by submitted_by_user_id when set (Discord-linked aliases combine
        // into one entry); falls back to per-name partition for anon rows.
        const rows = await db.all(`
            SELECT
                best.score_id,
                COALESCE(best.submitted_by_user_id, um.discord_user_id, best.discord_user_id) as discord_user_id,
                best.iscored_username,
                best.score,
                best.photo_url,
                best.submitted_at,
                best.origin_type,
                best.origin_game_room_id,
                best.platform,
                gr.name as origin_room_name,
                gr.slug as origin_room_slug,
                gr.logo_url as origin_room_logo_url,
                gr.short_tag as origin_room_short_tag,
                up.display_name,
                up.avatar_hash
            FROM (
                SELECT
                    gs.id as score_id,
                    gs.discord_user_id,
                    gs.submitted_by_user_id,
                    gs.iscored_username,
                    gs.score,
                    gs.photo_url,
                    gs.submitted_at,
                    gs.origin_type,
                    gs.origin_game_room_id,
                    gs.platform,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(gs.submitted_by_user_id, 'iscored:' || LOWER(COALESCE(gs.iscored_username, gs.discord_user_id)))
                        ORDER BY gs.score DESC, gs.submitted_at ASC
                    ) as rn
                FROM (
                    SELECT
                        id,
                        player_id as discord_user_id,
                        submitted_by_user_id,
                        iscored_username,
                        score,
                        photo_url,
                        submitted_at,
                        origin_type,
                        origin_game_room_id,
                        platform
                    FROM global_scores
                    WHERE global_game_id = ?
                      AND deleted_at IS NULL
                      AND orphaned_at IS NULL
                      ${excludeFilter}
                      ${roomFilter}
                ) gs
            ) best
            LEFT JOIN game_rooms gr ON gr.id = best.origin_game_room_id
            LEFT JOIN user_mappings um ON (
                best.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(best.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(best.submitted_by_user_id, um.discord_user_id)
            WHERE best.rn = 1
            GROUP BY best.score_id
            ORDER BY best.score DESC, best.submitted_at ASC
        `, globalGameId, ...roomParams);

        const rankings: GlobalRankedEntry[] = rows.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            display_name: e.display_name || null,
            score: e.score,
            photo_url: e.photo_url || null,
            submitted_at: e.submitted_at,
            origin_type: e.origin_type,
            origin_game_room_id: e.origin_game_room_id || null,
            origin_room_name: e.origin_room_name || null,
            origin_room_slug: e.origin_room_slug || null,
            origin_room_logo_url: e.origin_room_logo_url || null,
            origin_room_short_tag: e.origin_room_short_tag || null,
            avatar_hash: e.avatar_hash || null,
            score_id: e.score_id,
            platform: e.platform || null,
        }));

        await db.run(
            `INSERT OR REPLACE INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at) VALUES (?, ?, ?, ?)`,
            globalGameId, scope, JSON.stringify(rankings), new Date().toISOString()
        );

        logInfo(`Global leaderboard recalculated for ${globalGameId} (${scope}): ${rankings.length} entries`);
        return rankings;
    }

    /**
     * Get cached leaderboard, recalculating if missing.
     */
    static async getForGame(globalGameId: string, scope: string = 'global'): Promise<GlobalRankedEntry[]> {
        const db = await getDatabase();
        const cached = await db.get(
            'SELECT rankings FROM global_leaderboard_cache WHERE global_game_id = ? AND scope = ?',
            globalGameId, scope
        );
        if (cached) return JSON.parse(cached.rankings);
        return this.recalculate(globalGameId, scope);
    }

    /**
     * Invalidate cache for a game. Clears both global and all room-scoped entries
     * since any new score on that game potentially shifts multiple leaderboards.
     */
    static async invalidate(globalGameId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM global_leaderboard_cache WHERE global_game_id = ?', globalGameId);
    }

    static async invalidateAll(): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM global_leaderboard_cache');
    }

    /**
     * Catalogue search matching (v2.51.0, A3 — the ⌘K palette's server half).
     *
     * Single-token queries keep the pre-A3 behavior byte-for-byte: one `%needle%`
     * matched against name / display_name / manufacturer. That path is what the
     * page's plain search field has always done, and `"haunt"` → Haunted House
     * must not regress.
     *
     * Multi-token queries now AND across whitespace-separated tokens, so
     * `"stern 1995"` means "Stern AND 1995" rather than one literal substring
     * (which matched nothing, since no row contains the string "stern 1995").
     * A token that looks like a calendar year (1900-2099) additionally matches
     * `gg.year`. The year comparison is OR'd with the same text match rather
     * than replacing it, so titles that legitimately contain a number —
     * "Pinball 2000", "NBA Fastbreak 1997" — stay findable; a query token only
     * ever *widens* what it can match, never narrows it.
     *
     * Every value is bound as a parameter; user input is never interpolated
     * into the SQL string.
     *
     * Returns null for an all-whitespace query (caller adds no clause).
     */
    private static buildSearchFilter(search: string): { clause: string; params: any[] } | null {
        const trimmed = search.trim();
        if (!trimmed) return null;

        const textMatch = `(LOWER(gg.name) LIKE ? OR LOWER(COALESCE(gg.display_name, '')) LIKE ? OR LOWER(COALESCE(gg.manufacturer, '')) LIKE ?)`;

        const tokens = trimmed.split(/\s+/).filter(Boolean);
        if (tokens.length <= 1) {
            const needle = `%${trimmed.toLowerCase()}%`;
            return { clause: textMatch, params: [needle, needle, needle] };
        }

        const clauses: string[] = [];
        const params: any[] = [];
        for (const token of tokens) {
            const needle = `%${token.toLowerCase()}%`;
            if (GlobalLeaderboardService.isYearToken(token)) {
                clauses.push(`(gg.year = ? OR ${textMatch})`);
                params.push(Number(token), needle, needle, needle);
            } else {
                clauses.push(textMatch);
                params.push(needle, needle, needle);
            }
        }
        return { clause: `(${clauses.join(' AND ')})`, params };
    }

    /**
     * A bare 4-digit token inside the plausible release-year window. "1000" and
     * "3000" are deliberately NOT years — they are far more likely to be part of
     * a title ("Pinball 3000") than a manufacture date.
     */
    private static isYearToken(token: string): boolean {
        if (!/^\d{4}$/.test(token)) return false;
        const n = Number(token);
        return n >= 1900 && n <= 2099;
    }

    /**
     * Paginated catalogue view with per-game score aggregates. All catalogue games
     * appear (LEFT JOIN), including ones with zero scores. Sort defaults to `popular`
     * — a recency-weighted score count that emphasizes games with recent activity.
     *
     * Popularity formula: SUM(1 / (1 + age_in_days / 14)). 14-day half-life means a
     * score today is worth ~1, 14 days ago ~0.5, 90 days ago ~0.135.
     */
    static async getTopGames(options: {
        scope?: string;
        sort?: 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc' | 'pinned';
        limit?: number;
        offset?: number;
        search?: string;
        type?: string;
        platforms?: string[];
        /**
         * v2.52.0 (A4) — the viewer whose pins `sort=pinned` orders by. Also
         * populates `pinned_at` on every row, which the route turns into
         * `is_pinned`. Absent (anonymous) → `sort=pinned` degrades to
         * `popular` rather than erroring; that fallback is the caller's job.
         */
        pinnedUserId?: string;
        /**
         * scores-page-redesign (B3): when true (and scope is global), bound the
         * global catalogue view to games WITH at least one live global score —
         * the room Scoreboard's "Global" tab lens. Default/absent leaves the
         * standalone /scoreboard catalogue-browse behavior byte-identical
         * (zero-score catalogue games still appear there).
         */
        hasScores?: boolean;
    } = {}): Promise<{
        data: Array<{
            global_game_id: string;
            name: string;
            display_name: string | null;
            manufacturer: string | null;
            year: number | null;
            type: string;
            image_url: string | null;
            local_image_path: string | null;
            wheel_image_path: string | null;
            platforms: string;
            score_count: number;
            top_score: number | null;
            last_submitted_at: string | null;
            popularity: number;
            avg_rating: number;
            rating_count: number;
            /** v2.52.0: ISO pin timestamp for `pinnedUserId`, else null/absent. */
            pinned_at?: string | null;
        }>;
        total: number;
        hasMore: boolean;
    }> {
        const db = await getDatabase();
        const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
        const offset = Math.max(options.offset ?? 0, 0);
        const scope = options.scope || 'global';
        const isGlobal = scope === 'global';

        // Score-level filters go in the LEFT JOIN predicate so games with zero
        // matching scores still appear with score_count = 0.
        const joinConditions: string[] = ['gs.global_game_id = gg.id', 'gs.deleted_at IS NULL'];
        const joinParams: any[] = [];
        if (isGlobal) {
            joinConditions.push('gs.exclude_from_global = 0');
        } else {
            joinConditions.push('gs.origin_game_room_id = ?');
            joinParams.push(scope);
        }

        // Game-level filters go in WHERE so non-matching games are excluded entirely.
        const whereConditions: string[] = [
            `gg.status = 'approved'`,
            `gg.global_leaderboard = 1`,
        ];
        const whereParams: any[] = [];

        if (options.type) {
            whereConditions.push('gg.type = ?');
            whereParams.push(options.type);
        }
        if (options.search && options.search.trim()) {
            const search = GlobalLeaderboardService.buildSearchFilter(options.search);
            if (search) {
                whereConditions.push(search.clause);
                whereParams.push(...search.params);
            }
        }
        if (options.platforms && options.platforms.length > 0) {
            const clauses = options.platforms.map(() => `gg.platforms LIKE ?`);
            whereConditions.push(`(${clauses.join(' OR ')})`);
            for (const p of options.platforms) {
                whereParams.push(`%"${p}"%`);
            }
        }

        const whereClause = whereConditions.join(' AND ');
        const joinClause = joinConditions.join(' AND ');

        // Popularity: recency-weighted score count, 14-day half-life.
        // julianday('now') - julianday(submitted_at) = age in days.
        const popularityExpr =
            `COALESCE(SUM(1.0 / (1.0 + (julianday('now') - julianday(gs.submitted_at)) / 14.0)), 0)`;

        // v2.52.0 (A4) — the viewer's pin timestamp per row.
        //
        // A correlated scalar subquery, deliberately NOT a LEFT JOIN: this
        // query GROUPs BY gg.id and a join would put `global_game_pins` inside
        // the aggregate, quietly multiplying `score_count`/`popularity` for
        // pinned rows.
        //
        // The column is OMITTED ENTIRELY when there is no viewer rather than
        // selected as a literal NULL — an anonymous `/api/global/scoreboard`
        // response must keep exactly the key set it had before A4, and a
        // `pinned_at: null` on every row would break that. Its bind parameter
        // is the first in the statement, hence its own params array ahead of
        // joinParams.
        const selectParams: any[] = [];
        let pinnedAtSelect = '';
        if (options.pinnedUserId) {
            pinnedAtSelect = `,
                (SELECT p.created_at FROM global_game_pins p
                 WHERE p.global_game_id = gg.id AND p.discord_user_id = ?) as pinned_at`;
            selectParams.push(options.pinnedUserId);
        }

        const orderBy =
            // Pinned first, most-recently-pinned leading, then the standard
            // `popular` ordering for everything else. `pinned_at IS NULL` sorts
            // 0 (pinned) before 1 (not), so it is the primary key of the sort.
            options.sort === 'pinned' && options.pinnedUserId
                ? 'pinned_at IS NULL ASC, pinned_at DESC, popularity DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'most_scores' ? 'score_count DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'most_recent' ? 'last_submitted_at DESC NULLS LAST, gg.name COLLATE NOCASE ASC' :
            options.sort === 'highest_rated' ? 'avg_rating DESC, rating_count DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'name_asc' ? 'gg.name COLLATE NOCASE ASC' :
            'popularity DESC, gg.name COLLATE NOCASE ASC'; // default: popular

        // When scoped to a room, only show games that have scores from that room.
        // B3: hasScores=true applies the same bound to the global scope (the
        // room Scoreboard's "Global" tab lens), while leaving the standalone
        // /scoreboard catalogue browse (hasScores absent) unaffected.
        const requireScores = options.hasScores === true;
        const havingClause = (!isGlobal || requireScores) ? 'HAVING COUNT(gs.id) > 0' : '';

        // Count query: for global scope, count all catalogue games; for room scope
        // (or global+hasScores), only count games with at least one qualifying score.
        let total: number;
        if (isGlobal && !requireScores) {
            const countRow = await db.get(
                `SELECT COUNT(*) as c FROM global_games gg WHERE ${whereClause}`,
                ...whereParams
            );
            total = countRow?.c ?? 0;
        } else {
            const countRow = await db.get(
                `SELECT COUNT(*) as c FROM (
                    SELECT gg.id
                    FROM global_games gg
                    JOIN global_scores gs ON ${joinClause}
                    WHERE ${whereClause}
                    GROUP BY gg.id
                    HAVING COUNT(gs.id) > 0
                )`,
                ...joinParams, ...whereParams
            );
            total = countRow?.c ?? 0;
        }

        const data = await db.all(
            `SELECT
                gg.id as global_game_id,
                gg.name,
                gg.display_name,
                gg.manufacturer,
                gg.year,
                gg.type,
                gg.image_url,
                gg.local_image_path,
                gg.wheel_image_path,
                gg.platforms,
                COUNT(gs.id) as score_count,
                MAX(gs.score) as top_score,
                MAX(gs.submitted_at) as last_submitted_at,
                ${popularityExpr} as popularity,
                COALESCE(gr.avg_rating, 0) as avg_rating,
                COALESCE(gr.rating_count, 0) as rating_count${pinnedAtSelect}
            FROM global_games gg
            LEFT JOIN global_scores gs ON ${joinClause}
            LEFT JOIN (
                SELECT global_game_id,
                       AVG(rating) as avg_rating,
                       COUNT(*) as rating_count
                FROM global_game_ratings
                GROUP BY global_game_id
            ) gr ON gr.global_game_id = gg.id
            WHERE ${whereClause}
            GROUP BY gg.id
            ${havingClause}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?`,
            ...selectParams, ...joinParams, ...whereParams, limit, offset
        );

        return { data, total, hasMore: offset + data.length < total };
    }

    /**
     * v2.52.0 (A4) — the viewer's own rank + score across a batch of games, in
     * ONE query.
     *
     * Why not just call `getForGame` per game: a logged-in page load carries up
     * to 200 games, and `getForGame` recalculates whenever the per-game cache
     * is cold. That would turn one authenticated request into 200 full
     * leaderboard recomputes. This resolves rank arithmetically instead, and
     * the caller only falls back to `getForGame` for the handful of games the
     * viewer actually has a score on (to build `neighbors`).
     *
     * The ranking must agree with `recalculate` exactly or the card would show
     * a rank that isn't the one rendered, so both halves are mirrored here:
     *   1. best-per-player collapse using the SAME partition expression
     *      (`submitted_by_user_id`, else the `iscored:<lowername>` synthetic),
     *   2. the same resolved owner id
     *      (`COALESCE(submitted_by_user_id, user_mappings.discord_user_id, player_id)`)
     *      so a viewer's iScored-synced aliases count as theirs,
     *   3. the same tie-break (`score DESC, submitted_at ASC`).
     *
     * The `user_mappings` lookup is a scalar subquery rather than the LEFT JOIN
     * `recalculate` uses: a join under a window function could fan out a row
     * and shift every rank below it. `iscored_username` is UNIQUE COLLATE
     * NOCASE so the two forms select the same value.
     */
    static async getViewerRanks(
        gameIds: string[],
        viewerUserId: string,
        scope: string = 'global',
    ): Promise<Record<string, { rank: number; score: number }>> {
        if (gameIds.length === 0 || !viewerUserId) return {};
        const db = await getDatabase();
        const isGlobal = scope === 'global';
        const excludeFilter = isGlobal ? 'AND gs.exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND gs.origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];
        const placeholders = gameIds.map(() => '?').join(',');

        const rows = await db.all(`
            SELECT resolved.global_game_id, resolved.rank, resolved.score
            FROM (
                SELECT
                    best.global_game_id,
                    best.score,
                    COALESCE(
                        best.submitted_by_user_id,
                        CASE WHEN best.player_id LIKE 'iscored:%' THEN (
                            SELECT um.discord_user_id FROM user_mappings um
                            WHERE LOWER(um.iscored_username) = LOWER(best.iscored_username)
                            LIMIT 1
                        ) END,
                        best.player_id
                    ) AS owner_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY best.global_game_id
                        ORDER BY best.score DESC, best.submitted_at ASC
                    ) AS rank
                FROM (
                    SELECT
                        gs.global_game_id,
                        gs.player_id,
                        gs.submitted_by_user_id,
                        gs.iscored_username,
                        gs.score,
                        gs.submitted_at,
                        ROW_NUMBER() OVER (
                            PARTITION BY gs.global_game_id, COALESCE(gs.submitted_by_user_id, 'iscored:' || LOWER(COALESCE(gs.iscored_username, gs.player_id)))
                            ORDER BY gs.score DESC, gs.submitted_at ASC
                        ) AS player_rn
                    FROM global_scores gs
                    WHERE gs.global_game_id IN (${placeholders})
                      AND gs.deleted_at IS NULL
                      AND gs.orphaned_at IS NULL
                      ${excludeFilter}
                      ${roomFilter}
                ) best
                WHERE best.player_rn = 1
            ) resolved
            WHERE resolved.owner_id = ?
        `, ...gameIds, ...roomParams, viewerUserId);

        const out: Record<string, { rank: number; score: number }> = {};
        for (const row of rows) {
            out[row.global_game_id] = { rank: row.rank, score: row.score };
        }
        return out;
    }

    /**
     * Fetch top N leaderboard entries for a batch of global game IDs.
     * Returns a map of globalGameId → ranked entries (best per player, top N).
     * Used to enrich catalogue cards with inline score previews.
     */
    static async getTopScoresForGames(
        gameIds: string[],
        topN: number = 5,
        scope: string = 'global'
    ): Promise<Record<string, Array<{
        iscored_username: string;
        /**
         * v2.52.0: the implementation has always populated this (it is the
         * `display_name ?? iscored_username` render rule's input); the declared
         * signature simply omitted it, so callers outside this file couldn't
         * see it. Declared now that GlobalPinService reads it.
         */
        display_name: string | null;
        score: number;
        avatar_hash: string | null;
        discord_user_id: string;
        /** Sprint 12 — badge fields on Global Scoreboard cards. */
        origin_room_slug: string | null;
        origin_room_logo_url: string | null;
        /** Sprint 13 — admin-set label preferred over slug for RoomTag. */
        origin_room_short_tag: string | null;
    }>>> {
        if (gameIds.length === 0) return {};
        const db = await getDatabase();
        const isGlobal = scope === 'global';
        const excludeFilter = isGlobal ? 'AND gs.exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND gs.origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];

        const placeholders = gameIds.map(() => '?').join(',');

        const rows = await db.all(`
            SELECT
                ranked.global_game_id,
                ranked.discord_user_id,
                ranked.iscored_username,
                ranked.score,
                ranked.origin_game_room_id,
                gr.slug as origin_room_slug,
                gr.logo_url as origin_room_logo_url,
                gr.short_tag as origin_room_short_tag,
                up.display_name,
                up.avatar_hash
            FROM (
                SELECT
                    gs.global_game_id,
                    gs.player_id as discord_user_id,
                    gs.submitted_by_user_id,
                    gs.iscored_username,
                    gs.score,
                    gs.origin_game_room_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY gs.global_game_id, COALESCE(gs.submitted_by_user_id, 'iscored:' || LOWER(COALESCE(gs.iscored_username, gs.player_id)))
                        ORDER BY gs.score DESC
                    ) as player_rn
                FROM global_scores gs
                WHERE gs.global_game_id IN (${placeholders})
                  AND gs.deleted_at IS NULL
                  AND gs.orphaned_at IS NULL
                  ${excludeFilter}
                  ${roomFilter}
            ) ranked
            LEFT JOIN game_rooms gr ON gr.id = ranked.origin_game_room_id
            LEFT JOIN user_mappings um ON (
                ranked.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(ranked.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(ranked.submitted_by_user_id, um.discord_user_id)
            WHERE ranked.player_rn = 1
            ORDER BY ranked.global_game_id, ranked.score DESC
        `, ...gameIds, ...roomParams);

        // Group by game and take top N per game
        const result: Record<string, Array<{
            iscored_username: string;
            display_name: string | null;
            score: number;
            avatar_hash: string | null;
            discord_user_id: string;
            origin_room_slug: string | null;
            origin_room_logo_url: string | null;
            origin_room_short_tag: string | null;
        }>> = {};
        for (const row of rows) {
            const gid = row.global_game_id;
            if (!result[gid]) result[gid] = [];
            if (result[gid].length < topN) {
                result[gid].push({
                    iscored_username: row.iscored_username || 'Unknown',
                    display_name: row.display_name || null,
                    score: row.score,
                    avatar_hash: row.avatar_hash || null,
                    discord_user_id: row.discord_user_id,
                    origin_room_slug: row.origin_room_slug || null,
                    origin_room_logo_url: row.origin_room_logo_url || null,
                    origin_room_short_tag: row.origin_room_short_tag || null,
                });
            }
        }
        return result;
    }
}
