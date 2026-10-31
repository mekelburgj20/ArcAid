import { getDatabase } from '../database/database.js';
import { resolveUserLabels } from './PlayerProfileResolver.js';
import { GlobalRatingService, RATING_HEADLINE_BY_GAME_SQL, roundRating, type GlobalGameRatingInfo } from './GlobalRatingService.js';
import { catalogueIdForName, PlatformUnsupportedError } from '../utils/ratingTarget.js';

/** C2 - one named rating ("stamp your name on it or don't rate at all"). */
export interface RaterEntry {
    user_id: string;
    display_name: string;
    rating: number;
    updated_at: string;
    /** C2.2 - '' = the table in general, else a canonical engine id. */
    platform: string;
}

/**
 * What a rater is called when the id-label chain resolves nothing: pre-v2.86
 * guest ratings carry a random browser id, and a snowflake with no profile
 * row is still a raw id. Neither may render as-is (CLAUDE.md "Id-keyed
 * surfaces"), so the rater list says this instead.
 */
export const UNRESOLVED_RATER_LABEL = 'Unknown player';

/** Resolve rater rows to named entries through THE id-label chain. */
export async function toRaterEntries(
    rows: Array<{ user_id: string; rating: number; updated_at: string; platform?: string | null }>,
): Promise<RaterEntry[]> {
    const labels = await resolveUserLabels(rows.map(r => r.user_id));
    return rows.map(r => {
        const label = labels[r.user_id];
        return {
            user_id: r.user_id,
            display_name: label && label !== r.user_id ? label : UNRESOLVED_RATER_LABEL,
            rating: r.rating,
            updated_at: r.updated_at,
            platform: r.platform ?? '',
        };
    });
}

export interface GameRatingInfo extends Omit<GlobalGameRatingInfo, 'global_game_id'> {
    game_name: string;
    /** The catalogue row the rating lives on; null = room-only legacy store. */
    global_game_id: string | null;
    /** True when the catalogue store answered. */
    unified: boolean;
}

/**
 * The unambiguous approved catalogue names (lowercased) - the set form of
 * catalogueIdForName, shared with migration 205's fold.
 */
const UNAMBIGUOUS_NAME_MAP_SQL = `
    SELECT LOWER(name) AS lname, MIN(id) AS id, MIN(name) AS name FROM global_games WHERE status = 'approved'
     GROUP BY LOWER(name) HAVING COUNT(*) = 1`;

export class RatingService {
    /**
     * Set or update a user's rating for a game, by NAME in a room.
     *
     * C3: a name that denotes exactly one approved catalogue row is rated in
     * the ONE store (`global_game_ratings`, optionally per platform); every
     * other name keeps the v2.86.0 room-scoped `game_ratings` store (UNIQUE
     * `(game_room_id, game_name, user_id)`), which has no platform axis.
     */
    static async setRating(roomId: string, gameName: string, userId: string, rating: number, platform = ''): Promise<void> {
        const db = await getDatabase();
        const globalGameId = await catalogueIdForName(db, gameName);
        if (globalGameId) {
            await GlobalRatingService.setRating(globalGameId, userId, rating, platform);
            return;
        }
        if (platform !== '') throw new PlatformUnsupportedError();
        await db.run(
            `INSERT INTO game_ratings (game_room_id, game_name, user_id, rating, updated_at)
             VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT(game_room_id, game_name, user_id) DO UPDATE SET rating = excluded.rating, updated_at = datetime('now')`,
            roomId, gameName, userId, rating
        );
    }

