import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import {
    CalloutAction,
    CalloutEntry,
    isCalloutAction,
    validateCalloutEntries,
} from '../utils/callouts.js';

/** A stored callout, as the admin API returns it. */
export interface CalloutRow {
    id: number;
    triggers: string[];
    responses: string[];
    /** Built-in live-data responder; null for ordinary static entries. */
    action: CalloutAction | null;
    enabled: boolean;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

/** Thrown by `replaceAll`/`update` on a shape violation. Routes map it to 400. */
export class CalloutValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CalloutValidationError';
    }
}

interface DbCalloutRow {
    id: number;
    triggers: string;
    responses: string;
    action: string | null;
    enabled: number;
    sort_order: number;
    created_at: string;
    updated_at: string;
}

/**
 * Global (not per-room) callout list — the super admin uploads it once under
 * Admin → Settings → Callouts and every room that opts in via its
 * `CALLOUTS_ENABLED` setting draws from it.
 *
 * THE CACHE IS LOAD-BEARING. The Discord MessageCreate handler runs for every
 * message in every guild the bot can read; before v2.123.0 that path did a
 * `readFileSync` + `JSON.parse` per message. `getEnabledCached` keeps the
 * enabled subset in memory and every write path here drops it, so the handler
 * touches neither disk nor DB in the steady state. Any new write path MUST
 * call `invalidateCache()`.
 */
export class CalloutService {
    private static cache: CalloutEntry[] | null = null;

    /** Drops the in-memory cache. Call after ANY mutation of the table. */
    static invalidateCache(): void {
        CalloutService.cache = null;
    }

    /** Enabled entries in match order, memoized. Used by the Discord handler. */
    static async getEnabledCached(): Promise<CalloutEntry[]> {
        if (CalloutService.cache) return CalloutService.cache;
        const rows = await CalloutService.list();
        CalloutService.cache = rows
            .filter(r => r.enabled)
            .map(r => (r.action
                ? { id: r.id, triggers: r.triggers, responses: r.responses, action: r.action }
                : { id: r.id, triggers: r.triggers, responses: r.responses }));
        return CalloutService.cache;
    }

    /** Every callout, enabled or not, in admin/display order. */
    static async list(): Promise<CalloutRow[]> {
        const db = await getDatabase();
        const rows = (await db.all(
            `SELECT id, triggers, responses, action, enabled, sort_order, created_at, updated_at
             FROM callouts ORDER BY sort_order ASC, id ASC`,
        )) as DbCalloutRow[];
        return rows.map(CalloutService.hydrate);
    }

