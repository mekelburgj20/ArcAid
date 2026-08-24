import { logInfo, logWarn } from '../../utils/logger.js';

/**
 * Migration 164 — make `score_history.game_room_id` NULLABLE (v2.136.0, ADR 0018).
 *
 * ## Why
 *
 * A **Throwdown** is a player-created challenge with no game room at all: two
 * clicks, a shareable link, no room created anywhere. An earlier design gave
 * every player a hidden "personal room" instead; that was rejected because
 * personal rooms eat the flat public slug namespace, make the share link read
 * as somebody's room URL, and give every room-scoped feature an "except
 * personal rooms" caveat that compounds forever.
 *
 * Going genuinely room-less turned out to cost exactly one column. Verified
 * against the schema: `tournaments.game_room_id`, `games.game_room_id` and
 * `submissions` already tolerate a null room. `score_history.game_room_id` was
 * the only blocker — and `community_scores` is avoidable, because a Throwdown
 * writes `score_history` alone (which is the physical union every read path
 * uses anyway).
 *
 * ## Why this is the careful one
 *
 * `score_history` is the hottest table in the app. SQLite cannot drop a NOT
 * NULL constraint in place, so this is a create-copy-drop-rename. Notes:
 *
 * - **This is a `handler`, deliberately not a `sql:` entry.** The migration
 *   loop wraps `sql:` in a try/catch that SWALLOWS errors; a handler's error
 *   propagates and halts startup. CLAUDE.md already warns that a swallowed
 *   migration-077 `INSERT…SELECT` would half-migrate a legacy DB. Here that
 *   would mean silently losing scores, so failing loudly is the only safe mode.
 * - **The new table is built by TRANSFORMING the stored CREATE TABLE**, not by
 *   hand-writing a column list. `score_history` has grown ~10 columns by ALTER
 *   over its life, and migration 077 (the closest precedent) hardcoded its
 *   list — repeating that here risks quietly dropping whichever column was
 *   added last. SQLite rewrites `sqlite_master.sql` on ALTER ADD COLUMN, so the
 *   stored definition is always current.
 * - **The FK is kept.** Only `NOT NULL` goes. SQLite does not enforce a foreign
 *   key on a NULL value, so room-scoped rows keep their `ON DELETE CASCADE` and
 *   Throwdown rows simply carry NULL.
 * - **Row counts are asserted BEFORE the DROP.** A short copy must never reach
 *   the point where the original is gone.
 * - **Indexes are replayed from `sqlite_master`**, not from a hardcoded list, so
 *   an index added after this migration was written still survives.
 * - **The AUTOINCREMENT high-water mark is restored.** `DROP TABLE` deletes the
 *   table's `sqlite_sequence` row, so the rebuilt table would resume numbering
 *   from `MAX(id)` and REUSE ids of deleted rows — breaking the never-reuse
 *   guarantee AUTOINCREMENT exists to give. `score_history.id` addresses the
 *   per-row score-delete endpoint, so a reused id means a stale request can
 *   delete a different score. Caught by a test; do not remove the restore.
 *
 * The migration loop runs before `PRAGMA foreign_keys = ON`, which a table
 * rebuild requires — see `initDatabase`.
 */

type Db = {
    exec(sql: string): Promise<unknown>;
    get<T>(sql: string, ...params: unknown[]): Promise<T | undefined>;
    all<T>(sql: string, ...params: unknown[]): Promise<T>;
    run(sql: string, ...params: unknown[]): Promise<unknown>;
};

const TABLE = 'score_history';

