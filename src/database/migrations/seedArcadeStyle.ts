import type { Database } from 'sqlite';

/**
 * Migration 144 — legacy rooms adopt the Arcade card style.
 *
 * Style-system revamp Phase 1. `SCOREBOARD_STYLE` is the switch between the
 * modern card system and the legacy `GameCard` render path: `ScoreboardSurface`
 * reads `useNewCards = !!config.SCOREBOARD_STYLE`, so a room with no stored
 * value has been quietly rendering the old cards — a look nobody chose and
 * nobody can see in the admin picker, which showed Banner as active for it
 * (fixed in P0).
 *
 * P0 stopped NEW rooms landing in that state by seeding a style at create time.
 * This migration is the other half: every room that predates that seed and has
 * never had a style written for it is converted to `arcade`, the flagship look
 * and the new default.
 *
 * WHAT IT DELIBERATELY DOES NOT TOUCH. A room with ANY stored
 * `SCOREBOARD_STYLE` row — including the interim `'banner'` P0 seeded between
 * P0 and P1, and including a room whose admin deliberately picked banner,
 * showcase or minimal — keeps it. An explicit choice is a choice; the only
 * rooms with something to convert are the ones that never made one.
 *
 * IDEMPOTENT by construction: the `NOT EXISTS` subquery is false for every row
 * the previous run inserted, so a re-run is a no-op. Kept as an extracted
 * handler rather than inline SQL because the migration loop SWALLOWS errors
 * from `sql:` entries — a half-applied conversion would leave an arbitrary
 * subset of rooms on the legacy path with no signal that anything failed.
 */
export async function seedArcadeStyleForLegacyRooms(db: Database): Promise<number> {
    const result = await db.run(
        `INSERT INTO game_room_settings (game_room_id, key, value)
         SELECT gr.id, 'SCOREBOARD_STYLE', 'arcade'
         FROM game_rooms gr
         WHERE NOT EXISTS (
             SELECT 1 FROM game_room_settings s
             WHERE s.game_room_id = gr.id AND s.key = 'SCOREBOARD_STYLE'
         )`,
    );
    return result.changes ?? 0;
}
