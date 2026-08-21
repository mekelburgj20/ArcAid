import { getDatabase } from '../database/database.js';
import { GlobalLeaderboardService, cardId } from './GlobalLeaderboardService.js';

/**
 * Global Scoreboard pins (v2.52.0, Track A phase A4 —
 * docs/contracts/global-scoreboard-a4-contract.md).
 *
 * A pin is a per-viewer bookmark on a catalogue game. It drives the "My Pins"
 * rail, the per-card pin hotspot, and `sort=pinned` on the scoreboard.
 *
 * Two deliberate properties:
 *   • **Unlimited.** No cap, no cap messaging — a user may pin the whole
 *     catalogue if they want to.
 *   • **Provider-agnostic.** `discord_user_id` is the generic identity column
 *     name used across this schema; a `google:*` id (ADR 0015) pins exactly
 *     like a raw Discord snowflake. Nothing here parses the id.
 *
 * `last_known_rank` is seeded at pin time and is what makes the rail's
 * rank-delta badge possible without any alerting machinery. A5's rank-change
 * notifications are the other consumer of that column and are NOT built here.
 */

/**
 * Rows the scoreboard card renders (`CARD_ROWS` in
 * `admin-ui/src/components/GlobalGameCard.tsx`). The pins payload ships exactly
 * this many so the rail's card has neither missing rows nor dead weight.
 */
const CARD_ROWS = 6;

/**
 * One entry of a pin's `top_scores` — identical in shape to the scoreboard
 * card's rows, because it comes from the same batched helper.
 */
export interface PinnedTopScore {
    iscored_username: string;
    display_name: string | null;
    discord_user_id: string;
    avatar_hash: string | null;
    /** v2.74.0 (S24.1) — Google-linked avatar URL; `PlayerAvatar` prefers it. */
    avatar_url: string | null;
    score: number;
    origin_room_slug: string | null;
    origin_room_logo_url: string | null;
    origin_room_short_tag: string | null;
    /** Present on `neighbors` entries only (the card derives its own rows' rank from index). */
    rank?: number;
}

/** One row of `GET /api/global/pins` — everything the rail's CARD renders. */
export interface PinnedGame {
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
    /**
     * v2.59.0 (ADR 0016 P4) — which board this rail card shows: the pinned
     * game's HIGHEST-SCORING fidelity category, or null when it has no scores.
     *
     * The rail deliberately stays ONE ENTRY PER PINNED GAME. A pin is on the
     * game, so splitting a pinned game into three rail cards would triple the
     * rail off the back of a single user action. But a card has to show one
     * board, so `score_count`, `top_score`, `top_scores`, `my_rank`,
     * `my_score` and `neighbors` below are all THIS CATEGORY's figures — the
     * chip and the rows can never disagree.
     */
    category: string | null;
    /**
     * v2.55.0: ranks 1-6, the same rows the grid card renders. Replaces the
     * v2.52.0 `top_player` champion-only field — the rail now renders the FULL
     * card, and shipping both would be two representations of one dataset.
     */
    top_scores: PinnedTopScore[];
    /**
     * v2.55.0: ranks my_rank-1 … my_rank+1, populated ONLY when the viewer
     * ranks below the six rows above (the sole case where the card appends its
     * "YOU" row). Anywhere else it is `[]` — computing it would cost a
     * leaderboard read per pin for a row that never renders.
     */
    neighbors: PinnedTopScore[];
    my_rank: number | null;
    my_score: number | null;
    /**
     * Movement since the pin's `last_known_rank` reading.
     * **NEGATIVE MEANS IMPROVED** (moved toward #1), `0` unchanged, `null` when
     * there is no prior reading or no current rank.
     *
     * CONTRACT DISCREPANCY, resolved deliberately: both the A4 contract and the
     * design handoff write the formula as `last_known_rank - my_rank` AND state
     * "negative means improved". Those are mutually exclusive — improving means
     * `my_rank` gets smaller, so `last - my` is POSITIVE on an improvement
     * (pinned at #5, now #1 → +4). The sign convention is the half that the UI
     * actually consumes (`TrendingUp`/green vs `TrendingDown`/coral) and it is
     * stated in both documents, so it wins: the computation here is
     * `my_rank - last_known_rank`.
     */
    rank_delta: number | null;
    pinned_at: string;
}

