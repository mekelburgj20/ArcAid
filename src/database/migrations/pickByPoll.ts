import { logInfo } from '../../utils/logger.js';

/**
 * Migration 182 — Pick by poll is a rotation method (ADR 0026, v2.162.0).
 *
 * Until v2.161.x the poll queue was gated on `season_table_count IS NOT NULL`:
 * only a Season could be poll-picked, and every Season was. The owner ruling of
 * 2026-10-18 separates the two — "Pick by poll" is a game ROTATION METHOD that
 * any rotation tournament may use, and a Season may run without one.
 *
 *   1. `tournaments.poll_picks` (0/1) is the new gate. Every existing season
 *      was poll-picked, so those rows are backfilled to 1.
 *   2. The three poll columns lose their `season_` prefix — they describe the
 *      poll, not the season:
 *        season_poll_opens_before_h  → poll_opens_before_h
 *        season_poll_closes_before_h → poll_closes_before_h
 *        season_tie_rule             → poll_tie_rule
 *
 * `season_tie_fallback` is NOT renamed or dropped: it is unread as of v2.162.0
 * (the `admin` tie rule HOLDS instead of applying a fallback) and stays as a
 * dead column, like `season_points_top`.
 *
 * Idempotent: each step is guarded by `PRAGMA table_info(tournaments)`, so a
 * re-run — or a run against a DB that is already renamed — changes nothing.
 * The backfill runs only in the same pass that ADDS the column, so a second run
 * can never re-tick a poll an admin has since switched off.
 */
type Db = {
    exec(sql: string): Promise<unknown>;
    all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
};

const RENAMES: Array<[from: string, to: string]> = [
    ['season_poll_opens_before_h', 'poll_opens_before_h'],
    ['season_poll_closes_before_h', 'poll_closes_before_h'],
    ['season_tie_rule', 'poll_tie_rule'],
];

export async function pickByPoll(db: Db): Promise<void> {
    const columns = async () =>
        new Set(((await db.all(`PRAGMA table_info(tournaments)`)) as Array<{ name: string }>).map(c => c.name));

    let have = await columns();
    if (!have.has('poll_picks')) {
        await db.exec(`ALTER TABLE tournaments ADD COLUMN poll_picks INTEGER NOT NULL DEFAULT 0`);
        // Every season before v2.162.0 was poll-picked.
        await db.exec(`UPDATE tournaments SET poll_picks = 1 WHERE season_table_count IS NOT NULL`);
        logInfo('Migration 182: added tournaments.poll_picks (backfilled for existing seasons)');
    }

    for (const [from, to] of RENAMES) {
        have = await columns();
        if (have.has(to) || !have.has(from)) continue;
        await db.exec(`ALTER TABLE tournaments RENAME COLUMN ${from} TO ${to}`);
        logInfo(`Migration 182: renamed tournaments.${from} → ${to}`);
    }
}
