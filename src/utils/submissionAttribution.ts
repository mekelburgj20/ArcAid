import { isProviderUserId } from './identityProvider.js';

/**
 * Resolve a `submissions` row's player id using the SAME precedence
 * `TournamentEngine.processSlotMaintenance` uses to resolve a game's winner
 * (v2.35.0): the row's OWN attribution (`submitted_by_user_id` for web
 * submits, `discord_user_id` for legacy Discord-bot submits/iScored sync —
 * shape-checked via `isProviderUserId` since `discord_user_id` carries legacy
 * sentinels like 'COMMUNITY'/'ANON'/'SYSTEM'), falling back to a
 * `user_mappings` lookup by iScored username only when the row has no direct
 * attribution at all.
 *
 * Extracted so the next-win disposition resolver (winner + runner-up + the
 * dynasty check's previous-slot winner) and the rotation-readiness nudge (top
 * 3 on the active slot) all derive "who is this row's player" identically —
 * one definition, reused everywhere a submissions row needs a discord id.
 */
export interface SubmissionAttributionRow {
    iscored_username?: string | null;
    discord_user_id?: string | null;
    submitted_by_user_id?: string | null;
}

export async function resolveSubmissionPlayerId(
    db: { get: (sql: string, ...params: any[]) => Promise<any> },
    row: SubmissionAttributionRow | null | undefined,
): Promise<string | null> {
    if (!row) return null;
    if (row.submitted_by_user_id) return row.submitted_by_user_id;
    const directId = row.discord_user_id && isProviderUserId(row.discord_user_id) ? row.discord_user_id : null;
    if (directId) return directId;
    if (row.iscored_username) {
        const mapping = await db.get(
            'SELECT discord_user_id FROM user_mappings WHERE LOWER(iscored_username) = LOWER(?)',
            row.iscored_username,
        );
        return mapping?.discord_user_id ?? null;
    }
    return null;
}

/** Top-N submissions for a game, in score order, each already resolved to a
 *  player id (rows with no resolvable id are dropped). */
export async function resolveTopSubmissionPlayers(
    db: { all: (sql: string, ...params: any[]) => Promise<any[]>; get: (sql: string, ...params: any[]) => Promise<any> },
    gameId: string,
    limit: number,
): Promise<Array<{ playerId: string; iscoredUsername: string | null; score: number }>> {
    const rows = await db.all(
        `SELECT iscored_username, discord_user_id, submitted_by_user_id, score FROM submissions
         WHERE game_id = ? ORDER BY score DESC LIMIT ?`,
        gameId, limit,
    );
    const out: Array<{ playerId: string; iscoredUsername: string | null; score: number }> = [];
    for (const row of rows) {
        const playerId = await resolveSubmissionPlayerId(db, row);
        if (playerId) out.push({ playerId, iscoredUsername: row.iscored_username ?? null, score: row.score });
    }
    return out;
}
