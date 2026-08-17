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

/**
 * The finishing order of a completed slot expressed as PLACES — 1st, 2nd, 3rd —
 * rather than as submission rows. This is what the pick cascade walks
 * (tmp/pick-delegation-contract.md §3).
 *
 * Differs from `resolveTopSubmissionPlayers` in three ways that all matter once
 * a place can be awarded a pick:
 *
 *  1. **`orphaned_at IS NULL`.** A ban-hidden score must not resurface as the
 *     runner-up — same leak class the Discord drift audit closed in
 *     /list-winners, and already guarded in the old `resolveRunnerUp`.
 *  2. **Deduplicated by resolved identity.** One human can hold several rows on
 *     one board (a web submission plus an iScored-synced row under the same
 *     name, as ChalataLove did on Blackbelt 2018 — 1st AND 3rd). Without this
 *     they could be handed the pick as their own runner-up.
 *  3. **`maxPlaces` counts PLACES, not rows.** The limit is applied after
 *     dropping unattributed and duplicate rows, so asking for 3 places yields 3
 *     real players when 3 exist. Unattributed rows (an iScored-only name with no
 *     linked account) are skipped entirely: they cannot be DM'd, cannot hold a
 *     pick window, and have no queue — see contract §4.3.
 */
export async function resolveLeaderboardPlaces(
    db: { all: (sql: string, ...params: any[]) => Promise<any[]>; get: (sql: string, ...params: any[]) => Promise<any> },
    gameId: string,
    maxPlaces: number,
): Promise<Array<{ playerId: string; iscoredUsername: string | null; score: number }>> {
    const rows = await db.all(
        `SELECT iscored_username, discord_user_id, submitted_by_user_id, score FROM submissions
         WHERE game_id = ? AND orphaned_at IS NULL ORDER BY score DESC LIMIT 200`,
        gameId,
    );
    const out: Array<{ playerId: string; iscoredUsername: string | null; score: number }> = [];
    const seen = new Set<string>();
    for (const row of rows) {
        if (out.length >= maxPlaces) break;
        const playerId = await resolveSubmissionPlayerId(db, row);
        if (!playerId || seen.has(playerId)) continue;
        seen.add(playerId);
        out.push({ playerId, iscoredUsername: row.iscored_username ?? null, score: row.score });
    }
    return out;
}
