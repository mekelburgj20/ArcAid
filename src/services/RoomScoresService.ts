import { getDatabase } from '../database/database.js';
import { normalizeImageUrl, RankedEntry } from './LeaderboardService.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import { resolveProfiles } from './PlayerProfileResolver.js';

/**
 * scores-page-redesign (B1/B2): "Room Scores" = every score ever set in this
 * room, best-per-player-per-game across sources. `community_scores` already
 * dual-writes into `score_history` (source='community') on every submit
 * (CommunityScoreService.ts), and the admin "wipe player from game" path
 * deletes `score_history` rows but deliberately NOT `community_scores` rows —
 * so `score_history` alone is the correct, non-resurrecting source for this
 * view. No UNION with `community_scores` here (see migration 107 for the
 * one-time backfill of legacy pre-dual-write rows).
 *
 * v2.108.0: the PER-ROW self/admin delete
 * (`ScoreHistoryService.deleteEvent`) does now cascade a community row into
 * its `community_scores` twin. That does not change the reasoning above — the
 * admin wipe path is still `community_scores`-preserving, so a UNION here
 * would still resurrect wiped scores.
 */

export interface RoomScoreCard {
    gameId: string;
    gameName: string;
    displayName: string | null;
    tournamentName: string;
    tournamentType: string;
    imageUrl: string | null;
    gameStatus: string;
    catalogueStyleId: string | null;
    logoStyleId: string | null;
    bgStyleId: string | null;
    styleHeaderDisabled: boolean;
    /** v2.115.0 — per-game background framing (zoom %, position %). */
    bgZoom: number | null;
    bgPosX: number | null;
    bgPosY: number | null;
    bgHasBg: number | null;
    logoHasHeader: number | null;
    catHasBg: number | null;
    catHasHeader: number | null;
    externalUrl: string | null;
    notes: string | null;
    rankings: RankedEntry[];
    globalGameId: string | null;
    lastPlayed: string | null;
    playerCount: number;
    totalScores: number;
    viewerEntry?: RankedEntry | null;
}

export interface RoomScoresViewer {
    discordId: string;
    /** Lowercased iscored_username aliases (user_mappings + payload.username). */
    aliases: Set<string>;
}

interface CardChrome {
    displayName: string | null;
    imageUrl: string | null;
    catalogueStyleId: string | null;
    logoStyleId: string | null;
    bgStyleId: string | null;
    styleHeaderDisabled: boolean;
    bgZoom: number | null;
    bgPosX: number | null;
    bgPosY: number | null;
    bgHasBg: number | null;
    logoHasHeader: number | null;
    catHasBg: number | null;
    catHasHeader: number | null;
    globalGameId: string | null;
}

const EMPTY_CHROME: CardChrome = {
    displayName: null,
    imageUrl: null,
    catalogueStyleId: null,
    logoStyleId: null,
    bgStyleId: null,
    styleHeaderDisabled: false,
    bgZoom: null,
    bgPosX: null,
    bgPosY: null,
    bgHasBg: null,
    logoHasHeader: null,
    catHasBg: null,
    catHasHeader: null,
    globalGameId: null,
};

