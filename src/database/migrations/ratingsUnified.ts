import { logInfo } from '../../utils/logger.js';

/**
 * Migration 205 - unified ratings with a platform axis (C3 ratings half + C2.2).
 *
 * 1. Rebuild `global_game_ratings` with `platform TEXT NOT NULL DEFAULT ''`
 *    ('' = the table in general, else a canonical ENGINE id) and the unique
 *    key `(global_game_id, discord_user_id, platform)`. Skipped when the
 *    column already exists, so the handler can be re-run.
 * 2. Fold room `game_ratings` rows of catalogue tables into that one store,
 *    by the SAME rule as `catalogueIdForName` (src/utils/ratingTarget.ts) in
 *    set form: a lowercased name that denotes exactly ONE approved row. When a
 *    player rated the same table in two rooms (or already globally) the NEWER
 *    opinion wins. Room-only and ambiguous names stay in `game_ratings`.
 *    Pre-v2.86 guest uuids move too - they already render as "Unknown player".
 *
 * Runs before `PRAGMA foreign_keys = ON` (see initDatabase), which the table
 * rebuild requires.
 */

type Db = {
    exec(sql: string): Promise<unknown>;
    get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    all<T>(sql: string, ...params: unknown[]): Promise<T>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
};

export async function runRatingsUnified(db: Db): Promise<void> {
    // --- Step 1: platform column (rebuild) --------------------------------
    const cols = await db.all<Array<{ name: string }>>(`PRAGMA table_info(global_game_ratings)`);
    if (cols.length > 0 && !cols.some(c => c.name === 'platform')) {
        // DROP TABLE deletes the sqlite_sequence row; keep the AUTOINCREMENT
        // high-water mark so a deleted row's id is never reused.
        const seq = await db.get<{ seq: number }>(
            `SELECT seq FROM sqlite_sequence WHERE name = 'global_game_ratings'`,
        );
        await db.exec(`
            DROP TABLE IF EXISTS global_game_ratings_new;
            CREATE TABLE global_game_ratings_new (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                global_game_id TEXT NOT NULL,
                discord_user_id TEXT NOT NULL,
                platform TEXT NOT NULL DEFAULT '',
                rating INTEGER NOT NULL CHECK(rating >= 1 AND rating <= 5),
                created_at TEXT DEFAULT (datetime('now')),
                updated_at TEXT DEFAULT (datetime('now')),
                UNIQUE(global_game_id, discord_user_id, platform),
                FOREIGN KEY (global_game_id) REFERENCES global_games (id) ON DELETE CASCADE
            );
            INSERT INTO global_game_ratings_new (id, global_game_id, discord_user_id, platform, rating, created_at, updated_at)
              SELECT id, global_game_id, discord_user_id, '', rating, created_at, updated_at FROM global_game_ratings;
        `);
        const before = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_game_ratings`);
        const after = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM global_game_ratings_new`);
        if ((before?.n ?? 0) !== (after?.n ?? 0)) {
            throw new Error(`205_ratings_unified_per_platform: copy short (${after?.n} of ${before?.n} rows)`);
        }
        await db.exec(`
            DROP TABLE global_game_ratings;
            ALTER TABLE global_game_ratings_new RENAME TO global_game_ratings;
        `);
        if (seq?.seq) {
            await db.run(`DELETE FROM sqlite_sequence WHERE name = 'global_game_ratings'`);
            await db.run(`INSERT INTO sqlite_sequence (name, seq) VALUES ('global_game_ratings', ?)`, seq.seq);
        }
    }
    await db.exec(`CREATE INDEX IF NOT EXISTS idx_global_game_ratings_user ON global_game_ratings(discord_user_id)`);

    // --- Step 2: fold room ratings of catalogue tables ----------------------
    await db.exec(`
        DROP TABLE IF EXISTS _rating_name_map;
        CREATE TEMP TABLE _rating_name_map AS
          SELECT LOWER(name) AS lname, MIN(id) AS id FROM global_games WHERE status = 'approved'
          GROUP BY LOWER(name) HAVING COUNT(*) = 1;
    `);
    const toFold = await db.get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM game_ratings gr JOIN _rating_name_map m ON m.lname = LOWER(gr.game_name)`,
    );
    // "WHERE true" keeps SQLite from parsing the upsert's ON CONFLICT as part
    // of the join (its documented INSERT ... SELECT ... ON CONFLICT ambiguity).
    await db.exec(`
        INSERT INTO global_game_ratings (global_game_id, discord_user_id, platform, rating, created_at, updated_at)
          SELECT m.id, gr.user_id, '', gr.rating, gr.created_at, gr.updated_at
            FROM game_ratings gr JOIN _rating_name_map m ON m.lname = LOWER(gr.game_name)
           WHERE true
           ORDER BY gr.updated_at ASC
        ON CONFLICT(global_game_id, discord_user_id, platform) DO UPDATE SET
          rating = excluded.rating, updated_at = excluded.updated_at
          WHERE excluded.updated_at > global_game_ratings.updated_at;
        DELETE FROM game_ratings WHERE LOWER(game_name) IN (SELECT lname FROM _rating_name_map);
        DROP TABLE _rating_name_map;
    `);
    const kept = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM game_ratings`);
    logInfo(`205_ratings_unified_per_platform: folded ${toFold?.n ?? 0} room rating(s) into the catalogue store; kept ${kept?.n ?? 0} room-only rating(s)`);
}
