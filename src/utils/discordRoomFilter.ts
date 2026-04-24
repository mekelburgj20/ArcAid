import { getDatabase } from '../database/database.js';

/**
 * Returns the set of game_room_ids with `DISCORD_ENABLED=false`. Discord-
 * originated commands use this to exclude disabled rooms' data from their
 * query results — the admin-facing contract is "toggling Discord off severs
 * all Discord visibility into a room," which means its tournaments/games/
 * submissions shouldn't surface in slash-command output either.
 */
export async function discordDisabledRoomIds(): Promise<string[]> {
    const db = await getDatabase();
    const rows = (await db.all(
        `SELECT game_room_id FROM game_room_settings
         WHERE key = 'DISCORD_ENABLED' AND value = 'false'`,
    )) as Array<{ game_room_id: string }>;
    return rows.map(r => r.game_room_id);
}

/**
 * Builds a SQL fragment + parameter array that excludes rows whose tournament
 * belongs to a Discord-disabled room. The fragment is meant to be appended to
 * a WHERE clause (with a leading `AND`). If no rooms are disabled, returns an
 * empty fragment and no params — callers can always splat `...params` safely.
 *
 * `tournamentGameRoomColumn` is the qualified column to test (e.g. `t.game_room_id`
 * when the query joins `tournaments t`). Rows with a NULL tournament (manual
 * games) are always allowed through since they have no room attribution.
 */
export async function buildEnabledRoomSqlFilter(
    tournamentGameRoomColumn: string,
): Promise<{ sql: string; params: string[] }> {
    const disabled = await discordDisabledRoomIds();
    if (disabled.length === 0) return { sql: '', params: [] };
    const placeholders = disabled.map(() => '?').join(', ');
    return {
        sql: `AND (${tournamentGameRoomColumn} IS NULL OR ${tournamentGameRoomColumn} NOT IN (${placeholders}))`,
        params: disabled,
    };
}
