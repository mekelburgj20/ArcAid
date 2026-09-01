import { logInfo, logWarn } from '../../utils/logger.js';

/**
 * The create-copy-drop-rename that widens `score_history.source`.
 *
 * Extracted from migration 167 when migration 172 needed the same surgery for
 * `'vpx'`. SQLite cannot alter a CHECK constraint in place, and `score_history`
 * is the hottest table in the app, so every safeguard 167 earned is kept here
 * and is now shared rather than copied:
 *
 * - **A `handler`, deliberately not a `sql:` entry** — the migration loop
 *   swallows `sql:` errors, and a half-copied score table must halt startup
 *   rather than be skipped.
 * - **The new table is built by TRANSFORMING the stored CREATE TABLE**, never
 *   from a hand-written column list, so a column added by a later ALTER cannot
 *   be silently dropped.
 * - **Row counts are asserted BEFORE the DROP**, so a short copy never reaches
 *   the point where the original is gone.
 * - **Indexes are replayed from `sqlite_master`** rather than a hardcoded list.
 * - **The AUTOINCREMENT high-water mark is restored** — `score_history.id`
 *   addresses the per-row delete endpoint, so a reused id would let a stale
 *   request delete a different score. Caught by a test; do not remove.
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

export async function rebuildScoreHistorySource(db: Db, options: {
    /** Log prefix, e.g. `'Migration 172'`. */
    label: string;
    /** The value being added — also the idempotency probe. */
    newValue: string;
    /** The COMPLETE list the rewritten CHECK should accept, in order. */
    values: string[];
}): Promise<void> {
    const { label, newValue, values } = options;
    const newCheck = `CHECK(source IN (${values.map(v => `'${v}'`).join(', ')}))`;

    const table = await db.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLE,
    );
    if (!table?.sql) {
        // A brand-new database creates the table from the current schema in
        // `initDatabase`, which already lists every value.
        logInfo(`${label}: ${TABLE} not present yet — nothing to rebuild.`);
        return;
    }

    if (new RegExp(`source\\s+IN\\s*\\([^)]*'${newValue}'`, 'i').test(table.sql)) {
        logInfo(`${label}: ${TABLE}.source already accepts '${newValue}'.`);
        return;
    }

    // Tolerate whitespace and quoting variation, but require exactly one match
    // so a schema that has drifted fails loudly instead of half-transforming.
    const checkPattern = /CHECK\s*\(\s*source\s+IN\s*\([^)]*\)\s*\)/gi;
    const matches = table.sql.match(checkPattern) ?? [];
    if (matches.length === 0) {
        // No CHECK to widen: the column already accepts anything, so the new
        // value inserts fine and there is nothing to rebuild.
        logWarn(`${label}: ${TABLE}.source carries no CHECK constraint — leaving the table alone.`);
        return;
    }
    if (matches.length > 1) {
        throw new Error(
            `${label}: expected one source CHECK in ${TABLE}, found ${matches.length}. Refusing to rebuild.`,
        );
    }

    const columns = (await db.all<Array<{ name: string }>>(`PRAGMA table_info(${TABLE})`)).map(c => c.name);
    if (columns.length === 0) throw new Error(`${label}: ${TABLE} reported no columns.`);
    const columnList = columns.map(c => `"${c}"`).join(', ');

    const before = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE}`);
    const beforeCount = before?.n ?? 0;

    // Capture index definitions before the drop takes them with it. Implicit
    // indexes (UNIQUE constraints) have a NULL `sql` and return with the table.
    const indexes = await db.all<Array<{ sql: string }>>(
        `SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, TABLE,
    );

    const hasSequence = await db.get<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sqlite_sequence'`,
    );
    const sequence = hasSequence
        ? await db.get<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = ?`, TABLE)
        : undefined;

    const newTableSql = table.sql
        .replace(checkPattern, newCheck)
        .replace(new RegExp(`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)["\`\\[]?${TABLE}["\`\\]]?`, 'i'),
            `$1${TABLE}_new`);
    if (!/score_history_new/i.test(newTableSql)) {
        throw new Error(`${label}: could not rename the table in its CREATE statement. Refusing to rebuild.`);
    }
    if (!new RegExp(`'${newValue}'`, 'i').test(newTableSql)) {
        throw new Error(`${label}: the rewritten CHECK does not mention ${newValue}. Refusing to rebuild.`);
    }

    logInfo(`${label}: rebuilding ${TABLE} (${beforeCount} rows) to accept source='${newValue}'…`);

    await db.exec('BEGIN');
    try {
        await db.exec(newTableSql);
        await db.exec(`INSERT INTO ${TABLE}_new (${columnList}) SELECT ${columnList} FROM ${TABLE}`);

        const after = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE}_new`);
        const afterCount = after?.n ?? -1;
        if (afterCount !== beforeCount) {
            // Before the DROP, so the original is still intact when we bail.
            throw new Error(
                `${label}: copied ${afterCount} rows but expected ${beforeCount}. Rolling back; ${TABLE} is untouched.`,
            );
        }

        await db.exec(`DROP TABLE ${TABLE}`);
        await db.exec(`ALTER TABLE ${TABLE}_new RENAME TO ${TABLE}`);

        if (sequence?.seq != null) {
            // `sqlite_sequence.name` carries no UNIQUE constraint, so upsert
            // syntax is rejected — delete then insert is the only way.
            await db.run(`DELETE FROM sqlite_sequence WHERE name = ?`, TABLE);
            await db.run(`INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`, TABLE, sequence.seq);
        }

        for (const index of indexes) {
            try {
                await db.exec(index.sql);
            } catch (err) {
                // A single index failing to replay costs performance, not
                // correctness, and must not cost us the rebuild.
                logWarn(`${label}: could not recreate an index on ${TABLE}: ${index.sql}`, err);
            }
        }

        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }

    logInfo(`${label}: ${TABLE} rebuilt, ${beforeCount} rows preserved, ${indexes.length} index(es) replayed.`);
}
