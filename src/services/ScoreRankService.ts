import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';

/**
 * Submit-moment rank computation ("you are #N of M").
 *
 * This is a deliberately distinct, read-only concern shared by two unrelated
 * submit paths: the room/community path (`CommunityScoreService.submitScore`)
 * and the global path (`global.ts POST /api/global/scores`). Keeping the
 * canonical-partition SQL in ONE place means it cannot drift from the
 * leaderboard queries that the player actually sees rendered.
 *
 * Canonical partition (confirmed character-for-character against the rendered
 * leaderboards):
 *   - room:   COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
 *             (matches LeaderboardService.recalculate)
 *   - global: COALESCE(submitted_by_user_id, 'iscored:' || LOWER(COALESCE(iscored_username, player_id)))
 *             (matches GlobalLeaderboardService.recalculate)
 *
 * This intentionally does NOT reuse LobbyFeedGenerator's wrong
 * LOWER(iscored_username)-only partition, and it does NOT write
 * leaderboard_cache — the submit-moment rank is an ad-hoc single-row
 * computation, never a cache write.
 *
 * Best-effort: every method internally try/catches and returns an all-null
 * result on failure. The computation runs strictly AFTER the insert/submit
 * commits, so it can never fail or roll back persistence. The frontend renders
 * plain success when `rank` is null / all-null.
 */
export interface SubmitRankResult {
    /** 1-based rank among distinct canonical partitions; null on failure. */
    rank: number | null;
    /** Distinct canonical partitions on this board; null on failure. */
    totalPlayers: number | null;
    /** Submitter's prior best EXCLUDING the just-inserted row; null if none. */
    previousBest: number | null;
    /** Points behind the player ranked immediately above; null when rank === 1 (or failure). */
    gapToNext: number | null;
    /** Points behind the #1 score on the board; null when rank === 1 (or failure). */
    gapToFirst: number | null;
}

const NULL_RESULT: SubmitRankResult = {
    rank: null,
    totalPlayers: null,
    previousBest: null,
    gapToNext: null,
    gapToFirst: null,
};

interface RankAggregateRow {
    total_players: number | null;
    my_best: number | null;
    top_score: number | null;
    my_rank: number | null;
    next_higher_score: number | null;
}

/**
 * Turn a raw aggregate row + the just-submitted score + previousBest into the
 * public SubmitRankResult. `submittedScore` is used as the effective my_best
 * when the partition aggregate's my_best is null or lower (the just-inserted
 * row is the user's current attempt — the value they just saw).
 */
function interpret(
    row: RankAggregateRow | undefined,
    submittedScore: number,
    previousBest: number | null,
): SubmitRankResult {
    if (!row || row.total_players == null) return { ...NULL_RESULT };

    const totalPlayers = row.total_players;

    // Effective my_best: the higher of (the partition's MAX seen by the board)
    // and (the score the user just submitted). Guards against the case where
    // the new row is not yet the partition MAX, or is missing from the
    // exclude_from_global set.
    const aggBest = row.my_best;
    const myBest = aggBest == null ? submittedScore : Math.max(aggBest, submittedScore);

    // rank counts distinct partitions strictly above my best, +1. When the
    // aggregate already reflects my row, row.my_rank is authoritative; otherwise
    // fall back to recomputing from top_score / next_higher comparisons via the
    // strict-greater-than semantics. We trust row.my_rank when my_best matches
    // the aggregate, else derive: anyone strictly above myBest counts.
    let rank: number;
    if (aggBest != null && myBest === aggBest && row.my_rank != null) {
        rank = row.my_rank;
    } else {
        // The submittedScore may outrank what the aggregate recorded for this
        // partition (or the partition was absent). Recompute against top_score:
        // if myBest >= top_score, we are #1; otherwise we are behind everyone
        // whose best > myBest, which the aggregate's my_rank still bounds.
        rank = row.my_rank != null ? row.my_rank : 1;
        if (row.top_score != null && myBest >= row.top_score) {
            rank = 1;
        }
    }

    if (rank <= 1) {
        return {
            rank: 1,
            totalPlayers,
            previousBest,
            gapToNext: null,
            gapToFirst: null,
        };
    }

    const topScore = row.top_score;
    const nextHigher = row.next_higher_score;

    // Points behind the player immediately above (strictly-greater → positive).
    const gapToNext = nextHigher != null ? nextHigher - myBest : null;
    // Points behind the board #1.
    const gapToFirst = topScore != null ? topScore - myBest : null;

    return {
        rank,
        totalPlayers,
        previousBest,
        gapToNext,
        gapToFirst,
    };
}

