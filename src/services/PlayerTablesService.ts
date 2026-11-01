import { getDatabase } from '../database/database.js';
import { isCanonicalEngine } from '../utils/scoreProvenance.js';
import { parsePlatformsList } from '../utils/platformRules.js';
import { normalizeImageUrl } from './LeaderboardService.js';
import { RATING_HEADLINE_BY_GAME_SQL, roundRating } from './GlobalRatingService.js';

/**
 * C2 - "My Tables": which catalogue tables a player owns, optionally per
 * engine. `player_tables` (migration 204) holds one row per (user, game,
 * engine); `platform = ''` means "owned, platform unspecified" and is the
 * ONLY row for a generically owned game.
 *
 * Owner ruling: inventory may be anonymous. Nothing here lists owners by
 * name - other players only ever see `ownerCount(s)`.
 */

export interface OwnedTable {
    global_game_id: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
    type: string | null;
    image_url: string | null;
    /** global_games.platforms (parsed), for the FE chip offer. */
    catalogue_platforms: string[];
    /** This player's engines; [] = the single generic ('') row. */
    platforms: string[];
    /** Earliest of the player's rows for this game. */
    created_at: string;
    /** A14.1 - per-rater headline rating, one decimal; 0 when nobody rated. */
    avg_rating: number;
    /** A14.1 - distinct raters; 0 when nobody rated. */
    rating_count: number;
}

export class GameNotFoundError extends Error {
    readonly code = 'GAME_NOT_FOUND';
    constructor(public globalGameId: string) {
        super(`No catalogue game "${globalGameId}".`);
        this.name = 'GameNotFoundError';
    }
}

export class PlatformInvalidError extends Error {
    readonly code = 'PLATFORM_INVALID';
    constructor(public platform: string) {
        super(`"${platform}" is not a known engine.`);
        this.name = 'PlatformInvalidError';
    }
}

const IN_CHUNK = 500;

interface JoinedRow {
    global_game_id: string;
    platform: string;
    row_created_at: string;
    name: string;
    manufacturer: string | null;
    year: number | null;
    type: string | null;
    image_url: string | null;
    catalogue_platforms: string | null;
}

/** Fold joined (game x platform) rows into one OwnedTable per game. */
function foldRows(rows: JoinedRow[]): OwnedTable[] {
    const byGame = new Map<string, OwnedTable>();
    for (const r of rows) {
        let t = byGame.get(r.global_game_id);
        if (!t) {
            t = {
                global_game_id: r.global_game_id,
                name: r.name,
                manufacturer: r.manufacturer ?? null,
                year: r.year ?? null,
                type: r.type ?? null,
                image_url: normalizeImageUrl(r.image_url),
                catalogue_platforms: parsePlatformsList(r.catalogue_platforms || '[]'),
                platforms: [],
                created_at: r.row_created_at,
                avg_rating: 0,
                rating_count: 0,
            };
            byGame.set(r.global_game_id, t);
        }
        if (r.platform) t.platforms.push(r.platform);
        if (r.row_created_at && r.row_created_at < t.created_at) t.created_at = r.row_created_at;
    }
    const out = [...byGame.values()];
    for (const t of out) t.platforms.sort();
    out.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    return out;
}

/** A14.1 - set the headline rating on folded tables, ONE read per chunk of ids. */
async function attachRatings(tables: OwnedTable[]): Promise<OwnedTable[]> {
    if (tables.length === 0) return tables;
    const db = await getDatabase();
    const byId = new Map(tables.map(t => [t.global_game_id, t]));
    const ids = [...byId.keys()];
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
        const chunk = ids.slice(i, i + IN_CHUNK);
        const ph = chunk.map(() => '?').join(',');
        const rows = await db.all<Array<{ global_game_id: string; avg_rating: number | null; rating_count: number }>>(
            `SELECT global_game_id, avg_rating, rating_count
               FROM (${RATING_HEADLINE_BY_GAME_SQL})
              WHERE global_game_id IN (${ph})`,
            ...chunk,
        );
        for (const r of rows) {
            const t = byId.get(r.global_game_id);
            if (!t) continue;
            t.avg_rating = roundRating(r.avg_rating);
            t.rating_count = r.rating_count ?? 0;
        }
    }
    return tables;
}

const SELECT_JOINED = `
    SELECT pt.global_game_id, pt.platform, pt.created_at AS row_created_at,
           COALESCE(gg.display_name, gg.name) AS name,
           gg.manufacturer, gg.year, gg.type,
           COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) AS image_url,
           gg.platforms AS catalogue_platforms
      FROM player_tables pt
      JOIN global_games gg ON gg.id = pt.global_game_id`;

