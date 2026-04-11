import crypto from 'crypto';
import { getDatabase } from '../database/database.js';
import { sendChannelMessage } from '../utils/discord.js';
import { logError, logInfo } from '../utils/logger.js';

export interface SyncLogEntry {
    id: string;
    source: string;
    status: 'success' | 'error' | 'partial';
    records_imported: number;
    records_updated: number;
    records_skipped: number;
    errors: string | null;
    started_at: string;
    completed_at: string | null;
}

export class SyncLogService {
    /**
     * Starts a sync log entry. Returns the log ID for later completion.
     */
    static async start(source: string): Promise<string> {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        const startedAt = new Date().toISOString();
        await db.run(
            `INSERT INTO sync_logs (id, source, status, started_at) VALUES (?, ?, 'success', ?)`,
            id, source, startedAt
        );
        return id;
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
                errors = ?,
                completed_at = ?
             WHERE id = ?`,
            result.status,
            result.records_imported ?? 0,
            result.records_updated ?? 0,
            result.records_skipped ?? 0,
            result.errors?.length ? JSON.stringify(result.errors) : null,
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
