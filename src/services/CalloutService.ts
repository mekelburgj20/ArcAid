import fs from 'fs';
import path from 'path';
import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import {
    CALLOUT_CATEGORIES,
    CalloutAction,
    CalloutCategory,
    CalloutEntry,
    calloutCategoryOf,
    DEFAULT_CALLOUT_CATEGORY,
    isCalloutAction,
    isCalloutCategory,
    validateCalloutEntries,
} from '../utils/callouts.js';
import { BUILTIN_HELP_ENTRIES } from '../utils/calloutBuiltins.js';

/** A stored callout, as the admin API returns it. */
export interface CalloutRow {
    id: number;
    triggers: string[];
    responses: string[];
    /** Built-in live-data responder; null for ordinary static entries. */
    action: CalloutAction | null;
    /** Which room-toggleable bucket this entry sits in (migration 156). */
    category: CalloutCategory;
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
    category: string | null;
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
                ? { id: r.id, triggers: r.triggers, responses: r.responses, action: r.action, category: r.category }
                : { id: r.id, triggers: r.triggers, responses: r.responses, category: r.category }));
        return CalloutService.cache;
    }

    /** Every callout, enabled or not, in admin/display order. */
    static async list(): Promise<CalloutRow[]> {
        const db = await getDatabase();
        const rows = (await db.all(
            `SELECT id, triggers, responses, action, category, enabled, sort_order, created_at, updated_at
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
                    `INSERT INTO callouts (triggers, responses, action, category, enabled, sort_order)
                     VALUES (?, ?, ?, ?, ?, ?)`,
                    JSON.stringify(e.triggers), JSON.stringify(e.responses ?? []),
                    e.action ?? null, calloutCategoryOf(e), e.enabled === false ? 0 : 1, i,
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
            /** Which room-toggleable bucket the entry moves to. */
            category?: CalloutCategory;
        },
    ): Promise<CalloutRow | null> {
        const db = await getDatabase();
        const existing = (await db.get(
            `SELECT id, triggers, responses, action, category, enabled, sort_order, created_at, updated_at
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
        // The category is carried explicitly rather than left to inference:
        // an admin who moved an entry to `banter` must not have it silently
        // re-derived back to `callouts` by an unrelated trigger edit.
        const nextCategory = patch.category ?? current.category;
        const probe = nextAction && next.responses.length === 0
            ? { triggers: next.triggers, action: nextAction, category: nextCategory }
            : {
                triggers: next.triggers, responses: next.responses,
                action: nextAction ?? undefined, category: nextCategory,
            };
        const check = validateCalloutEntries([probe]);
        if ('error' in check) throw new CalloutValidationError(check.error.replace(/^entry 0: /, ''));
        const clean = check.entries[0];
        if (!clean) throw new CalloutValidationError('Callout is empty after normalization');

        await db.run(
            `UPDATE callouts
             SET triggers = ?, responses = ?, action = ?, category = ?, enabled = ?,
                 updated_at = datetime('now')
             WHERE id = ?`,
            JSON.stringify(clean.triggers), JSON.stringify(clean.responses ?? []),
            clean.action ?? null, calloutCategoryOf(clean), next.enabled ? 1 : 0, id,
        );
        CalloutService.invalidateCache();

        const updated = (await db.get(
            `SELECT id, triggers, responses, action, category, enabled, sort_order, created_at, updated_at
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
            // Always emitted (v2.125.0) — an export that dropped it would make
            // a re-upload fall back to inference and silently re-file every
            // entry an admin had hand-sorted.
            entry.category = r.category;
            if (!r.enabled) entry.enabled = false;
            return entry;
        });
    }

    /** Counts for the admin card header, including the per-category split. */
    static async counts(): Promise<{
        total: number; enabled: number; disabled: number; responses: number; actions: number;
        byCategory: Record<CalloutCategory, number>;
    }> {
        const rows = await CalloutService.list();
        const enabled = rows.filter(r => r.enabled).length;
        // Every category is present with 0 rather than absent, so the FE can
        // render a stable set of chips without defaulting each lookup.
        const byCategory = Object.fromEntries(
            CALLOUT_CATEGORIES.map(c => [c, rows.filter(r => r.category === c).length]),
        ) as Record<CalloutCategory, number>;
        return {
            total: rows.length,
            enabled,
            disabled: rows.length - enabled,
            responses: rows.reduce((sum, r) => sum + r.responses.length, 0),
            actions: rows.filter(r => r.action !== null).length,
            byCategory,
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

    /**
     * Boot step (v2.125.0): make sure every built-in live answer is reachable.
     *
     * For each action in `BUILTIN_HELP_ENTRIES`, if the table holds NO row with
     * that action — enabled OR disabled — one is appended with the default
     * trigger phrases. Idempotent by construction, and deliberately blind to
     * `enabled`: an admin who switched a built-in off has made a decision, and
     * re-adding it on the next restart would override them silently.
     *
     * New rows go at the END of `sort_order`, so they can never shadow an
     * existing entry in the first-match-wins loop.
     *
     * Returns how many were added. Never throws — a failure here must not take
     * down boot; the feature degrades to "that action has no trigger yet".
     */
    static async ensureBuiltinHelpEntries(): Promise<number> {
        try {
            const db = await getDatabase();
            const existing = (await db.all(
                'SELECT DISTINCT action FROM callouts WHERE action IS NOT NULL',
            )) as Array<{ action: string }>;
            const have = new Set(existing.map(r => r.action));

            const missing = BUILTIN_HELP_ENTRIES.filter(e => e.action && !have.has(e.action));
            if (missing.length === 0) return 0;

            const maxRow = await db.get('SELECT MAX(sort_order) AS max_order FROM callouts');
            let order = (maxRow?.max_order ?? -1) + 1;

            for (const entry of missing) {
                await db.run(
                    `INSERT INTO callouts (triggers, responses, action, category, enabled, sort_order)
                     VALUES (?, '[]', ?, ?, 1, ?)`,
                    JSON.stringify(entry.triggers), entry.action ?? null,
                    calloutCategoryOf(entry), order++,
                );
            }
            CalloutService.invalidateCache();
            logInfo(
                `[chat-responses] Added ${missing.length} built-in help answer(s): `
                + `${missing.map(e => e.action).join(', ')}.`,
            );
            return missing.length;
        } catch (err) {
            logError('[chat-responses] ensureBuiltinHelpEntries failed (non-fatal) —', err);
            return 0;
        }
    }

    private static hydrate(row: DbCalloutRow): CalloutRow {
        return {
            id: row.id,
            triggers: CalloutService.parseJsonArray(row.triggers),
            responses: CalloutService.parseJsonArray(row.responses),
            action: isCalloutAction(row.action) ? row.action : null,
            // A hand-edited or pre-migration row with a junk/NULL category
            // degrades to the default rather than escaping every filter.
            category: isCalloutCategory(row.category) ? row.category : DEFAULT_CALLOUT_CATEGORY,
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
