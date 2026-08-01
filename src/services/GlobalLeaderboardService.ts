import { getDatabase } from '../database/database.js';
import { logInfo } from '../utils/logger.js';
import { UNKNOWN } from '../utils/scoreProvenance.js';
import { catalogueMatchTokens } from '../utils/platformRules.js';
import {
    buildEngineCategoryExpr,
    categoryEngineIds,
    prospectiveCategoryFromCatalogue,
} from '../utils/engineCategorySql.js';
import { CARD_CATEGORY_ORDER } from '../utils/scoreProvenance.js';

/**
 * The card category expression, for queries that alias `global_scores` as `gs`.
 * Generated from the TypeScript taxonomy — see `utils/engineCategorySql.ts` for
 * why this is derived rather than hand-written SQL.
 */
const CARD_CATEGORY_EXPR = buildEngineCategoryExpr('gs.engine', 'gs.id');

/** Same expression for queries that select from `global_scores` unaliased. */
const CARD_CATEGORY_EXPR_BARE = buildEngineCategoryExpr('engine', 'id');

/**
 * Stable identity for one scoreboard card — v2.59.0 (ADR 0016 P4).
 *
 * A card is a `(game, category)` pair, so the game id alone is no longer
 * unique on the page: one game can render a Simulation card AND an
 * Arcade-Style card. This is the React key, the `top_scores` lookup key and
 * the per-viewer rank key. `null` (the zero-score card, which has no category)
 * folds to the literal `none` so it never collides with a real category id.
 *
 * Pins are deliberately NOT keyed on this — a pin belongs to the game, so
 * every one of its cards shows the same pin state (see the P4 contract).
 */
export function cardId(globalGameId: string, category: string | null): string {
    return `${globalGameId}::${category ?? 'none'}`;
}

export interface GlobalRankedEntry {
    rank: number;
    discord_user_id: string;
    iscored_username: string;
    /** User-chosen global display name (from `user_profiles.display_name`); null when unset. */
    display_name?: string | null;
    score: number;
    photo_url: string | null;
    submitted_at: string;
    origin_type: string;
    origin_game_room_id: string | null;
    origin_room_name: string | null;
    /** Sprint 12 — supports the RoomTag badge on Global Scoreboard rows. */
    origin_room_slug: string | null;
    origin_room_logo_url: string | null;
    /** Sprint 13 — optional admin-set short label; null falls back to slug-derived. */
    origin_room_short_tag: string | null;
    avatar_hash: string | null;
    score_id: string;
    /**
     * v2.5.1: per-row platform stamp shown on the Global Scoreboard's per-game
     * leaderboard. `null` for legacy rows (multi-platform games where a
     * specific platform couldn't be inferred at backfill time).
     *
     * @deprecated v2.58.0 (ADR 0016) — kept because tournament `platform_rules`
     * still read the legacy column, but display is derived from engine/device.
     */
    platform: string | null;
    /**
     * v2.58.0 (ADR 0016): what produced the score — the authoritative field for
     * comparability and the fidelity category. `'unknown'` where nobody recorded
     * it (never null: migration 125 backfilled, every writer stamps it).
     */
    engine: string;
    /** v2.58.0 (ADR 0016): what it ran on. Provenance only. */
    device: string;
}

/**
 * v2.57.0 (A5a) — the minimum number of scores a game must have collected in
 * the trailing 7 days before the hero card is allowed to call it HOT.
 *
 * The design handoff selects the hero as "most scores submitted in the trailing
 * 7 days", unconditionally, and stamps it with a `HOT` badge plus
 * `+{n} scores this week`. Checked against production: in a representative
 * trailing week ONE game had 5 scores and three others had exactly 1. Applied
 * literally, a quiet week crowns a game with a *single* score and calls it hot —
 * the badge stops meaning anything and the acceptance criterion ("a genuinely
 * trending game, not just the first row") is false.
 *
 * So the weekly winner only becomes the hero when it clears this floor.
 * Below it, the hero falls back to the highest `score_count` game in the same
 * filtered result set and renders neutrally: no HOT badge, no weekly delta. A
 * hero card is good page structure either way; it just must not claim heat it
 * doesn't have.
 *
 * 3 is deliberately a floor ("more than a couple of people played it this
 * week"), not a tuned constant — raise it as the community grows.
 */
export const HERO_MIN_WEEKLY_SCORES = 3;

/** Trailing window the hero's "this week" count is measured over. */
export const HERO_WINDOW_DAYS = 7;

/**
 * v2.57.0 (A5a) — the hero card's game. Every field `getTopGames` returns for a
 * grid card, plus the two the hero adds.
 */
export interface HeroGameRow {
    global_game_id: string;
    name: string;
    display_name: string | null;
    manufacturer: string | null;
    year: number | null;
    type: string;
    image_url: string | null;
    local_image_path: string | null;
    wheel_image_path: string | null;
    platforms: string;
    score_count: number;
    top_score: number | null;
    last_submitted_at: string | null;
    popularity: number;
    avg_rating: number;
    rating_count: number;
    /** Scores submitted in the trailing 7 days. */
    weekly_score_count: number;
    /** True only when `weekly_score_count >= HERO_MIN_WEEKLY_SCORES`. */
    is_hot: boolean;
    /**
     * v2.59.0 (P4) — the game's HIGHEST-SCORING fidelity category, or null when
     * it has no scores.
     *
     * The hero is chosen at GAME level and stays that way: `score_count`,
     * `weekly_score_count` and `is_hot` are still the game's totals, and A5a's
     * threshold logic is untouched. But a card has to show *a* board, and a
     * board that silently mixed engines would be the exact claim ADR 0016
     * forbids — so the rows it renders (and the chip naming them) come from
     * this one category.
     */
    category: string | null;
    /** v2.59.0 (P4) — card identity for `top_scores` / rank lookups. */
    card_id: string;
}

/**
 * Leaderboard for a global game. Scope is either 'global' (all rooms combined)
 * or a specific game_room_id (filter to scores that originated in that room).
 *
 * Cached per (global_game_id, scope) in global_leaderboard_cache.
 */