export class RoomScoresService {
    /**
     * Two-phase read: Phase 1 pulls the paginated game list + aggregate
     * metadata straight from score_history; Phase 2 fetches the top-10 ranking
     * for EVERY game on the page in one windowed query (v2.74.0, S24.6 — was
     * one query per card under `Promise.all`), using the canonical partition
     * from LeaderboardService.recalculate minus the tournament-window filter.
     */
    static async getRoomScores(roomId: string, opts: {
        sort?: 'recent' | 'alpha' | 'most_played';
        limit?: number;
        offset?: number;
        search?: string;
        viewer?: RoomScoresViewer;
    } = {}): Promise<{ data: RoomScoreCard[]; total: number; hasMore: boolean }> {
        const db = await getDatabase();
        const sort = opts.sort || 'recent';
        const limit = opts.limit ?? 48;
        const offset = opts.offset ?? 0;
        const search = opts.search?.trim();

        const searchFilter = search ? 'AND LOWER(game_name) LIKE LOWER(?)' : '';
        const searchParams = search ? [`%${search}%`] : [];

        const orderBy =
            sort === 'alpha' ? 'LOWER(game_name) ASC' :
            sort === 'most_played' ? 'total_scores DESC' :
            'last_played DESC'; // default: recent

        const games = await db.all(`
            SELECT
                MAX(game_name) as game_name,
                COUNT(DISTINCT COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))) as player_count,
                COUNT(*) as total_scores,
                MAX(created_at) as last_played
            FROM score_history
            WHERE game_room_id = ?
              AND orphaned_at IS NULL
              ${searchFilter}
            GROUP BY LOWER(game_name)
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?
        `, roomId, ...searchParams, limit, offset);

        const totalRow = await db.get(`
            SELECT COUNT(*) as c FROM (
                SELECT 1
                FROM score_history
                WHERE game_room_id = ?
                  AND orphaned_at IS NULL
                  ${searchFilter}
                GROUP BY LOWER(game_name)
            )
        `, roomId, ...searchParams);
        const total = totalRow?.c ?? 0;

        const gameNames: string[] = games.map((g: any) => g.game_name as string);
        const chromeMap = await this.resolveCardChrome(roomId, gameNames);
        // v2.74.0 (S24.6): ONE windowed query for the whole page's rankings.
        // Pre-S24 this was `getGameRankings` per card — 48 queries on a full
        // page, in parallel but still 48 round-trips plus 48 profile joins.
        const rankingsByGame = await this.getGameRankingsBatch(roomId, gameNames);

        const data: RoomScoreCard[] = games.map((game: any) => {
            const gameName = game.game_name as string;
            const rankings = rankingsByGame.get(gameName.toLowerCase()) ?? [];
            const chrome = chromeMap.get(gameName.toLowerCase()) || EMPTY_CHROME;

            const card: RoomScoreCard = {
                gameId: chrome.globalGameId || `room_${gameName}`,
                gameName,
                displayName: chrome.displayName,
                tournamentName: '',
                tournamentType: 'room',
                imageUrl: chrome.imageUrl,
                gameStatus: 'ROOM',
                catalogueStyleId: chrome.catalogueStyleId,
                logoStyleId: chrome.logoStyleId,
                bgStyleId: chrome.bgStyleId,
                styleHeaderDisabled: chrome.styleHeaderDisabled,
                bgZoom: chrome.bgZoom,
                bgPosX: chrome.bgPosX,
                bgPosY: chrome.bgPosY,
                bgHasBg: chrome.bgHasBg,
                logoHasHeader: chrome.logoHasHeader,
                catHasBg: chrome.catHasBg,
                catHasHeader: chrome.catHasHeader,
                externalUrl: null,
                notes: null,
                rankings,
                globalGameId: chrome.globalGameId,
                lastPlayed: game.last_played,
                playerCount: game.player_count,
                totalScores: game.total_scores,
            };

            if (opts.viewer) {
                const viewer = opts.viewer;
                card.viewerEntry = rankings.find(r =>
                    r.discord_user_id === viewer.discordId
                    || viewer.aliases.has((r.iscored_username || '').toLowerCase())
                ) || null;
            }

            return card;
        });

        return { data, total, hasMore: offset + data.length < total };
    }

