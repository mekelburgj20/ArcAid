/**
 * The ONE ordering contract for a player's pick queue (v2.126.0).
 *
 * Every reader and the engine's own walker must agree on which row is "next",
 * or the Picks page shows one thing and the rotation does another. Before the
 * hold model there was a single hand-copied `ORDER BY queue_order ASC, rowid
 * ASC` in six places; the hold rule adds a bucket in front of it, so the
 * fragment now lives here and is imported.
 *
 * Order:
 *   1. HELD rows (`queue_held_at IS NOT NULL`), oldest hold first. A hold is
 *      stamped by the engine when it reaches a pick that is inside its
 *      cooldown; the row keeps its place in the queue instead of being
 *      deleted, and jumps to the front the moment the cooldown clears — the
 *      owner's "it should be the top of their queue as soon as it is no
 *      longer in cooldown".
 *   2. UNHELD rows by `queue_order ASC` — NULLs first in SQLite, which is
 *      load-bearing: `[Pending Pick]` placeholders and repurposed placeholder
 *      rows carry `queue_order = NULL` precisely so they sort to the front.
 *   3. `rowid ASC` as the deterministic tie-break.
 *
 * `queue_held_at` is cleared on promotion to ACTIVE alongside `queue_order`:
 * an ACTIVE row is in nobody's queue.
 */

/**
 * The ORDER BY body, optionally qualified with a table alias (`'g'` →
 * `g.queue_held_at`, …) for the joined queries.
 */
export function queueOrderSql(alias = ''): string {
    const p = alias ? `${alias}.` : '';
    return `CASE WHEN ${p}queue_held_at IS NOT NULL THEN 0 ELSE 1 END ASC, ` +
        `${p}queue_held_at ASC, ${p}queue_order ASC, ${p}rowid ASC`;
}

/** Unqualified form, for single-table queue reads. */
export const QUEUE_ORDER_SQL = queueOrderSql();
