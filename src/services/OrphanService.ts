import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';

/**
 * Orphan-on-flip logic for REQUIRE_DISCORD_LOGIN (plan §15 / Sprint 6).
 *
 * When a room enables "Require login for score submissions" (false → true), every
 * anonymous row already stored for that room is stamped with `orphaned_at = NOW()`.
 * Leaderboard queries filter `orphaned_at IS NULL`, so orphaned rows disappear from
 * every public surface without being deleted. Flipping back (true → false) clears
 * the stamp and restores visibility.
 *
 * Scope: rows where `submitted_from_room_id = roomId` AND `submitted_by_user_id IS NULL`
 * across all four score tables. Rows submitted by authenticated Discord users are
 * never touched.
 *
 * Tables covered:
 *   - submissions
 *   - community_scores
 *   - score_history
 *   - global_scores (room-scoped only — only rows whose `submitted_from_room_id = roomId`)
 */
export class OrphanService {
    /**
     * Apply orphan status to anonymous rows across the four score tables.
     * Returns the aggregate row count that was modified.
     */
    static async orphanAnonymousRows(roomId: string): Promise<number> {
        const db = await getDatabase();
        const now = new Date().toISOString();
        const tables = ['submissions', 'community_scores', 'score_history', 'global_scores'];
        // Sprint 13: atomic across the 4 tables — a crash mid-flip no longer leaves
        // half the room's anonymous history orphaned and half visible.
        await db.run('BEGIN');
        try {
            let total = 0;
            for (const table of tables) {
                const result = await db.run(
                    `UPDATE ${table}
                     SET orphaned_at = ?
                     WHERE submitted_from_room_id = ?
                       AND submitted_by_user_id IS NULL
                       AND orphaned_at IS NULL`,
                    now, roomId
                );
                total += result.changes ?? 0;
            }
            await db.run('COMMIT');
            return total;
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
    }

    /**
     * Reverse orphan stamps (restore visibility) for anonymous rows in a room.
     * Only unsets rows that were previously orphaned; authenticated rows stay untouched.
     */
    static async restoreOrphanedRows(roomId: string): Promise<number> {
        const db = await getDatabase();
        const tables = ['submissions', 'community_scores', 'score_history', 'global_scores'];
        await db.run('BEGIN');
        try {
            let total = 0;
            for (const table of tables) {
                const result = await db.run(
                    `UPDATE ${table}
                     SET orphaned_at = NULL
                     WHERE submitted_from_room_id = ?
                       AND submitted_by_user_id IS NULL
                       AND orphaned_at IS NOT NULL`,
                    roomId
                );
                total += result.changes ?? 0;
            }
            await db.run('COMMIT');
            return total;
        } catch (err) {
            await db.run('ROLLBACK');
            throw err;
        }
    }

    /**
     * Dispatch for REQUIRE_DISCORD_LOGIN flip. Called from GameRoomSettingsService.set
     * with the *previous* value so we know which direction to go.
     * Silent no-op when direction unchanged.
     */
    static async handleRequireLoginFlip(
        roomId: string,
        prevValue: string | null,
        newValue: string
    ): Promise<void> {
        // v2.35.0 — REQUIRE_DISCORD_LOGIN gained a third value ('discord':
        // provider must be Discord specifically). Both 'true' and 'discord'
        // mean "login is required" for orphan purposes — a 'false' -> 'discord'
        // transition must orphan anonymous rows exactly like 'false' -> 'true'
        // did, and a 'true' <-> 'discord' transition is a no-op here (rows
        // are already orphaned either way; only the *provider* requirement
        // changed, which this table has no per-row concept of).
        const requiresLogin = (v: string | null) => v === 'true' || v === 'discord';
        const prev = requiresLogin(prevValue);
        const next = requiresLogin(newValue);
        if (prev === next) return;
        if (next) {
            const n = await OrphanService.orphanAnonymousRows(roomId);
            logInfo(`OrphanService: orphaned ${n} anonymous rows in room ${roomId} (REQUIRE_DISCORD_LOGIN → ${newValue})`);
        } else {
            const n = await OrphanService.restoreOrphanedRows(roomId);
            logInfo(`OrphanService: restored ${n} orphaned rows in room ${roomId} (REQUIRE_DISCORD_LOGIN → false)`);
        }
        // Leaderboard caches: invalidate downstream. Done inline from GameRoomSettingsService
        // after this call completes to keep cache deps out of this service.
    }
}