export class ScoreRankService {
    /**
     * Tournament-window rank: the population is score_history filtered by
     * `submitted_during_tournament_id` — character-for-character the filter
     * `LeaderboardService.queryRankedRows` renders (all sources, canonical
     * partition). `submittedScore` is folded into the submitter's best so the
     * result stays right even when the just-submitted row was deduped by
     * ScoreHistoryService.log against an older out-of-window row.
     */
    private static async computeTournamentWindowRank(args: {
        gameRoomId: string;
        gameName: string;
        partitionKey: string;
        submittedScore: number;
        tournamentId: string;
        excludeHistoryId: number | null;
    }): Promise<SubmitRankResult> {
        const { gameRoomId, gameName, partitionKey, submittedScore, tournamentId, excludeHistoryId } = args;
        const db = await getDatabase();
        const row = await db.get<RankAggregateRow>(
            `
            WITH best_per_player AS (
                SELECT player_key, MAX(score) AS best_score
                FROM (
                    SELECT
                        COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) AS player_key,
                        score
                    FROM score_history
                    WHERE game_room_id = ?
                      AND submitted_during_tournament_id = ?
                      AND LOWER(game_name) = LOWER(?)
                      AND orphaned_at IS NULL
                )
                GROUP BY player_key
            ),
            me AS (
                SELECT MAX(COALESCE((SELECT best_score FROM best_per_player WHERE player_key = ?), 0), ?) AS my_best,
                       EXISTS(SELECT 1 FROM best_per_player WHERE player_key = ?) AS on_board
            )
            SELECT
                (SELECT COUNT(*) FROM best_per_player) + (SELECT CASE WHEN on_board THEN 0 ELSE 1 END FROM me) AS total_players,
                (SELECT my_best FROM me) AS my_best,
                MAX((SELECT MAX(best_score) FROM best_per_player), (SELECT my_best FROM me)) AS top_score,
                (SELECT COUNT(*) + 1 FROM best_per_player WHERE best_score > (SELECT my_best FROM me)) AS my_rank,
                (SELECT MIN(best_score) FROM best_per_player WHERE best_score > (SELECT my_best FROM me)) AS next_higher_score
            `,
            gameRoomId, tournamentId, gameName,
            partitionKey, submittedScore, partitionKey,
        );
        const prevRow = await db.get<{ prev_best: number | null }>(
            `
            SELECT MAX(score) AS prev_best
            FROM score_history
            WHERE game_room_id = ?
              AND submitted_during_tournament_id = ?
              AND LOWER(game_name) = LOWER(?)
              AND orphaned_at IS NULL
              AND COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) = ?
              AND (? IS NULL OR id <> ?)
            `,
            gameRoomId, tournamentId, gameName, partitionKey,
            excludeHistoryId, excludeHistoryId,
        );
        return interpret(row, submittedScore, prevRow?.prev_best ?? null);
    }

