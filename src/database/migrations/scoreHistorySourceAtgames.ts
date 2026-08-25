import { logInfo, logWarn } from '../../utils/logger.js';

/**
 * Migration 167 — widen `score_history.source` to accept `'atgames'` (P7).
 *
 * ## Why a fourth source at all
 *
 * An AtGames score is not any of the three we already have. It is not
 * `'tournament'` (Arcaid never saw the submit — it arrived from a third-party
 * API), not `'community'` (it happened inside a tournament window and counts
 * for standings), and not `'sync'` (that value means iScored, and doctrine
 * forces `engine`/`device` to `'unknown'` for it per ADR 0016 P2, whereas an
 * AtGames row carries KNOWN provenance: the cabinet model is in the payload).
 *
 * Reusing any of the three would make provenance unrecoverable afterwards —
 * "which of these tournament rows did we actually witness?" is a question the
 * trust model has to be able to answer, and a shared source value erases it.
 * S23.4 chose `'community'` for CSV backfills specifically to avoid this
 * rebuild; that was the right call there because those rows have no tournament
 * linkage. These do.
 *
 * ## Why this is the careful one
 *
 * `score_history` is the hottest table in the app and SQLite cannot alter a
 * CHECK constraint in place, so this is a create-copy-drop-rename. It follows
 * migration 164 (`scoreHistoryRoomNullable`) step for step, and for the same
 * reasons:
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
const NEW_CHECK = `CHECK(source IN ('tournament', 'community', 'sync', 'atgames'))`;

export async function scoreHistorySourceAtgames(db: Db): Promise<void> {
    const table = await db.get<{ sql: string }>(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, TABLE,
    );
    if (!table?.sql) {
        // A brand-new database creates the table from the current schema in
        // `initDatabase`, which already lists the four values.
        logInfo(`Migration 167: ${TABLE} not present yet — nothing to rebuild.`);
        return;
    }

    if (/source\s+IN\s*\([^)]*'atgames'/i.test(table.sql)) {
        logInfo(`Migration 167: ${TABLE}.source already accepts 'atgames'.`);
        return;
    }

    // Tolerate whitespace and quoting variation, but require exactly one match
    // so a schema that has drifted fails loudly instead of half-transforming.
    const checkPattern = /CHECK\s*\(\s*source\s+IN\s*\([^)]*\)\s*\)/gi;
    const matches = table.sql.match(checkPattern) ?? [];
    if (matches.length === 0) {
        // No CHECK to widen: the column already accepts anything, so
        // `'atgames'` inserts fine and there is nothing to rebuild.
        logWarn(`Migration 167: ${TABLE}.source carries no CHECK constraint — leaving the table alone.`);
        return;
    }
    if (matches.length > 1) {
        throw new Error(
            `Migration 167: expected one source CHECK in ${TABLE}, found ${matches.length}. Refusing to rebuild.`,
        );
    }

    const columns = (await db.all<Array<{ name: string }>>(`PRAGMA table_info(${TABLE})`)).map(c => c.name);
    if (columns.length === 0) throw new Error(`Migration 167: ${TABLE} reported no columns.`);
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
        .replace(checkPattern, NEW_CHECK)
        .replace(new RegExp(`(CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)["\`\\[]?${TABLE}["\`\\]]?`, 'i'),
            `$1${TABLE}_new`);
    if (!/score_history_new/i.test(newTableSql)) {
        throw new Error('Migration 167: could not rename the table in its CREATE statement. Refusing to rebuild.');
    }
    if (!/'atgames'/i.test(newTableSql)) {
        throw new Error('Migration 167: the rewritten CHECK does not mention atgames. Refusing to rebuild.');
    }

    logInfo(`Migration 167: rebuilding ${TABLE} (${beforeCount} rows) to accept source='atgames'…`);

    await db.exec('BEGIN');
    try {
        await db.exec(newTableSql);
        await db.exec(`INSERT INTO ${TABLE}_new (${columnList}) SELECT ${columnList} FROM ${TABLE}`);

        const after = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM ${TABLE}_new`);
        const afterCount = after?.n ?? -1;
        if (afterCount !== beforeCount) {
            // Before the DROP, so the original is still intact when we bail.
            throw new Error(
                `Migration 167: copied ${afterCount} rows but expected ${beforeCount}. Rolling back; ${TABLE} is untouched.`,
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
                logWarn(`Migration 167: could not recreate an index on ${TABLE}: ${index.sql}`, err);
            }
        }

        await db.exec('COMMIT');
    } catch (error) {
        await db.exec('ROLLBACK').catch(() => {});
        throw error;
    }

    logInfo(`Migration 167: ${TABLE} rebuilt, ${beforeCount} rows preserved, ${indexes.length} index(es) replayed.`);
}
