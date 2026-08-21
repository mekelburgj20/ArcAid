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
    /**
     * v2.5.0: per-score platform — accepted for signature parity with the local
     * persistence call sites. iScored has no platform concept, so this is
     * pass-through-only (logged for debugging, never sent to the API).
     */
    platform?: string | null;
}): Promise<void> {
    const { roomId, gameName, username, score, persistentPhotoPath } = opts;
    let tempPhotoPath: string | undefined;
    try {
        // Resolve per-room (or env-fallback) creds. null means iScored is
        // disabled or unconfigured for this room — nothing to sync.
        const { getIScoredCredsForRoom } = await import('../utils/iscoredCreds.js');
        const creds = await getIScoredCredsForRoom(roomId);
        if (!creds) {
            logInfo(`iScored disabled for room ${roomId}, skipping sync for "${gameName}"`);
            return;
        }

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
            const apiClient = new IScoredApiClient({ gameroomName: creds.gameroomName });
            await apiClient.submitScore(activeGame.iscored_id, username, score);
            logInfo(`iScored API sync: submitted score for "${gameName}" by ${username}`);
        } else {
            // Playwright fallback — supports photos.
            if (persistentPhotoPath) {
                tempPhotoPath = persistentPhotoPath + '.tmp';
                fs.copyFileSync(persistentPhotoPath, tempPhotoPath);
            }

            const { IScoredSessionRegistry } = await import('../engine/IScoredSessionRegistry.js');
            await IScoredSessionRegistry.getInstance().withSession(creds, async (client) => {
                await client.submitScore(activeGame.iscored_id, username, score, tempPhotoPath);
            });
            logInfo(`iScored Playwright sync: submitted score for "${gameName}" by ${username}`);
        }
    } catch (err) {
        // iScored answers "Access Denied" to BOTH a locked game and a gameroom
        // with Write access switched off — same six characters, two completely
        // different operator actions. Arcaid knows which one it is.
        //
        // The lookup above requires status='ACTIVE', so a non-ACTIVE row here
        // means the round CLOSED between that read and this write: rotation
        // locks the game on iScored while a submit is already in flight. That is
        // routine, the score is safely in Arcaid regardless, and it does not
        // deserve an ERROR that reads like a broken integration.
        const message = err instanceof Error ? err.message : String(err);
        if (await gameRoundClosed(roomId, gameName)) {
            logWarn(`iScored sync for "${gameName}" by ${username} was rejected by iScored — the game is locked (round closed); the score still counts in Arcaid.`);
        } else {
            logError(`iScored sync failed for "${gameName}" by ${username}: ${message} (check that Write access is enabled on the iScored gameroom)`, err);
        }
    } finally {
        if (tempPhotoPath) try { fs.unlinkSync(tempPhotoPath); } catch {}
    }
}

/**
 * Has this room's copy of the game stopped being live? Re-read at FAILURE time,
 * not reused from the pre-submit lookup — the whole point is to catch the row
 * changing underneath an in-flight submit.
 *
 * `end_date` counts alongside status because deactivation stamps it, and a row
 * that has an end date is finished whatever its status column says. Its own
 * errors are swallowed: this only decides a log level.
 */
async function gameRoundClosed(roomId: string, gameName: string): Promise<boolean> {
    try {
        const db = await getDatabase();
        const row = await db.get(`
            SELECT g.status, g.end_date FROM games g
            JOIN tournaments t ON t.id = g.tournament_id
            WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
            ORDER BY CASE g.status WHEN 'ACTIVE' THEN 0 ELSE 1 END, g.created_at DESC
            LIMIT 1
        `, gameName, roomId);
        if (!row) return false;
        return row.status !== 'ACTIVE' || !!row.end_date;
    } catch {
        return false;
    }
}