export class GlobalLeaderboardService {
    /**
     * Recalculate and cache the leaderboard for a single global game.
     *
     * Groups by LOWER(iscored_username), takes MAX(score) per player. Soft-deleted
     * scores and exclude_from_global rows are filtered. For room-scoped views,
     * only scores that originated in that room are included (origin_game_room_id).
     */
    static async recalculate(globalGameId: string, scope: string = 'global'): Promise<GlobalRankedEntry[]> {
        const rankings = await GlobalLeaderboardService.rankedRows(globalGameId, scope);

        const db = await getDatabase();
        await db.run(
            `INSERT OR REPLACE INTO global_leaderboard_cache (global_game_id, scope, rankings, generated_at) VALUES (?, ?, ?, ?)`,
            globalGameId, scope, JSON.stringify(rankings), new Date().toISOString()
        );

        logInfo(`Global leaderboard recalculated for ${globalGameId} (${scope}): ${rankings.length} entries`);
        return rankings;
    }

    /**
     * The ranked-rows query behind `recalculate`, with an optional card-category
     * scope (v2.59.0, ADR 0016 P4).
     *
     * Extracted so a per-CATEGORY board is the same query with one extra
     * predicate rather than a second copy that can drift. The predicate sits in
     * the INNERMOST subquery, i.e. before the best-per-player collapse — that
     * ordering is load-bearing. A player with a 900 on `vpx` and a 700 on `fx`
     * must appear on the Arcade-Style card with their 700; collapsing first and
     * filtering after would silently drop them from every board but their best
     * one.
     */
    private static async rankedRows(
        globalGameId: string,
        scope: string = 'global',
        category?: string | null,
    ): Promise<GlobalRankedEntry[]> {
        const db = await getDatabase();

        const isGlobal = scope === 'global';
        // For global scope, respect exclude_from_global. For room scope, show everything
        // (a user opted out of global, but their room submission still counts in the room).
        const excludeFilter = isGlobal ? 'AND exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];
        const categoryFilter = category ? `AND ${CARD_CATEGORY_EXPR_BARE} = ?` : '';
        const categoryParams = category ? [category] : [];

        // Pull all non-deleted scores for the game, pick best per player, enrich with avatar + room name.
        // Partition collapses by submitted_by_user_id when set (Discord-linked aliases combine
        // into one entry); falls back to per-name partition for anon rows.
        const rows = await db.all(`
            SELECT
                best.score_id,
                COALESCE(best.submitted_by_user_id, um.discord_user_id, best.discord_user_id) as discord_user_id,
                best.iscored_username,
                best.score,
                best.photo_url,
                best.submitted_at,
                best.origin_type,
                best.origin_game_room_id,
                best.platform,
                best.engine,
                best.device,
                gr.name as origin_room_name,
                gr.slug as origin_room_slug,
                gr.logo_url as origin_room_logo_url,
                gr.short_tag as origin_room_short_tag,
                up.display_name,
                up.avatar_hash
            FROM (
                SELECT
                    gs.id as score_id,
                    gs.discord_user_id,
                    gs.submitted_by_user_id,
                    gs.iscored_username,
                    gs.score,
                    gs.photo_url,
                    gs.submitted_at,
                    gs.origin_type,
                    gs.origin_game_room_id,
                    gs.platform,
                    gs.engine,
                    gs.device,
                    ROW_NUMBER() OVER (
                        PARTITION BY COALESCE(gs.submitted_by_user_id, 'iscored:' || LOWER(COALESCE(gs.iscored_username, gs.discord_user_id)))
                        ORDER BY gs.score DESC, gs.submitted_at ASC
                    ) as rn
                FROM (
                    SELECT
                        id,
                        player_id as discord_user_id,
                        submitted_by_user_id,
                        iscored_username,
                        score,
                        photo_url,
                        submitted_at,
                        origin_type,
                        origin_game_room_id,
                        platform,
                        engine,
                        device
                    FROM global_scores
                    WHERE global_game_id = ?
                      AND deleted_at IS NULL
                      AND orphaned_at IS NULL
                      ${excludeFilter}
                      ${roomFilter}
                      ${categoryFilter}
                ) gs
            ) best
            LEFT JOIN game_rooms gr ON gr.id = best.origin_game_room_id
            LEFT JOIN user_mappings um ON (
                best.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(best.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(best.submitted_by_user_id, um.discord_user_id)
            WHERE best.rn = 1
            GROUP BY best.score_id
            ORDER BY best.score DESC, best.submitted_at ASC
        `, globalGameId, ...roomParams, ...categoryParams);

        const rankings: GlobalRankedEntry[] = rows.map((e: any, i: number) => ({
            rank: i + 1,
            discord_user_id: e.discord_user_id,
            iscored_username: e.iscored_username || 'Unknown',
            display_name: e.display_name || null,
            score: e.score,
            photo_url: e.photo_url || null,
            submitted_at: e.submitted_at,
            origin_type: e.origin_type,
            origin_game_room_id: e.origin_game_room_id || null,
            origin_room_name: e.origin_room_name || null,
            origin_room_slug: e.origin_room_slug || null,
            origin_room_logo_url: e.origin_room_logo_url || null,
            origin_room_short_tag: e.origin_room_short_tag || null,
            avatar_hash: e.avatar_hash || null,
            score_id: e.score_id,
            platform: e.platform || null,
            engine: e.engine || UNKNOWN,
            device: e.device || UNKNOWN,
        }));

        return rankings;
    }

    /**
     * Get cached leaderboard, recalculating if missing.
     */
    static async getForGame(globalGameId: string, scope: string = 'global'): Promise<GlobalRankedEntry[]> {
        const db = await getDatabase();
        const cached = await db.get(
            'SELECT rankings FROM global_leaderboard_cache WHERE global_game_id = ? AND scope = ?',
            globalGameId, scope
        );
        if (cached) return JSON.parse(cached.rankings);
        return this.recalculate(globalGameId, scope);
    }

    /**
     * The ranked board for ONE card — a `(game, category)` pair (v2.59.0, P4).
     *
     * Deliberately UNCACHED, unlike `getForGame`. It is only ever called for
     * the handful of cards a viewer actually holds a score on (to build the
     * three-row `neighbors` window), so caching would add a cache row per
     * category per scope to save a query that runs a few times per page load.
     * `global_leaderboard_cache` is keyed `(global_game_id, scope)` and its
     * invalidation sweeps by game, so a composite scope string WOULD be
     * correct — it just isn't worth the extra state.
     *
     * A null category is the zero-score card: no scores, so no board.
     */
    static async getForCard(
        globalGameId: string,
        category: string | null,
        scope: string = 'global',
    ): Promise<GlobalRankedEntry[]> {
        if (!category) return [];
        return GlobalLeaderboardService.rankedRows(globalGameId, scope, category);
    }

