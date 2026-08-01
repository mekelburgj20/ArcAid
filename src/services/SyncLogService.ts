import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { sendChannelMessage } from '../utils/discord.js';
import { logError, logInfo } from '../utils/logger.js';

export type SyncLogStatus = 'running' | 'success' | 'error' | 'partial' | 'interrupted';

export interface SyncLogEntry {
    id: string;
    source: string;
    status: SyncLogStatus;
    records_imported: number;
    records_updated: number;
    records_skipped: number;
    errors: string | null;
    started_at: string;
    completed_at: string | null;
    /** Bumped once per page while the job works — see SYNC_STALE_MS. */
    heartbeat_at?: string | null;
    pages_done?: number | null;
    records_fetched?: number | null;
    /** Denominator from the source's own count endpoint, taken at run start. */
    expected_total?: number | null;
    /** Keyset cursor: highest source id consumed so far. */
    last_id?: number | null;
    /** Identifies the query this checkpoint belongs to. */
    target_fingerprint?: string | null;
}

/** Resume state carried forward from an interrupted run. */
export interface SyncCheckpoint {
    syncLogId: string;
    lastId: number;
    pagesDone: number;
    recordsFetched: number;
    imported: number;
    updated: number;
    skipped: number;
    expectedTotal: number | null;
}

/**
 * How long a `running` row may go without a heartbeat before it is presumed
 * dead. Generous relative to the per-page cadence: a page is one API call plus
 * up to 500 upserts, so minutes of silence is a stall, not normal pacing.
 */
export const SYNC_STALE_MS = 10 * 60 * 1000;