    /**
     * Replaces the ENTIRE list in one transaction — the upload path.
     * Validation runs first, so a bad file never empties the table.
     * `sort_order` follows array order, which is match order.
     */
    static async replaceAll(input: unknown): Promise<number> {
        const result = validateCalloutEntries(input);
        if ('error' in result) throw new CalloutValidationError(result.error);
        const entries = result.entries;

        const db = await getDatabase();
        await db.exec('BEGIN');
        try {
            await db.run('DELETE FROM callouts');
            for (const [i, e] of entries.entries()) {
                await db.run(
                    `INSERT INTO callouts (triggers, responses, action, enabled, sort_order)
                     VALUES (?, ?, ?, ?, ?)`,
                    JSON.stringify(e.triggers), JSON.stringify(e.responses ?? []),
                    e.action ?? null, e.enabled === false ? 0 : 1, i,
                );
            }
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
        CalloutService.invalidateCache();
        return entries.length;
    }

    /**
     * Patches one row. Any subset of enabled/triggers/responses; a
     * triggers/responses change is re-validated through the same rules as an
     * upload (the row is rebuilt into a one-entry list and checked).
     * Returns null when the id doesn't exist.
     */
    static async update(
        id: number,
        patch: {
            enabled?: boolean;
            triggers?: string[];
            responses?: string[];
            /** `null` clears the action back to a plain static entry. */
            action?: CalloutAction | null;
        },
    ): Promise<CalloutRow | null> {
        const db = await getDatabase();
        const existing = (await db.get(
            `SELECT id, triggers, responses, action, enabled, sort_order, created_at, updated_at
             FROM callouts WHERE id = ?`, id,
        )) as DbCalloutRow | undefined;
        if (!existing) return null;

        const current = CalloutService.hydrate(existing);
        const nextAction = patch.action === undefined ? current.action : patch.action;
        const next = {
            triggers: patch.triggers ?? current.triggers,
            responses: patch.responses ?? current.responses,
            enabled: patch.enabled ?? current.enabled,
        };

        // Re-validated through the SAME rules as an upload. An action entry may
        // legitimately end up with no responses, so the probe omits the key
        // entirely in that case (matching the uploaded normal form).
        const probe = nextAction && next.responses.length === 0
            ? { triggers: next.triggers, action: nextAction }
            : { triggers: next.triggers, responses: next.responses, action: nextAction ?? undefined };
        const check = validateCalloutEntries([probe]);
        if ('error' in check) throw new CalloutValidationError(check.error.replace(/^entry 0: /, ''));
        const clean = check.entries[0];
        if (!clean) throw new CalloutValidationError('Callout is empty after normalization');

        await db.run(
            `UPDATE callouts
             SET triggers = ?, responses = ?, action = ?, enabled = ?, updated_at = datetime('now')
             WHERE id = ?`,
            JSON.stringify(clean.triggers), JSON.stringify(clean.responses ?? []),
            clean.action ?? null, next.enabled ? 1 : 0, id,
        );
        CalloutService.invalidateCache();

        const updated = (await db.get(
            `SELECT id, triggers, responses, action, enabled, sort_order, created_at, updated_at
             FROM callouts WHERE id = ?`, id,
        )) as DbCalloutRow;
        return CalloutService.hydrate(updated);
    }

    /** Deletes one row. Returns false when the id doesn't exist. */
    static async remove(id: number): Promise<boolean> {
        const db = await getDatabase();
        const result: any = await db.run('DELETE FROM callouts WHERE id = ?', id);
        const changed = (result?.changes ?? 0) > 0;
        if (changed) CalloutService.invalidateCache();
        return changed;
    }

    /**
     * The list in the SAME JSON shape the owner's `data/callouts.json` uses,
     * so an export → edit → upload round-trip is lossless. `enabled` is
     * emitted only when false, matching `validateCalloutEntries`' normal form.
     */
    static async exportEntries(): Promise<CalloutEntry[]> {
        const rows = await CalloutService.list();
        return rows.map(r => {
            // Key order matches `validateCalloutEntries`' normal form so an
            // export → upload round-trip is byte-identical: triggers, then
            // responses (omitted when an action entry has none), then action,
            // then enabled (only when false).
            const entry: CalloutEntry = { triggers: r.triggers };
            if (!r.action || r.responses.length > 0) entry.responses = r.responses;
            if (r.action) entry.action = r.action;
            if (!r.enabled) entry.enabled = false;
            return entry;
        });
    }

    /** Counts for the admin card header. */
    static async counts(): Promise<{ total: number; enabled: number; disabled: number; responses: number; actions: number }> {
        const rows = await CalloutService.list();
        const enabled = rows.filter(r => r.enabled).length;
        return {
            total: rows.length,
            enabled,
            disabled: rows.length - enabled,
            responses: rows.reduce((sum, r) => sum + r.responses.length, 0),
            actions: rows.filter(r => r.action !== null).length,
        };
    }

    /**
     * One-time boot seed: if the table is EMPTY and `data/callouts.json`
     * exists, import it so existing deployments keep the list they already
     * had. This is the only runtime read of that file — once seeded, the DB
     * is the source of truth and the file is never consulted again (a second
     * boot finds a non-empty table and no-ops).
     *
     * Non-fatal by contract: a malformed file logs and leaves the table empty
     * rather than blocking startup.
     */
    static async seedFromFileIfEmpty(filePath?: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get('SELECT COUNT(*) AS count FROM callouts');
        if ((row?.count ?? 0) > 0) return 0;

        const target = filePath || path.join(process.cwd(), 'data', 'callouts.json');
        if (!fs.existsSync(target)) return 0;

        try {
            const parsed = JSON.parse(fs.readFileSync(target, 'utf8'));
            const count = await CalloutService.replaceAll(parsed);
            logInfo(`[callouts] Seeded ${count} callout entries from ${target} (one-time import; the DB is the source of truth from now on).`);
            return count;
        } catch (err) {
            logError('[callouts] Seed from data/callouts.json failed (non-fatal) —', err);
            return 0;
        }
    }

    private static hydrate(row: DbCalloutRow): CalloutRow {
        return {
            id: row.id,
            triggers: CalloutService.parseJsonArray(row.triggers),
            responses: CalloutService.parseJsonArray(row.responses),
            action: isCalloutAction(row.action) ? row.action : null,
            enabled: row.enabled !== 0,
            sort_order: row.sort_order,
            created_at: row.created_at,
            updated_at: row.updated_at,
        };
    }

    /** Defensive: a hand-edited row with bad JSON degrades to empty, never throws. */
    private static parseJsonArray(stored: string): string[] {
        try {
            const parsed = JSON.parse(stored);
            return Array.isArray(parsed) ? parsed.filter(v => typeof v === 'string') : [];
        } catch {
            return [];
        }
    }
}