export async function scoreHistoryRoomNullable(db: Db): Promise<void> {
    const table = await db.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLE,
    );
    if (!table?.sql) {
        // A brand-new database creates the table from the current schema in
        // `initDatabase`, which already declares the column nullable.
        logInfo(`Migration 164: ${TABLE} not present yet — nothing to rebuild.`);
        return;
    }

    // Tolerate whitespace variation, but require exactly one match so a schema
    // that has drifted fails loudly instead of being half-transformed.
    const notNullPattern = /game_room_id\s+TEXT\s+NOT\s+NULL/gi;
    const matches = table.sql.match(notNullPattern) ?? [];
    if (matches.length === 0) {
        logInfo(`Migration 164: ${TABLE}.game_room_id is already nullable.`);
        return;
    }
    if (matches.length > 1) {
        throw new Error(
            `Migration 164: expected one 'game_room_id TEXT NOT NULL' in ${TABLE}, found ${matches.length}. Refusing to rebuild.`,
        );
    }

    const columns = (await db.all<Array<{ name: string }>>(`PRAGMA table_info(${TABLE})`)).map(c => c.name);
    if (columns.length === 0) throw new Error(`Migration 164: ${TABLE} reported no columns.`);
    const columnList = columns.map(c => `"${c}"`).join(', ');

    const before = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    const beforeCount = before?.n ?? 0;

    // Capture index definitions before the drop takes them with it. Indexes
    // SQLite created implicitly (UNIQUE constraints) have a NULL `sql` and come
    // back automatically with the table definition, so they are skipped.
    const indexes = await db.all<Array<{ sql: string }>>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, TABLE,
    );

    // The AUTOINCREMENT high-water mark, which the DROP below would take with
    // it. `sqlite_sequence` only exists once some table uses AUTOINCREMENT.
    const hasSequence = await db.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
    );
    const sequence = hasSequence
        ? await db.get<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = ?`, TABLE)
        : undefined;

    const newTableSql = table.sql
        .replace(notNullPattern, 'game_room_id TEXT')
        .replace(new RegExp(`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)["\`\\[]?${TABLE}["\`\\]]?`, 'i'),
            `$1${TABLE}_new`);
    if (!/score_history_new/i.test(newTableSql)) {
        throw new Error('Migration 164: could not rename the table in its CREATE statement. Refusing to rebuild.');
    }

    logInfo(`Migration 164: rebuilding ${TABLE} (${beforeCount} rows) to allow a NULL game_room_id…`);

    await db.exec('BEGIN');
    try {
        await db.exec(newTableSql);
        await db.exec(`INSERT INTO ${TABLE}_new (${columnList}) SELECT ${columnList} FROM ${TABLE}`);

        const after = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE}_new`);
        const afterCount = after?.n ?? -1;
        if (afterCount !== beforeCount) {
            // Before the DROP, so the original is still intact when we bail.
            throw new Error(
                `Migration 164: copied ${afterCount} rows but expected ${beforeCount}. Rolling back; ${TABLE} is untouched.`,
            );
        }

        await db.exec(`DROP TABLE ${TABLE}`);
        await db.exec(`ALTER TABLE ${TABLE}_new RENAME TO ${TABLE}`);

        if (sequence?.seq != null) {
            // Restore the counter so ids continue where they left off rather
            // than resuming from MAX(id) and reusing deleted ones.
            // `sqlite_sequence.name` carries no UNIQUE constraint, so upsert
            // syntax is rejected outright — delete then insert is the only way.
            // The rename above already left a row here (from the copy), so the
            // delete is doing real work, not defending against nothing.
            await db.run(`DELETE FROM sqlite_sequence WHERE name = ?`, TABLE);
            await db.run(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, TABLE, sequence.seq);
        }

        for (const index of indexes) {
            try {
                await db.exec(index.sql);
            } catch (err) {
                // A single index failing to replay is bad for performance but
                // not for correctness, and it must not cost us the rebuild.
                logWarn(`Migration 164: could not recreate an index on ${TABLE}: ${index.sql}`, err);
            }
        }

        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }

    logInfo(`Migration 164: ${TABLE} rebuilt, ${beforeCount} rows preserved, ${indexes.length} index(es) replayed.`);
}
