import type { Database } from 'sqlite';

/**
 * Migration 224 (B31.1): run recaps.
 *
 * - `user_preferences.recap_play_stats`: NULL = shown (default on), 0 = hidden.
 * - `user_preferences.recap_time_of_day`: NULL / 0 = off (default), 1 = on.
 * - `run_recap_posts`: B31.5's idempotency ledger, created now so that slice never
 *   touches database.ts. No FK on `game_id`: an audit row that outlives its game
 *   (like `maintenance_runs`).
 *
 * Idempotent: each column is added only when missing; the table is IF NOT EXISTS.
 */
export async function runRecaps(db: Database): Promise<void> {
    const columns = (await db.all(`PRAGMA table_info(user_preferences)`)) as Array<{ name: string }>;
    if (!columns.some(c => c.name === 'recap_play_stats')) {
        await db.exec(`ALTER TABLE user_preferences ADD COLUMN recap_play_stats INTEGER`);
    }
    if (!columns.some(c => c.name === 'recap_time_of_day')) {
        await db.exec(`ALTER TABLE user_preferences ADD COLUMN recap_time_of_day INTEGER`);
    }
    await db.exec(`
        CREATE TABLE IF NOT EXISTS run_recap_posts (
            game_id      TEXT PRIMARY KEY,
            game_room_id TEXT,
            status       TEXT NOT NULL,
            channel_id   TEXT,
            message_ids  TEXT,
            reason       TEXT,
            claimed_at   TEXT NOT NULL,
            finished_at  TEXT
        );
    `);
}