    /**
     * Every board ONE game has, biggest first (v2.63.0).
     *
     * The game-detail page's counterpart to `getTopGames`' per-card rows: the
     * scoreboard already splits a mixed game into a Simulation card and an
     * Arcade-Style card, but clicking either one landed on a single COMBINED
     * list that mixed the two back together — the exact comparability claim ADR
     * 0016 exists to forbid, made on the page a player actually reads. This is
     * what lets that page render one board per category instead.
     *
     * Ordering is `score_count DESC`, then the taxonomy's own display order as
     * a deterministic tiebreak. Biggest-first means "first" and "highest" name
     * the SAME element, so the page's default board and its fallback for a
     * missing or bogus `?category=` are one rule rather than two.
     *
     * `score_count` counts score ROWS, matching `getDominantCards`. A board's
     * rendered length is smaller wherever one player holds several scores
     * (best-per-player collapses them), so this is a size ranking, not a
     * row-count promise — the page must not print it as "N players".
     *
     * A game with no scores returns `[]`, which the caller reads as the
     * zero-score claim state.
     */
    static async getCardCategories(
        globalGameId: string,
        scope: string = 'global',
    ): Promise<Array<{ category: string; score_count: number }>> {
        const db = await getDatabase();
        const isGlobal = scope === 'global';
        const excludeFilter = isGlobal ? 'AND gs.exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND gs.origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];

        const rows = await db.all(`
            SELECT ${CARD_CATEGORY_EXPR} as category, COUNT(*) as score_count
            FROM global_scores gs
            WHERE gs.global_game_id = ?
              AND gs.deleted_at IS NULL
              AND gs.orphaned_at IS NULL
              ${excludeFilter}
              ${roomFilter}
            GROUP BY category
        `, globalGameId, ...roomParams);

        const rank = (category: string) => {
            const i = CARD_CATEGORY_ORDER.indexOf(category);
            return i === -1 ? CARD_CATEGORY_ORDER.length : i;
        };

        return rows
            .filter((row: any) => row.category != null)
            .map((row: any) => ({
                category: String(row.category),
                score_count: row.score_count ?? 0,
            }))
            .sort((a, b) =>
                b.score_count - a.score_count || rank(a.category) - rank(b.category));
    }

