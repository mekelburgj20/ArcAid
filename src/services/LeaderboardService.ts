import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { getNextRunTime } from '../utils/cronUtils.js';

export interface RankedEntry {
    rank: number;
    discord_user_id: string;
    iscored_username: string;
    score: number;
    avatar_hash?: string | null;
}

export class LeaderboardService {
    /**
     * Recalculate and cache the leaderboard for a specific game.
     */
    static async recalculate(gameId: string): Promise<RankedEntry[]> {
        const db = await getDatabase();

        // Get best score per player across both submissions and community_scores.
        // submissions uses game_id; community_scores uses game_name + game_room_id.
        // Union both sources, then take MAX(score) per player.
        // Left join user_mappings to get avatar_hash for Discord-linked players.
        const entries = await db.all(`
            SELECT
                COALESCE(um.discord_user_id, combined.discord_user_id) as discord_user_id,
                combined.iscored_username,
                combined.score,
                um.avatar_hash
            FROM (
                SELECT
                    CASE WHEN MAX(CASE WHEN discord_user_id NOT IN ('SYSTEM','COMMUNITY','ANON') AND discord_user_id NOT LIKE 'iscored:%' THEN discord_user_id END) IS NOT NULL
                         THEN MAX(CASE WHEN discord_user_id NOT IN ('SYSTEM','COMMUNITY','ANON') AND discord_user_id NOT LIKE 'iscored:%' THEN discord_user_id END)
                         ELSE MAX(discord_user_id)
                    END as discord_user_id,
                    iscored_username,
                    MAX(score) as score
                FROM (
                    SELECT discord_user_id, iscored_username, score
                    FROM submissions
                    WHERE game_id = ?
                    UNION ALL
                    SELECT discord_user_id, iscored_username, score
                    FROM community_scores
                    WHERE LOWER(game_name) = LOWER((SELECT name FROM games WHERE id = ?))
                      AND game_room_id = (SELECT t.game_room_id FROM games g JOIN tournaments t ON t.id = g.tournament_id WHERE g.id = ?)
                ) raw
                GROUP BY LOWER(iscored_username)
            ) combined
            LEFT JOIN user_mappings um ON (
                um.discord_user_id = combined.discord_user_id
                OR ((combined.discord_user_id IN ('SYSTEM','COMMUNITY','ANON') OR combined.discord_user_id LIKE 'iscored:%')
                    AND LOWER(um.iscored_username) = LOWER(combined.iscored_username))
            )
            ORDER BY combined.score DESC
        `, gameId, gameId, gameId);

        const rankings: RankedEntry[] = entries.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            score: e.score,
            avatar_hash: e.avatar_hash || null,
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
     * Get leaderboards for all active games, optionally filtered by game room.
     */
    static async getActiveLeaderboards(gameRoomId?: string): Promise<Array<{ gameId: string; gameName: string; displayName: string | null; tournamentName: string; tournamentType: string; imageUrl: string | null; gameStatus: string; catalogueStyleId: string | null; logoStyleId: string | null; bgStyleId: string | null; styleHeaderDisabled: boolean; externalUrl: string | null; notes: string | null; rankings: RankedEntry[]; nextMaintenanceAt: string | null }>> {
        const db = await getDatabase();

        const roomFilter = gameRoomId ? ' AND t.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        // 1. All ACTIVE games always show
        const activeGames = await db.all(`
            SELECT g.id, g.name as game_name, g.display_name, g.status, t.name as tournament_name, t.type as tournament_type,
                   COALESCE(t.display_order, 9999) as display_order, gl.image_url,
                   g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                   g.tournament_id, g.external_url, g.notes,
                   sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                   sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
            LEFT JOIN style_catalogue sc_bg ON g.bg_style_id = sc_bg.id
            LEFT JOIN style_catalogue sc_logo ON g.logo_style_id = sc_logo.id
            LEFT JOIN style_catalogue sc_cat ON g.catalogue_style_id = sc_cat.id
            WHERE g.status = 'ACTIVE'${roomFilter}
            GROUP BY COALESCE(g.tournament_id, g.id), g.name
            ORDER BY display_order ASC, g.start_date ASC
        `, ...roomParams);

        // 2. COMPLETED games only if the tournament's cleanup_rule retains them
        const tournamentQuery = gameRoomId
            ? `SELECT id, name, type, cleanup_rule, COALESCE(display_order, 9999) as display_order
               FROM tournaments WHERE is_active = 1 AND game_room_id = ?`
            : `SELECT id, name, type, cleanup_rule, COALESCE(display_order, 9999) as display_order
               FROM tournaments WHERE is_active = 1`;

        const tournaments = gameRoomId
            ? await db.all(tournamentQuery, gameRoomId)
            : await db.all(tournamentQuery);

        const retainedGames: any[] = [];
        for (const t of tournaments) {
            let rule: { mode: string; count?: number } = { mode: 'retain', count: 0 };
            try { rule = JSON.parse(t.cleanup_rule || '{}'); } catch {}

            if (rule.mode === 'immediate' || (rule.mode === 'retain' && (rule.count || 0) === 0)) {
                continue; // No completed games visible
            }

            if (rule.mode === 'retain' && (rule.count || 0) > 0) {
                const completed = await db.all(`
                    SELECT g.id, g.name as game_name, g.display_name, g.status, ? as tournament_name, ? as tournament_type,
                           ? as display_order, gl.image_url,
                           g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                           g.external_url, g.notes,
                           sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                           sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
                    FROM games g
                    LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
                    LEFT JOIN style_catalogue sc_bg ON g.bg_style_id = sc_bg.id
                    LEFT JOIN style_catalogue sc_logo ON g.logo_style_id = sc_logo.id
                    LEFT JOIN style_catalogue sc_cat ON g.catalogue_style_id = sc_cat.id
                    WHERE g.tournament_id = ? AND g.status = 'COMPLETED'
                    ORDER BY g.end_date DESC
                    LIMIT ?
                `, t.name, t.type, t.display_order, t.id, rule.count);
                retainedGames.push(...completed);
            } else if (rule.mode === 'scheduled') {
                const completed = await db.all(`
                    SELECT g.id, g.name as game_name, g.display_name, g.status, ? as tournament_name, ? as tournament_type,
                           ? as display_order, gl.image_url,
                           g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                           g.external_url, g.notes,
                           sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                           sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
                    FROM games g
                    LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
                    LEFT JOIN style_catalogue sc_bg ON g.bg_style_id = sc_bg.id
                    LEFT JOIN style_catalogue sc_logo ON g.logo_style_id = sc_logo.id
                    LEFT JOIN style_catalogue sc_cat ON g.catalogue_style_id = sc_cat.id
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

        // Batch-load cached leaderboards (avoid N+1 per-game queries)
        const gameIds = deduped.map(g => g.id);
        const placeholders = gameIds.map(() => '?').join(',');
        const cachedRows = gameIds.length > 0
            ? await db.all(
                `SELECT game_id, rankings FROM leaderboard_cache WHERE game_id IN (${placeholders})`,
                ...gameIds
            )
            : [];
        const cacheMap = new Map(cachedRows.map((r: any) => [r.game_id, JSON.parse(r.rankings)]));

        // Build cadence map for active tournaments to compute next maintenance time
        const cadenceMap = new Map<string, { cron: string; timezone: string }>();
        const tournamentIds = [...new Set(deduped.map((g: any) => g.tournament_id).filter(Boolean))];
        for (const tid of tournamentIds) {
            const tRow = await db.get('SELECT cadence, game_room_id FROM tournaments WHERE id = ?', tid);
            if (tRow?.cadence) {
                try {
                    const cadenceObj = JSON.parse(tRow.cadence);
                    if (cadenceObj?.cron) {
                        let tz = cadenceObj.timezone || process.env.BOT_TIMEZONE || 'America/Chicago';
                        if (tRow.game_room_id) {
                            const roomTz = await db.get(
                                "SELECT value FROM game_room_settings WHERE game_room_id = ? AND key = 'TIMEZONE'",
                                tRow.game_room_id
                            );
                            if (roomTz?.value) tz = roomTz.value;
                        }
                        cadenceMap.set(tid, { cron: cadenceObj.cron, timezone: tz });
                    }
                } catch {}
            }
        }

        const results = [];
        for (const game of deduped) {
            // Use cached rankings if available, otherwise recalculate
            const rankings = cacheMap.get(game.id) ?? await this.recalculate(game.id);

            // Compute next maintenance time for active games
            let nextMaintenanceAt: string | null = null;
            if (game.status === 'ACTIVE' && game.tournament_id) {
                const cadenceInfo = cadenceMap.get(game.tournament_id);
                if (cadenceInfo) {
                    const nextRun = getNextRunTime(cadenceInfo.cron, cadenceInfo.timezone);
                    if (nextRun) nextMaintenanceAt = nextRun.toISOString();
                }
            }

            results.push({
                gameId: game.id,
                gameName: game.game_name,
                displayName: game.display_name || null,
                tournamentName: game.tournament_name || 'Untracked',
                tournamentType: game.tournament_type || '',
                imageUrl: game.image_url || null,
                gameStatus: game.status || 'ACTIVE',
                catalogueStyleId: game.catalogue_style_id || null,
                logoStyleId: game.logo_style_id || null,
                bgStyleId: game.bg_style_id || null,
                styleHeaderDisabled: game.style_header_disabled === 1,
                bgHasBg: game.bg_has_bg ?? null,
                logoHasHeader: game.logo_has_header ?? null,
                catHasBg: game.cat_has_bg ?? null,
                catHasHeader: game.cat_has_header ?? null,
                externalUrl: game.external_url || null,
                notes: game.notes || null,
                rankings,
                nextMaintenanceAt,
            });
        }
        return results;
    }
}
