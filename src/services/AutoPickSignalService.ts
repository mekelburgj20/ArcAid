import { getDatabase } from '../database/database.js';
import { queueOrderSql } from '../utils/queueOrder.js';
import { gameRunWindowSql } from '../utils/gameRunWindow.js';
import {
    DEFAULT_SITE_MEAN, LOW_RATING_MAX, UNLABELLED_CONTRIBUTOR, formatQueueCredit,
    type AutoPickContributor, type AutoPickPlayerQueue, type AutoPickRating, type AutoPickRound,
    type AutoPickSignals, type AutoPickResult,
} from '../utils/autoPickRanking.js';
import { resolveUserLabels } from './PlayerProfileResolver.js';

/**
 * Loads the signals `rankAutoPick` (src/utils/autoPickRanking.ts) ranks on, in
 * a handful of batched queries, and applies a Tier 1 pick's queue consumption
 * (v2.219.0, ADR 0036). Both auto-pick sites call `load` then the ranker.
 */
export class AutoPickSignalService {
    static async load(opts: {
        tournamentId: string;
        gameRoomId: string | null | undefined;
        /** The site's eligible names (any case); bounds the per-name queries. */
        names: string[];
    }): Promise<AutoPickSignals> {
        const db = await getDatabase();
        const { tournamentId } = opts;
        const roomId = opts.gameRoomId ?? null;
        const namesJson = JSON.stringify([...new Set(opts.names.map(n => n.toLowerCase()))]);

        // Queues: every player's QUEUED rows in THIS tournament, in the ONE
        // queue order (grouped by player first; within a player the order is
        // exactly `queueOrderSql`). Placeholders and ownerless rows are no vote.
        const queueRows = await db.all(
            `SELECT id, name, picker_discord_id, rowid AS rid FROM games
              WHERE tournament_id = ? AND status = 'QUEUED'
                AND picker_discord_id IS NOT NULL AND name != '[Pending Pick]'
              ORDER BY picker_discord_id, ${queueOrderSql()}`,
            tournamentId,
        ) as Array<{ id: string; name: string; picker_discord_id: string; rid: number }>;
        const queueMap = new Map<string, AutoPickPlayerQueue>();
        for (const r of queueRows) {
            const q = queueMap.get(r.picker_discord_id) ?? { userId: r.picker_discord_id, rows: [] };
            q.rows.push({ gameId: r.id, name: r.name, rowid: r.rid });
            queueMap.set(r.picker_discord_id, q);
        }

        // Ratings: one vote per (name, user) — ADR 0035 stores a row per
        // platform, so a user's rows on one table average into one opinion.
        const ratingRows = await db.all(
            `SELECT LOWER(gg.name) AS lname, r.discord_user_id AS uid, AVG(r.rating) AS avg_rating,
                    EXISTS (SELECT 1 FROM room_members rm
                             WHERE rm.room_id = ? AND rm.user_id = r.discord_user_id) AS is_member
               FROM global_game_ratings r
               JOIN global_games gg ON gg.id = r.global_game_id
              WHERE LOWER(gg.name) IN (SELECT value FROM json_each(?))
              GROUP BY LOWER(gg.name), r.discord_user_id`,
            roomId, namesJson,
        ) as Array<{ lname: string; uid: string; avg_rating: number; is_member: number }>;
        const ratings = new Map<string, AutoPickRating>();
        for (const r of ratingRows) {
            const agg = ratings.get(r.lname) ?? { sum: 0, count: 0, memberLow: false };
            agg.sum += r.avg_rating;
            agg.count += 1;
            if (roomId && r.is_member && r.avg_rating <= LOW_RATING_MAX) agg.memberLow = true;
            ratings.set(r.lname, agg);
        }
        const meanRow = await db.get('SELECT AVG(rating) AS m FROM global_game_ratings') as { m: number | null } | undefined;
        const siteMean = typeof meanRow?.m === 'number' ? meanRow.m : DEFAULT_SITE_MEAN;

        // Room reach: distinct players who ever posted on the table in this
        // room (NULL-room Throwdown rows are excluded by the room filter).
        const roomPlayers = new Map<string, number>();
        if (roomId) {
            const rows = await db.all(
                `SELECT LOWER(game_name) AS lname,
                        COUNT(DISTINCT COALESCE(NULLIF(discord_user_id, 'SYSTEM'), LOWER(iscored_username))) AS n
                   FROM score_history
                  WHERE game_room_id = ? AND LOWER(game_name) IN (SELECT value FROM json_each(?))
                  GROUP BY LOWER(game_name)`,
                roomId, namesJson,
            ) as Array<{ lname: string; n: number }>;
            for (const r of rows) roomPlayers.set(r.lname, r.n);
        }

        // Rounds: participation per run, counted the way the tournament
        // boards do (RankingService): tournament attribution + name + the
        // run window — never `score_history.game_id` (sparse on prod).
        const roundRows = await db.all(
            `SELECT g.name, g.start_date,
                    (SELECT COUNT(DISTINCT COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username)))
                       FROM score_history sh
                      WHERE sh.submitted_during_tournament_id = g.tournament_id
                        AND LOWER(sh.game_name) = LOWER(g.name)
                        AND ${gameRunWindowSql('sh', 'g')}
                        AND sh.orphaned_at IS NULL) AS participants
               FROM games g
              WHERE g.tournament_id = ? AND g.status IN ('COMPLETED', 'ARCHIVED') AND g.start_date IS NOT NULL`,
            tournamentId,
        ) as Array<{ name: string; start_date: string; participants: number }>;
        const rounds: AutoPickRound[] = roundRows.map(r => ({
            name: r.name, startDate: r.start_date, participants: r.participants ?? 0,
        }));

        const activeRows = await db.all(
            `SELECT name FROM games WHERE tournament_id = ? AND status = 'ACTIVE'`, tournamentId,
        ) as Array<{ name: string }>;

        return {
            queues: [...queueMap.values()],
            ratings,
            siteMean,
            roomPlayers,
            rounds,
            activeNames: new Set(activeRows.map(r => r.name.toLowerCase())),
        };
    }

