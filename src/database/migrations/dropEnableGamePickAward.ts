import type { Database } from 'sqlite';

/**
 * Migration 126 — drop the room-level pick-award gate (v2.56.0).
 *
 * `game_room_settings.ENABLE_GAME_PICK_AWARD` used to AND with each
 * tournament's `winner_picks` inside `PickAwardGate`. It defaulted to absent
 * (→ off) and was never referenced by the tournament form, so a tournament
 * configured with "Winner picks next game" ✓ plus winner/runner-up windows
 * would auto-pick immediately with nothing in the UI explaining why. The key
 * is gone; winner-picks is per-tournament only.
 *
 * Nothing reads the key any more, so the rows are deleted rather than left as
 * orphans that would invite a future reader to believe they still matter. The
 * key is not in the public `scoreboard-config` prefix allowlist, so no public
 * payload changes.
 *
 * Idempotent by construction: re-running deletes 0 rows.
 */
export async function dropEnableGamePickAward(db: Database): Promise<number> {
    const before = await db.get<{ c: number }>(
        `SELECT COUNT(*) AS c FROM game_room_settings WHERE key = 'ENABLE_GAME_PICK_AWARD'`,
    );
    const removed = before?.c ?? 0;
    if (removed > 0) {
        // eslint-disable-next-line no-console
        console.log(`[migration] 126: removing ${removed} orphaned ENABLE_GAME_PICK_AWARD setting row(s)`);
    }
    await db.run(`DELETE FROM game_room_settings WHERE key = 'ENABLE_GAME_PICK_AWARD'`);
    return removed;
}
