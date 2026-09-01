import { getDatabase } from '../database/database.js';
import { ScoreHistoryService } from './ScoreHistoryService.js';
import { normalizeSubmitterUserId } from './SubmissionContextService.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import { logInfo } from '../utils/logger.js';

/**
 * Writing a score to a Throwdown (v2.136.0, ADR 0018).
 *
 * ## Why this is not `CommunityScoreService.submitScore`
 *
 * That path writes `community_scores`, whose `game_room_id` is `NOT NULL` — and
 * a Throwdown has no room. Rather than rebuild a second table to make it
 * nullable, a Throwdown writes **`score_history` only**, which is fine because
 * `score_history` is already the physical union every read path uses:
 * `EventResultService` computes the boards and standings from
 * `submitted_during_tournament_id` alone and never looks at `community_scores`.
 *
 * ## What a Throwdown score deliberately does NOT do
 *
 * - ~~**No global-scoreboard fan-out.**~~ **REVERSED in v2.153.0 (ADR 0023.)**
 *   The original note called this "a product call, not an implementation
 *   detail", and the product call has now been made the other way: a player
 *   should be rewarded for a score wherever they earned it, so a Throwdown
 *   score fans out like any other. `fanOutFromRoomSubmission` tolerates a null
 *   room and records the row as global-origin — which is exactly what a
 *   challenge belonging to no room is. Opting out is the player's choice
 *   (`share_to_global`), never the format's.
 * - **No iScored sync.** iScored boards belong to rooms.
 * - **No room name claim.** `RoomNameClaimService` is per-room first-claim-wins;
 *   with no room there is nothing to claim against, so the player's global
 *   display name is used as-is.
 */

export interface ThrowdownSubmitInput {
    tournamentId: string;
    /** The round's `games.id`, from the gate — never re-resolved by name here. */
    gameId: string;
    gameName: string;
    userId: string;
    /** The name this score renders under; the caller resolves it. */
    username: string;
    score: number;
    engine?: string | null;
    device?: string | null;
    platform?: string | null;
}

export class ThrowdownScoreService {
    /**
     * @returns the new `score_history.id`, or null when the row was deduped
     *   (an identical score already exists for this player on this round).
     */
    static async submit(input: ThrowdownSubmitInput): Promise<{ historyId: number | null; rank: number | null }> {
        const historyId = await ScoreHistoryService.log({
            gameName: input.gameName,
            // The whole point of migration 164 — a score with no game room.
            gameRoomId: null,
            gameId: input.gameId,
            username: input.username,
            discordUserId: input.userId,
            score: input.score,
            source: 'community',
            tournamentId: input.tournamentId,
            platform: input.platform ?? null,
            engine: input.engine ?? UNKNOWN,
            device: input.device ?? UNKNOWN,
        });

        // v2.153.0 (ADR 0023): a Throwdown score reaches the Global Scoreboard
        // like any other. Room-less is not a reason to hide it — the fan-out
        // now tolerates a null room and records the row as global-origin, which
        // is exactly what a challenge that belongs to no room is.
        if (historyId != null) {
            const { GlobalScoreService } = await import('./GlobalScoreService.js');
            await GlobalScoreService.fanOutAutomatedScore({
                gameRoomId: null,
                gameName: input.gameName,
                gameId: input.gameId,
                canonicalUserId: normalizeSubmitterUserId(input.userId),
                username: input.username,
                score: input.score,
                tournamentId: input.tournamentId,
                platform: input.platform ?? null,
                engine: input.engine ?? UNKNOWN,
                device: input.device ?? UNKNOWN,
                source: 'tournament',
            });
        }

        logInfo(`Throwdown score: ${input.username} ${input.score} on ${input.gameName} (${input.tournamentId})`);
        return { historyId, rank: await ThrowdownScoreService.rankFor(input.tournamentId, input.userId, input.username) };
    }

    /**
     * "You are #N" at the moment of submitting — ranked against everyone in this
     * Throwdown, on best-per-player, which is what the board itself shows.
     */
    static async rankFor(tournamentId: string, userId: string, username: string): Promise<number | null> {
        const db = await getDatabase();
        const submittedBy = normalizeSubmitterUserId(userId);
        const rows = await db.all<Array<{ identity_key: string; best: number }>>(
            `SELECT COALESCE(sh.submitted_by_user_id, 'anon:' || LOWER(sh.iscored_username)) AS identity_key,
                    MAX(sh.score) AS best
               FROM score_history sh
              WHERE sh.submitted_during_tournament_id = ? AND sh.orphaned_at IS NULL
              GROUP BY identity_key
              ORDER BY best DESC`,
            tournamentId,
        );
        const key = submittedBy ?? `anon:${username.toLowerCase()}`;
        const index = rows.findIndex(r => r.identity_key === key);
        return index === -1 ? null : index + 1;
    }
}
