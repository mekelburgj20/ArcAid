import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { getNextRunTime } from '../utils/cronUtils.js';
import {
    UNKNOWN,
    deriveLegacyPlatform,
    mapLegacyPlatform,
    normalizeProvenanceToken,
} from '../utils/scoreProvenance.js';

/**
 * v2.0.3: translate stored catalogue paths (`data/catalogue-images/…`) to the
 * public HTTP URL (`/api/catalogue-images/…`). Leaves absolute URLs and other
 * paths untouched. Mirrors the frontend `toCatalogueUrl` helper.
 */
export function normalizeImageUrl(raw: string | null | undefined): string | null {
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
    /**
     * User-chosen global display name (from `user_profiles.display_name`).
     * Null when the user hasn't picked one — FE falls back to iscored_username.
     */
    display_name?: string | null;
    score: number;
    avatar_hash?: string | null;
    /**
     * v2.5.0: per-score platform stratification. `null` for legacy rows that
     * couldn't be backfilled (multi-platform games where the platform a player
     * actually used is unknowable retroactively).
     *
     * @deprecated v2.58.0 (ADR 0016) — `engine` + `device` are authoritative.
     * Retained because tournament `platform_rules` still read the legacy column
     * until the rules phase lands; do NOT derive display from it.
     */
    platform?: string | null;
    /**
     * v2.58.0 (ADR 0016): what produced the score. Determines comparability and
     * the fidelity category. Never null and never NULL in the DB — migration
     * 125 backfilled every row and every writer stamps it — but `'unknown'` is
     * a first-class value meaning "nobody recorded it".
     */
    engine?: string | null;
    /** v2.58.0 (ADR 0016): what it ran on. Provenance only, never a boundary. */
    device?: string | null;
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
        // PARTITION collapses by submitted_by_user_id (Discord linkage) when set,
        // else by anon name — so a user with multiple aliases under one Discord
        // ID renders as one leaderboard row, while pure-anon submissions still
        // partition per-name. ROW_NUMBER picks the highest-scoring row in the
        // partition; its iscored_username is the displayed alias when no
        // user_profiles.display_name is set.
        const entries = await db.all(`
            SELECT
                COALESCE(best.submitted_by_user_id, um.discord_user_id, best.discord_user_id) as discord_user_id,
                best.iscored_username,
                best.score,
                best.platform,
                best.engine,
                best.device,
                up.display_name,
                up.avatar_hash
            FROM (
                SELECT
                    iscored_username,
                    discord_user_id,
                    submitted_by_user_id,
                    score,
                    platform,
                    engine,
                    device,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM score_history
                WHERE game_room_id = ?
                  AND submitted_during_tournament_id = ?
                  AND LOWER(game_name) = LOWER(?)
                  AND orphaned_at IS NULL
            ) best
            LEFT JOIN user_mappings um ON (
                -- iscored:* synthetic ids resolve to a real Discord user via
                -- user_mappings.iscored_username (case-insensitive).
                best.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(best.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(best.submitted_by_user_id, um.discord_user_id)
            WHERE best.rn = 1
            ORDER BY best.score DESC
        `, gameMeta.game_room_id, gameMeta.tournament_id, gameMeta.name);

        const rankings: RankedEntry[] = entries.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            display_name: e.display_name || null,
            score: e.score,
            avatar_hash: e.avatar_hash || null,
            platform: e.platform || null,
            engine: e.engine || UNKNOWN,
            device: e.device || UNKNOWN,
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
     * v2.58.0 (ADR 0016): same shape as getForGame, filtered by engine and/or
     * device. Bypasses the cache because the cache stores the unfiltered "All"
     * view — a player's best may be on a different engine than the one being
     * queried, so post-cache JS filtering would mis-rank.
     *
     * ## Why this replaced the platform filter
     *
     * The v2.5.0 predecessor filtered `UPPER(platform) = UPPER(?)` — a raw
     * string compare with NO alias folding — while `getDistinctPlatforms` DID
     * fold via `normalizePlatform`. A tab could therefore be labelled `vpx`
     * from rows stored as `VPX`, and then query a value matching nothing. The
     * two halves are now built from the same columns, so the class of bug is
     * gone by construction, not by keeping two normalisers in step.
     *
     * `engine = 'unknown'` is a legitimate filter value, not an escape hatch:
     * it selects exactly the rows whose provenance was never recorded, which is
     * what the "Unspecified" tab shows. Any OTHER engine excludes them, per
     * ADR 0016 — an unknown-engine score is not evidence of a VPX score.
     *
     * ## Why there is no legacy `platform` fallback
     *
     * Migration 125 backfilled `engine`/`device` on every pre-existing row and
     * asserts a zero-NULL post-condition; every writer since v2.53.0 stamps
     * both. So no row is reachable through `platform` that is not reachable
     * through `engine`, and a fallback could only ever re-introduce the
     * unfolded-compare bug.
     */
    static async getForGameByProvenance(
        gameId: string,
        filter: { engine?: string | null; device?: string | null },
    ): Promise<RankedEntry[]> {
        const db = await getDatabase();
        const gameMeta = await db.get(`
            SELECT g.id, g.name, g.tournament_id, t.game_room_id
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id = ?
        `, gameId);
        if (!gameMeta) return [];

        const engine = normalizeProvenanceToken(filter.engine);
        const device = normalizeProvenanceToken(filter.device);
        const clauses: string[] = [];
        const params: any[] = [];
        if (engine) {
            clauses.push('AND LOWER(COALESCE(engine, ?)) = ?');
            params.push(UNKNOWN, engine);
        }
        if (device) {
            clauses.push('AND LOWER(COALESCE(device, ?)) = ?');
            params.push(UNKNOWN, device);
        }
        if (clauses.length === 0) return this.getForGame(gameId);

        const entries = await db.all(`
            SELECT
                COALESCE(best.submitted_by_user_id, um.discord_user_id, best.discord_user_id) as discord_user_id,
                best.iscored_username,
                best.score,
                best.platform,
                best.engine,
                best.device,
                up.display_name,
                up.avatar_hash
            FROM (
                SELECT
                    iscored_username,
                    discord_user_id,
                    submitted_by_user_id,
                    score,
                    platform,
                    engine,
                    device,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM score_history
                WHERE game_room_id = ?
                  AND submitted_during_tournament_id = ?
                  AND LOWER(game_name) = LOWER(?)
                  AND orphaned_at IS NULL
                  ${clauses.join('\n                  ')}
            ) best
            LEFT JOIN user_mappings um ON (
                best.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(best.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(best.submitted_by_user_id, um.discord_user_id)
            WHERE best.rn = 1
            ORDER BY best.score DESC
        `, gameMeta.game_room_id, gameMeta.tournament_id, gameMeta.name, ...params);

        return entries.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            display_name: e.display_name || null,
            score: e.score,
            avatar_hash: e.avatar_hash || null,
            platform: e.platform || null,
            engine: e.engine || UNKNOWN,
            device: e.device || UNKNOWN,
        }));
    }

    /**
     * Deprecated `?platform=` entry point, kept working for bookmarks and the
     * Discord/OG links that already carry one. Maps the legacy token through
     * `LEGACY_PLATFORM_MAP` and filters on the axes it implies — so `?platform=vpxs`
     * now correctly resolves to engine `vpx` on device `atgames`.
     *
     * @deprecated v2.58.0 — use `getForGameByProvenance`.
     */
    static async getForGameByPlatform(gameId: string, platform: string): Promise<RankedEntry[]> {
        const { engine, device } = mapLegacyPlatform(platform);
        return this.getForGameByProvenance(gameId, {
            engine: engine === UNKNOWN ? null : engine,
            device: device === UNKNOWN ? null : device,
        });
    }

    /**
     * v2.58.0 (ADR 0016): the distinct engines and devices present on this
     * game's leaderboard (within the active tournament window). Drives the
     * GameDetail tab strip.
     *
     * Read off the SAME columns `getForGameByProvenance` filters on, which is
     * the point: every value returned here is guaranteed to match rows when fed
     * back through the filter. The predecessor returned alias-folded values from
     * a column the filter compared raw, so a tab could match zero rows.
     *
     * `'unknown'` IS included when present — it is a real, and on production the
     * most common, provenance state (63 of ~120 rows). Hiding it would leave a
     * majority of scores unreachable from the tab strip; the FE renders it as
     * "Unspecified". Devices are reported separately and are never a
     * comparability boundary — the FE uses them for secondary filtering only.
     */
    static async getDistinctProvenance(gameId: string): Promise<{ engines: string[]; devices: string[] }> {
        const db = await getDatabase();
        const gameMeta = await db.get(`
            SELECT g.name, g.tournament_id, t.game_room_id
            FROM games g
            LEFT JOIN tournaments t ON t.id = g.tournament_id
            WHERE g.id = ?
        `, gameId);
        if (!gameMeta) return { engines: [], devices: [] };

        const rows = await db.all(`
            SELECT DISTINCT
                LOWER(COALESCE(engine, ?)) as engine,
                LOWER(COALESCE(device, ?)) as device
            FROM score_history
            WHERE game_room_id = ?
              AND submitted_during_tournament_id = ?
              AND LOWER(game_name) = LOWER(?)
              AND orphaned_at IS NULL
        `, UNKNOWN, UNKNOWN, gameMeta.game_room_id, gameMeta.tournament_id, gameMeta.name);

        const engines: string[] = [];
        const devices: string[] = [];
        for (const r of rows as Array<{ engine: string; device: string }>) {
            if (r.engine && !engines.includes(r.engine)) engines.push(r.engine);
            if (r.device && r.device !== UNKNOWN && !devices.includes(r.device)) devices.push(r.device);
        }
        // Known engines first (alphabetical), 'unknown' last — an "Unspecified"
        // tab reads as a residual bucket, not a peer of the real engines.
        engines.sort((a, b) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : a.localeCompare(b)));
        devices.sort();
        return { engines, devices };
    }

    /**
     * Legacy platform ids for the deprecated `distinctPlatforms` response field.
     *
     * DERIVED from `getDistinctProvenance` rather than queried independently, so
     * it cannot disagree with the engines the tab strip and the filter use —
     * which is exactly how the old label/query mismatch arose.
     *
     * @deprecated v2.58.0 — use `getDistinctProvenance`.
     */
    static async getDistinctPlatforms(gameId: string): Promise<string[]> {
        const { engines, devices } = await this.getDistinctProvenance(gameId);
        const out: string[] = [];
        for (const engine of engines) {
            if (engine === UNKNOWN) continue;
            const legacy = deriveLegacyPlatform(engine, (devices.length === 1 ? devices[0] : UNKNOWN) ?? UNKNOWN);
            if (legacy && !out.includes(legacy)) out.push(legacy);
        }
        return out;
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
        // v2.0.2: two-level globalGameId resolution so card title → /games/:id?from=:slug
        // routes correctly. Resolution order:
        //   a. games.global_game_id     (explicit per-game link)
        //   b. global_games.id via case-insensitive name match (approved only)
        // Matches the resolution used by All Games search.
        const activeGames = await db.all(`
            SELECT g.id, g.name as game_name, g.display_name, g.status, t.name as tournament_name, t.type as tournament_type,
                   -- v2.4.0: per-game display_order takes precedence (pinned games
                   -- set their own), falling back to tournament order, then 9999.
                   COALESCE(g.display_order, t.display_order, 9999) as display_order,
                   -- v2.4.0: pinned games are those with no tournament attribution.
                   CASE WHEN g.tournament_id IS NULL THEN 1 ELSE 0 END as is_pinned,
                   COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                   g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                   g.tournament_id, g.external_url, g.notes,
                   COALESCE(g.global_game_id, gg.id) as global_game_id,
                   sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                   sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
            FROM games g
            LEFT JOIN tournaments t ON g.tournament_id = t.id
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
                           COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                           g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                           g.external_url, g.notes,
                           COALESCE(g.global_game_id, gg.id) as global_game_id,
                           sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                           sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
                    FROM games g
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
                           COALESCE(gg.local_image_path, gg.wheel_image_path, gg.image_url) as image_url,
                           g.catalogue_style_id, g.logo_style_id, g.bg_style_id, g.style_header_disabled,
                           g.external_url, g.notes,
                           COALESCE(g.global_game_id, gg.id) as global_game_id,
                           sc_bg.has_background as bg_has_bg, sc_logo.has_header as logo_has_header,
                           sc_cat.has_background as cat_has_bg, sc_cat.has_header as cat_has_header
                    FROM games g
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
                // v2.4.0: pinned games (no tournament) render with a "Pinned"
                // chip instead of the tournament badge. Clients use this flag.
                isPinned: game.is_pinned === 1,
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
