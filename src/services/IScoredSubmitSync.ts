import fs from 'fs';
import { getDatabase } from '../database/database.js';
import { logInfo, logWarn, logError } from '../utils/logger.js';

/**
 * v2.2.2 — shared iScored sync for web score submissions.
 *
 * Posts a score to iScored when the supplied (roomId, gameName) resolves to an
 * ACTIVE tournament game with an `iscored_id`. Fire-and-forget — errors are
 * caught and logged; callers should not `await` for user-visible flows.
 *
 * Called from all three web submission paths so the sync behaviour is identical
 * regardless of which surface the player used:
 *   - POST /:roomId/submit-score/:gameName   (tournament card / game detail)
 *   - POST /:roomId/freeplay-score           (freeplay catalogue)
 *   - POST /:roomId/community-scores/:gameName (legacy community endpoint)
 *
 * Pre-v2.2.2 only the first path synced, so scores submitted via freeplay or
 * the legacy community endpoint stayed local-only. That broke winner resolution
 * for rooms where iScored was still the canonical public scoreboard.
 *
 * Username passed in should be the *resolved* display name (post
 * RoomNameClaimService auto-suffix) so iScored shows the same name the room's
 * leaderboard shows.
 */
export async function syncScoreToIScored(opts: {
    roomId: string;
    gameName: string;
    username: string;
    score: number;
    /** Absolute path to the persisted photo file, used only by the Playwright fallback. */
    persistentPhotoPath?: string;
}): Promise<void> {
    const { roomId, gameName, username, score, persistentPhotoPath } = opts;
    let tempPhotoPath: string | undefined;
    try {
        const db = await getDatabase();
        const activeGame = await db.get(`
            SELECT g.iscored_id FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
              AND g.status = 'ACTIVE' AND g.iscored_id IS NOT NULL
            LIMIT 1
        `, gameName, roomId);
        if (!activeGame) {
            logWarn(`No active iScored game found for "${gameName}" in room ${roomId}, skipping sync`);
            return;
        }

        const useApi = process.env.ISCORED_API_ENABLED !== 'false';
        if (useApi) {
            // API path — fast, no browser overhead (no photo support).
            const { IScoredApiClient } = await import('../engine/IScoredApiClient.js');
            const apiClient = new IScoredApiClient();
            await apiClient.submitScore(activeGame.iscored_id, username, score);
            logInfo(`iScored API sync: submitted score for "${gameName}" by ${username}`);
        } else {
            // Playwright fallback — supports photos.
            const hasCredentials = !!(process.env.ISCORED_USERNAME && process.env.ISCORED_PASSWORD);
            if (!hasCredentials) return;

            if (persistentPhotoPath) {
                tempPhotoPath = persistentPhotoPath + '.tmp';
                fs.copyFileSync(persistentPhotoPath, tempPhotoPath);
            }

            const { IScoredClient } = await import('../engine/IScoredClient.js');
            const client = new IScoredClient();
            await client.connect();
            try {
                await client.submitScore(activeGame.iscored_id, username, score, tempPhotoPath);
                logInfo(`iScored Playwright sync: submitted score for "${gameName}" by ${username}`);
            } finally {
                await client.disconnect();
            }
        }
    } catch (err) {
        logError(`iScored sync failed for "${gameName}" by ${username}:`, err);
    } finally {
        if (tempPhotoPath) try { fs.unlinkSync(tempPhotoPath); } catch {}
    }
}
