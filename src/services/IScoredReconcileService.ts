import { getDatabase } from '../database/database.js';

/**
 * iScored "Reconcile" — find games that exist on iScored but should no longer
 * be there, and let an admin delete them. This is the cleanup tool for the
 * orphan bug (a delete that silently no-op'd left the game on iScored while
 * ArcAid archived the row) plus any other drift.
 *
 * Categorization matches each iScored game against ArcAid's local `games` rows
 * BY `iscored_id`. iScored game IDs are globally unique, so matching across all
 * local rows (any room) is safe even when several rooms share one iScored
 * account — a game that is ACTIVE in another room still lands in `keep`.
 */

export interface IScoredGameSummary {
    id: string;
    name: string;
    hidden: boolean;
    locked: boolean;
    tags: string[];
}

export interface ReconcileEntry extends IScoredGameSummary {
    /** Name of a matching local row, if any (for display). */
    localName: string | null;
    /** Distinct local statuses for this iscored_id (e.g. ['ARCHIVED']). */
    localStatuses: string[];
}

export interface ReconcilePlan {
    /** A local ACTIVE/COMPLETED/QUEUED row exists → ArcAid wants it on iScored. Never delete. */
    keep: ReconcileEntry[];
    /** Only ARCHIVED local rows → ArcAid archived it but iScored kept it. Safe to delete. */
    orphans: ReconcileEntry[];
    /** No local row at all → could be a hand-made iScored game. Admin opt-in only. */
    unmanaged: ReconcileEntry[];
}

// Statuses that mean "ArcAid is (or will be) actively using this on iScored".
// COMPLETED is included because cleanup owns it — it's pending deletion by the
// normal cleanup path, not an orphan.
const KEEP_STATUSES = new Set(['ACTIVE', 'COMPLETED', 'QUEUED']);

/**
 * Categorize the games currently on iScored against the local DB.
 */
export async function buildReconcilePlan(iscoredGames: IScoredGameSummary[]): Promise<ReconcilePlan> {
    const db = await getDatabase();
    const localRows = (await db.all(
        `SELECT iscored_id, name, status FROM games WHERE iscored_id IS NOT NULL`,
    )) as Array<{ iscored_id: string; name: string; status: string }>;

    const byIscoredId = new Map<string, { name: string; statuses: Set<string> }>();
    for (const r of localRows) {
        const key = String(r.iscored_id);
        const entry = byIscoredId.get(key) ?? { name: r.name, statuses: new Set<string>() };
        entry.statuses.add(r.status);
        byIscoredId.set(key, entry);
    }

    const plan: ReconcilePlan = { keep: [], orphans: [], unmanaged: [] };
    for (const g of iscoredGames) {
        const local = byIscoredId.get(g.id);
        const entry: ReconcileEntry = {
            ...g,
            localName: local?.name ?? null,
            localStatuses: local ? [...local.statuses].sort() : [],
        };
        if (!local) {
            plan.unmanaged.push(entry);
        } else if ([...local.statuses].some((s) => KEEP_STATUSES.has(s))) {
            plan.keep.push(entry);
        } else {
            plan.orphans.push(entry);
        }
    }
    return plan;
}