    /**
     * Invalidate cache for a game. Clears both global and all room-scoped entries
     * since any new score on that game potentially shifts multiple leaderboards.
     */
    static async invalidate(globalGameId: string): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM global_leaderboard_cache WHERE global_game_id = ?', globalGameId);
    }

    static async invalidateAll(): Promise<void> {
        const db = await getDatabase();
        await db.run('DELETE FROM global_leaderboard_cache');
    }

    /**
     * Catalogue search matching (v2.51.0, A3 — the ⌘K palette's server half).
     *
     * Single-token queries keep the pre-A3 behavior byte-for-byte: one `%needle%`
     * matched against name / display_name / manufacturer. That path is what the
     * page's plain search field has always done, and `"haunt"` → Haunted House
     * must not regress.
     *
     * Multi-token queries now AND across whitespace-separated tokens, so
     * `"stern 1995"` means "Stern AND 1995" rather than one literal substring
     * (which matched nothing, since no row contains the string "stern 1995").
     * A token that looks like a calendar year (1900-2099) additionally matches
     * `gg.year`. The year comparison is OR'd with the same text match rather
     * than replacing it, so titles that legitimately contain a number —
     * "Pinball 2000", "NBA Fastbreak 1997" — stay findable; a query token only
     * ever *widens* what it can match, never narrows it.
     *
     * Every value is bound as a parameter; user input is never interpolated
     * into the SQL string.
     *
     * Returns null for an all-whitespace query (caller adds no clause).
     */
    private static buildSearchFilter(search: string): { clause: string; params: any[] } | null {
        const trimmed = search.trim();
        if (!trimmed) return null;

        const textMatch = `(LOWER(gg.name) LIKE ? OR LOWER(COALESCE(gg.display_name, '')) LIKE ? OR LOWER(COALESCE(gg.manufacturer, '')) LIKE ?)`;

        const tokens = trimmed.split(/\s+/).filter(Boolean);
        if (tokens.length <= 1) {
            const needle = `%${trimmed.toLowerCase()}%`;
            return { clause: textMatch, params: [needle, needle, needle] };
        }

        const clauses: string[] = [];
        const params: any[] = [];
        for (const token of tokens) {
            const needle = `%${token.toLowerCase()}%`;
            if (GlobalLeaderboardService.isYearToken(token)) {
                clauses.push(`(gg.year = ? OR ${textMatch})`);
                params.push(Number(token), needle, needle, needle);
            } else {
                clauses.push(textMatch);
                params.push(needle, needle, needle);
            }
        }
        return { clause: `(${clauses.join(' AND ')})`, params };
    }

    /**
     * A bare 4-digit token inside the plausible release-year window. "1000" and
     * "3000" are deliberately NOT years — they are far more likely to be part of
     * a title ("Pinball 3000") than a manufacture date.
     */
    private static isYearToken(token: string): boolean {
        if (!/^\d{4}$/.test(token)) return false;
        const n = Number(token);
        return n >= 1900 && n <= 2099;
    }

    /**
     * The catalogue-view filter set, in one place (v2.57.0).
     *
     * Extracted from `getTopGames` so `getHeroGame` is filtered by CONSTRUCTION
     * rather than by a second copy that has to be kept in step. The hero has to
     * respect the same platform group / room scope / search the grid does — a
     * globally-hottest hero above a Physical-only grid is incoherent — and the
     * only durable way to guarantee that is for both to build their SQL here.
     *
     * Score-level predicates belong in the LEFT JOIN (so zero-score games still
     * appear); game-level predicates belong in WHERE (so non-matching games
     * vanish entirely).
     */
    private static buildCatalogueFilters(options: {
        scope?: string;
        search?: string;
        type?: string;
        platforms?: string[];
        category?: string;
    }): { joinClause: string; joinParams: any[]; whereClause: string; whereParams: any[] } {
        const scope = options.scope || 'global';
        const isGlobal = scope === 'global';

        const joinConditions: string[] = ['gs.global_game_id = gg.id', 'gs.deleted_at IS NULL'];
        const joinParams: any[] = [];
        if (isGlobal) {
            joinConditions.push('gs.exclude_from_global = 0');
        } else {
            joinConditions.push('gs.origin_game_room_id = ?');
            joinParams.push(scope);
        }

        const whereConditions: string[] = [
            `gg.status = 'approved'`,
            `gg.global_leaderboard = 1`,
        ];
        const whereParams: any[] = [];

        if (options.type) {
            whereConditions.push('gg.type = ?');
            whereParams.push(options.type);
        }
        if (options.search && options.search.trim()) {
            const search = GlobalLeaderboardService.buildSearchFilter(options.search);
            if (search) {
                whereConditions.push(search.clause);
                whereParams.push(...search.params);
            }
        }
        if (options.platforms && options.platforms.length > 0) {
            // v2.58.0 (ADR 0016) — exact JSON membership, engine-equivalent.
            //
            // `gg.platforms` is a JSON array of legacy platform ids, and the
            // old `LIKE '%"vpx"%'` treated it as an opaque string. Quoting kept
            // `vpx` from matching `vpxs` by accident, but ADR 0016 says those
            // ARE the same engine, so the "safe" pattern was quietly excluding
            // VPX-Standalone titles from a VPX filter. `json_each` gives an
            // exact per-element compare, and the shared expansion supplies the
            // engine's full id set — so the filter now over- and under-matches
            // on neither axis.
            //
            // ADR 0016 catalogue phase §4 / hazard H-D — the expansion is now
            // `catalogueMatchTokens`, shared with `GlobalGameService.search`
            // (which was still doing a raw `includes`, so the same chip
            // returned different games on the two surfaces). It supersedes
            // `equivalentLegacyPlatforms` here by also resolving ENGINE ids, so
            // `atgames` finds both a pre-fold row (platform `atgames`) and a
            // folded one (engine `atgames_native`).
            const tokens = new Set<string>();
            for (const p of options.platforms) {
                for (const t of catalogueMatchTokens(p)) tokens.add(t);
            }
            const list = [...tokens];
            if (list.length > 0) {
                whereConditions.push(`EXISTS (
                    SELECT 1 FROM json_each(gg.platforms) je
                    WHERE LOWER(je.value) IN (${list.map(() => '?').join(',')})
                )`);
                whereParams.push(...list);
            }
        }

        // v2.59.0 (ADR 0016 P4) — the category chip.
        //
        // WHERE, not HAVING, and not the LEFT JOIN. In WHERE it discards score
        // rows outside the chosen band BEFORE grouping, so a mixed game yields
        // exactly the one card that was asked for with the right count. In the
        // JOIN it would instead keep every game and show them all with a count
        // of zero.
        //
        // The category id is a caller-supplied value, so unlike the engine ids
        // baked into the expression it is BOUND, not interpolated.
        //
        // ── v2.63.0: zero-score games match via the CATALOGUE ───────────────
        //
        // A game with no scores produces a NULL category (the LEFT JOIN found
        // nothing), and `NULL = 'simulation'` is NULL, so pre-v2.63 an empty
        // game fell out of EVERY category filter. Nobody could reach an
        // unplayed table through the chip that describes it, which is the one
        // place a `Claim 1st →` CTA is most worth showing.
        //
        // Since v2.62.0 `global_games.platforms` holds canonical ENGINE ids, so
        // the band a zero-score game's FIRST score would land in is derivable
        // without inventing anything. The second disjunct says exactly that: no
        // score row (`gs.id IS NULL`) AND at least one catalogue engine in the
        // chosen band. A game on `vpx` + `fx` matches BOTH bands, which is
        // correct — it will genuinely produce two boards.
        //
        // Games WITH scores are untouched. `gs.id IS NULL` is false for every
        // row a successful join produced, so a scored game can only ever match
        // through its score-derived category — its boards stay what they are,
        // and a catalogue row claiming an engine nobody has scored on cannot
        // conjure a card.
        //
        // The engine ids come from `categoryEngineIds` (the same taxonomy the
        // CASE expression is generated from) and are BOUND. `unspecified`
        // yields an empty list — no engine has "no band" — so it keeps exactly
        // the pre-v2.63 clause and zero-score games stay out of it.
        if (options.category) {
            const engines = categoryEngineIds(options.category);
            if (engines.length > 0) {
                // `json_valid` guard: `json_each` THROWS "malformed JSON" on a
                // NULL or non-JSON `platforms`, and one such row would 500 the
                // whole scoreboard rather than just excluding that game. The
                // column is `TEXT DEFAULT '[]'` but nullable, and every
                // importer writes it independently, so treating a broken value
                // as "no engines" is the only failure mode worth having.
                whereConditions.push(`(
                    ${CARD_CATEGORY_EXPR} = ?
                    OR (gs.id IS NULL AND EXISTS (
                        SELECT 1 FROM json_each(
                            CASE WHEN json_valid(gg.platforms) THEN gg.platforms ELSE '[]' END
                        ) cje
                        WHERE LOWER(TRIM(cje.value)) IN (${engines.map(() => '?').join(',')})
                    ))
                )`);
                whereParams.push(options.category, ...engines);
            } else {
                whereConditions.push(`${CARD_CATEGORY_EXPR} = ?`);
                whereParams.push(options.category);
            }
        }

        return {
            joinClause: joinConditions.join(' AND '),
            joinParams,
            whereClause: whereConditions.join(' AND '),
            whereParams,
        };
    }

    /**
     * v2.57.0 (A5a) — the hero card's game for a given filtered view.
     *
     * Two-branch selection, per `HERO_MIN_WEEKLY_SCORES`:
     *   1. the game with the most scores in the trailing 7 days, IF that count
     *      clears the floor → `is_hot: true` + the weekly delta to render;
     *   2. otherwise the highest `score_count` game in the same view →
     *      `is_hot: false`, weekly count still reported but never rendered as a
     *      "+n this week" claim.
     *
     * Returns null when no game in the view has a single score. A hero card
     * exists to showcase a champion; with nothing to show, the page is better
     * off as a plain grid (this also covers the empty-result-set case).
     *
     * Cost note: the weekly count is one extra conditional SUM over the SAME
     * LEFT JOIN `getTopGames` already performs, ordered + LIMIT 1. No new index
     * is required — `idx_global_scores_submitted` on `submitted_at` predates
     * this — and the timestamp column is `global_scores.submitted_at`; there is
     * no `created_at` on that table.
     */
    static async getHeroGame(options: {
        scope?: string;
        search?: string;
        type?: string;
        platforms?: string[];
        category?: string;
    } = {}): Promise<HeroGameRow | null> {
        const db = await getDatabase();
        const { joinClause, joinParams, whereClause, whereParams } =
            GlobalLeaderboardService.buildCatalogueFilters(options);

        const since = new Date(Date.now() - HERO_WINDOW_DAYS * 86_400_000).toISOString();
        const popularityExpr =
            `COALESCE(SUM(1.0 / (1.0 + (julianday('now') - julianday(gs.submitted_at)) / 14.0)), 0)`;

        const select = (orderBy: string) => `
            SELECT
                gg.id as global_game_id,
                gg.name,
                gg.display_name,
                gg.manufacturer,
                gg.year,
                gg.type,
                gg.image_url,
                gg.local_image_path,
                gg.wheel_image_path,
                gg.platforms,
                COUNT(gs.id) as score_count,
                MAX(gs.score) as top_score,
                MAX(gs.submitted_at) as last_submitted_at,
                ${popularityExpr} as popularity,
                COALESCE(gr.avg_rating, 0) as avg_rating,
                COALESCE(gr.rating_count, 0) as rating_count,
                COALESCE(SUM(CASE WHEN gs.submitted_at >= ? THEN 1 ELSE 0 END), 0) as weekly_score_count
            FROM global_games gg
            LEFT JOIN global_scores gs ON ${joinClause}
            LEFT JOIN (
                SELECT global_game_id,
                       AVG(rating) as avg_rating,
                       COUNT(*) as rating_count
                FROM global_game_ratings
                GROUP BY global_game_id
            ) gr ON gr.global_game_id = gg.id
            WHERE ${whereClause}
            GROUP BY gg.id
            HAVING COUNT(gs.id) > 0
            ORDER BY ${orderBy}
            LIMIT 1`;

        /**
         * P4 — attach the game's dominant category. One extra query, page-1
         * only, bounded to a single game id. A correlated subquery inside
         * `select()` would have been threaded through three clause builders
         * for no measurable gain.
         *
         * `category` is scoped by the SAME room/category filters the hero was
         * chosen under, so a room-scoped hero names the category it leads in
         * *that room*.
         */
        const withCategory = async (row: any, isHot: boolean): Promise<HeroGameRow> => {
            const cards = await GlobalLeaderboardService.getDominantCards(
                [row.global_game_id], options.scope || 'global', options.category,
            );
            const category = cards[row.global_game_id]?.category ?? null;
            return {
                ...row,
                is_hot: isHot,
                category,
                card_id: cardId(row.global_game_id, category),
            } as HeroGameRow;
        };

        // `since` binds in the SELECT list, so it leads the parameter order.
        const hot = await db.get(
            select('weekly_score_count DESC, score_count DESC, gg.name COLLATE NOCASE ASC'),
            since, ...joinParams, ...whereParams,
        );
        if (hot && hot.weekly_score_count >= HERO_MIN_WEEKLY_SCORES) {
            return withCategory(hot, true);
        }

        // Nothing in this view has any score at all — the hot query already
        // proved it (it only filters on HAVING COUNT > 0), so skip the second
        // round-trip.
        if (!hot) return null;

        const neutral = await db.get(
            select('score_count DESC, popularity DESC, gg.name COLLATE NOCASE ASC'),
            since, ...joinParams, ...whereParams,
        );
        return neutral ? withCategory(neutral, false) : null;
    }

    /**
     * The dominant CARD of each game — its biggest fidelity category, plus
     * that category's score count and top score (v2.59.0, ADR 0016 P4).
     *
     * Two surfaces need exactly one card for a game that may have several:
     * the hero (game-level by design) and the My Pins rail (one entry per
     * pinned game — pins are keyed on the game, so multiplying rail entries
     * per category would be a regression, not a feature). "Biggest" means most
     * scores, tie-broken by top score then category id so the choice is
     * deterministic across page loads.
     *
     * Games with no qualifying scores are ABSENT from the result; callers read
     * that as `category: null`, the uncategorised card.
     */
    static async getDominantCards(
        gameIds: string[],
        scope: string = 'global',
        category?: string,
    ): Promise<Record<string, { category: string; score_count: number; top_score: number | null }>> {
        if (gameIds.length === 0) return {};
        const db = await getDatabase();
        const isGlobal = scope === 'global';
        const excludeFilter = isGlobal ? 'AND gs.exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND gs.origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];
        const categoryFilter = category ? `AND ${CARD_CATEGORY_EXPR} = ?` : '';
        const categoryParams = category ? [category] : [];
        const placeholders = gameIds.map(() => '?').join(',');

        const rows = await db.all(`
            SELECT
                gs.global_game_id,
                ${CARD_CATEGORY_EXPR} as category,
                COUNT(*) as score_count,
                MAX(gs.score) as top_score
            FROM global_scores gs
            WHERE gs.global_game_id IN (${placeholders})
              AND gs.deleted_at IS NULL
              AND gs.orphaned_at IS NULL
              ${excludeFilter}
              ${roomFilter}
              ${categoryFilter}
            GROUP BY gs.global_game_id, category
            ORDER BY gs.global_game_id ASC, score_count DESC, top_score DESC, category ASC
        `, ...gameIds, ...roomParams, ...categoryParams);

        const out: Record<string, { category: string; score_count: number; top_score: number | null }> = {};
        for (const row of rows) {
            // ORDER BY already put each game's winner first, so first-wins.
            if (out[row.global_game_id]) continue;
            out[row.global_game_id] = {
                category: row.category,
                score_count: row.score_count ?? 0,
                top_score: row.top_score ?? null,
            };
        }
        return out;
    }

    /**
     * Paginated catalogue view — ONE ROW PER CARD, where a card is a
     * `(game, fidelity category)` pair (v2.59.0, ADR 0016 P4).
     *
     * Before P4 this was one row per game and every score on the game shared a
     * board, which is exactly the comparability problem ADR 0016 exists to fix:
     * a VPX score and an FX score are not the same contest. `GROUP BY gg.id`
     * became `GROUP BY gg.id, <category>`, so a game with scores on both
     * engines now yields two cards and each aggregate — `score_count`,
     * `top_score`, `last_submitted_at`, `popularity` — is that CATEGORY's
     * figure, never the game's total.
     *
     * Three consequences worth stating outright:
     *
     *   • **Nothing is dropped.** `unspecified` is a category like any other
     *     here, so the 38-of-67 production rows with `engine='unknown'` get a
     *     card instead of falling through the grouping. The union of a game's
     *     cards is exactly its score set.
     *   • **`total` counts CARDS, not games**, and so does pagination.
     *   • **Ordering is a TOTAL order.** Every sort ends in
     *     `gg.id, category`, which is unique per row. Without that tiebreak,
     *     ties (identical popularity, or two categories of the same game with
     *     the same name) could be returned in a different order for `offset=0`
     *     and `offset=30`, silently dropping or duplicating a card across the
     *     page boundary.
     *
     * All catalogue games still appear (LEFT JOIN), including ones with zero
     * scores: those produce a NULL category — a single uncategorised card that
     * keeps discovery and the `Claim 1st →` CTA. That falls out of the join
     * rather than a special branch.
     *
     * Popularity formula: SUM(1 / (1 + age_in_days / 14)). 14-day half-life means a
     * score today is worth ~1, 14 days ago ~0.5, 90 days ago ~0.135.
     */
    static async getTopGames(options: {
        scope?: string;
        sort?: 'popular' | 'most_scores' | 'highest_rated' | 'most_recent' | 'name_asc' | 'pinned';
        limit?: number;
        offset?: number;
        search?: string;
        type?: string;
        platforms?: string[];
        /**
         * v2.59.0 (P4) — the category chip. One of `CARD_CATEGORY_ORDER`;
         * absent means "All". Filters which CARDS appear, and (in `game`
         * grouping) which games qualify.
         */
        category?: string;
        /**
         * v2.59.0 (P4) — `card` (default) returns one row per
         * `(game, category)`. `game` collapses back to one row per game and is
         * used by the ⌘K palette, which searches GAMES: a game matches if any
         * of its cards would. Those rows carry `category: null` because they
         * represent no single board.
         */
        groupBy?: 'card' | 'game';
        /**
         * v2.52.0 (A4) — the viewer whose pins `sort=pinned` orders by. Also
         * populates `pinned_at` on every row, which the route turns into
         * `is_pinned`. Absent (anonymous) → `sort=pinned` degrades to
         * `popular` rather than erroring; that fallback is the caller's job.
         */
        pinnedUserId?: string;
        /**
         * scores-page-redesign (B3): when true (and scope is global), bound the
         * global catalogue view to games WITH at least one live global score —
         * the room Scoreboard's "Global" tab lens. Default/absent leaves the
         * standalone /scoreboard catalogue-browse behavior byte-identical
         * (zero-score catalogue games still appear there).
         */
        hasScores?: boolean;
    } = {}): Promise<{
        data: Array<{
            global_game_id: string;
            name: string;
            display_name: string | null;
            manufacturer: string | null;
            year: number | null;
            type: string;
            image_url: string | null;
            local_image_path: string | null;
            wheel_image_path: string | null;
            platforms: string;
            score_count: number;
            top_score: number | null;
            last_submitted_at: string | null;
            popularity: number;
            avg_rating: number;
            rating_count: number;
            /**
             * v2.59.0 (P4) — the card's fidelity category, or null when the
             * game has no scores at all (the single uncategorised card).
             */
            category: string | null;
            /** v2.59.0 (P4) — `${global_game_id}::${category ?? 'none'}`. */
            card_id: string;
            /**
             * v2.63.0 — DISPLAY ONLY. The band a zero-score card's catalogue
             * engines unambiguously imply, so its `Claim 1st →` card can say
             * which board the first score will open. Null for every card that
             * has scores (there `category` is the answer) and null when the
             * catalogue is ambiguous or silent.
             *
             * Deliberately a SEPARATE field rather than a value folded into
             * `category`. `category` means "this card's board", and null means
             * "there is no board" — the invariant `card_id` is derived from and
             * that the P4 coverage tests rest on. A prospective band is a
             * different claim ("there is no board YET, and here is the one that
             * would open"), so it gets its own name instead of overloading one
             * that already has a job.
             */
            prospective_category?: string | null;
            /** v2.52.0: ISO pin timestamp for `pinnedUserId`, else null/absent. */
            pinned_at?: string | null;
        }>;
        total: number;
        hasMore: boolean;
    }> {
        const db = await getDatabase();
        const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
        const offset = Math.max(options.offset ?? 0, 0);
        const scope = options.scope || 'global';
        const isGlobal = scope === 'global';

        const { joinClause, joinParams, whereClause, whereParams } =
            GlobalLeaderboardService.buildCatalogueFilters(options);

        // Popularity: recency-weighted score count, 14-day half-life.
        // julianday('now') - julianday(submitted_at) = age in days.
        const popularityExpr =
            `COALESCE(SUM(1.0 / (1.0 + (julianday('now') - julianday(gs.submitted_at)) / 14.0)), 0)`;

        // v2.52.0 (A4) — the viewer's pin timestamp per row.
        //
        // A correlated scalar subquery, deliberately NOT a LEFT JOIN: this
        // query GROUPs BY gg.id and a join would put `global_game_pins` inside
        // the aggregate, quietly multiplying `score_count`/`popularity` for
        // pinned rows.
        //
        // The column is OMITTED ENTIRELY when there is no viewer rather than
        // selected as a literal NULL — an anonymous `/api/global/scoreboard`
        // response must keep exactly the key set it had before A4, and a
        // `pinned_at: null` on every row would break that. Its bind parameter
        // is the first in the statement, hence its own params array ahead of
        // joinParams.
        const selectParams: any[] = [];
        let pinnedAtSelect = '';
        if (options.pinnedUserId) {
            pinnedAtSelect = `,
                (SELECT p.created_at FROM global_game_pins p
                 WHERE p.global_game_id = gg.id AND p.discord_user_id = ?) as pinned_at`;
            selectParams.push(options.pinnedUserId);
        }

        // v2.59.0 (P4) — the grouping key. `card` splits a game per fidelity
        // category; `game` collapses back for the ⌘K palette, which searches
        // games. `groupKey` is what both GROUP BY and the count subquery use,
        // so the two can never disagree about what a "row" is.
        const byCard = options.groupBy !== 'game';
        const categorySelect = byCard ? `${CARD_CATEGORY_EXPR} as category` : 'NULL as category';
        const groupKey = byCard ? 'gg.id, category' : 'gg.id';

        /**
         * Every sort ends in `gg.id, category` — a UNIQUE key per row, which is
         * what makes LIMIT/OFFSET pagination stable. `gg.name` was never unique
         * (two games can share a title) and is now doubly non-unique, since one
         * game contributes several rows under the same name. A non-total order
         * lets SQLite return tied rows in any order per statement, so page 2
         * could repeat or skip a card that page 1 already showed.
         */
        const stableTail = byCard ? 'gg.id ASC, category ASC' : 'gg.id ASC';
        const orderBy = (
            // Pinned first, most-recently-pinned leading, then the standard
            // `popular` ordering for everything else. `pinned_at IS NULL` sorts
            // 0 (pinned) before 1 (not), so it is the primary key of the sort.
            options.sort === 'pinned' && options.pinnedUserId
                ? 'pinned_at IS NULL ASC, pinned_at DESC, popularity DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'most_scores' ? 'score_count DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'most_recent' ? 'last_submitted_at DESC NULLS LAST, gg.name COLLATE NOCASE ASC' :
            options.sort === 'highest_rated' ? 'avg_rating DESC, rating_count DESC, gg.name COLLATE NOCASE ASC' :
            options.sort === 'name_asc' ? 'gg.name COLLATE NOCASE ASC' :
            'popularity DESC, gg.name COLLATE NOCASE ASC' // default: popular
        ) + `, ${stableTail}`;

        // When scoped to a room, only show games that have scores from that room.
        // B3: hasScores=true applies the same bound to the global scope (the
        // room Scoreboard's "Global" tab lens), while leaving the standalone
        // /scoreboard catalogue browse (hasScores absent) unaffected.
        const requireScores = options.hasScores === true;
        const havingClause = (!isGlobal || requireScores) ? 'HAVING COUNT(gs.id) > 0' : '';

        // Count query. Pre-P4 the global, unfiltered case had a fast path
        // (`COUNT(*) FROM global_games`) because rows and games were the same
        // thing; a row is now a CARD, so the count has to do the same grouping
        // the data query does or `total` would disagree with what pagination
        // walks. One shared shape covers every scope/filter combination.
        const countRow = await db.get(
            `SELECT COUNT(*) as c FROM (
                SELECT gg.id, ${categorySelect}
                FROM global_games gg
                LEFT JOIN global_scores gs ON ${joinClause}
                WHERE ${whereClause}
                GROUP BY ${groupKey}
                ${havingClause}
            )`,
            ...joinParams, ...whereParams
        );
        const total: number = countRow?.c ?? 0;

        const data = await db.all(
            `SELECT
                gg.id as global_game_id,
                gg.name,
                gg.display_name,
                gg.manufacturer,
                gg.year,
                gg.type,
                gg.image_url,
                gg.local_image_path,
                gg.wheel_image_path,
                gg.platforms,
                COUNT(gs.id) as score_count,
                MAX(gs.score) as top_score,
                MAX(gs.submitted_at) as last_submitted_at,
                ${popularityExpr} as popularity,
                COALESCE(gr.avg_rating, 0) as avg_rating,
                COALESCE(gr.rating_count, 0) as rating_count,
                ${categorySelect}${pinnedAtSelect}
            FROM global_games gg
            LEFT JOIN global_scores gs ON ${joinClause}
            LEFT JOIN (
                SELECT global_game_id,
                       AVG(rating) as avg_rating,
                       COUNT(*) as rating_count
                FROM global_game_ratings
                GROUP BY global_game_id
            ) gr ON gr.global_game_id = gg.id
            WHERE ${whereClause}
            GROUP BY ${groupKey}
            ${havingClause}
            ORDER BY ${orderBy}
            LIMIT ? OFFSET ?`,
            ...selectParams, ...joinParams, ...whereParams, limit, offset
        );

        return {
            data: data.map((row: any) => {
                const category = row.category ?? null;
                return {
                    ...row,
                    category,
                    card_id: cardId(row.global_game_id, category),
                    // v2.63.0 — the zero-score card's prospective band. Only
                    // ever computed in `card` grouping: a `game` row's null
                    // category means "this row names no single board", not
                    // "this game has no scores", so deriving one there would
                    // label every palette result.
                    ...(byCard && category === null
                        ? { prospective_category: prospectiveCategoryFromCatalogue(row.platforms) }
                        : {}),
                };
            }),
            total,
            hasMore: offset + data.length < total,
        };
    }

    /**
     * v2.52.0 (A4) — the viewer's own rank + score across a batch of games, in
     * ONE query.
     *
     * Why not just call `getForGame` per game: a logged-in page load carries up
     * to 200 games, and `getForGame` recalculates whenever the per-game cache
     * is cold. That would turn one authenticated request into 200 full
     * leaderboard recomputes. This resolves rank arithmetically instead, and
     * the caller only falls back to `getForGame` for the handful of games the
     * viewer actually has a score on (to build `neighbors`).
     *
     * The ranking must agree with `recalculate` exactly or the card would show
     * a rank that isn't the one rendered, so both halves are mirrored here:
     *   1. best-per-player collapse using the SAME partition expression
     *      (`submitted_by_user_id`, else the `iscored:<lowername>` synthetic),
     *   2. the same resolved owner id
     *      (`COALESCE(submitted_by_user_id, user_mappings.discord_user_id, player_id)`)
     *      so a viewer's iScored-synced aliases count as theirs,
     *   3. the same tie-break (`score DESC, submitted_at ASC`).
     *
     * The `user_mappings` lookup is a scalar subquery rather than the LEFT JOIN
     * `recalculate` uses: a join under a window function could fan out a row
     * and shift every rank below it. `iscored_username` is UNIQUE COLLATE
     * NOCASE so the two forms select the same value.
     *
     * v2.59.0 (P4): ranks are now scoped WITHIN a card's category and the
     * result is keyed by `cardId(...)`, not by game id. A viewer can be 3rd on
     * Simulation and 9th on Arcade-Style for one game, and both are true — a
     * single game-level number would be neither. The category partition also
     * rides on the inner best-per-player collapse, so someone's FX score is
     * ranked on the FX board even when their VPX score is higher.
     *
     * One call still covers a whole page: it returns EVERY card the viewer
     * scored on across `gameIds`, so the caller looks up by `card_id` and
     * ignores the rest.
     */
    static async getViewerCardRanks(
        gameIds: string[],
        viewerUserId: string,
        scope: string = 'global',
    ): Promise<Record<string, { rank: number; score: number }>> {
        if (gameIds.length === 0 || !viewerUserId) return {};
        const db = await getDatabase();
        const isGlobal = scope === 'global';
        const excludeFilter = isGlobal ? 'AND gs.exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND gs.origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];
        const placeholders = gameIds.map(() => '?').join(',');

        const rows = await db.all(`
            SELECT resolved.global_game_id, resolved.category, resolved.rank, resolved.score
            FROM (
                SELECT
                    best.global_game_id,
                    best.category,
                    best.score,
                    COALESCE(
                        best.submitted_by_user_id,
                        CASE WHEN best.player_id LIKE 'iscored:%' THEN (
                            SELECT um.discord_user_id FROM user_mappings um
                            WHERE LOWER(um.iscored_username) = LOWER(best.iscored_username)
                            LIMIT 1
                        ) END,
                        best.player_id
                    ) AS owner_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY best.global_game_id, best.category
                        ORDER BY best.score DESC, best.submitted_at ASC
                    ) AS rank
                FROM (
                    SELECT
                        gs.global_game_id,
                        ${CARD_CATEGORY_EXPR} as category,
                        gs.player_id,
                        gs.submitted_by_user_id,
                        gs.iscored_username,
                        gs.score,
                        gs.submitted_at,
                        ROW_NUMBER() OVER (
                            PARTITION BY gs.global_game_id, ${CARD_CATEGORY_EXPR}, COALESCE(gs.submitted_by_user_id, 'iscored:' || LOWER(COALESCE(gs.iscored_username, gs.player_id)))
                            ORDER BY gs.score DESC, gs.submitted_at ASC
                        ) AS player_rn
                    FROM global_scores gs
                    WHERE gs.global_game_id IN (${placeholders})
                      AND gs.deleted_at IS NULL
                      AND gs.orphaned_at IS NULL
                      ${excludeFilter}
                      ${roomFilter}
                ) best
                WHERE best.player_rn = 1
            ) resolved
            WHERE resolved.owner_id = ?
        `, ...gameIds, ...roomParams, viewerUserId);

        const out: Record<string, { rank: number; score: number }> = {};
        for (const row of rows) {
            out[cardId(row.global_game_id, row.category ?? null)] = { rank: row.rank, score: row.score };
        }
        return out;
    }

    /**
     * Fetch top N leaderboard entries for a batch of global game IDs, split by
     * fidelity category. Used to enrich catalogue cards with inline previews.
     *
     * v2.59.0 (P4): returns a map of **`card_id`** → ranked entries, not game
     * id. Each card gets its own top N, and the best-per-player collapse
     * happens WITHIN the category — a player whose VPX score outranks their FX
     * score still appears on the Arcade-Style card with the FX one. Callers
     * pass game ids and look results up by `card_id`; every category of every
     * requested game comes back in the one query.
     */
    static async getTopScoresForCards(
        gameIds: string[],
        topN: number = 5,
        scope: string = 'global'
    ): Promise<Record<string, Array<{
        iscored_username: string;
        /**
         * v2.52.0: the implementation has always populated this (it is the
         * `display_name ?? iscored_username` render rule's input); the declared
         * signature simply omitted it, so callers outside this file couldn't
         * see it. Declared now that GlobalPinService reads it.
         */
        display_name: string | null;
        score: number;
        avatar_hash: string | null;
        discord_user_id: string;
        /** Sprint 12 — badge fields on Global Scoreboard cards. */
        origin_room_slug: string | null;
        origin_room_logo_url: string | null;
        /** Sprint 13 — admin-set label preferred over slug for RoomTag. */
        origin_room_short_tag: string | null;
    }>>> {
        if (gameIds.length === 0) return {};
        const db = await getDatabase();
        const isGlobal = scope === 'global';
        const excludeFilter = isGlobal ? 'AND gs.exclude_from_global = 0' : '';
        const roomFilter = isGlobal ? '' : 'AND gs.origin_game_room_id = ?';
        const roomParams = isGlobal ? [] : [scope];

        const placeholders = gameIds.map(() => '?').join(',');

        const rows = await db.all(`
            SELECT
                ranked.global_game_id,
                ranked.category,
                ranked.discord_user_id,
                ranked.iscored_username,
                ranked.score,
                ranked.origin_game_room_id,
                gr.slug as origin_room_slug,
                gr.logo_url as origin_room_logo_url,
                gr.short_tag as origin_room_short_tag,
                up.display_name,
                up.avatar_hash
            FROM (
                SELECT
                    gs.global_game_id,
                    ${CARD_CATEGORY_EXPR} as category,
                    gs.player_id as discord_user_id,
                    gs.submitted_by_user_id,
                    gs.iscored_username,
                    gs.score,
                    gs.origin_game_room_id,
                    ROW_NUMBER() OVER (
                        PARTITION BY gs.global_game_id, ${CARD_CATEGORY_EXPR}, COALESCE(gs.submitted_by_user_id, 'iscored:' || LOWER(COALESCE(gs.iscored_username, gs.player_id)))
                        ORDER BY gs.score DESC
                    ) as player_rn
                FROM global_scores gs
                WHERE gs.global_game_id IN (${placeholders})
                  AND gs.deleted_at IS NULL
                  AND gs.orphaned_at IS NULL
                  ${excludeFilter}
                  ${roomFilter}
            ) ranked
            LEFT JOIN game_rooms gr ON gr.id = ranked.origin_game_room_id
            LEFT JOIN user_mappings um ON (
                ranked.discord_user_id LIKE 'iscored:%'
                AND LOWER(um.iscored_username) = LOWER(ranked.iscored_username)
            )
            LEFT JOIN user_profiles up ON up.discord_user_id = COALESCE(ranked.submitted_by_user_id, um.discord_user_id)
            WHERE ranked.player_rn = 1
            ORDER BY ranked.global_game_id, ranked.category, ranked.score DESC
        `, ...gameIds, ...roomParams);

        // Group by CARD and take top N per card.
        const result: Record<string, Array<{
            iscored_username: string;
            display_name: string | null;
            score: number;
            avatar_hash: string | null;
            discord_user_id: string;
            origin_room_slug: string | null;
            origin_room_logo_url: string | null;
            origin_room_short_tag: string | null;
        }>> = {};
        for (const row of rows) {
            const key = cardId(row.global_game_id, row.category ?? null);
            if (!result[key]) result[key] = [];
            if (result[key].length < topN) {
                result[key].push({
                    iscored_username: row.iscored_username || 'Unknown',
                    display_name: row.display_name || null,
                    score: row.score,
                    avatar_hash: row.avatar_hash || null,
                    discord_user_id: row.discord_user_id,
                    origin_room_slug: row.origin_room_slug || null,
                    origin_room_logo_url: row.origin_room_logo_url || null,
                    origin_room_short_tag: row.origin_room_short_tag || null,
                });
            }
        }
        return result;
    }
}
