import type { Database } from 'sqlite';
import { logInfo } from '../../utils/logger.js';

/**
 * Migration 190 (v2.171.0, W33/W34) — repair what an event with a cron left behind.
 *
 * 1. An EVENT's cadence never carries a cron. TWR Tournament #1 (format=event)
 *    carried `0 12 * * *`, so rotation maintenance completed its live round 13 h
 *    early and auto-picked a non-round game (2026-10-24). The cron is removed;
 *    the zone and the rest of the cadence stay. (The Scheduler now skips events
 *    regardless; this keeps the stored row honest.)
 * 2. A FINISHED event leaves no ACTIVE game. The stray "JP's Pokemon Pinball"
 *    card stayed live on the board after that event ended. Closed locally — a
 *    migration cannot reach iScored; from now on EventScheduler closes such a
 *    card at finish through `deactivateGame`. `end_date` falls back to the
 *    event's finish time.
 *
 * Idempotent: a second run finds nothing to change.
 */
export async function repairEventCronAndLeftoverCards(db: Database): Promise<{ cronsRemoved: number; cardsClosed: number }> {
    const events = await db.all<Array<{ id: string; cadence: string | null }>>(
        `SELECT id, cadence FROM tournaments WHERE format = 'event' AND cadence LIKE '%"cron"%'`,
    );
    let cronsRemoved = 0;
    for (const t of events) {
        let cadence: Record<string, unknown>;
        try { cadence = JSON.parse(t.cadence || '{}'); } catch { continue; }
        if (!cadence || typeof cadence !== 'object' || Array.isArray(cadence) || !('cron' in cadence)) continue;
        delete cadence.cron;
        await db.run(`UPDATE tournaments SET cadence = ? WHERE id = ?`, JSON.stringify(cadence), t.id);
        cronsRemoved++;
    }
    const closed = await db.run(
        `UPDATE games
            SET status = 'COMPLETED',
                end_date = COALESCE(end_date, (SELECT t.event_finished_at FROM tournaments t WHERE t.id = games.tournament_id))
          WHERE status = 'ACTIVE'
            AND tournament_id IN (SELECT id FROM tournaments WHERE event_finished_at IS NOT NULL)`,
    ) as { changes?: number };
    const cardsClosed = closed.changes ?? 0;
    if (cronsRemoved || cardsClosed) {
        logInfo(`Migration 190: removed the cron from ${cronsRemoved} event(s); closed ${cardsClosed} leftover ACTIVE game(s) on finished events.`);
    }
    return { cronsRemoved, cardsClosed };
}
