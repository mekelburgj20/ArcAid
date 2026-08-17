/**
 * Migration 149 — widen `picker_dispositions.disposition` to admit 'auto'.
 *
 * 'auto' is the owner's "roll the dice" option (2026-08-17): the winner hands
 * the pick straight to the auto-picker instead of using their queue, taking a
 * window, or passing it to a person.
 *
 * The value lives in a CHECK constraint, which SQLite cannot ALTER — so this is
 * a create-copy-drop-rename rebuild. Safe here because the migration loop runs
 * BEFORE `PRAGMA foreign_keys = ON` is set in `initDatabase` (see CLAUDE.md —
 * migrations 066/077/095 are the same shape); a rebuild under enforcement would
 * trip the tournaments FK on DROP.
 *
 * Idempotent: no-ops when the table is absent (fresh DB — 143 creates it with
 * the old constraint, this runs straight after) or already widened.
 */
export async function widenPickDispositionCheck(db: any): Promise<void> {
    const table = await db.get(
        `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'picker_dispositions'`,
    );
    if (!table?.sql) return;                       // table not created yet — nothing to widen
    if (table.sql.includes("'auto'")) return;      // already widened

    await db.exec(`
        CREATE TABLE picker_dispositions_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tournament_id TEXT NOT NULL,
            discord_user_id TEXT NOT NULL,
            disposition TEXT NOT NULL CHECK(disposition IN ('nominate', 'forfeit', 'auto')),
            nominee_discord_id TEXT,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(tournament_id, discord_user_id),
            FOREIGN KEY (tournament_id) REFERENCES tournaments (id) ON DELETE CASCADE
        );

        INSERT INTO picker_dispositions_new
            (id, tournament_id, discord_user_id, disposition, nominee_discord_id, created_at, updated_at)
        SELECT id, tournament_id, discord_user_id, disposition, nominee_discord_id, created_at, updated_at
        FROM picker_dispositions;

        DROP TABLE picker_dispositions;
        ALTER TABLE picker_dispositions_new RENAME TO picker_dispositions;

        CREATE INDEX IF NOT EXISTS idx_picker_dispositions_tournament ON picker_dispositions(tournament_id);
    `);
}
