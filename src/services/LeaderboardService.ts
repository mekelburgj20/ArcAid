import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';

export interface RankedEntry {
    rank: number;
    discord_user_id: string;
    iscored_username: string;
    score: number;
}

export class LeaderboardService {
    /**
     * Recalculate and cache the leaderboard for a specific game.
     */
    static async recalculate(gameId: string): Promise<RankedEntry[]> {
        const db = await getDatabase();

        // Get best score per player for this game
        // Group by lowercase iscored_username to handle case variations (Cal vs CAL)
        // Prefer a real discord_user_id over 'SYSTEM' placeholder
        const entries = await db.all(`
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
        `, gameId);

        const rankings: RankedEntry[] = entries.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            score: e.score,
        }));

        // Cache the result
        await db.run(
            `INSERT OR REPLACE INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, ?, ?)`,
            gameId, JSON.stringify(rankings), new Date().toISOString()
        );

        logInfo(`Leaderboard recalculated for game ${gameId}: ${rankings.length} entries`);
        return rankings;
    }

    /**
     * Get cached leaderboard, recalculating if stale or missing.
     */
    static async getForGame(gameId: string): Promise<RankedEntry[]> {
        const db = await getDatabase();
        const cached = await db.get('SELECT rankings, generated_at FROM leaderboard_cache WHERE game_id = ?', gameId);

        if (cached) {
            return JSON.parse(cached.rankings);
        }

        return await this.recalculate(gameId);
    }

    /**
     * Invalidate cache for a game (call after new score submission).
     */
    static async invalidate(gameId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', gameId);
    }

    /**
     * Invalidate all cached leaderboards.
     */
    static async invalidateAll(): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM leaderboard_cache');
    }

    /**
     * Get leaderboards for all active games.
     */
    static async getActiveLeaderboards(): Promise<Array<{ gameId: string; gameName: string; tournamentName: string; tournamentType: string; imageUrl: string | null; rankings: RankedEntry[] }>> {
        const db = await getDatabase();

        // 1. All ACTIVE games always show
        const activeGames = await db.all(`
            SELECT g.id, g.name as game_name, t.name as tournament_name, t.type as tournament_type,
                   COALESCE(t.display_order, 9999) as display_order, gl.image_url
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
            WHERE g.status = 'ACTIVE'
            GROUP BY COALESCE(g.tournament_id, g.id), g.name
            ORDER BY display_order ASC, g.start_date ASC
        `);

        // 2. COMPLETED games only if the tournament's cleanup_rule retains them
        // - retain with count > 0: keep N most recent completed
        // - scheduled: games remain visible until the scheduled cleanup runs
        // - immediate or retain(0): no completed games shown
        const tournaments = await db.all(`
            SELECT id, name, type, cleanup_rule, COALESCE(display_order, 9999) as display_order
            FROM tournaments WHERE is_active = 1
        `);

        const retainedGames: any[] = [];
        for (const t of tournaments) {
            let rule: { mode: string; count?: number } = { mode: 'retain', count: 0 };
            try { rule = JSON.parse(t.cleanup_rule || '{}'); } catch {}

            if (rule.mode === 'immediate' || (rule.mode === 'retain' && (rule.count || 0) === 0)) {
                continue; // No completed games visible
            }

            if (rule.mode === 'retain' && (rule.count || 0) > 0) {
                // Keep N most recent completed games
                const completed = await db.all(`
                    SELECT g.id, g.name as game_name, ? as tournament_name, ? as tournament_type,
                           ? as display_order, gl.image_url
                    FROM games g
                    LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
                    WHERE g.tournament_id = ? AND g.status = 'COMPLETED'
                    ORDER BY g.end_date DESC
                    LIMIT ?
                `, t.name, t.type, t.display_order, t.id, rule.count);
                retainedGames.push(...completed);
            } else if (rule.mode === 'scheduled') {
                // All completed games visible until scheduled cleanup runs
                const completed = await db.all(`
                    SELECT g.id, g.name as game_name, ? as tournament_name, ? as tournament_type,
                           ? as display_order, gl.image_url
                    FROM games g
                    LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
                    WHERE g.tournament_id = ? AND g.status = 'COMPLETED'
                    ORDER BY g.end_date DESC
                `, t.name, t.type, t.display_order, t.id);
                retainedGames.push(...completed);
            }
        }

        // Combine and sort: active first, then retained completed
        const allGames = [...activeGames, ...retainedGames]
            .sort((a, b) => (a.display_order - b.display_order) || 0);

        // Deduplicate by game name + tournament
        const seen = new Set<string>();
        const deduped = allGames.filter(g => {
            const key = `${g.tournament_name}:${g.game_name}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });

        const results = [];
        for (const game of deduped) {
            const rankings = await this.getForGame(game.id);
            results.push({
                gameId: game.id,
                gameName: game.game_name,
                tournamentName: game.tournament_name || 'Untracked',
                tournamentType: game.tournament_type || '',
                imageUrl: game.image_url || null,
                rankings,
            });
        }
        return results;
    }
}