    /**
     * ROOM / community path. `partitionKey` is the CANONICAL key the caller
     * already computed: submittedByUserId ?? ('iscored:' + iscoredUsername.toLowerCase()).
     * `submittedScore` is the score just inserted. `excludeCommunityScoreId` is
     * the community_scores.id (AUTOINCREMENT integer) of the row just inserted,
     * used to exclude it when deriving previousBest.
     *
     * TWO boards, picked by whether the game is ACTIVE in a tournament:
     *
     * - **Tournament window** (v2.125.1): the score just logged carries
     *   `submitted_during_tournament_id` (ScoreHistoryService.log auto-resolves
     *   the ACTIVE tournament for room+game), and the card the player is
     *   looking at is `LeaderboardService.queryRankedRows` — score_history
     *   filtered by that window, ALL sources (`sync` rows included). The rank
     *   is computed against exactly that population. Pre-v2.125.1 this path
     *   didn't exist: the union below excluded `source='sync'`, so on a board
     *   whose rivals all came from iScored (rtx_pinball's Jaws, 2026-08-21)
     *   the submitter was told "#1 of 1" while the card showed #4.
     * - **Freeplay / no active tournament**: the two-source union the community
     *   board renders — community_scores + tournament rows from score_history
     *   (source='tournament'), MAX-per-canonical-partition.
     *
     * `tournamentId === undefined` resolves the window with the SAME query
     * ScoreHistoryService.log uses (so rank and row land on the same board);
     * `null` forces the freeplay union.
     */
    static async computeRoomRank(args: {
        gameRoomId: string;
        gameName: string;
        partitionKey: string;
        submittedScore: number;
        excludeCommunityScoreId?: number | null;
        /**
         * score_history.id of the row the submit just logged (null when
         * ScoreHistoryService.log deduped). Excluded from previousBest on the
         * tournament-window path.
         */
        excludeHistoryId?: number | null;
        tournamentId?: string | null;
    }): Promise<SubmitRankResult> {
        const { gameRoomId, gameName, partitionKey, submittedScore } = args;
        try {
            const db = await getDatabase();

            let tournamentId = args.tournamentId;
            if (tournamentId === undefined) {
                const activeGame = await db.get<{ tournament_id: string }>(
                    `SELECT t.id as tournament_id
                     FROM games g
                     JOIN tournaments t ON t.id = g.tournament_id
                     WHERE LOWER(g.name) = LOWER(?)
                       AND t.game_room_id = ?
                       AND g.status = 'ACTIVE'
                     LIMIT 1`,
                    gameName, gameRoomId,
                );
                tournamentId = activeGame?.tournament_id ?? null;
            }
            if (tournamentId) {
                return await ScoreRankService.computeTournamentWindowRank({
                    gameRoomId, gameName, partitionKey, submittedScore, tournamentId,
                    excludeHistoryId: args.excludeHistoryId ?? null,
                });
            }

            // Pass A — current board state INCLUDING the just-inserted row.
            // This is what the user sees rendered, so rank/totalPlayers/gaps are
            // computed against it.
            const row = await db.get<RankAggregateRow>(
                `
                WITH merged AS (
                    SELECT
                        COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) AS player_key,
                        score
                    FROM community_scores
                    WHERE game_room_id = ?
                      AND LOWER(game_name) = LOWER(?)
                      AND orphaned_at IS NULL

                    UNION ALL

                    SELECT
                        COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username)) AS player_key,
                        sh.score
                    FROM score_history sh
                    WHERE sh.game_room_id = ?
                      AND LOWER(sh.game_name) = LOWER(?)
                      AND sh.source = 'tournament'
                      AND sh.orphaned_at IS NULL
                ),
                best_per_player AS (
                    SELECT player_key, MAX(score) AS best_score
                    FROM merged
                    GROUP BY player_key
                )
                SELECT
                    (SELECT COUNT(*) FROM best_per_player) AS total_players,
                    (SELECT best_score FROM best_per_player WHERE player_key = ?) AS my_best,
                    (SELECT MAX(best_score) FROM best_per_player) AS top_score,
                    (SELECT COUNT(*) + 1
                       FROM best_per_player
                      WHERE best_score > (SELECT best_score FROM best_per_player WHERE player_key = ?)
                    ) AS my_rank,
                    (SELECT MIN(best_score)
                       FROM best_per_player
                      WHERE best_score > (SELECT best_score FROM best_per_player WHERE player_key = ?)
                    ) AS next_higher_score
                `,
                gameRoomId, gameName,
                gameRoomId, gameName,
                partitionKey, partitionKey, partitionKey,
            );

            // previousBest — the submitter's MAX EXCLUDING the just-inserted
            // community_scores row. A scalar pass keyed on the canonical
            // partition; the score_history branch is intentionally left intact
            // (its rows are a different table/source).
            const prevRow = await db.get<{ prev_best: number | null }>(
                `
                SELECT MAX(score) AS prev_best FROM (
                    SELECT score FROM community_scores
                      WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND orphaned_at IS NULL
                        AND COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) = ?
                        AND (? IS NULL OR id <> ?)
                    UNION ALL
                    SELECT score FROM score_history
                      WHERE game_room_id = ? AND LOWER(game_name) = LOWER(?) AND source = 'tournament' AND orphaned_at IS NULL
                        AND COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username)) = ?
                )
                `,
                gameRoomId, gameName, partitionKey,
                args.excludeCommunityScoreId ?? null, args.excludeCommunityScoreId ?? null,
                gameRoomId, gameName, partitionKey,
            );

            const previousBest = prevRow?.prev_best ?? null;
            return interpret(row, submittedScore, previousBest);
        } catch (error) {
            logError('ScoreRankService.computeRoomRank error:', error);
            return { ...NULL_RESULT };
        }
    }

