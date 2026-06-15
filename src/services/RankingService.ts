import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';

export type RankMethod = 'max_10' | 'average_rank' | 'best_game_papa' | 'best_game_linear';

export interface RankingGroup {
    id: string;
    name: string;
    description: string;
    rank_method: RankMethod;
    best_n: number;
    min_games: number;
    is_active: boolean;
    created_at: string;
    tournament_ids: string[];
}

export interface OverallRanking {
    rank: number;
    iscored_username: string;
    /** User-chosen global display name; null when unset (FE falls back to iscored_username). */
    display_name?: string | null;
    discord_user_id: string;
    total_points: number;
    games_played: number;
    avatar_hash?: string | null;
    /** Per-game breakdown: game name -> { rank, points } */
    breakdown: Array<{ game_name: string; game_rank: number; points: number }>;
}

/** Points table for Max 10 method */
const MAX_10_POINTS = [100, 80, 65, 50, 40, 30, 20, 15, 10, 5];

export const RANK_METHOD_INFO: Record<RankMethod, { label: string; description: string }> = {
    max_10: {
        label: 'Max 10',
        description: 'Awards points to the top 10 players on each game (1st: 100, 2nd: 80, 3rd: 65, 4th: 50, 5th: 40, 6th: 30, 7th: 20, 8th: 15, 9th: 10, 10th: 5). Best N games count toward total.',
    },
    average_rank: {
        label: 'Average Rank',
        description: 'Ranks players by their average position across all game leaderboards. Lower is better. Players must meet the minimum games threshold to qualify.',
    },
    best_game_papa: {
        label: 'Best Game (PAPA)',
        description: 'Awards points based on rank (1st: 100, 2nd: 90, 3rd: 85, then each subsequent place is 1 point less). Best N games count toward total.',
    },
    best_game_linear: {
        label: 'Best Game (Linear)',
        description: 'Awards points based on rank (1st: 100, 2nd: 99, 3rd: 98, each subsequent place is 1 point less). Best N games count toward total.',
    },
};

export class RankingService {
    /**
     * Get all ranking groups with their tournament IDs.
     */
    static async getAll(gameRoomId?: string): Promise<RankingGroup[]> {
        const db = await getDatabase();
        const groups = gameRoomId
            ? await db.all(`SELECT * FROM ranking_groups WHERE game_room_id = ? ORDER BY name`, gameRoomId)
            : await db.all(`SELECT * FROM ranking_groups ORDER BY name`);
        const result: RankingGroup[] = [];
        for (const g of groups) {
            const tournamentRows = await db.all(
                'SELECT tournament_id FROM ranking_group_tournaments WHERE ranking_group_id = ?',
                g.id
            );
            result.push({
                id: g.id,
                name: g.name,
                description: g.description || '',
                rank_method: g.rank_method as RankMethod,
                best_n: g.best_n,
                min_games: g.min_games,
                is_active: !!g.is_active,
                created_at: g.created_at,
                tournament_ids: tournamentRows.map((r: any) => r.tournament_id),
            });
        }
        return result;
    }

    /**
     * Get a single ranking group by ID.
     */
    static async getById(id: string): Promise<RankingGroup | null> {
        const db = await getDatabase();
        const g = await db.get('SELECT * FROM ranking_groups WHERE id = ?', id);
        if (!g) return null;
        const tournamentRows = await db.all(
            'SELECT tournament_id FROM ranking_group_tournaments WHERE ranking_group_id = ?',
            g.id
        );
        return {
            id: g.id,
            name: g.name,
            description: g.description || '',
            rank_method: g.rank_method as RankMethod,
            best_n: g.best_n,
            min_games: g.min_games,
            is_active: !!g.is_active,
            created_at: g.created_at,
            tournament_ids: tournamentRows.map((r: any) => r.tournament_id),
        };
    }

