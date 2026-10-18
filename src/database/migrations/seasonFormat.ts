import { logInfo } from '../../utils/logger.js';

/**
 * Migration 181 — Season format (docs/season-format-plan.md §3).
 *
 * A Season is NOT a new tournament format: it is a `format = 'rotation'`
 * tournament with a season block switched on (`season_table_count` non-NULL).
 * This migration adds that block, two ranking-group knobs the season standings
 * need, and the three poll-queue tables.
 *
 * Idempotent: every column is PRAGMA-guarded, every table/index is IF NOT
 * EXISTS. Safe to re-run against a partially-migrated DB.
 */
type Db = {
    exec(sql: string): Promise<unknown>;
    all<T = unknown>(sql: string, ...params: unknown[]): Promise<T[]>;
};

export async function seasonFormat(db: Db): Promise<void> {
    const addColumns = async (table: string, columns: Array<[string, string]>) => {
        const existing = (await db.all(`PRAGMA table_info(${table})`)) as Array<{ name: string }>;
        const have = new Set(existing.map(c => c.name));
        for (const [name, ddl] of columns) {
            if (have.has(name)) continue;
            await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
            logInfo(`Migration 181: added ${table}.${name}`);
        }
    };

    await addColumns('tournaments', [
        // NULL = not a season. N = a season of N tables.
        ['season_table_count', 'INTEGER'],
        // Points for 1st place; 2nd = top-1 ... floor 0.
        // UNREAD since v2.161.1 — points live on ranking_groups.points_top.
        ['season_points_top', 'INTEGER NOT NULL DEFAULT 50'],
        // The auto-created standings group. Pseudo-FK (no constraint — SQLite
        // cannot add an enforced FK via ALTER TABLE).
        ['season_ranking_group_id', 'TEXT'],
        // Default poll window, relative to the NEXT rotation.
        // RENAMED by migration 182 → poll_opens_before_h / poll_closes_before_h.
        ['season_poll_opens_before_h', 'INTEGER NOT NULL DEFAULT 96'],
        ['season_poll_closes_before_h', 'INTEGER NOT NULL DEFAULT 3'],
        // admin | random | first_nominated
        // RENAMED by migration 182 → poll_tie_rule.
        ['season_tie_rule', `TEXT NOT NULL DEFAULT 'admin'`],
        // random | first_nominated — applied immediately when the rule is admin.
        // UNREAD since v2.162.0 (ADR 0026): the admin tie rule HOLDS, there is
        // no fallback. Column kept, nothing reads or writes it.
        ['season_tie_fallback', `TEXT NOT NULL DEFAULT 'random'`],
        // ISO UTC. Non-NULL = paused: no polls post, no rotation fires.
        ['season_paused_at', 'TEXT'],
        // ISO UTC. Idempotency stamp for the season-end announcement.
        ['season_finished_at', 'TEXT'],
    ]);

    await addColumns('ranking_groups', [
        // best_game_linear only: 1st = top, 2nd = top-1 ... Existing groups
        // keep 100, so nothing changes for them.
        ['points_top', 'INTEGER NOT NULL DEFAULT 100'],
        // 1 = count ARCHIVED games too (season groups). Default off so no
        // existing room's standings change on deploy.
        ['include_archived', 'INTEGER NOT NULL DEFAULT 0'],
    ]);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS season_polls (
            id TEXT PRIMARY KEY,
            tournament_id TEXT NOT NULL,
            slot_no INTEGER NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            question TEXT,
            opens_at TEXT,
            closes_at TEXT,
            discord_channel_id TEXT,
            discord_message_id TEXT,
            posted_at TEXT,
            tie_rule TEXT,
            result_game_name TEXT,
            result_queued_game_id TEXT,
            tied INTEGER NOT NULL DEFAULT 0,
            resolved_at TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            FOREIGN KEY (tournament_id) REFERENCES tournaments(id) ON DELETE CASCADE
        )
    `);
    await db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_season_polls_slot ON season_polls(tournament_id, slot_no)`);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS season_poll_candidates (
            poll_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            game_name TEXT NOT NULL,
            global_game_id TEXT,
            discord_answer_id INTEGER,
            PRIMARY KEY (poll_id, position),
            FOREIGN KEY (poll_id) REFERENCES season_polls(id) ON DELETE CASCADE
        )
    `);

    // user_id is the CANONICAL identity (IdentityLinkService.resolveCanonical).
    // Identity-stable rows only — names resolve at read via resolveProfiles.
    await db.exec(`
        CREATE TABLE IF NOT EXISTS season_poll_votes (
            poll_id TEXT NOT NULL,
            user_id TEXT NOT NULL,
            position INTEGER NOT NULL,
            source TEXT NOT NULL,
            voted_at TEXT NOT NULL DEFAULT (datetime('now')),
            PRIMARY KEY (poll_id, user_id),
            FOREIGN KEY (poll_id) REFERENCES season_polls(id) ON DELETE CASCADE
        )
    `);
}
