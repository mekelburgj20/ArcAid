import type { Database } from 'sqlite';
import { logInfo } from '../../utils/logger.js';

/**
 * Migration 131 — give `sync_logs` a real lifecycle plus resume state.
 *
 * Background (igdb-import-hardening, 2026-08). `SyncLogService.start` inserted
 * the row with `status = 'success'` and left it that way until `complete`
 * overwrote it, so a job that was still working — or one that died mid-run —
 * was indistinguishable from a clean finish. Every catalogue sync shared that
 * defect; the IGDB bulk seed is where it hurt, because that run takes hours
 * and had never survived to `complete`.
 *
 * Columns added:
 *   heartbeat_at       ISO timestamp bumped once per page. A `running` row
 *                      whose heartbeat has gone quiet is how both the startup
 *                      sweep and the single-flight guard tell "still working"
 *                      from "the process died".
 *   pages_done         Pages completed so far (progress numerator).
 *   records_fetched    Rows pulled from the source so far. Distinct from
 *                      imported/updated/skipped, which describe what the
 *                      catalogue did with them.
 *   expected_total     Denominator, taken from the source's own count endpoint
 *                      at run start. A run finishing well short of it is
 *                      `partial`, not `success`.
 *   last_id            Keyset cursor — the highest source id consumed. Resume
 *                      continues at `id > last_id`.
 *   target_fingerprint Identifies the query the checkpoint belongs to. A
 *                      checkpoint is only resumable while the filter that
 *                      produced it is unchanged; widening the platform scope
 *                      invalidates it rather than silently skipping the new
 *                      range (whose ids sort below the cursor).
 *
 * Checkpoint state lives on the job row rather than in a separate
 * `import_checkpoints` table on purpose: its lifetime is exactly the job's
 * lifetime, and a second table would need reconciling with `sync_logs`
 * anyway — two rows that can disagree about the same run.
 *
 * Idempotent: every ADD COLUMN is pragma-guarded.
 */
const COLUMNS: Array<{ name: string; ddl: string }> = [
    { name: 'heartbeat_at', ddl: 'heartbeat_at TEXT' },
    { name: 'pages_done', ddl: 'pages_done INTEGER DEFAULT 0' },
    { name: 'records_fetched', ddl: 'records_fetched INTEGER DEFAULT 0' },
    { name: 'expected_total', ddl: 'expected_total INTEGER' },
    { name: 'last_id', ddl: 'last_id INTEGER' },
    { name: 'target_fingerprint', ddl: 'target_fingerprint TEXT' },
];

export async function addSyncLogProgressColumns(db: Database): Promise<void> {
    const existing = await db.all<Array<{ name: string }>>(`PRAGMA table_info(sync_logs)`);
    const have = new Set(existing.map(c => c.name));

    const added: string[] = [];
    for (const col of COLUMNS) {
        if (have.has(col.name)) continue;
        await db.exec(`ALTER TABLE sync_logs ADD COLUMN ${col.ddl}`);
        added.push(col.name);
    }

    // Partial index over the live rows only — the sweep and the single-flight
    // guard both ask "is there a running job for this source?", and that set is
    // tiny next to the full sync history.
    await db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sync_logs_running
             ON sync_logs(source, heartbeat_at) WHERE status = 'running'`,
    );

    logInfo(
        added.length > 0
            ? `[migration] 131: added sync_logs columns ${added.join(', ')}`
            : '[migration] 131: sync_logs progress columns already present',
    );
}