export class PlayerTablesService {
    static async listForUser(userId: string): Promise<OwnedTable[]> {
        const db = await getDatabase();
        const rows = await db.all<JoinedRow[]>(
            `${SELECT_JOINED} WHERE pt.user_id = ?`, userId,
        );
        return attachRatings(foldRows(rows));
    }

    /**
     * REPLACE the player's rows for one game with `platforms`. [] (or only
     * '') => one generic '' row. An engine list drops '' - a game is either
     * generic or per-engine, never both.
     */
    static async setOwnership(userId: string, globalGameId: string, platforms: string[]): Promise<OwnedTable> {
        const db = await getDatabase();
        const game = await db.get('SELECT id FROM global_games WHERE id = ?', globalGameId);
        if (!game) throw new GameNotFoundError(globalGameId);

        const engines = new Set<string>();
        for (const raw of platforms) {
            const p = typeof raw === 'string' ? raw.trim() : '';
            if (typeof raw !== 'string') throw new PlatformInvalidError(String(raw));
            if (p === '') continue;
            if (!isCanonicalEngine(p)) throw new PlatformInvalidError(p);
            engines.add(p);
        }
        const rows = engines.size ? [...engines] : [''];

        await db.exec('BEGIN');
        try {
            // Keep the original created_at across a re-save of the same game.
            const prev = await db.get<{ c: string | null }>(
                'SELECT MIN(created_at) AS c FROM player_tables WHERE user_id = ? AND global_game_id = ?',
                userId, globalGameId,
            );
            await db.run('DELETE FROM player_tables WHERE user_id = ? AND global_game_id = ?', userId, globalGameId);
            for (const p of rows) {
                await db.run(
                    `INSERT INTO player_tables (user_id, global_game_id, platform, created_at)
                     VALUES (?, ?, ?, COALESCE(?, datetime('now')))`,
                    userId, globalGameId, p, prev?.c ?? null,
                );
            }
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }

        const joined = await db.all<JoinedRow[]>(
            `${SELECT_JOINED} WHERE pt.user_id = ? AND pt.global_game_id = ?`, userId, globalGameId,
        );
        const table = (await attachRatings(foldRows(joined)))[0];
        // The game row was checked above and the FK cascades on its delete, so
        // only a concurrent catalogue delete can leave this empty.
        if (!table) throw new GameNotFoundError(globalGameId);
        return table;
    }

    static async removeOwnership(userId: string, globalGameId: string): Promise<boolean> {
        const db = await getDatabase();
        const res = await db.run(
            'DELETE FROM player_tables WHERE user_id = ? AND global_game_id = ?', userId, globalGameId,
        );
        return (res.changes ?? 0) > 0;
    }

    static async ownedGameIds(userId: string): Promise<string[]> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ global_game_id: string }>>(
            'SELECT DISTINCT global_game_id FROM player_tables WHERE user_id = ?', userId,
        );
        return rows.map(r => r.global_game_id);
    }

    /** The player's engines for a game ([] = generic), or null when not owned. */
    static async ownedPlatforms(userId: string, globalGameId: string): Promise<string[] | null> {
        const db = await getDatabase();
        const rows = await db.all<Array<{ platform: string }>>(
            'SELECT platform FROM player_tables WHERE user_id = ? AND global_game_id = ? ORDER BY platform',
            userId, globalGameId,
        );
        if (rows.length === 0) return null;
        return rows.map(r => r.platform).filter(p => p !== '');
    }

    /** COUNT(DISTINCT user_id) per game. Ids with no owners are absent (read as 0). */
    static async ownerCounts(globalGameIds: string[]): Promise<Record<string, number>> {
        const ids = [...new Set(globalGameIds.filter((id): id is string => typeof id === 'string' && id !== ''))];
        const out: Record<string, number> = {};
        if (ids.length === 0) return out;
        const db = await getDatabase();
        for (let i = 0; i < ids.length; i += IN_CHUNK) {
            const chunk = ids.slice(i, i + IN_CHUNK);
            const ph = chunk.map(() => '?').join(',');
            const rows = await db.all<Array<{ global_game_id: string; n: number }>>(
                `SELECT global_game_id, COUNT(DISTINCT user_id) AS n
                   FROM player_tables WHERE global_game_id IN (${ph})
                  GROUP BY global_game_id`,
                ...chunk,
            );
            for (const r of rows) out[r.global_game_id] = r.n;
        }
        return out;
    }

    static async ownerCount(globalGameId: string): Promise<number> {
        const counts = await PlayerTablesService.ownerCounts([globalGameId]);
        return counts[globalGameId] ?? 0;
    }
}
