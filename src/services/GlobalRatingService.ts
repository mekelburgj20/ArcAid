import { getDatabase } from '../database/database.js';
import { toRaterEntries, type RaterEntry } from './RatingService.js';

/** C2.2 - one platform's aggregate beside the headline. */
export interface PlatformRatingAgg {
    platform: string;
    avg_rating: number;
    rating_count: number;
    user_rating: number | null;
}

export interface GlobalGameRatingInfo {
    global_game_id: string;
    /** AVG over each rater's own average (one opinion per player), 1 decimal, 0 when none. */
    avg_rating: number;
    /** Distinct raters. */
    rating_count: number;
    /** The viewer's platform = '' row. */
    user_rating: number | null;
    /** Every row of the viewer, keyed by platform ('' included); {} when anonymous. */
    user_ratings: Record<string, number>;
    /** Platforms != '' that have rows, rating_count DESC then platform ASC. */
    by_platform: PlatformRatingAgg[];
    /** One entry per ROW (a player rating two platforms appears twice), newest first. */
    raters: RaterEntry[];
}

/**
 * C3 - the headline aggregate: every rater counts ONCE, with the average of
 * their own rows (general + per-platform). Bind: global_game_id.
 */
export const RATING_HEADLINE_SQL = `
    SELECT AVG(u.r) AS avg_rating, COUNT(*) AS rating_count
      FROM (SELECT AVG(rating) AS r FROM global_game_ratings WHERE global_game_id = ? GROUP BY discord_user_id) u`;

/** The same per-rater rule for every game at once (global_game_id, avg_rating, rating_count). */
export const RATING_HEADLINE_BY_GAME_SQL = `
    SELECT global_game_id, AVG(r) AS avg_rating, COUNT(*) AS rating_count
      FROM (SELECT global_game_id, discord_user_id, AVG(rating) AS r
              FROM global_game_ratings GROUP BY global_game_id, discord_user_id)
     GROUP BY global_game_id`;

export function roundRating(avg: number | null | undefined): number {
    return avg ? Math.round(avg * 10) / 10 : 0;
}

export class GlobalRatingService {
    /**
     * Set or update a user's rating for a global game on one platform
     * ('' = the table in general, else a canonical engine id - callers
     * validate through normalizeRatingPlatform).
     */
    static async setRating(globalGameId: string, discordUserId: string, rating: number, platform = ''): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_game_ratings (global_game_id, discord_user_id, platform, rating, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(global_game_id, discord_user_id, platform) DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`,
            globalGameId, discordUserId, platform, rating
        );
    }

    /**
     * Get a single game's rating info, optionally with a specific user's ratings.
     */
    static async getGameRating(globalGameId: string, discordUserId?: string): Promise<GlobalGameRatingInfo> {
        const db = await getDatabase();
        const agg = await db.get(RATING_HEADLINE_SQL, globalGameId);

        const userRatings: Record<string, number> = {};
        if (discordUserId) {
            const rows = await db.all(
                `SELECT platform, rating FROM global_game_ratings WHERE global_game_id = ? AND discord_user_id = ?`,
                globalGameId, discordUserId
            );
            for (const r of rows) userRatings[r.platform] = r.rating;
        }

        const platformRows = await db.all(
            `SELECT platform, AVG(rating) AS avg_rating, COUNT(*) AS rating_count
               FROM global_game_ratings
              WHERE global_game_id = ? AND platform != ''
              GROUP BY platform
              ORDER BY rating_count DESC, platform ASC`,
            globalGameId
        );
        const byPlatform: PlatformRatingAgg[] = platformRows.map((p: { platform: string; avg_rating: number; rating_count: number }) => ({
            platform: p.platform,
            avg_rating: roundRating(p.avg_rating),
            rating_count: p.rating_count,
            user_rating: userRatings[p.platform] ?? null,
        }));

        const raterRows = await db.all(
            `SELECT discord_user_id AS user_id, platform, rating, updated_at FROM global_game_ratings
              WHERE global_game_id = ?
              ORDER BY updated_at DESC, discord_user_id ASC, platform ASC`,
            globalGameId
        );
        return {
            global_game_id: globalGameId,
            avg_rating: roundRating(agg?.avg_rating),
            rating_count: agg?.rating_count || 0,
            user_rating: userRatings[''] ?? null,
            user_ratings: userRatings,
            by_platform: byPlatform,
            raters: await toRaterEntries(raterRows),
        };
    }

    /**
     * C2 - every global rating a user has given (their player page), newest
     * first, with the catalogue name. C2.2: each row names its platform.
     */
    static async getRatingsByUser(discordUserId: string): Promise<Array<{ global_game_id: string; name: string; platform: string; rating: number; updated_at: string }>> {
        const db = await getDatabase();
        return db.all(
            `SELECT r.global_game_id, COALESCE(gg.display_name, gg.name, r.global_game_id) AS name,
                    r.platform, r.rating, r.updated_at
               FROM global_game_ratings r
               LEFT JOIN global_games gg ON gg.id = r.global_game_id
              WHERE r.discord_user_id = ?
              ORDER BY r.updated_at DESC, r.global_game_id ASC, r.platform ASC`,
            discordUserId
        );
    }

    /**
     * Bulk ratings for the scoreboard page - returns a map of globalGameId ->
     * { avg_rating, rating_count } (per-rater rule). Optionally includes the
     * user's general ('' platform) ratings.
     */
    static async getBulkRatings(discordUserId?: string): Promise<{
        ratings: Record<string, { avg_rating: number; rating_count: number }>;
        userRatings: Record<string, number>;
    }> {
        const db = await getDatabase();
        const rows = await db.all(RATING_HEADLINE_BY_GAME_SQL);
        const ratings: Record<string, { avg_rating: number; rating_count: number }> = {};
        for (const r of rows) {
            ratings[r.global_game_id] = {
                avg_rating: roundRating(r.avg_rating),
                rating_count: r.rating_count,
            };
        }

        const userRatings: Record<string, number> = {};
        if (discordUserId) {
            const userRows = await db.all(
                `SELECT global_game_id, rating FROM global_game_ratings WHERE discord_user_id = ? AND platform = ''`,
                discordUserId
            );
            for (const r of userRows) {
                userRatings[r.global_game_id] = r.rating;
            }
        }

        return { ratings, userRatings };
    }
}
