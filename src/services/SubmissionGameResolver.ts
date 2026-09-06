import { getDatabase } from '../database/database.js';
import { logWarn } from '../utils/logger.js';

/**
 * The one games row a web submission belongs to.
 */
export interface ResolvedSubmissionGame {
    id: string;
    tournament_id: string | null;
    status: string;
    name: string;
    /**
     * True when the resolution had to pick a winner among several ACTIVE
     * rows sharing this name in this room — the ambiguous-active-games bug
     * class (v2.155.1; the WG-VR / Daily Grind "Black Rose" incident,
     * 2026-09-03..06). Callers may want to log/flag this even though a
     * decision was still made.
     */
    ambiguous: boolean;
}

interface CandidateRow {
    id: string;
    tournament_id: string;
    status: string;
    name: string;
    start_date: string | null;
    created_at: string;
    tournament_name: string;
}

interface ByIdRow extends CandidateRow {
    game_room_id: string | null;
}

/**
 * Resolve which `games` row a web score submission belongs to.
 *
 * v2.155.1 — extracted so the `submissions` upsert (in the submit routes) and
 * `ScoreHistoryService.log`'s tournament stamp (and the leaderboard cache
 * invalidation that follows either) all make the SAME decision. Before this,
 * each ran its own name lookup with a different `ORDER BY` (or none at all),
 * so a room with two ACTIVE games sharing a name — e.g. "Black Rose" ACTIVE
 * in both Weekly Grind - VR and Daily Grind at once — could write the
 * `submissions` row to one tournament, stamp `score_history` with a
 * DIFFERENT tournament, and invalidate the cache of a THIRD (wrong) game,
 * leaving the score on no leaderboard at all.
 *
 * ## Resolution order
 *
 * 1. `gameId`, when given, is authoritative IF it actually matches this room,
 *    this name (case-insensitively), and a submittable status
 *    (`ACTIVE`/`COMPLETED`) — the FE sheet knows exactly which card the
 *    player pressed "Submit" on. A pinned game (`tournament_id IS NULL`) is
 *    never a valid target here. A mismatch is logged and treated as if no
 *    `gameId` had been supplied at all — never as an error, since older
 *    clients never send one.
 * 2. Name lookup across ALL games in this room with this name whose status is
 *    `ACTIVE` or `COMPLETED`. ACTIVE rows are preferred; when MULTIPLE rows
 *    are ACTIVE at once (the bug class this exists to close), the one with
 *    the EARLIEST `start_date` wins (NULL sorts last; ties broken by the
 *    earliest `created_at`) and a WARN names every competing tournament plus
 *    the one that won, so an operator can see it happened.
 * 3. No ACTIVE row at all: the newest `COMPLETED` row by `created_at DESC`
 *    (the v2.100.3 contract — see `submit-score-game-resolution.test.ts`,
 *    which this preserves).
 *
 * Returns `null` when nothing in this room has this name at all.
 */
export async function resolveSubmissionGame(params: {
    roomId: string;
    gameName: string;
    gameId?: string | null;
}): Promise<ResolvedSubmissionGame | null> {
    const { roomId, gameName } = params;
    const db = await getDatabase();

    if (params.gameId) {
        const byId = await db.get<ByIdRow>(
            `SELECT g.id, g.tournament_id, g.status, g.name, g.start_date, g.created_at,
                    t.name as tournament_name, t.game_room_id
             FROM games g
             JOIN tournaments t ON t.id = g.tournament_id
             WHERE g.id = ?`,
            params.gameId,
        );
        const matches = !!byId
            && byId.game_room_id === roomId
            && byId.name.toLowerCase() === gameName.toLowerCase()
            && (byId.status === 'ACTIVE' || byId.status === 'COMPLETED');
        if (matches) {
            return {
                id: byId!.id,
                tournament_id: byId!.tournament_id,
                status: byId!.status,
                name: byId!.name,
                ambiguous: false,
            };
        }
        logWarn(
            `submit: ignoring gameId ${params.gameId} for game "${gameName}" in room ${roomId} ` +
            `(room/name/status mismatch) — falling back to name lookup`,
        );
    }

    const candidates = await db.all<CandidateRow[]>(
        `SELECT g.id, g.tournament_id, g.status, g.name, g.start_date, g.created_at,
                t.name as tournament_name
         FROM games g
         JOIN tournaments t ON t.id = g.tournament_id
         WHERE LOWER(g.name) = LOWER(?) AND t.game_room_id = ?
           AND g.status IN ('ACTIVE', 'COMPLETED')`,
        gameName, roomId,
    );
    if (candidates.length === 0) return null;

    const actives = candidates.filter(c => c.status === 'ACTIVE');
    if (actives.length > 0) {
        // Earliest start_date wins; NULL start_date sorts last; ties broken
        // by earliest created_at.
        const sorted = [...actives].sort((a, b) => {
            if (a.start_date === null && b.start_date !== null) return 1;
            if (a.start_date !== null && b.start_date === null) return -1;
            if (a.start_date !== null && b.start_date !== null && a.start_date !== b.start_date) {
                return a.start_date < b.start_date ? -1 : 1;
            }
            if (a.created_at !== b.created_at) return a.created_at < b.created_at ? -1 : 1;
            return 0;
        });
        const winner = sorted[0]!;
        const ambiguous = actives.length > 1;
        if (ambiguous) {
            const names = actives.map(a => `"${a.tournament_name}"${a.id === winner.id ? ' (won)' : ''}`).join(', ');
            logWarn(
                `submit: ambiguous ACTIVE game "${gameName}" in room ${roomId} — ` +
                `${actives.length} tournaments each have an ACTIVE row named this: ${names}`,
            );
        }
        return {
            id: winner.id,
            tournament_id: winner.tournament_id,
            status: winner.status,
            name: winner.name,
            ambiguous,
        };
    }

    // No ACTIVE row: newest COMPLETED by created_at DESC (v2.100.3 contract).
    const completed = [...candidates].sort((a, b) => {
        if (a.created_at !== b.created_at) return a.created_at > b.created_at ? -1 : 1;
        return 0;
    });
    const winner = completed[0]!;
    return {
        id: winner.id,
        tournament_id: winner.tournament_id,
        status: winner.status,
        name: winner.name,
        ambiguous: false,
    };
}
