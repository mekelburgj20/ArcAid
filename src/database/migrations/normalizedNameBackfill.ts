import type { Database } from 'sqlite';
import { normalizeGameName } from '../../utils/catalogueUtils.js';
import { logInfo } from '../../utils/logger.js';

/**
 * Migration 130 — persist `global_games.normalized_name` and index it.
 *
 * Background (igdb-import-hardening, 2026-08). Step 4 of the catalogue dedup
 * hierarchy (ADR 0004) matched on the JS-normalized game name. The only way to
 * do that was `SELECT * FROM global_games` and normalize every row in JS —
 * v2.4.12 dropped a SQL `LIKE` prefilter because punctuation broke it, and the
 * comment at the time reasoned "at ~5k rows this is milliseconds."
 *
 * That reasoning does not survive a bulk import. `GlobalGameService.upsert`
 * calls the walk once per row, so a run of N games over a catalogue of M rows
 * is O(N×M) full-table scans — and each scan is `SELECT *`, hydrating every
 * column of every row. The IGDB bulk seed (tens of thousands of games) is the
 * case that made it fatal: it has never once completed.
 *
 * The fix is mechanical, not semantic. `normalizeGameName` is deterministic
 * and depends on nothing but the name string, so its result can simply be
 * stored alongside the name and indexed. The dedup HIERARCHY — concrete vs.
 * loose tiers, cross-type guard, external-id conflict rules, tie-breaks — is
 * untouched; only the candidate LOOKUP changes from a scan to an index seek.
 *
 * Rows written before this migration (and any raw INSERT that bypasses
 * `GlobalGameService`) leave the column NULL; `findByNormalizedName` keeps
 * scanning exactly those, so correctness never depends on the backfill having
 * reached a given row. The backfill just makes that residual set empty.
 *
 * Idempotent: the ADD COLUMN is pragma-guarded, the index is IF NOT EXISTS,
 * and the backfill only touches `normalized_name IS NULL`. A name that
 * normalizes to nothing is stored as `''`, not NULL, so it is not rescanned
 * on every subsequent run.
 */
export async function backfillNormalizedNames(db: Database): Promise<void> {
    const columns = await db.all<Array<{ name: string }>>(
        `PRAGMA table_info(global_games)`,
    );
    if (!columns.some(c => c.name === 'normalized_name')) {
        await db.exec(`ALTER TABLE global_games ADD COLUMN normalized_name TEXT`);
        logInfo('[migration] 130: added global_games.normalized_name');
    }

    await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_global_games_normalized_name
             ON global_games(normalized_name)`,
    );

    const pending = await db.all<Array<{ id: string; name: string }>>(
        `SELECT id, name FROM global_games WHERE normalized_name IS NULL`,
    );

    if (pending.length === 0) {
        logInfo('[migration] 130: normalized_name already populated for every row (0 backfilled)');
        return;
    }

    let written = 0;
    let empty = 0;
    await db.exec('BEGIN TRANSACTION');
    try {
        for (const row of pending) {
            const normalized = normalizeGameName(row.name || '');
            if (!normalized) empty++;
            await db.run(
                `UPDATE global_games SET normalized_name = ? WHERE id = ?`,
                normalized, row.id,
            );
            written++;
        }
        await db.exec('COMMIT');
    } catch (err) {
        await db.exec('ROLLBACK');
        throw err;
    }

    const distinct = await db.get<{ n: number }>(
        `SELECT COUNT(DISTINCT normalized_name) AS n FROM global_games WHERE normalized_name != ''`,
    );
    logInfo(
        `[migration] 130: backfilled normalized_name for ${written} row(s) ` +
        `(${empty} normalized to empty, ${distinct?.n ?? 0} distinct keys)`,
    );
}
