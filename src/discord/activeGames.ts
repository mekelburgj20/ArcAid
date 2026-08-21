import { getDatabase } from '../database/database.js';
import {
    GuildReadScope,
    buildGuildScopedRoomSqlFilter,
} from '../utils/discordRoomFilter.js';

/** One ACTIVE game row, with the context both callers need to label it. */
export interface ActiveGameRow {
    game_name: string;
    tournament_name: string | null;
    tournament_type: string | null;
    game_room_id: string | null;
    /**
     * v2.125.0 — the extra columns the `time_left` / `leaders` / `my_rank` /
     * `tournament_rules` chat answers need. Added to THIS query rather than
     * given one of their own so all five surfaces (including `/list-active`)
     * agree on which games are active and which guild may see them; a second
     * query would drift silently. `/list-active` simply ignores them.
     */
    game_id: string;
    tournament_id: string | null;
    /** Raw `tournaments.cadence` JSON — cron + timezone for the countdown. */
    cadence: string | null;
    platform_rules: string | null;
    eligibility_days: number | null;
}

/**
 * The ACTIVE games a guild is allowed to see, in tournament order.
 *
 * Extracted from `/list-active` (v2.123.0) so the `active_games` callout
 * responder answers with EXACTLY the same rows the slash command does —
 * including the guild scoping. Two implementations of "what's on right now"
 * would drift, and the failure would be silent (a callout confidently naming
 * a game from another room).
 *
 * INNER JOIN on tournaments is deliberate: orphan games with no tournament
 * (legacy pre-multi-room data) have no room attribution and must not surface
 * in any guild's output.
 */
export async function listActiveGamesForScope(scope: GuildReadScope): Promise<ActiveGameRow[]> {
    const db = await getDatabase();
    const { sql: scopeFilter, params } = buildGuildScopedRoomSqlFilter('t.game_room_id', scope);
    return (await db.all(`
        SELECT g.name AS game_name,
               g.id AS game_id,
               t.name AS tournament_name,
               t.type AS tournament_type,
               t.game_room_id AS game_room_id,
               t.id AS tournament_id,
               t.cadence AS cadence,
               t.platform_rules AS platform_rules,
               t.eligibility_days AS eligibility_days
        FROM games g
        JOIN tournaments t ON g.tournament_id = t.id
        WHERE g.status = 'ACTIVE' ${scopeFilter}
        ORDER BY t.name ASC, g.name ASC
    `, ...params)) as ActiveGameRow[];
}
