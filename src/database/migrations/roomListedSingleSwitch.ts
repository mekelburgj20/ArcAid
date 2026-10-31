import type { Database } from 'sqlite';

/**
 * Migration 201 — ROOM_LISTED is the one listing switch.
 *
 * Two values used to decide whether a room is on the landing page:
 * `game_rooms.is_public` (set at creation, then only by a super admin) and the
 * owner's "Listed on Arcaid" toggle (`game_room_settings.ROOM_LISTED`). A room
 * created private showed the toggle ON while staying hidden, and its owner had
 * no way to change it (arcaid_witness_demo, 2026-10-30).
 *
 * From here the toggle decides and `is_public` mirrors it:
 *   - a private room whose toggle was never saved keeps hiding (toggle stored off);
 *   - a room whose owner saved the toggle gets what they chose;
 *   - every other room is unchanged.
 */
export async function roomListedSingleSwitch(db: Database): Promise<void> {
    await db.run(
        `INSERT INTO game_room_settings (game_room_id, key, value)
         SELECT id, 'ROOM_LISTED', 'false' FROM game_rooms r
          WHERE r.is_public = 0
            AND NOT EXISTS (SELECT 1 FROM game_room_settings s
                             WHERE s.game_room_id = r.id AND s.key = 'ROOM_LISTED')`,
    );
    await db.run(
        `UPDATE game_rooms SET is_public = CASE
            WHEN (SELECT value FROM game_room_settings s
                   WHERE s.game_room_id = game_rooms.id AND s.key = 'ROOM_LISTED') = 'false'
            THEN 0 ELSE 1 END`,
    );
}