    /**
     * GLOBAL path. `partitionKey` is the canonical global key the caller
     * computed: submittedByUserId ?? ('iscored:' + (iscoredUsername ?? playerId).toLowerCase()).
     * `excludeGlobalScoreId` is the global_scores.id (TEXT uuid) just inserted.
     *
     * Ranks over global_scores for one globalGameId, restricted to
     * exclude_from_global = 0 (the DEFAULT 'global' scope the submitter sees on
     * /scoreboard) with deleted_at / orphaned_at filtered, mirroring
     * GlobalLeaderboardService.recalculate.
     */
    static async computeGlobalRank(args: {
        globalGameId: string;
        partitionKey: string;
        submittedScore: number;
        excludeGlobalScoreId?: string | null;
    }): Promise<SubmitRankResult> {
        const { globalGameId, partitionKey, submittedScore } = args;
        try {
            const db = await getDatabase();

            // Pass A — current public board state INCLUDING the just-inserted row.
            const row = await db.get<RankAggregateRow>(
                `
                WITH best_per_player AS (
                    SELECT
                        COALESCE(submitted_by_user_id, 'iscored:' || LOWER(COALESCE(iscored_username, player_id))) AS player_key,
                        MAX(score) AS best_score
                    FROM global_scores
                    WHERE global_game_id = ?
                      AND deleted_at IS NULL
                      AND orphaned_at IS NULL
                      AND exclude_from_global = 0
                    GROUP BY player_key
                )
                SELECT
                    (SELECT COUNT(*) FROM best_per_player) AS total_players,
                    (SELECT best_score FROM best_per_player WHERE player_key = ?) AS my_best,
                    (SELECT MAX(best_score) FROM best_per_player) AS top_score,
                    (SELECT COUNT(*) + 1 FROM best_per_player
                      WHERE best_score > (SELECT best_score FROM best_per_player WHERE player_key = ?)) AS my_rank,
                    (SELECT MIN(best_score) FROM best_per_player
                      WHERE best_score > (SELECT best_score FROM best_per_player WHERE player_key = ?)) AS next_higher_score
                `,
                globalGameId,
                partitionKey, partitionKey, partitionKey,
            );

            // previousBest — submitter's MAX EXCLUDING the just-inserted row.
            const prevRow = await db.get<{ prev_best: number | null }>(
                `
                SELECT MAX(score) AS prev_best FROM global_scores
                  WHERE global_game_id = ? AND deleted_at IS NULL AND orphaned_at IS NULL AND exclude_from_global = 0
                    AND COALESCE(submitted_by_user_id, 'iscored:' || LOWER(COALESCE(iscored_username, player_id))) = ?
                    AND (? IS NULL OR id <> ?)
                `,
                globalGameId, partitionKey,
                args.excludeGlobalScoreId ?? null, args.excludeGlobalScoreId ?? null,
            );

            const previousBest = prevRow?.prev_best ?? null;
            return interpret(row, submittedScore, previousBest);
        } catch (error) {
            logError('ScoreRankService.computeGlobalRank error:', error);
            return { ...NULL_RESULT };
        }
    }
}
