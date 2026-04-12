import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

export interface GlobalRankedEntry {
    rank: number;
    discord_user_id: string;
    iscored_username: string;
    score: number;
    photo_url: string | null;
    submitted_at: string;
    origin_type: string;
    origin_game_room_id: string | null;
    origin_room_name: string | null;
    avatar_hash: string | null;
    score_id: string;
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
        // Case-insensitive grouping on iscored_username mirrors LeaderboardService pattern.
        const rows = await db.all(`
            SELECT
                best.score_id,
                best.discord_user_id,
                best.iscored_username,
                best.score,
                best.photo_url,
                best.submitted_at,
                best.origin_type,
                best.origin_game_room_id,
                gr.name as origin_room_name,
                um.avatar_hash
            FROM (
                SELECT
                    gs.id as score_id,
                    gs.discord_user_id,
                    gs.iscored_username,
                    gs.score,
                    gs.photo_url,
                    gs.submitted_at,
                    gs.origin_type,
                    gs.origin_game_room_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY LOWER(COALESCE(gs.iscored_username, gs.player_id))
                        ORDER BY gs.score DESC, gs.submitted_at ASC
                    ) as rn
                FROM (
                    SELECT
                        id,
                        player_id as discord_user_id,
                        iscored_username,
                        score,
                        photo_url,
                        submitted_at,
                        origin_type,
                        origin_game_room_id
                    FROM global_scores
                    WHERE global_game_id = ?
                      AND deleted_at IS NULL
                      ${excludeFilter}
                      ${roomFilter}
                ) gs
            ) best
            LEFT JOIN game_rooms gr ON gr.id = best.origin_game_room_id
            LEFT JOIN user_mappings um ON (
                um.discord_user_id = best.discord_user_id
                OR LOWER(um.iscored_username) = LOWER(best.iscored_username)
            )
            WHERE best.rn = 1
            GROUP BY best.score_id
            ORDER BY best.score DESC, best.submitted_at ASC
        `, globalGameId, ...roomParams);

        const rankings: GlobalRankedEntry[] = rows.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            score: e.score,
            photo_url: e.photo_url || null,
            submitted_at: e.submitted_at,
            origin_type: e.origin_type,
            origin_game_room_id: e.origin_game_room_id || null,
            origin_room_name: e.origin_room_name || null,
            avatar_hash: e.avatar_hash || null,
            score_id: e.score_id,
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
     * Paginated catalogue view with per-game score aggregates. All catalogue games
     * appear (LEFT JOIN), including ones with zero scores. Sort defaults to `popular`
     * — a recency-weighted score count that emphasizes games with recent activity.
     *
     * Popularity formula: SUM(1 / (1 + age_in_days / 14)). 14-day half-life means a
     * score today is worth ~1, 14 days ago ~0.5, 90 days ago ~0.135.
     */
    static async getTopGames(options: {
        scope?: string;
        sort?: 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc';
        limit?: number;
        offset?: number;
        search?: string;
        type?: string;
        platforms?: string[];
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
            const needle = `%${options.search.trim().toLowerCase()}%`;
            whereConditions.push(
                `(LOWER(gg.name) LIKE ? OR LOWER(COALESCE(gg.display_name, '')) LIKE ? OR LOWER(COALESCE(gg.manufacturer, '')) LIKE ?)`
            );
            whereParams.push(needle, needle, needle);
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

        const orderBy =
            options.sort === 'most_scores' ? 'score_count DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'most_recent' ? 'last_submitted_at DESC NULLS LAST, gg.name COLLATE NOCASE ASC' :
            options.sort === 'highest_rated' ? 'avg_rating DESC, rating_count DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'name_asc' ? 'gg.name COLLATE NOCASE ASC' :
            'popularity DESC, gg.name COLLATE NOCASE ASC'; // default: popular

        // When scoped to a room, only show games that have scores from that room.
        const havingClause = isGlobal ? '' : 'HAVING COUNT(gs.id) > 0';

        // Count query: for global scope, count all catalogue games; for room scope,
        // only count games with at least one score from the room.
        let total: number;
        if (isGlobal) {
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
                COALESCE(gr.rating_count, 0) as rating_count
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
            ...joinParams, ...whereParams, limit, offset
        );

        return { data, total, hasMore: offset + data.length < total };
    }
}
