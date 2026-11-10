import { getDatabase } from '../database/database.js';
import { normalizeImageUrl } from './LeaderboardService.js';

/**
 * Table art for lists that name games (v2.240.0, B25): History, the tournament
 * page, the player page, the Stats page.
 *
 * The rule is the one the score card falls back to when a game has no style
 * background (`LeaderboardService.getActiveLeaderboards`, `/leaderboard/:gameId`):
 * the approved `global_games` row whose name matches case-insensitively, its
 * `local_image_path`, else `wheel_image_path`, else `image_url`, as a public URL
 * (`normalizeImageUrl`). Keyed by NAME, not by a `games` row, because most of
 * these lists are built from score rows whose `game_id` has decayed to NULL
 * (ADR 0005), and a past run's row may be gone.
 *
 * One query per call (chunked under SQLite's variable limit), however many
 * names the page has.
 */
export class GameArtService {
    /** The map key for a game name. */
    static key(name: string): string {
        return name.toLowerCase();
    }

    /** Art URL per game name (key: `GameArtService.key(name)`); names with no art are absent. */
    static async artForNames(names: ReadonlyArray<string | null | undefined>): Promise<Map<string, string>> {
        const keys = [...new Set(names.filter((n): n is string => !!n && !!n.trim()).map(n => GameArtService.key(n)))];
        const out = new Map<string, string>();
        if (keys.length === 0) return out;
        const db = await getDatabase();
        const CHUNK = 500;
        for (let i = 0; i < keys.length; i += CHUNK) {
            const chunk = keys.slice(i, i + CHUNK);
            const rows = await db.all<Array<{ k: string; img: string | null }>>(
                `SELECT LOWER(name) AS k, COALESCE(local_image_path, wheel_image_path, image_url) AS img
                 FROM global_games
                 WHERE status = 'approved'
                   AND LOWER(name) IN (${chunk.map(() => '?').join(',')})
                   AND COALESCE(local_image_path, wheel_image_path, image_url) IS NOT NULL
                 ORDER BY (local_image_path IS NULL), id`,
                ...chunk,
            );
            for (const row of rows) {
                if (out.has(row.k)) continue; // first (best) row per name wins
                const url = normalizeImageUrl(row.img);
                if (url) out.set(row.k, url);
            }
        }
        return out;
    }

    /** Same as `artForNames`, as a plain object for a JSON response. */
    static async artRecord(names: ReadonlyArray<string | null | undefined>): Promise<Record<string, string>> {
        return Object.fromEntries(await GameArtService.artForNames(names));
    }
}