    /**
     * Get a single game's rating info for a specific user, scoped to a room
     * (or, for a catalogue table, from the one store).
     */
    static async getGameRating(roomId: string, gameName: string, userId?: string): Promise<GameRatingInfo> {
        const db = await getDatabase();
        const globalGameId = await catalogueIdForName(db, gameName);
        if (globalGameId) {
            const info = await GlobalRatingService.getGameRating(globalGameId, userId);
            return { ...info, game_name: gameName, global_game_id: globalGameId, unified: true };
        }

        const agg = await db.get(
            `SELECT AVG(rating) as avg_rating, COUNT(*) as rating_count FROM game_ratings WHERE game_room_id = ? AND game_name = ?`,
            roomId, gameName
        );
        let userRating: number | null = null;
        if (userId) {
            const row = await db.get(
                `SELECT rating FROM game_ratings WHERE game_room_id = ? AND game_name = ? AND user_id = ?`,
                roomId, gameName, userId
            );
            if (row) userRating = row.rating;
        }
        const raterRows = await db.all(
            `SELECT user_id, rating, updated_at FROM game_ratings
              WHERE game_room_id = ? AND game_name = ?
              ORDER BY updated_at DESC, user_id ASC`,
            roomId, gameName
        );
        return {
            game_name: gameName,
            global_game_id: null,
            unified: false,
            avg_rating: agg?.avg_rating ? Math.round(agg.avg_rating * 10) / 10 : 0,
            rating_count: agg?.rating_count || 0,
            user_rating: userRating,
            user_ratings: userRating !== null ? { '': userRating } : {},
            by_platform: [],
            raters: await toRaterEntries(raterRows),
        };
    }

    /**
     * C2 - every room-only (legacy store) rating a user has given in a room,
     * newest first. Catalogue-table ratings come from
     * GlobalRatingService.getRatingsByUser.
     */
    static async getRatingsByUser(roomId: string, userId: string): Promise<Array<{ game_name: string; platform: string; rating: number; updated_at: string }>> {
        const db = await getDatabase();
        return db.all(
            `SELECT game_name, '' AS platform, rating, updated_at FROM game_ratings
              WHERE game_room_id = ? AND user_id = ?
              ORDER BY updated_at DESC, game_name ASC`,
            roomId, userId
        );
    }

    /**
     * Get ratings for all games in a room (bulk, for game library view).
     * Returns a map of game_name -> { avg_rating, rating_count }: the room's
     * legacy rows, then the catalogue aggregates (per-rater rule) for every
     * unambiguous approved name that has ratings. Catalogue wins on a collision.
     */
    static async getAllRatings(roomId: string): Promise<Record<string, { avg_rating: number; rating_count: number }>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT game_name, AVG(rating) as avg_rating, COUNT(*) as rating_count FROM game_ratings WHERE game_room_id = ? GROUP BY game_name`,
            roomId
        );
        const map: Record<string, { avg_rating: number; rating_count: number }> = {};
        for (const r of rows) {
            map[r.game_name] = {
                avg_rating: Math.round(r.avg_rating * 10) / 10,
                rating_count: r.rating_count,
            };
        }
        const catalogueRows = await db.all(
            `SELECT m.name AS game_name, a.avg_rating, a.rating_count
               FROM (${RATING_HEADLINE_BY_GAME_SQL}) a
               JOIN (${UNAMBIGUOUS_NAME_MAP_SQL}) m ON m.id = a.global_game_id`
        );
        for (const r of catalogueRows) {
            map[r.game_name] = {
                avg_rating: roundRating(r.avg_rating),
                rating_count: r.rating_count,
            };
        }
        return map;
    }

    /**
     * Get all ratings by a specific user in a room (for showing their stars in
     * the library): legacy rows plus the user's general ('' platform)
     * catalogue ratings of unambiguous names, keyed by name.
     */
    static async getUserRatings(roomId: string, userId: string): Promise<Record<string, number>> {
        const db = await getDatabase();
        const rows = await db.all(
            `SELECT game_name, rating FROM game_ratings WHERE game_room_id = ? AND user_id = ?`,
            roomId, userId
        );
        const map: Record<string, number> = {};
        for (const r of rows) {
            map[r.game_name] = r.rating;
        }
        const catalogueRows = await db.all(
            `SELECT m.name AS game_name, r.rating
               FROM global_game_ratings r
               JOIN (${UNAMBIGUOUS_NAME_MAP_SQL}) m ON m.id = r.global_game_id
              WHERE r.discord_user_id = ? AND r.platform = ''`,
            userId
        );
        for (const r of catalogueRows) {
            map[r.game_name] = r.rating;
        }
        return map;
    }
}