export class SyncLogService {
    /**
     * Starts a sync log entry. Returns the log ID for later completion.
     *
     * igdb-import-hardening (2026-08): this used to INSERT with
     * `status = 'success'`, so a job that was still working — or one whose
     * process died mid-run — was indistinguishable from a clean finish. Rows
     * now open as `running` and only reach a terminal status via `complete`
     * or the startup sweep.
     */
    static async start(
        source: string,
        opts?: {
            expectedTotal?: number | null;
            targetFingerprint?: string | null;
            /** Seeds counters + cursor when continuing an interrupted run. */
            resumeFrom?: SyncCheckpoint | null;
        },
    ): Promise<string> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        const resume = opts?.resumeFrom ?? null;
        await db.run(
            `INSERT INTO sync_logs (
                id, source, status, started_at, heartbeat_at,
                records_imported, records_updated, records_skipped,
                pages_done, records_fetched, expected_total, last_id, target_fingerprint
             ) VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            id, source, startedAt, startedAt,
            resume?.imported ?? 0, resume?.updated ?? 0, resume?.skipped ?? 0,
            resume?.pagesDone ?? 0, resume?.recordsFetched ?? 0,
            opts?.expectedTotal ?? resume?.expectedTotal ?? null,
            resume?.lastId ?? null,
            opts?.targetFingerprint ?? null,
        );
        return id;
    }

    /**
     * Records per-page progress and bumps the heartbeat. This IS the
     * checkpoint write: after it returns, a crash resumes from `lastId`
     * with these counters rather than starting over.
     */
    static async recordProgress(
        id: string,
        progress: {
            lastId?: number | null;
            pagesDone?: number;
            recordsFetched?: number;
            imported?: number;
            updated?: number;
            skipped?: number;
            expectedTotal?: number | null;
        },
    ): Promise<void> {
        const db = await getDatabase();
        const sets: string[] = ['heartbeat_at = ?'];
        const params: unknown[] = [new Date().toISOString()];

        const map: Array<[string, unknown]> = [
            ['last_id', progress.lastId],
            ['pages_done', progress.pagesDone],
            ['records_fetched', progress.recordsFetched],
            ['records_imported', progress.imported],
            ['records_updated', progress.updated],
            ['records_skipped', progress.skipped],
            ['expected_total', progress.expectedTotal],
        ];
        for (const [col, value] of map) {
            if (value === undefined) continue;
            sets.push(`${col} = ?`);
            params.push(value);
        }

        params.push(id);
        await db.run(`UPDATE sync_logs SET ${sets.join(', ')} WHERE id = ?`, ...params);
    }

    /**
     * The currently-live run for a source, or undefined. "Live" means status
     * `running` AND a heartbeat inside SYNC_STALE_MS — a `running` row from a
     * process that died is not live, and must not block a new run forever.
     * Backs the single-flight guard on the sync endpoints.
     */
    static async getActiveRun(source: string, staleMs = SYNC_STALE_MS): Promise<SyncLogEntry | undefined> {
        const db = await getDatabase();
        const cutoff = new Date(Date.now() - staleMs).toISOString();
        return db.get(
            `SELECT * FROM sync_logs
              WHERE source = ? AND status = 'running'
                AND heartbeat_at IS NOT NULL AND heartbeat_at >= ?
              ORDER BY started_at DESC LIMIT 1`,
            source, cutoff,
        );
    }

    /**
     * The most recent resumable checkpoint for a source, or null.
     *
     * Deliberately examines only the LATEST run for the source, then asks
     * whether that one is resumable — rather than searching back for the most
     * recent resumable row. Otherwise a completed run would not retire the
     * checkpoint left by an older failed one, and every subsequent sync would
     * resume from a cursor that has since been crawled past.
     *
     * Resumable statuses:
     *   interrupted  swept at boot — the process died mid-run
     *   error        threw (e.g. the retry budget ran out); the cursor is
     *                still good, which is the entire point of checkpointing
     *   partial      finished short of the expected total and said so
     *   running      only when the heartbeat has gone quiet; a live run is
     *                not resumable, it is still going
     * `success` is terminal: there is nothing left to pick up.
     *
     * The run must also have a cursor, and its `target_fingerprint` must match
     * the query we are about to issue. That check is not bookkeeping — a
     * keyset cursor is only meaningful against the filter that produced it, so
     * widening the platform scope must invalidate the checkpoint rather than
     * silently skip the newly-included ids that sort below the cursor.
     */
    static async findResumable(
        source: string,
        targetFingerprint: string,
        staleMs = SYNC_STALE_MS,
    ): Promise<SyncCheckpoint | null> {
        const db = await getDatabase();
        const cutoff = new Date(Date.now() - staleMs).toISOString();
        const row = await db.get<SyncLogEntry>(
            `SELECT * FROM sync_logs WHERE source = ? ORDER BY started_at DESC LIMIT 1`,
            source,
        );
        if (!row) return null;
        if (row.last_id == null) return null;

        const resumable =
            row.status === 'interrupted' ||
            row.status === 'error' ||
            row.status === 'partial' ||
            (row.status === 'running' && (!row.heartbeat_at || row.heartbeat_at < cutoff));
        if (!resumable) return null;
        if ((row.target_fingerprint ?? '') !== targetFingerprint) {
            logInfo(
                `Sync resume declined for ${source}: checkpoint was taken against a different ` +
                `query (stored="${row.target_fingerprint ?? ''}", current="${targetFingerprint}"). Starting fresh.`,
            );
            return null;
        }
        return {
            syncLogId: row.id,
            lastId: row.last_id!,
            pagesDone: row.pages_done ?? 0,
            recordsFetched: row.records_fetched ?? 0,
            imported: row.records_imported ?? 0,
            updated: row.records_updated ?? 0,
            skipped: row.records_skipped ?? 0,
            expectedTotal: row.expected_total ?? null,
        };
    }

    /**
     * Startup sweep: any `running` row left behind by a process that exited
     * (deploy, crash, OOM) is marked `interrupted`. Without this a dead row
     * stays `running` forever, the admin UI reports a phantom in-flight sync,
     * and the resume path has no signal that there is work to pick up.
     *
     * Runs at boot, when by definition nothing of ours is mid-sync — but the
     * heartbeat cutoff is applied anyway so a future caller (a periodic sweep)
     * cannot mistakenly kill a live job.
     */
    static async sweepStaleRunning(staleMs = SYNC_STALE_MS): Promise<number> {
        const db = await getDatabase();
        const cutoff = new Date(Date.now() - staleMs).toISOString();
        const result = await db.run(
            `UPDATE sync_logs
                SET status = 'interrupted', completed_at = ?
              WHERE status = 'running'
                AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
            new Date().toISOString(), cutoff,
        );
        const swept = result.changes ?? 0;
        if (swept > 0) {
            logInfo(`Sync log sweep: marked ${swept} abandoned running sync(s) as interrupted.`);
        }
        return swept;
    }

    /**
     * Completes a sync log entry with results.
     */
    static async complete(
        id: string,
        result: {
            status: 'success' | 'error' | 'partial';
            records_imported?: number;
            records_updated?: number;
            records_skipped?: number;
            records_fetched?: number;
            errors?: string[];
        }
    ): Promise<void> {
        const db = await getDatabase();
        const completedAt = new Date().toISOString();
        await db.run(
            `UPDATE sync_logs SET
                status = ?,
                records_imported = ?,
                records_updated = ?,
                records_skipped = ?,
                records_fetched = COALESCE(?, records_fetched),
                errors = ?,
                completed_at = ?,
                heartbeat_at = ?
             WHERE id = ?`,
            result.status,
            result.records_imported ?? 0,
            result.records_updated ?? 0,
            result.records_skipped ?? 0,
            result.records_fetched ?? null,
            result.errors?.length ? JSON.stringify(result.errors) : null,
            completedAt,
            completedAt,
            id
        );

        // Send Discord alert on failure
        if (result.status === 'error' || result.status === 'partial') {
            await this.sendAlert(id, result.status, result.errors);
        }
    }

    /**
     * Returns the most recent sync log per source.
     */
    static async getLatestPerSource(): Promise<SyncLogEntry[]> {
        const db = await getDatabase();
        return db.all(`
            SELECT s.* FROM sync_logs s
            INNER JOIN (
                SELECT source, MAX(started_at) as max_started
                FROM sync_logs
                GROUP BY source
            ) latest ON s.source = latest.source AND s.started_at = latest.max_started
            ORDER BY s.started_at DESC
        `);
    }

    /**
     * Returns recent sync logs (all sources).
     */
    static async getRecent(limit: number = 20): Promise<SyncLogEntry[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM sync_logs ORDER BY started_at DESC LIMIT ?`,
            limit
        );
    }

    /**
     * Returns sync logs for a specific source.
     */
    static async getBySource(source: string, limit: number = 10): Promise<SyncLogEntry[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM sync_logs WHERE source = ? ORDER BY started_at DESC LIMIT ?`,
            source, limit
        );
    }

    /**
     * Sends a Discord alert to the configured alert channel on sync failure.
     */
    private static async sendAlert(
        logId: string,
        status: string,
        errors?: string[]
    ): Promise<void> {
        try {
            const db = await getDatabase();
            const log = await db.get('SELECT * FROM sync_logs WHERE id = ?', logId) as SyncLogEntry | undefined;
            if (!log) return;

            const channelId = process.env.SYNC_ALERT_CHANNEL_ID;
            if (!channelId) return;

            const errorSummary = errors?.length
                ? `\nErrors:\n${errors.slice(0, 5).map(e => `• ${e}`).join('\n')}${errors.length > 5 ? `\n... and ${errors.length - 5} more` : ''}`
                : '';

            const message = `⚠️ **Catalogue Sync ${status === 'error' ? 'Failed' : 'Partial'}** — \`${log.source}\`\n` +
                `Imported: ${log.records_imported} | Updated: ${log.records_updated} | Skipped: ${log.records_skipped}` +
                errorSummary;

            await sendChannelMessage(channelId, message);
            logInfo(`Sync alert sent for ${log.source} (${status})`);
        } catch (err) {
            logError('Failed to send sync alert:', err);
        }
    }
}
