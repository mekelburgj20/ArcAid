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
     * Top N scores across all games for a scope. Used by the global scoreboard
     * page for the "most scores" / "highest score" summary views.
     */
    static async getTopGames(options: {
        scope?: string;
        sort?: 'most_scores' | 'highest_score' | 'most_recent';
        limit?: number;
    } = {}): Promise<Array<{
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
    }>> {
        const db = await getDatabase();
        const limit = options.limit || 20;
        const scope = options.scope || 'global';
        const isGlobal = scope === 'global';
        const excludeFilter = isGlobal ? 'AND gs.exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND gs.origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];

        const orderBy =
            options.sort === 'most_scores' ? 'score_count DESC' :
            options.sort === 'most_recent' ? 'last_submitted_at DESC' :
            'top_score DESC';

        return db.all(`
            SELECT
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
                MAX(gs.submitted_at) as last_submitted_at
            FROM global_games gg
            JOIN global_scores gs ON gs.global_game_id = gg.id
            WHERE gg.status = 'approved'
              AND gg.global_leaderboard = 1
              AND gs.deleted_at IS NULL
              ${excludeFilter}
              ${roomFilter}
            GROUP BY gg.id
            ORDER BY ${orderBy}
            LIMIT ?
        `, ...roomParams, limit);
    }
}
