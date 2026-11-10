import { getDatabase } from '../database/database.js';
import { logInfo, logWarn } from '../utils/logger.js';
import { trackBackground } from '../utils/backgroundTasks.js';
import type { IScoredCreds } from '../utils/iscoredCreds.js';

export interface IScoredBoardRequest {
    roomId: string;
    tournamentId: string;
    /** The tournament's type, used as the board's iScored tag. */
    tournamentType: string;
    /** The `games` row that is ALREADY active in Arcaid. */
    gameId: string;
    gameName: string;
    styleId?: string;
    creds: IScoredCreds;
}

/**
 * Builds the iScored board for a game that is already active in Arcaid, then
 * links it to the game (F10).
 *
 * The web Activate button and the web pick used to build the board FIRST and
 * activate second, inside the HTTP request. Building a board is four iScored
 * page flows with retries, which can outrun Cloudflare's 100 s limit (the
 * admin saw HTTP 524), and any iScored failure refused the activation outright
 * (ProBros, 2026-11-10: their iScored room had been emptied, every White Water
 * activation timed out, and the weekly sat empty for two days). Arcaid is the
 * record and iScored is a mirror, so those routes now commit the activation,
 * answer, and call this.
 *
 * Never throws. A failure leaves the game live with no board and writes a
 * `problem` row on Room Admin -> Activity that names the retry (Game States ->
 * "Create on iScored"). Until the board links, a web score on this game is not
 * copied to iScored: `IScoredSubmitSync` needs an `iscored_id`.
 */
export function createIScoredBoardAfterActivation(req: IScoredBoardRequest): Promise<void> {
    return trackBackground(run(req));
}

async function run(req: IScoredBoardRequest): Promise<void> {
    let iscoredId: string;
    try {
        const { IScoredSessionRegistry } = await import('./IScoredSessionRegistry.js');
        iscoredId = await IScoredSessionRegistry.getInstance().withSession(req.creds, async (client) => {
            const id = await client.createGame(req.gameName, req.styleId);
            await client.setGameTags(id, req.tournamentType);
            await client.setGameStatus(id, { locked: false, hidden: false });
            return id;
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logWarn(`iScored board for "${req.gameName}" (game ${req.gameId}) could not be created; the game is live in Arcaid without one:`, err);
        await recordProblem(req, `${req.gameName} is live in Arcaid, but its iScored board could not be created: ${message.slice(0, 200)}. Retry from Game States -> Create on iScored.`, message);
        return;
    }

    try {
        const db = await getDatabase();
        // Only fill an empty link: a game deleted meanwhile, or linked by an
        // admin's "Create on iScored", keeps what it has.
        const res = await db.run('UPDATE games SET iscored_id = ? WHERE id = ? AND iscored_id IS NULL', iscoredId, req.gameId);
        if (!res.changes) {
            logWarn(`iScored board ${iscoredId} for "${req.gameName}" was created, but game ${req.gameId} is gone or already linked, so the board is not linked to Arcaid.`);
            await recordProblem(req, `An iScored board for ${req.gameName} was created (iScored id ${iscoredId}) but is not linked to an Arcaid game; the game was removed or linked another way. Delete the extra board on iScored if you don't need it.`, 'board created after the game was removed or linked');
            return;
        }
        logInfo(`   -> Created on iScored: ${req.gameName} (ID: ${iscoredId}), linked to game ${req.gameId}`);

        const { TournamentEngine } = await import('./TournamentEngine.js');
        await TournamentEngine.getInstance().reorderIScoredLineup(req.roomId).catch(err =>
            logWarn('Failed to reorder iScored lineup after activation:', err),
        );
    } catch (err) {
        logWarn(`iScored board ${iscoredId} for "${req.gameName}" was created but could not be linked to game ${req.gameId}:`, err);
    }
}

async function recordProblem(req: IScoredBoardRequest, summary: string, reason: string): Promise<void> {
    const { ActivityLogService } = await import('../services/ActivityLogService.js');
    await ActivityLogService.record({
        roomId: req.roomId,
        category: 'server',
        eventType: 'iscored_board_failed',
        severity: 'problem',
        tournamentId: req.tournamentId,
        gameId: req.gameId,
        gameName: req.gameName,
        summary,
        details: { reasons: [reason.slice(0, 300)] },
    });
}
