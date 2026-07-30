import { getDatabase } from '../database/database.js';
import { GlobalLeaderboardService } from './GlobalLeaderboardService.js';

/**
 * Global Scoreboard pins (v2.52.0, Track A phase A4 —
 * tmp/global-scoreboard-a4-contract.md).
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

/** One row of `GET /api/global/pins` — everything the rail chip renders. */
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
    /** Same entry shape the cards' `top_scores` use; null when nobody has scored. */
    top_player: {
        iscored_username: string;
        display_name: string | null;
        discord_user_id: string;
        avatar_hash: string | null;
        score: number;
    } | null;
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

        const ranks = await GlobalLeaderboardService.getViewerRanks([globalGameId], discordUserId, 'global');
        const seedRank = ranks[globalGameId]?.rank ?? null;

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
     * The viewer's pins, newest first, with enough per-chip data that the rail
     * renders in one round trip.
     *
     * The champion (`top_player`) comes from the existing batched
     * `getTopScoresForGames` helper rather than a bespoke query, so the rail's
     * "#1" is literally the same row the card's rank-1 line shows.
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
            score_count: number;
            top_score: number | null;
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
                (SELECT COUNT(*) FROM global_scores gs
                  WHERE gs.global_game_id = gg.id
                    AND gs.deleted_at IS NULL
                    AND gs.orphaned_at IS NULL
                    AND gs.exclude_from_global = 0) as score_count,
                (SELECT MAX(gs.score) FROM global_scores gs
                  WHERE gs.global_game_id = gg.id
                    AND gs.deleted_at IS NULL
                    AND gs.orphaned_at IS NULL
                    AND gs.exclude_from_global = 0) as top_score,
                p.last_known_rank,
                p.created_at as pinned_at
            FROM global_game_pins p
            JOIN global_games gg ON gg.id = p.global_game_id
            WHERE p.discord_user_id = ?
            ORDER BY p.created_at DESC
        `, discordUserId);

        if (rows.length === 0) return [];

        const gameIds = rows.map(r => r.global_game_id);
        const [champions, myRanks] = await Promise.all([
            GlobalLeaderboardService.getTopScoresForGames(gameIds, 1, 'global'),
            GlobalLeaderboardService.getViewerRanks(gameIds, discordUserId, 'global'),
        ]);

        return rows.map(r => {
            const champ = champions[r.global_game_id]?.[0];
            const mine = myRanks[r.global_game_id];
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
                score_count: r.score_count ?? 0,
                top_score: r.top_score ?? null,
                top_player: champ
                    ? {
                        iscored_username: champ.iscored_username,
                        display_name: champ.display_name ?? null,
                        discord_user_id: champ.discord_user_id,
                        avatar_hash: champ.avatar_hash,
                        score: champ.score,
                    }
                    : null,
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
