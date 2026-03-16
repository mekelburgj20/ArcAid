import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

export interface AuditEntry {
    id?: number;
    actor: string;
    action: string;
    target_type: string;
    target_id: string;
    details: string;
    ip_address: string;
    correlation_id: string;
    created_at?: string;
}

export class AuditService {
    /**
     * Log an admin action to the audit_log table.
     */
    static async log(entry: Omit<AuditEntry, 'id' | 'created_at'>): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO audit_log (actor, action, target_type, target_id, details, ip_address, correlation_id)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            entry.actor, entry.action, entry.target_type, entry.target_id,
            entry.details, entry.ip_address, entry.correlation_id
        );
        logInfo(`[AUDIT] ${entry.actor} ${entry.action} ${entry.target_type}/${entry.target_id}`);
    }

    /**
     * Query recent audit log entries.
     */
    static async getRecent(limit: number = 100, offset: number = 0): Promise<AuditEntry[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?`,
            limit, offset
        );
    }

    /**
     * Query audit log entries by actor.
     */
    static async getByActor(actor: string, limit: number = 50): Promise<AuditEntry[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM audit_log WHERE actor = ? ORDER BY created_at DESC LIMIT ?`,
            actor, limit
        );
    }

    /**
     * Query audit log entries by target.
     */
    static async getByTarget(targetType: string, targetId: string, limit: number = 50): Promise<AuditEntry[]> {
        const db = await getDatabase();
        return db.all(
            `SELECT * FROM audit_log WHERE target_type = ? AND target_id = ? ORDER BY created_at DESC LIMIT ?`,
            targetType, targetId, limit
        );
    }

    /**
     * Delete audit entries older than the given number of days.
     */
    static async cleanup(retentionDays: number = 90): Promise<number> {
        const db = await getDatabase();
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - retentionDays);
        const result = await db.run(
            `DELETE FROM audit_log WHERE created_at < ?`,
            cutoff.toISOString()
        );
        return result.changes || 0;
    }
}
