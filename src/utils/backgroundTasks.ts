/**
 * Registry for fire-and-forget promise chains (v2.24.1).
 *
 * Score submission fans out work that deliberately outlives the request —
 * lobby feed generation, milestones, friend events, DM/push notifications.
 * In production that's the point; in tests those chains can still be running
 * when the next test resets the shared in-memory DB, producing
 * `SQLITE_MISUSE: Database handle is closed` noise and, on slow contended
 * runners, the `cannot start a transaction within a transaction` flakes that
 * hit `community-scores-attribution` (2026-07-15) and `room-scores`
 * (2026-07-18, blocked a deploy) — see ROADMAP.
 *
 * Every fire-and-forget chain registers via `trackBackground`; the vitest
 * setup awaits `drainBackgroundTasks()` before each DB reset. Production
 * behavior is unchanged (a Set add/delete per chain).
 */
const inFlight = new Set<Promise<unknown>>();

/** Register a fire-and-forget promise chain. Returns the same promise. */
export function trackBackground<T>(p: Promise<T>): Promise<T> {
    inFlight.add(p);
    const drop = () => { inFlight.delete(p); };
    p.then(drop, drop);
    return p;
}

/**
 * Await every registered chain, looping because a settling chain can spawn
 * new ones (nested dynamic-import hops register late). Iteration-capped so a
 * pathological self-respawning chain can't hang the suite.
 */
export async function drainBackgroundTasks(): Promise<void> {
    for (let i = 0; i < 100 && inFlight.size > 0; i++) {
        await Promise.allSettled([...inFlight]);
    }
}