    /**
     * Canonical best-per-player-per-game ranking for EVERY game on the page, in
     * one query — v2.74.0 (S24.6).
     *
     * Identical to `LeaderboardService.recalculate`'s query with the
     * `submitted_during_tournament_id` predicate removed (all-time-best instead
     * of best-during-tournament-window), plus a second window that numbers the
     * best-per-player rows WITHIN each game so the top-10 card preview cut is a
     * predicate rather than a per-game `LIMIT 10`. Grouping is on
     * `LOWER(game_name)`, matching the page query's own `GROUP BY`.
     *
     * Display names/avatars are resolved once for the whole page by
     * `resolveProfiles` (S24.1), not joined per row.
     *
     * Returns a map keyed by LOWERCASED game name.
     */
    private static async getGameRankingsBatch(
        roomId: string,
        gameNames: string[],
    ): Promise<Map<string, RankedEntry[]>> {
        const out = new Map<string, RankedEntry[]>();
        if (gameNames.length === 0) return out;

        const db = await getDatabase();
        const lowerNames = [...new Set(gameNames.map(n => n.toLowerCase()))];
        const placeholders = lowerNames.map(() => '?').join(',');

        const entries = await db.all(`
            SELECT
                ranked.game_key,
                ranked.discord_user_id,
                ranked.submitted_by_user_id,
                ranked.iscored_username,
                ranked.score,
                ranked.platform,
                ranked.engine,
                ranked.device,
                ranked.history_id,
                ranked.source,
                ranked.photo_url,
                ranked.game_rank
            FROM (
                SELECT
                    best.game_key,
                    best.discord_user_id,
                    best.submitted_by_user_id,
                    best.iscored_username,
                    best.score,
                    best.platform,
                    best.engine,
                    best.device,
                    best.history_id,
                    best.source,
                    best.photo_url,
                    ROW_NUMBER() OVER (
                        PARTITION BY best.game_key ORDER BY best.score DESC
                    ) as game_rank
                FROM (
                    SELECT
                        LOWER(game_name) as game_key,
                        iscored_username,
                        discord_user_id,
                        submitted_by_user_id,
                        score,
                        platform,
                        engine,
                        device,
                        -- v2.108.0 (B3): the score_history id + source of the
                        -- row the inner ROW_NUMBER elects as this player's
                        -- best. The per-row delete acts on exactly this id.
                        id as history_id,
                        source,
                        -- v2.109.0 (score-gesture-photos): same row, its photo.
                        photo_url,
                        ROW_NUMBER() OVER (
                            PARTITION BY LOWER(game_name),
                                         COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                            ORDER BY score DESC, created_at ASC
                        ) as rn
                    FROM score_history
                    WHERE game_room_id = ?
                      AND LOWER(game_name) IN (${placeholders})
                      AND orphaned_at IS NULL
                ) best
                WHERE best.rn = 1
            ) ranked
            WHERE ranked.game_rank <= 10
            ORDER BY ranked.game_key, ranked.game_rank
        `, roomId, ...lowerNames);

        const profiles = await resolveProfiles(entries as any[]);
        entries.forEach((e: any, i: number) => {
            const profile = profiles[i]!;
            let list = out.get(e.game_key);
            if (!list) { list = []; out.set(e.game_key, list); }
            list.push({
                rank: e.game_rank,
                discord_user_id: profile.discord_user_id,
                iscored_username: e.iscored_username || 'Unknown',
                display_name: profile.display_name,
                score: e.score,
                avatar_hash: profile.avatar_hash,
                avatar_url: profile.avatar_url,
                // v2.58.0 (ADR 0016): the CTE has always selected `platform` and
                // then dropped it on the floor — the outer SELECT never projected
                // it, so room-card previews showed no provenance at all while every
                // other surface did. Projected properly now, on both new axes.
                platform: e.platform || null,
                engine: e.engine || UNKNOWN,
                device: e.device || UNKNOWN,
                // v2.108.0 (B3) — delete plumbing. `submitted_by_user_id` is
                // the RAW column, NOT `profile.discord_user_id`: the latter is
                // resolved for display and is not an ownership claim.
                history_id: e.history_id ?? null,
                source: e.source ?? null,
                submitted_by_user_id: e.submitted_by_user_id ?? null,
                // v2.109.0 (score-gesture-photos) — same identity-stable
                // pass-through as history_id/source.
                photo_url: e.photo_url ?? null,
            });
        });

        return out;
    }

