import { getDatabase } from '../database/database.js';

/**
 * Returns the set of game_room_ids that Discord read commands must exclude:
 * rooms with `DISCORD_ENABLED=false` (toggling Discord off severs all
 * Discord visibility into a room, so its tournaments/games/submissions
 * shouldn't surface in slash-command output either), UNION rooms with
 * `JOIN_POLICY=approval` (v2.39.0 — an approval room is invisible to
 * non-members; a cross-room Discord read command has no per-guild-membership
 * concept today, so the safe default is to exclude it entirely rather than
 * leak scores/games to anyone who can run the command. See ROADMAP for a
 * future guild-implies-membership refinement).
 */
export async function discordExcludedRoomIds(): Promise<string[]> {
    const db = await getDatabase();
    const rows = (await db.all(
        `SELECT game_room_id FROM game_room_settings
         WHERE (key = 'DISCORD_ENABLED' AND value = 'false')
            OR (key = 'JOIN_POLICY' AND value = 'approval')`,
    )) as Array<{ game_room_id: string }>;
    return Array.from(new Set(rows.map(r => r.game_room_id)));
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
    const disabled = await discordExcludedRoomIds();
    if (disabled.length === 0) return { sql: '', params: [] };
    const placeholders = disabled.map(() => '?').join(', ');
    return {
        sql: `AND (${tournamentGameRoomColumn} IS NULL OR ${tournamentGameRoomColumn} NOT IN (${placeholders}))`,
        params: disabled,
    };
}