    /**
     * Create a new ranking group.
     */
    static async create(data: {
        id: string;
        name: string;
        description?: string;
        rank_method: RankMethod;
        best_n: number;
        min_games: number;
        tournament_ids: string[];
        game_room_id?: string;
    }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO ranking_groups (id, name, description, rank_method, best_n, min_games, game_room_id) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            data.id, data.name, data.description || '', data.rank_method, data.best_n, data.min_games, data.game_room_id || null
        );
        for (const tid of data.tournament_ids) {
            await db.run(
                'INSERT INTO ranking_group_tournaments (ranking_group_id, tournament_id) VALUES (?, ?)',
                data.id, tid
            );
        }
        logInfo(`Created ranking group: ${data.name} (${data.rank_method}, ${data.tournament_ids.length} tournaments)`);
    }

    /**
     * Update an existing ranking group.
     */
    static async update(id: string, data: {
        name: string;
        description?: string;
        rank_method: RankMethod;
        best_n: number;
        min_games: number;
        tournament_ids: string[];
    }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE ranking_groups SET name = ?, description = ?, rank_method = ?, best_n = ?, min_games = ? WHERE id = ?`,
            data.name, data.description || '', data.rank_method, data.best_n, data.min_games, id
        );
        // Replace tournament associations
        await db.run('DELETE FROM ranking_group_tournaments WHERE ranking_group_id = ?', id);
        for (const tid of data.tournament_ids) {
            await db.run(
                'INSERT INTO ranking_group_tournaments (ranking_group_id, tournament_id) VALUES (?, ?)',
                id, tid
            );
        }
        // Invalidate cache
        await db.run('DELETE FROM ranking_groups_cache WHERE ranking_group_id = ?', id);
        logInfo(`Updated ranking group: ${data.name}`);
    }

    /**
     * Delete a ranking group.
     */
    static async delete(id: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM ranking_groups WHERE id = ?', id);
        logInfo(`Deleted ranking group: ${id}`);
    }

    /**
     * Toggle active status.
     */
    static async setActive(id: string, active: boolean): Promise<void> {
        const db = await getDatabase();
        await db.run('UPDATE ranking_groups SET is_active = ? WHERE id = ?', active ? 1 : 0, id);
    }

    /**
     * Compute overall rankings for a group.
     */
    static async computeRankings(groupId: string, precomputedWatermark?: string): Promise<OverallRanking[]> {
        const group = await this.getById(groupId);
        if (!group || group.tournament_ids.length === 0) return [];

        const db = await getDatabase();
        const placeholders = group.tournament_ids.map(() => '?').join(',');

        // v2.13.12 — source from score_history (the per-event log), not
        // submissions (the best-ever-per-game cache). Filter by
        // submitted_during_tournament_id matching the game's owning tournament,
        // so only scores submitted DURING the active tournament window count.
        //
        // Why: submissions.game_id can be set by community/freeplay submission
        // paths even when the player never entered the tournament flow. Those
        // rows have score_history.submitted_during_tournament_id = NULL and
        // source = 'community'. Pre-v2.13.12, the rankings query treated them
        // as tournament scores because submissions.game_id matched. See the
        // mekelburgj/Black Rose case 2026-05-23. score_history is the
        // authoritative tournament-window record, mirroring the pattern in
        // LeaderboardService.recalculate.
        //
        // Per-row deletes naturally fall out — admin/self delete drops the
        // score_history row, so it no longer contributes here.
        //
        // Multi-alias collapse: PARTITION BY (game_id, COALESCE(submitted_by_user_id,
        // 'iscored:' || LOWER(iscored_username))) — a Discord user with multiple
        // iScored aliases gets one row per game; pure-anon submissions still
        // partition per-name (consistent with LeaderboardService).
        const rows = await db.all(`
            SELECT
                best.game_id,
                best.game_name,
                best.iscored_username,
                best.discord_user_id,
                best.submitted_by_user_id,
                best.score
            FROM (
                SELECT
                    g.id AS game_id,
                    g.name AS game_name,
                    sh.iscored_username,
                    sh.discord_user_id,
                    sh.submitted_by_user_id,
                    sh.score,
                    ROW_NUMBER() OVER (
                        PARTITION BY g.id, COALESCE(sh.submitted_by_user_id, 'iscored:' || LOWER(sh.iscored_username))
                        ORDER BY sh.score DESC, sh.created_at ASC
                    ) AS rn
                FROM games g
                JOIN score_history sh ON sh.game_id = g.id
                WHERE g.tournament_id IN (${placeholders})
                  AND g.status IN ('ACTIVE','COMPLETED')
                  AND sh.submitted_during_tournament_id = g.tournament_id
                  AND sh.orphaned_at IS NULL
            ) best
            WHERE best.rn = 1
            ORDER BY best.game_id, best.score DESC, best.iscored_username
        `, ...group.tournament_ids);

        if (rows.length === 0) {
            // Still write an empty cache so the watermark can short-circuit
            // subsequent reads until the underlying data changes.
            const watermark = await this.computeDataWatermark(group);
            await db.run(
                `INSERT OR REPLACE INTO ranking_groups_cache (ranking_group_id, rankings, generated_at, data_watermark) VALUES (?, ?, ?, ?)`,
                groupId, '[]', new Date().toISOString(), watermark
            );
            return [];
        }

        // Group rows by game_id and assign per-game ranks. Rows are already
        // ordered by (game_id, score DESC) so rank is just position-within-game.
        const gameRankings = new Map<string, Array<{
            game_name: string;
            iscored_username: string;
            discord_user_id: string;
            submitted_by_user_id: string | null;
            rank: number;
        }>>();

        for (const row of rows) {
            let list = gameRankings.get(row.game_id);
            if (!list) {
                list = [];
                gameRankings.set(row.game_id, list);
            }
            list.push({
                game_name: row.game_name,
                iscored_username: row.iscored_username || 'Unknown',
                discord_user_id: row.discord_user_id || '',
                submitted_by_user_id: row.submitted_by_user_id || null,
                rank: list.length + 1,
            });
        }

        // Aggregate per player. Key matches the SQL PARTITION so each player
        // gets exactly one entry per game (multi-alias collapsed).
        const playerData = new Map<string, {
            iscored_username: string;
            discord_user_id: string;
            games: Array<{ game_name: string; game_rank: number; points: number }>;
        }>();

        for (const [, rankings] of gameRankings) {
            const totalPlayers = rankings.length;
            for (const entry of rankings) {
                const key = entry.submitted_by_user_id ?? `iscored:${entry.iscored_username.toLowerCase()}`;
                if (!playerData.has(key)) {
                    playerData.set(key, {
                        iscored_username: entry.iscored_username,
                        discord_user_id: entry.discord_user_id,
                        games: [],
                    });
                }
                const player = playerData.get(key)!;
                // Prefer real discord ID over synthetic ones (SYSTEM/COMMUNITY/ANON).
                const isSynthetic = (id: string) => !id || id === 'SYSTEM' || id === 'COMMUNITY' || id === 'ANON';
                if (isSynthetic(player.discord_user_id) && !isSynthetic(entry.discord_user_id)) {
                    player.discord_user_id = entry.discord_user_id;
                }

                const points = this.calculatePoints(group.rank_method, entry.rank, totalPlayers);
                player.games.push({
                    game_name: entry.game_name,
                    game_rank: entry.rank,
                    points,
                });
            }
        }

        // Batch-load avatar hashes for all known discord user IDs
        const isSyntheticId = (id: string) => !id || id === 'SYSTEM' || id === 'COMMUNITY' || id === 'ANON';
        // v2.0.1: username fallback is only valid for iScored-synced scores
        // (legitimate attribution of a sync score to a known Discord user).
        // COMMUNITY/ANON/SYSTEM must NOT fall back — those are truly anonymous
        // and the fallback leaks the real user's avatar when the typed name
        // happens to match a user_mapping. See v2.0.0 F.20 regression.
        const canUseUsernameFallback = (id: string) => !!id && id.startsWith('iscored:');
        const discordIds = [...new Set(
            [...playerData.values()]
                .map(p => p.discord_user_id)
                .filter(id => !isSyntheticId(id))
        )];
        // Pull avatar + display_name from user_profiles (keyed by discord_user_id).
        const avatarMap = new Map<string, string>(); // keyed by discord_user_id
        const displayNameMap = new Map<string, string>(); // keyed by discord_user_id
        if (discordIds.length > 0) {
            const ph = discordIds.map(() => '?').join(',');
            const profileRows = await db.all(
                `SELECT discord_user_id, display_name, avatar_hash FROM user_profiles WHERE discord_user_id IN (${ph})`,
                ...discordIds
            );
            for (const row of profileRows) {
                if (row.avatar_hash) avatarMap.set(row.discord_user_id, row.avatar_hash);
                if (row.display_name) displayNameMap.set(row.discord_user_id, row.display_name);
            }
        }
        // iScored-synced fallback: resolve iscored_username → discord_user_id via
        // user_mappings, then JOIN to user_profiles for the avatar + display_name.
        const usernamesFallback = [...playerData.values()]
            .filter(p => canUseUsernameFallback(p.discord_user_id))
            .map(p => p.iscored_username.toLowerCase());
        const userAvatarMap = new Map<string, { discord_user_id: string; avatar_hash: string; display_name: string | null }>();
        if (usernamesFallback.length > 0) {
            const ph2 = usernamesFallback.map(() => '?').join(',');
            const rows2 = await db.all(
                `SELECT um.iscored_username, um.discord_user_id, up.avatar_hash, up.display_name
                 FROM user_mappings um
                 LEFT JOIN user_profiles up ON up.discord_user_id = um.discord_user_id
                 WHERE LOWER(um.iscored_username) IN (${ph2})`,
                ...usernamesFallback
            );
            for (const row of rows2) {
                userAvatarMap.set(row.iscored_username.toLowerCase(), {
                    discord_user_id: row.discord_user_id,
                    avatar_hash: row.avatar_hash || '',
                    display_name: row.display_name || null,
                });
            }
        }

        // Now compute total scores
        const results: OverallRanking[] = [];
        for (const [, player] of playerData) {
            const gamesPlayed = player.games.length;
            // Resolve avatar + display_name: try discord_user_id first, then username fallback
            let resolvedDiscordId = player.discord_user_id;
            let resolvedAvatar: string | null = avatarMap.get(player.discord_user_id) || null;
            let resolvedDisplayName: string | null = displayNameMap.get(player.discord_user_id) || null;
            if (!resolvedAvatar || !resolvedDisplayName) {
                const fb = userAvatarMap.get(player.iscored_username.toLowerCase());
                if (fb) {
                    if (!resolvedAvatar && fb.avatar_hash) resolvedAvatar = fb.avatar_hash;
                    if (!resolvedDisplayName && fb.display_name) resolvedDisplayName = fb.display_name;
                    if (isSyntheticId(resolvedDiscordId)) resolvedDiscordId = fb.discord_user_id;
                }
            }

            if (group.rank_method === 'average_rank') {
                // Average rank: need min_games to qualify
                if (gamesPlayed < group.min_games) continue;
                // Take best N ranks (lowest ranks = best)
                const sorted = [...player.games].sort((a, b) => a.game_rank - b.game_rank);
                const bestGames = sorted.slice(0, group.best_n);
                const avgRank = bestGames.reduce((sum, g) => sum + g.game_rank, 0) / bestGames.length;
                results.push({
                    rank: 0, // assigned after sorting
                    iscored_username: player.iscored_username,
                    display_name: resolvedDisplayName,
                    discord_user_id: resolvedDiscordId,
                    total_points: Math.round(avgRank * 100) / 100, // 2 decimal places
                    games_played: gamesPlayed,
                    avatar_hash: resolvedAvatar,
                    breakdown: bestGames,
                });
            } else {
                // Points-based: take best N point totals
                const sorted = [...player.games].sort((a, b) => b.points - a.points);
                const bestGames = sorted.slice(0, group.best_n);
                const totalPoints = bestGames.reduce((sum, g) => sum + g.points, 0);
                results.push({
                    rank: 0,
                    iscored_username: player.iscored_username,
                    display_name: resolvedDisplayName,
                    discord_user_id: resolvedDiscordId,
                    total_points: totalPoints,
                    games_played: gamesPlayed,
                    avatar_hash: resolvedAvatar,
                    breakdown: bestGames,
                });
            }
        }

        // Sort: for average_rank, lower is better; for points methods, higher is better
        if (group.rank_method === 'average_rank') {
            results.sort((a, b) => a.total_points - b.total_points);
        } else {
            results.sort((a, b) => b.total_points - a.total_points);
        }

        // Assign ranks
        results.forEach((r, i) => { r.rank = i + 1; });

        // Cache results with a snapshot of the data watermark. Subsequent
        // reads compare the live watermark to this snapshot and invalidate
        // automatically if anything changed — score insert/delete, game
        // status flip, eligible-game set change, etc.
        // Reuse the watermark getRankings already computed on a cache miss (S1)
        // — otherwise this is the second computeDataWatermark round-trip per miss.
        const watermark = precomputedWatermark ?? await this.computeDataWatermark(group);
        await db.run(
            `INSERT OR REPLACE INTO ranking_groups_cache (ranking_group_id, rankings, generated_at, data_watermark) VALUES (?, ?, ?, ?)`,
            groupId, JSON.stringify(results), new Date().toISOString(), watermark
        );

        logInfo(`Computed rankings for group "${group.name}": ${results.length} players`);
        return results;
    }

    /**
     * Get cached rankings, validating freshness against the current data
     * watermark. If the underlying data (score counts, game eligibility, etc.)
     * has changed since the cache was last written, the cache is silently
     * recomputed. Score-mutation code paths therefore don't need to remember
     * to call invalidate() — the data tells us when the cache is stale.
     *
     * The watermark query is sub-10ms over indexed columns; the recompute is
     * 50-200ms. Net savings: ~95% when nothing has changed (the common case).
     */
    static async getRankings(groupId: string): Promise<OverallRanking[]> {
        const db = await getDatabase();
        const cached = await db.get(
            'SELECT rankings, data_watermark FROM ranking_groups_cache WHERE ranking_group_id = ?',
            groupId,
        );
        let freshWatermark: string | undefined;
        if (cached && cached.data_watermark) {
            const group = await this.getById(groupId);
            if (group) {
                const currentWatermark = await this.computeDataWatermark(group);
                if (currentWatermark === cached.data_watermark) {
                    return JSON.parse(cached.rankings);
                }
                // Watermark mismatch — reuse the just-computed watermark so the
                // recompute below doesn't compute it a second time (S1).
                freshWatermark = currentWatermark;
            }
        }
        return await this.computeRankings(groupId, freshWatermark);
    }

    /**
     * Cheap fingerprint of the data state that ranking computation depends on.
     * Any change to (eligible games, score rows, score values, game status
     * transitions, game start/end timestamps) flips the watermark and forces
     * the next read to recompute.
     *
     * Composition:
     *   - eligible_games: COUNT of games in this group's tournaments where
     *     status IN ('ACTIVE', 'COMPLETED'). Drops when maintenance hides a
     *     game; rises when a new game activates.
     *   - score_count: COUNT of non-orphaned score_history rows tied to this
     *     group's tournament windows (submitted_during_tournament_id IN ...).
     *     Changes on insert / delete / orphan. v2.13.12 — was sourced from
     *     submissions; switched to score_history to match the rankings query
     *     itself, so per-row score_history deletes correctly invalidate.
     *   - score_sum: SUM of those scores. Changes on insert (sum rises),
     *     delete (sum drops). The only mutation it can't detect is an upsert
     *     that lands the same value as before — which is a no-op anyway.
     *   - max_game_end: latest end_date across this group's games. Captures
     *     status flips to COMPLETED.
     *   - max_game_start: latest start_date. Captures status flips to ACTIVE
     *     (auto-pick, manual activate, queue rotation).
     *
     * What's deliberately NOT in the watermark: user_profiles changes
     * (display_name / avatar_hash). Display name lag in cached rankings is
     * acceptable; including it would require a JOIN per read for negligible
     * UX benefit. RankingGroup config changes ARE handled — `update()` calls
     * `invalidate()` directly, since config edits aren't reflected in the
     * data layer.
     *
     * Backward-compat note: v2.13.12 changes the watermark source table from
     * submissions to score_history. Old cached watermarks will mismatch the
     * new formula on the first read after deploy, triggering an automatic
     * recompute. No manual invalidation needed.
     */
    private static async computeDataWatermark(group: RankingGroup): Promise<string> {
        if (group.tournament_ids.length === 0) {
            return '0:0:0::';
        }
        const db = await getDatabase();
        const placeholders = group.tournament_ids.map(() => '?').join(',');
        // One round-trip. Backed by idx_games_tournament_id and the covering
        // idx_score_history_tournament (submitted_during_tournament_id,
        // orphaned_at, score) added in migration 103 — the COUNT/SUM are
        // index-only, keeping this in the single-millisecond range.
        const row = await db.get(`
            SELECT
                (SELECT COUNT(*) FROM games
                 WHERE tournament_id IN (${placeholders})
                   AND status IN ('ACTIVE','COMPLETED')) AS eligible_games,
                (SELECT COUNT(*) FROM score_history
                 WHERE orphaned_at IS NULL
                   AND submitted_during_tournament_id IN (${placeholders})) AS score_count,
                (SELECT COALESCE(SUM(score), 0) FROM score_history
                 WHERE orphaned_at IS NULL
                   AND submitted_during_tournament_id IN (${placeholders})) AS score_sum,
                (SELECT COALESCE(MAX(end_date), '') FROM games
                 WHERE tournament_id IN (${placeholders})) AS max_game_end,
                (SELECT COALESCE(MAX(start_date), '') FROM games
                 WHERE tournament_id IN (${placeholders})) AS max_game_start
        `, ...group.tournament_ids, ...group.tournament_ids, ...group.tournament_ids,
           ...group.tournament_ids, ...group.tournament_ids);

        return [
            row?.eligible_games ?? 0,
            row?.score_count ?? 0,
            row?.score_sum ?? 0,
            row?.max_game_end ?? '',
            row?.max_game_start ?? '',
        ].join(':');
    }

    /**
     * Invalidate cache for a specific group (call after score changes).
     */
    static async invalidate(groupId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM ranking_groups_cache WHERE ranking_group_id = ?', groupId);
    }

    /**
     * Invalidate all ranking group caches.
     */
    static async invalidateAll(): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM ranking_groups_cache');
    }

    /**
     * Get all active ranking groups with their computed rankings (for public display).
     */
    static async getActiveWithRankings(gameRoomId?: string): Promise<Array<{
        group: RankingGroup;
        rankings: OverallRanking[];
    }>> {
        const groups = await this.getAll(gameRoomId);
        const active = groups.filter(g => g.is_active);
        const results = [];
        for (const group of active) {
            const rankings = await this.getRankings(group.id);
            results.push({ group, rankings });
        }
        return results;
    }

    /**
     * Calculate points for a given rank using the specified method.
     */
    private static calculatePoints(method: RankMethod, rank: number, _totalPlayers: number): number {
        switch (method) {
            case 'max_10':
                // Only top 10 get points
                if (rank > 10) return 0;
                return MAX_10_POINTS[rank - 1] ?? 0;

            case 'best_game_papa':
                // 1st: 100, 2nd: 90, 3rd: 85, then -1 per place
                if (rank === 1) return 100;
                if (rank === 2) return 90;
                if (rank === 3) return 85;
                // 4th: 84, 5th: 83, etc.
                const papaPoints = 85 - (rank - 3);
                return Math.max(papaPoints, 0);

            case 'best_game_linear':
                // 1st: 100, 2nd: 99, 3rd: 98, etc.
                const linearPoints = 101 - rank;
                return Math.max(linearPoints, 0);

            case 'average_rank':
                // For average rank, we use the rank itself (not points)
                return rank;

            default:
                return 0;
        }
    }
}