    /**
     * Tier 1 consumption: delete every contributing QUEUED row (status
     * guarded, by id). Returns the players whose queues lost a row, so the
     * caller can compact + nudge each the way its own consumption site does.
     * `keepGameId` is the row the site is activating (never deleted).
     */
    static async consumeContributors(
        contributors: AutoPickContributor[] | undefined,
        keepGameId?: string,
    ): Promise<string[]> {
        if (!contributors?.length) return [];
        const db = await getDatabase();
        const affected: string[] = [];
        for (const c of contributors) {
            const ids = c.gameIds.filter(id => id !== keepGameId);
            if (!ids.length) continue;
            const result = await db.run(
                `DELETE FROM games WHERE status = 'QUEUED' AND id IN (${ids.map(() => '?').join(',')})`,
                ...ids,
            );
            if ((result.changes ?? 0) > 0) affected.push(c.userId);
        }
        return affected;
    }

    /** "A, B and C" for a Tier 1 pick — resolved labels, "a member" when none. */
    static async queueCredit(contributors: AutoPickContributor[] | undefined): Promise<string> {
        const ids = (contributors ?? []).map(c => c.userId);
        const names = await resolveUserLabels(ids);
        return formatQueueCredit(ids.map(id => names[id] || UNLABELLED_CONTRIBUTOR));
    }

    /** The `details.autoPick` audit block (raw ids; resolved at read). */
    static auditDetails(ranked: AutoPickResult<{ name: string }>): Record<string, unknown> {
        return {
            tier: ranked.tier,
            points: ranked.points ?? null,
            contributors: (ranked.contributors ?? []).map(c => c.userId),
            tally: ranked.tally,
            weight: Math.round(ranked.weight * 1000) / 1000,
            benchReason: ranked.benchReason ?? null,
            poolSize: ranked.poolSize,
        };
    }
}
