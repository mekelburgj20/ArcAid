import { getDatabase } from '../database/database.js';
import { normalizeImageUrl, RankedEntry } from './LeaderboardService.js';

/**
 * scores-page-redesign (B1/B2): "Room Scores" = every score ever set in this
 * room, best-per-player-per-game across sources. `community_scores` already
 * dual-writes into `score_history` (source='community') on every submit
 * (CommunityScoreService.ts), and the admin "wipe player from game" path
 * deletes `score_history` rows but deliberately NOT `community_scores` rows —
 * so `score_history` alone is the correct, non-resurrecting source for this
 * view. No UNION with `community_scores` here (see migration 107 for the
 * one-time backfill of legacy pre-dual-write rows).
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
    bgHasBg: null,
    logoHasHeader: null,
    catHasBg: null,
    catHasHeader: null,
    globalGameId: null,
};

export class RoomScoresService {
    /**
     * Two-phase read: Phase 1 pulls the paginated game list + aggregate
     * metadata straight from score_history; Phase 2 fetches each game's
     * top-10 ranking (Promise.all) using the exact canonical partition query
     * from LeaderboardService.recalculate, minus the tournament-window filter.
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

        const data: RoomScoreCard[] = await Promise.all(games.map(async (game: any) => {
            const gameName = game.game_name as string;
            const rankings = await this.getGameRankings(roomId, gameName);
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
        }));

        return { data, total, hasMore: offset + data.length < total };
    }

    /**
     * Canonical best-per-player-per-game ranking, identical to
     * LeaderboardService.recalculate's query with the
     * `submitted_during_tournament_id` predicate removed (all-time-best
     * instead of best-during-tournament-window). Top 10 only — card preview.
     */
    private static async getGameRankings(roomId: string, gameName: string): Promise<RankedEntry[]> {
        const db = await getDatabase();

        const entries = await db.all(`
            SELECT
                COALESCE(best.submitted_by_user_id, um.discord_user_id, best.discord_user_id) as discord_user_id,
                best.iscored_username,
                best.score,
                up.display_name,
                up.avatar_hash
            FROM (
                SELECT
                    iscored_username,
                    discord_user_id,
                    submitted_by_user_id,
                    score,
                    platform,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(submitted_by_user_id, 'iscored:' || LOWER(iscored_username))
                        ORDER BY score DESC, created_at ASC
                    ) as rn
                FROM score_history
                WHERE game_room_id = ?
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
            LIMIT 10
        `, roomId, gameName);

        return entries.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            display_name: e.display_name || null,
            score: e.score,
            avatar_hash: e.avatar_hash || null,
        }));
    }

    /**
     * Batched style/image resolution for card chrome: game_room_game_library
     * (per-room style overlay) → global_games (approved catalogue match) →
     * style_catalogue (has_background/has_header flags). Ported verbatim from
     * the old `/:roomId/community-leaderboards` handler (rooms.ts), batched
     * via IN(...) over all game names on the page instead of per-game N+1.
     */
    private static async resolveCardChrome(roomId: string, gameNames: string[]): Promise<Map<string, CardChrome>> {
        const result = new Map<string, CardChrome>();
        if (gameNames.length === 0) return result;

        const db = await getDatabase();
        const lowerNames = [...new Set(gameNames.map(n => n.toLowerCase()))];
        const placeholders = lowerNames.map(() => '?').join(',');

        const roomLibRows = await db.all(`
            SELECT game_name, catalogue_style_id, logo_style_id, bg_style_id, style_header_disabled, global_game_id
            FROM game_room_game_library
            WHERE game_room_id = ? AND LOWER(game_name) IN (${placeholders})
        `, roomId, ...lowerNames);
        const roomLibByName = new Map<string, any>();
        for (const r of roomLibRows) roomLibByName.set((r.game_name as string).toLowerCase(), r);

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
            const catalogueGame = catalogueByName.get(name);

            const catalogueStyleId = roomLib?.catalogue_style_id || null;
            const logoStyleId = roomLib?.logo_style_id || null;
            const bgStyleId = roomLib?.bg_style_id || null;
            const styleHeaderDisabled = !!(roomLib?.style_header_disabled);

            let bgHasBg: number | null = null, logoHasHeader: number | null = null, catHasBg: number | null = null, catHasHeader: number | null = null;
            if (bgStyleId && styleById.has(bgStyleId)) bgHasBg = styleById.get(bgStyleId).has_background;
            if (logoStyleId && styleById.has(logoStyleId)) logoHasHeader = styleById.get(logoStyleId).has_header;
            if (catalogueStyleId && styleById.has(catalogueStyleId)) {
                catHasBg = styleById.get(catalogueStyleId).has_background;
                catHasHeader = styleById.get(catalogueStyleId).has_header;
            }

            const globalGameId = roomLib?.global_game_id || catalogueGame?.id || null;
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
