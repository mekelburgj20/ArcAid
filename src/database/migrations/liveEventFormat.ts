import { logInfo } from '../../utils/logger.js';

/**
 * Migration 163 — Live Event tournament format (Arc 1, Phase 1).
 *
 * Adds the time-boxed "event" format alongside the perpetual cron-rotated
 * "rotation" format every tournament has been until now. The whole design
 * hangs off two decisions recorded in ADR 0017:
 *
 *   1. **A round IS a `games` row** (`round_no`, `scheduled_start_at`,
 *      `scheduled_end_at`, `status='SCHEDULED'`) rather than a new
 *      `tournament_rounds` table. Every read path in the app — cards,
 *      LeaderboardService, TournamentScoresService, Game Detail, the Discord
 *      reads, callouts, OG meta, ScoreSyncPoller, ScoreHistoryService's
 *      tournament auto-stamp, ScoreRankService — already keys on
 *      `games` + `tournament_id`, so rounds inherit all of it for free. A
 *      separate table would have meant patching ~15 readers.
 *   2. **`SCHEDULED` is a new `games.status`**, deliberately NOT `'QUEUED'`.
 *      16 non-test files act on `'QUEUED'` (the pick queue, TimeoutManager,
 *      the queue_order backfill at the bottom of `initDatabase`, reconcile) —
 *      a pre-created round must be invisible to every one of them.
 *
 * `games.status` has no CHECK constraint (`GameStatus` is a TS union), so the
 * new status needs no table rebuild.
 *
 * Idempotent: every column is PRAGMA-guarded, every table/index is IF NOT
 * EXISTS. Safe to re-run against a partially-migrated DB.
 */
type Db = {
    exec(sql: string): Promise<unknown>;
    all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
};

export async function liveEventFormat(db: Db): Promise<void> {
    const addColumns = async (table: string, columns: Array<[string, string]>) => {
        const existing = (await db.all(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
        const have = new Set(existing.map(c => c.name));
        for (const [name, ddl] of columns) {
            if (have.has(name)) continue;
            await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
            logInfo(`Migration 163: added ${table}.${name}`);
        }
    };

    await addColumns('tournaments', [
        // 'rotation' (every pre-existing tournament) | 'event'
        ['format', `TEXT NOT NULL DEFAULT 'rotation'`],
        // ISO UTC. For events: MIN(round start) / MAX(round end), maintained by
        // EventService so a tournament row alone answers "when is this".
        ['start_date', 'TEXT'],
        ['end_date', 'TEXT'],
        // NULL = check-in is open from the moment the event is created.
        // Check-in always CLOSES at round 1 start (no separate column) —
        // stragglers are handled by an admin adding them as source='admin'.
        ['checkin_opens_at', 'TEXT'],
        ['checkin_required', 'INTEGER NOT NULL DEFAULT 1'],
        // best | average | sum — how per-round bests combine into standings.
        ['aggregate_method', `TEXT NOT NULL DEFAULT 'best'`],
        // NULL = no gear-up badge. Otherwise a score whose elapsed-since-round-
        // start is below this is FLAGGED for the host's eye. Display only —
        // Arcaid cannot see play time from outside, so it never rejects.
        ['min_elapsed_sec', 'INTEGER'],
        // Late-submit grace after a round's scheduled end. AtGames is
        // exit-to-submit (a score only uploads when the player fully exits the
        // table), so hosts running "exit at the buzzer" rules need 120-180s;
        // pure phone-submit frenzies keep the 60s default. ONE value, read by
        // both the submission gate and the scheduler via eventEndGraceSec().
        ['end_grace_sec', 'INTEGER NOT NULL DEFAULT 60'],
        // Idempotency stamps — the per-minute EventScheduler tick is at-least-
        // once (a restart mid-tick re-runs it), so every announcement and the
        // final result write are guarded on these being NULL.
        ['checkin_announced_at', 'TEXT'],
        ['event_finished_at', 'TEXT'],
        // Frozen final standings, {v:1,...}. IDENTITY-STABLE ROWS ONLY — same
        // doctrine as leaderboard_cache: never bake a display name or an avatar
        // in here, they are resolved at read time by PlayerProfileResolver.
        ['event_result', 'TEXT'],
    ]);

    await addColumns('games', [
        // NULL for every rotation game. Non-NULL == "this row is an event round".
        ['round_no', 'INTEGER'],
        ['scheduled_start_at', 'TEXT'],
        ['scheduled_end_at', 'TEXT'],
    ]);

    // Drives the EventScheduler's per-minute sweep for rounds due to start.
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_games_scheduled
        ON games(status, scheduled_start_at) WHERE round_no IS NOT NULL
    `);

    // Who is allowed to submit during a checkin_required event.
    //
    // `user_id` is the CANONICAL identity (IdentityLinkService.resolveCanonical)
    // — a Google web check-in and a Discord /check-in by the same linked person
    // must collide on the PK, not create two participants.
    //
    // `source`: 'checkin' = the player checked themselves in; 'admin' = a room
    // admin added them (this is the straggler path, and it deliberately bypasses
    // the late-check-in guard); 'qualifier' is RESERVED for a future "import the
    // submitters of tournament X" button — declared in the CHECK now so adding
    // it later needs no table rebuild.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS tournament_participants (
            tournament_id TEXT NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
            user_id TEXT NOT NULL,
            checked_in_at TEXT NOT NULL,
            source TEXT NOT NULL DEFAULT 'checkin' CHECK(source IN ('checkin','qualifier','admin')),
            added_by TEXT,
            PRIMARY KEY (tournament_id, user_id)
        )
    `);
    await db.exec(`
        CREATE INDEX IF NOT EXISTS idx_tournament_participants_user
        ON tournament_participants(user_id)
    `);
}
