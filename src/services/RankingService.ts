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
    discord_user_id: string;
    total_points: number;
    games_played: number;
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
    static async getAll(): Promise<RankingGroup[]> {
        const db = await getDatabase();
        const groups = await db.all(`SELECT * FROM ranking_groups ORDER BY name`);
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
    }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO ranking_groups (id, name, description, rank_method, best_n, min_games) VALUES (?, ?, ?, ?, ?, ?)`,
            data.id, data.name, data.description || '', data.rank_method, data.best_n, data.min_games
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
    static async computeRankings(groupId: string): Promise<OverallRanking[]> {
        const group = await this.getById(groupId);
        if (!group || group.tournament_ids.length === 0) return [];

        const db = await getDatabase();

        // Get all completed + active games for the selected tournaments
        const placeholders = group.tournament_ids.map(() => '?').join(',');
        const games = await db.all(
            `SELECT g.id, g.name FROM games g
             WHERE g.tournament_id IN (${placeholders})
             AND g.status IN ('ACTIVE', 'COMPLETED')`,
            ...group.tournament_ids
        );

        if (games.length === 0) return [];

        // For each game, get per-player best scores and rank them
        // gameRankings: Map<gameId, Array<{ username, discord_user_id, rank }>>
        const gameRankings = new Map<string, Array<{ game_name: string; iscored_username: string; discord_user_id: string; rank: number }>>();

        for (const game of games) {
            const scores = await db.all(`
                SELECT
                    CASE WHEN MAX(CASE WHEN discord_user_id != 'SYSTEM' THEN discord_user_id END) IS NOT NULL
                         THEN MAX(CASE WHEN discord_user_id != 'SYSTEM' THEN discord_user_id END)
                         ELSE discord_user_id
                    END as discord_user_id,
                    iscored_username,
                    MAX(score) as score
                FROM submissions
                WHERE game_id = ?
                GROUP BY LOWER(iscored_username)
                ORDER BY score DESC
            `, game.id);

            const ranked = scores.map((s: any, i: number) => ({
                game_name: game.name,
                iscored_username: s.iscored_username || 'Unknown',
                discord_user_id: s.discord_user_id,
                rank: i + 1,
            }));
            gameRankings.set(game.id, ranked);
        }

        // Compute points per player per game based on method
        // playerData: Map<lowercase_username, { username, discord_user_id, games: Array<{ game_name, rank, points }> }>
        const playerData = new Map<string, {
            iscored_username: string;
            discord_user_id: string;
            games: Array<{ game_name: string; game_rank: number; points: number }>;
        }>();

        for (const [, rankings] of gameRankings) {
            const totalPlayers = rankings.length;
            for (const entry of rankings) {
                const key = entry.iscored_username.toLowerCase();
                if (!playerData.has(key)) {
                    playerData.set(key, {
                        iscored_username: entry.iscored_username,
                        discord_user_id: entry.discord_user_id,
                        games: [],
                    });
                }
                const player = playerData.get(key)!;
                // Prefer real discord ID
                if (player.discord_user_id === 'SYSTEM' && entry.discord_user_id !== 'SYSTEM') {
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

        // Now compute total scores
        const results: OverallRanking[] = [];
        for (const [, player] of playerData) {
            const gamesPlayed = player.games.length;

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
                    discord_user_id: player.discord_user_id,
                    total_points: Math.round(avgRank * 100) / 100, // 2 decimal places
                    games_played: gamesPlayed,
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
                    discord_user_id: player.discord_user_id,
                    total_points: totalPoints,
                    games_played: gamesPlayed,
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

        // Cache results
        await db.run(
            `INSERT OR REPLACE INTO ranking_groups_cache (ranking_group_id, rankings, generated_at) VALUES (?, ?, ?)`,
            groupId, JSON.stringify(results), new Date().toISOString()
        );

        logInfo(`Computed rankings for group "${group.name}": ${results.length} players`);
        return results;
    }

    /**
     * Get cached rankings, or recompute if missing.
     */
    static async getRankings(groupId: string): Promise<OverallRanking[]> {
        const db = await getDatabase();
        const cached = await db.get('SELECT rankings FROM ranking_groups_cache WHERE ranking_group_id = ?', groupId);
        if (cached) {
            return JSON.parse(cached.rankings);
        }
        return await this.computeRankings(groupId);
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
    static async getActiveWithRankings(): Promise<Array<{
        group: RankingGroup;
        rankings: OverallRanking[];
    }>> {
        const groups = await this.getAll();
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