    /**
     * Batched style/image resolution for card chrome: `games` row overlay
     * (active/pinned games in this room — the admin Leaderboard page's
     * per-game Style button writes here via `StyleCatalogueService.
     * assignImageToGame`) → `game_room_game_library` (per-room library-wide
     * style overlay, written via `assignImageToLibrary`) → `global_games`
     * (approved catalogue match) → `style_catalogue` (has_background/
     * has_header flags). The `games`-row overlay takes precedence over the
     * library overlay — same doctrine as `LeaderboardService.
     * getActiveLeaderboards`, which is the Tournaments tab's card source and
     * reads style columns straight off `games` (it doesn't even consult
     * `game_room_game_library`). Pre-fix, this method only ever read the
     * library row, so a game styled via the per-game Style button (which
     * writes `games.bg_style_id`, not the library) rendered no background on
     * the Room Scores tab while showing one correctly on Tournaments.
     * Batched via IN(...) over all game names on the page instead of
     * per-game N+1.
     */
    private static async resolveCardChrome(roomId: string, gameNames: string[]): Promise<Map<string, CardChrome>> {
        const result = new Map<string, CardChrome>();
        if (gameNames.length === 0) return result;

        const db = await getDatabase();
        const lowerNames = [...new Set(gameNames.map(n => n.toLowerCase()))];
        const placeholders = lowerNames.map(() => '?').join(',');

        const roomLibRows = await db.all(`
            SELECT game_name, catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled,
                   bg_zoom, bg_pos_x, bg_pos_y, global_game_id
            FROM game_room_game_library
            WHERE game_room_id = ? AND LOWER(game_name) IN (${placeholders})
        `, roomId, ...lowerNames);
        const roomLibByName = new Map<string, any>();
        for (const r of roomLibRows) roomLibByName.set((r.game_name as string).toLowerCase(), r);

        // Active/pinned `games` rows for this room — the per-game Style
        // button's write target. `games.status = 'ACTIVE'` covers both
        // tournament-active games AND pinned games (pinned rows are created
        // with status 'ACTIVE' and tournament_id NULL — see gameCreation.ts).
        const gamesRows = await db.all(`
            SELECT name, catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled,
                   bg_zoom, bg_pos_x, bg_pos_y, global_game_id
            FROM games
            WHERE game_room_id = ? AND status = 'ACTIVE' AND LOWER(name) IN (${placeholders})
        `, roomId, ...lowerNames);
        const gamesRowByName = new Map<string, any>();
        for (const g of gamesRows) gamesRowByName.set((g.name as string).toLowerCase(), g);

        const catalogueRows = await db.all(`
            SELECT id, name, local_image_path, wheel_image_path, image_url, display_name
            FROM global_games
            WHERE status = 'approved' AND LOWER(name) IN (${placeholders})
        `, ...lowerNames);
        const catalogueByName = new Map<string, any>();
        for (const c of catalogueRows) catalogueByName.set((c.name as string).toLowerCase(), c);

        const styleIds = new Set<string>();
        for (const name of lowerNames) {
            const roomLib = roomLibByName.get(name);
            if (roomLib?.bg_style_id) styleIds.add(roomLib.bg_style_id);
            if (roomLib?.logo_style_id) styleIds.add(roomLib.logo_style_id);
            if (roomLib?.catalogue_style_id) styleIds.add(roomLib.catalogue_style_id);
            const gamesRow = gamesRowByName.get(name);
            if (gamesRow?.bg_style_id) styleIds.add(gamesRow.bg_style_id);
            if (gamesRow?.logo_style_id) styleIds.add(gamesRow.logo_style_id);
            if (gamesRow?.catalogue_style_id) styleIds.add(gamesRow.catalogue_style_id);
        }
        const styleById = new Map<string, any>();
        if (styleIds.size > 0) {
            const styleIdList = [...styleIds];
            const stylePlaceholders = styleIdList.map(() => '?').join(',');
            const styleRows = await db.all(
                `SELECT id, has_background, has_header FROM style_catalogue WHERE id IN (${stylePlaceholders})`,
                ...styleIdList
            );
            for (const s of styleRows) styleById.set(s.id, s);
        }

        for (const name of lowerNames) {
            const roomLib = roomLibByName.get(name);
            const gamesRow = gamesRowByName.get(name);
            const catalogueGame = catalogueByName.get(name);

            // `games`-row overlay wins whenever it carries ANY style
            // assignment; otherwise fall back to the library overlay.
            const gamesRowHasOverlay = !!(gamesRow?.catalogue_style_id || gamesRow?.logo_style_id || gamesRow?.bg_style_id);
            const overlaySource = gamesRowHasOverlay ? gamesRow : roomLib;

            const catalogueStyleId = overlaySource?.catalogue_style_id || null;
            const logoStyleId = overlaySource?.logo_style_id || null;
            const bgStyleId = overlaySource?.bg_style_id || null;
            const styleHeaderDisabled = !!(overlaySource?.style_header_disabled);
            // v2.115.0 — framing resolves per FIELD (games row first, library
            // default second), deliberately NOT through `overlaySource`: a game
            // can carry a style with no framing of its own while the room's
            // library default has one, and that framing should still apply.
            const bgZoom = gamesRow?.bg_zoom ?? roomLib?.bg_zoom ?? null;
            const bgPosX = gamesRow?.bg_pos_x ?? roomLib?.bg_pos_x ?? null;
            const bgPosY = gamesRow?.bg_pos_y ?? roomLib?.bg_pos_y ?? null;

            let bgHasBg: number | null = null, logoHasHeader: number | null = null, catHasBg: number | null = null, catHasHeader: number | null = null;
            if (bgStyleId && styleById.has(bgStyleId)) bgHasBg = styleById.get(bgStyleId).has_background;
            if (logoStyleId && styleById.has(logoStyleId)) logoHasHeader = styleById.get(logoStyleId).has_header;
            if (catalogueStyleId && styleById.has(catalogueStyleId)) {
                catHasBg = styleById.get(catalogueStyleId).has_background;
                catHasHeader = styleById.get(catalogueStyleId).has_header;
            }

            const globalGameId = gamesRow?.global_game_id || roomLib?.global_game_id || catalogueGame?.id || null;
            const imageUrl = normalizeImageUrl(
                catalogueGame?.local_image_path || catalogueGame?.wheel_image_path || catalogueGame?.image_url || null
            );

            result.set(name, {
                displayName: catalogueGame?.display_name || null,
                imageUrl,
                catalogueStyleId,
                logoStyleId,
                bgStyleId,
                styleHeaderDisabled,
                bgZoom,
                bgPosX,
                bgPosY,
                bgHasBg,
                logoHasHeader,
                catHasBg,
                catHasHeader,
                globalGameId,
            });
        }

        return result;
    }
}