export class GlobalPinService {
    /** Total pins held by a user. Returned by both write endpoints. */
    static async countForUser(discordUserId: string): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ c: number }>(
            'SELECT COUNT(*) as c FROM global_game_pins WHERE discord_user_id = ?',
            discordUserId,
        );
        return row?.c ?? 0;
    }

    /** The set of game ids this user has pinned, bounded to `gameIds`. */
    static async pinnedIdsAmong(discordUserId: string, gameIds: string[]): Promise<Set<string>> {
        if (gameIds.length === 0) return new Set();
        const db = await getDatabase();
        const placeholders = gameIds.map(() => '?').join(',');
        const rows = await db.all<{ global_game_id: string }[]>(
            `SELECT global_game_id FROM global_game_pins
             WHERE discord_user_id = ? AND global_game_id IN (${placeholders})`,
            discordUserId, ...gameIds,
        );
        return new Set(rows.map(r => r.global_game_id));
    }

    /**
     * Idempotent pin. Re-pinning an already-pinned game is a no-op that does
     * NOT reseed `last_known_rank` — the seed is the baseline the rail's delta
     * is measured from, and resetting it on a stray double-click would silently
     * erase the user's progress reading.
     *
     * Returns null when the game doesn't exist (route answers 404). The check
     * is explicit rather than relying on the FK: an FK violation surfaces as a
     * 500, and "you pinned a game that isn't in the catalogue" is a 404.
     */
    static async pin(discordUserId: string, globalGameId: string): Promise<{ pinned: true; pin_count: number } | null> {
        const db = await getDatabase();
        const game = await db.get<{ id: string }>('SELECT id FROM global_games WHERE id = ?', globalGameId);
        if (!game) return null;

        // P4 — seed the baseline on the same board `list` will report a rank
        // for (the game's dominant category). Seeding a game-level rank while
        // rendering a category-level one would make every rail delta wrong by
        // however much the two boards differ.
        const dominant = await GlobalLeaderboardService.getDominantCards([globalGameId], 'global');
        const category = dominant[globalGameId]?.category ?? null;
        const ranks = await GlobalLeaderboardService.getViewerCardRanks([globalGameId], discordUserId, 'global');
        const seedRank = ranks[cardId(globalGameId, category)]?.rank ?? null;

        await db.run(
            `INSERT INTO global_game_pins (discord_user_id, global_game_id, created_at, last_known_rank, last_seen_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(discord_user_id, global_game_id) DO NOTHING`,
            discordUserId, globalGameId, new Date().toISOString(), seedRank, new Date().toISOString(),
        );

        return { pinned: true, pin_count: await this.countForUser(discordUserId) };
    }

    /** Idempotent unpin — unpinning something that isn't pinned is a 200 no-op. */
    static async unpin(discordUserId: string, globalGameId: string): Promise<{ pinned: false; pin_count: number }> {
        const db = await getDatabase();
        await db.run(
            'DELETE FROM global_game_pins WHERE discord_user_id = ? AND global_game_id = ?',
            discordUserId, globalGameId,
        );
        return { pinned: false, pin_count: await this.countForUser(discordUserId) };
    }

    /**
     * The viewer's pins, newest first, with enough per-card data that the rail
     * renders in one round trip.
     *
     * The rows come from the existing batched `getTopScoresForCards` helper
     * rather than a bespoke query, so the rail's leaderboard is literally the
     * same data the grid card shows — the two must not be able to disagree
     * (v2.55.0 makes them the same React component too).
     */
    static async list(discordUserId: string): Promise<PinnedGame[]> {
        const db = await getDatabase();

        const rows = await db.all<Array<{
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
            last_known_rank: number | null;
            pinned_at: string;
        }>>(`
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
                p.last_known_rank,
                p.created_at as pinned_at
            FROM global_game_pins p
            JOIN global_games gg ON gg.id = p.global_game_id
            WHERE p.discord_user_id = ?
            ORDER BY p.created_at DESC
        `, discordUserId);

        if (rows.length === 0) return [];

        const gameIds = rows.map(r => r.global_game_id);
        // P4 — `score_count` / `top_score` used to be two scalar subqueries
        // over every score on the game. They come from the dominant-card
        // lookup now instead, because the rail renders ONE category's board
        // and a footer reading "18 scores" above six Simulation rows (12 of
        // which are FX) would be the same mixed-engine claim the ADR forbids.
        const [dominant, topScores, myRanks] = await Promise.all([
            GlobalLeaderboardService.getDominantCards(gameIds, 'global'),
            GlobalLeaderboardService.getTopScoresForCards(gameIds, CARD_ROWS, 'global'),
            GlobalLeaderboardService.getViewerCardRanks(gameIds, discordUserId, 'global'),
        ]);
        const cardIdFor = (gameId: string) => cardId(gameId, dominant[gameId]?.category ?? null);

        // Neighbour rows for the card's "YOU" line, fetched ONLY for pins where
        // the viewer ranks below the six rendered rows. Inside the top 6 they
        // are already on the card, so the extra leaderboard read would buy a
        // row that is never drawn.
        const neighborsByCard: Record<string, PinnedTopScore[]> = {};
        await Promise.all(rows
            .filter(r => (myRanks[cardIdFor(r.global_game_id)]?.rank ?? 0) > CARD_ROWS)
            .map(async r => {
                const key = cardIdFor(r.global_game_id);
                const rank = myRanks[key]!.rank;
                const full = await GlobalLeaderboardService.getForCard(
                    r.global_game_id, dominant[r.global_game_id]?.category ?? null, 'global',
                );
                neighborsByCard[key] = full
                    .filter(e => e.rank >= rank - 1 && e.rank <= rank + 1)
                    .map(e => ({
                        iscored_username: e.iscored_username,
                        display_name: e.display_name ?? null,
                        discord_user_id: e.discord_user_id,
                        avatar_hash: e.avatar_hash,
                        avatar_url: e.avatar_url,
                        score: e.score,
                        origin_room_slug: e.origin_room_slug,
                        origin_room_logo_url: e.origin_room_logo_url,
                        origin_room_short_tag: e.origin_room_short_tag,
                        rank: e.rank,
                    }));
            }));

        return rows.map(r => {
            const key = cardIdFor(r.global_game_id);
            const card = dominant[r.global_game_id];
            const mine = myRanks[key];
            const myRank = mine?.rank ?? null;
            return {
                global_game_id: r.global_game_id,
                name: r.name,
                display_name: r.display_name,
                manufacturer: r.manufacturer,
                year: r.year,
                type: r.type,
                image_url: r.image_url,
                local_image_path: r.local_image_path,
                wheel_image_path: r.wheel_image_path,
                platforms: r.platforms,
                category: card?.category ?? null,
                score_count: card?.score_count ?? 0,
                top_score: card?.top_score ?? null,
                top_scores: (topScores[key] ?? []).map(s => ({
                    iscored_username: s.iscored_username,
                    display_name: s.display_name ?? null,
                    discord_user_id: s.discord_user_id,
                    avatar_hash: s.avatar_hash,
                    avatar_url: s.avatar_url,
                    score: s.score,
                    origin_room_slug: s.origin_room_slug,
                    origin_room_logo_url: s.origin_room_logo_url,
                    origin_room_short_tag: s.origin_room_short_tag,
                })),
                neighbors: neighborsByCard[key] ?? [],
                my_rank: myRank,
                my_score: mine?.score ?? null,
                // Negative = improved (see the interface note on the docs'
                // self-contradictory formula). Null when either reading is
                // missing — a first-ever pin has no baseline and must render no
                // badge rather than a misleading "0 / unchanged".
                rank_delta: (r.last_known_rank != null && myRank != null)
                    ? myRank - r.last_known_rank
                    : null,
                pinned_at: r.pinned_at,
            };
        });
    }
}
