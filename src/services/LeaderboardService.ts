import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { getNextRunTime } from '../utils/cronUtils.js';

/**
 * v2.0.3: translate stored catalogue paths (`data/catalogue-images/…`) to the
 * public HTTP URL (`/api/catalogue-images/…`). Leaves absolute URLs and other
 * paths untouched. Mirrors the frontend `toCatalogueUrl` helper.
 */
function normalizeImageUrl(raw: string | null | undefined): string | null {
    if (!raw) return null;
    if (/^https?:\/\//i.test(raw)) return raw;
    const m = raw.match(/^\/?data\/catalogue-images\/(.+)$/);
    if (m) return `/api/catalogue-images/${m[1]}`;
    return raw.startsWith('/') ? raw : `/${raw}`;
}

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
     *
     * v2.1.0: tournament leaderboards now read from `score_history` filtered by
     * `submitted_during_tournament_id` (§13 refactor). Previously they read
     * `submissions`, which stores only the best-ever per player — incorrect for
     * tournament scoring, where the goal is "best score during *this* tournament
     * window", which may legitimately be below an all-time personal best.
     *
     * The `submissions` table is still written on every submit (dual-write) so
     * back-compat is preserved for anything still reading it directly, but the
     * canonical source for tournament card rankings is now score_history.
     */
    static async recalculate(gameId: string): Promise<RankedEntry[]> {
        const db = await getDatabase();

        // Resolve the game's tournament + room scope so we can filter score_history correctly.
        const gameMeta = await db.get(`
            SELECT g.id, g.name, g.tournament_id, t.game_room_id
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id = ?
        `, gameId);
        if (!gameMeta) {
            // Game not found — cache an empty ranking so callers don't thrash on retries.
            await db.run(
                `INSERT OR REPLACE INTO leaderboard_cache (game_id, rankings, generated_at) VALUES (?, ?, ?)`,
                gameId, JSON.stringify([]), new Date().toISOString()
            );
            return [];
        }

        // Best-score-per-player from score_history for this tournament window.
        // ROW_NUMBER lets us keep the winning row's photo_url + discord_user_id
        // without a separate JOIN back to the same table.
        const entries = await db.all(`
            SELECT
                COALESCE(um.discord_user_id, best.discord_user_id) as discord_user_id,
                best.iscored_username,
                best.score,
                um.avatar_hash
            FROM (
                SELECT
                    iscored_username,
                    discord_user_id,
                    score,
                    ROW_NUMBER() OVER (
                        PARTITION BY LOWER(iscored_username)
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM score_history
                WHERE game_room_id = ?
                  AND submitted_during_tournament_id = ?
                  AND LOWER(game_name) = LOWER(?)
                  AND orphaned_at IS NULL
            ) best
            LEFT JOIN user_mappings um ON (
                -- v2.0.1: username-fallback limited to iScored-synced rows so
                -- anonymous submissions don't leak avatars.
                um.discord_user_id = best.discord_user_id
                OR (best.discord_user_id LIKE 'iscored:%'
                    AND LOWER(um.iscored_username) = LOWER(best.iscored_username))
            )
            WHERE best.rn = 1
            ORDER BY best.score DESC
        `, gameMeta.game_room_id, gameMeta.tournament_id, gameMeta.name);

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
    static async getActiveLeaderboards(gameRoomId?: string): Promise<Array<{ gameId: string; gameName: string; displayName: string | null; tournamentName: string; tournamentType: string; imageUrl: string | null; gameStatus: string; catalogueStyleId: string | null; logoStyleId: string | null; bgStyleId: string | null; styleHeaderDisabled: boolean; externalUrl: string | null; notes: string | null; rankings: RankedEntry[]; nextMaintenanceAt: string | null; globalGameId: string | null }>> {
        const db = await getDatabase();

        const roomFilter = gameRoomId ? ' AND t.game_room_id = ?' : '';
        const roomParams = gameRoomId ? [gameRoomId] : [];

        // 1. All ACTIVE games always show
        // v2.0.2: three-level globalGameId resolution so card title → /games/:id?from=:slug
        // routes correctly even when the games/library column wasn't populated during
        // tournament setup. Resolution order:
        //   a. games.global_game_id          (explicit per-game link)
        //   b. game_library.global_game_id   (library-level link)
        //   c. global_games.id via case-insensitive name match (approved only)
        // Matches the resolution used by All Games search.
        const activeGames = await db.all(`
            SELECT g.id, g.name as game_name, g.display_name, g.status, t.name as tournament_name, t.type as tournament_type,
                   COALESCE(t.display_order, 9999) as display_order,
                   -- v2.0.3: image fallback hierarchy — game_library.image_url,
                   -- then global_games (local → wheel → url) so tournament cards
                   -- get a default image when neither the room admin nor the
                   -- tournament curator set a style background.
                   COALESCE(gl.image_url, gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                   g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                   g.tournament_id, g.external_url, g.notes,
                   COALESCE(g.global_game_id, gl.global_game_id, gg.id) as global_game_id,
                   sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                   sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
            LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
            LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'
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
                           ? as display_order,
                           COALESCE(gl.image_url, gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                           g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                           g.external_url, g.notes,
                           COALESCE(g.global_game_id, gl.global_game_id, gg.id) as global_game_id,
                           sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                           sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
                    FROM games g
                    LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
                    LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'
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
                           ? as display_order,
                           COALESCE(gl.image_url, gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                           g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                           g.external_url, g.notes,
                           COALESCE(g.global_game_id, gl.global_game_id, gg.id) as global_game_id,
                           sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                           sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
                    FROM games g
                    LEFT JOIN game_library gl ON g.name = gl.name COLLATE NOCASE
                    LEFT JOIN global_games gg ON LOWER(gg.name) = LOWER(g.name) AND gg.status = 'approved'
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
                // v2.0.3: normalize catalogue paths to their public URL so cards
                // render the image directly. `data/catalogue-images/...` → `/api/catalogue-images/...`.
                imageUrl: normalizeImageUrl(game.image_url),
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
                globalGameId: game.global_game_id || null,
            });
        }
        return results;
    }
}
