import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { PickAwardGate } from './PickAwardGate.js';
import { parseTournamentRules, normalizeTournamentRulesInput } from '../utils/platformRules.js';

/**
 * Season block input (docs/season-format-plan.md §3.1). Flat snake_case like
 * every other tournament field. On UPDATE, `season_table_count: undefined`
 * means "leave the season block as stored" (so a pre-season client that does
 * not know these fields cannot switch a season off by omission); `null`
 * switches it off; a number switches it on / edits it.
 */
export interface SeasonInput {
    season_table_count?: number | null;
    season_points_top?: number;
    season_poll_opens_before_h?: number;
    season_poll_closes_before_h?: number;
    season_tie_rule?: 'admin' | 'random' | 'first_nominated';
    season_tie_fallback?: 'random' | 'first_nominated';
}

/** A season configuration the service refuses. Routes map it to a 400. */
export class SeasonConfigError extends Error {
    constructor(public code: string, message: string) {
        super(message);
        this.name = 'SeasonConfigError';
    }
}

interface ResolvedSeason {
    table_count: number;
    points_top: number;
    opens_before_h: number;
    closes_before_h: number;
    tie_rule: string;
    tie_fallback: string;
}

const SEASON_TIE_RULES = ['admin', 'random', 'first_nominated'];
const SEASON_TIE_FALLBACKS = ['random', 'first_nominated'];

/**
 * Merge the incoming season fields over what is stored, then validate.
 * Returns null when the tournament is (or becomes) not a season.
 * Same rules as the Zod refine in `schemas.ts` — duplicated on purpose so
 * non-HTTP callers are held to them too (plan §3.1: "Zod + service, both").
 */
function resolveSeason(
    input: SeasonInput,
    stored: any | null,
    format: string | undefined,
    cadence: any,
): ResolvedSeason | null {
    const tableCount = input.season_table_count === undefined
        ? (stored?.season_table_count ?? null)
        : input.season_table_count;
    if (tableCount === null || tableCount === undefined) return null;

    const season: ResolvedSeason = {
        table_count: tableCount,
        points_top: input.season_points_top ?? stored?.season_points_top ?? 50,
        opens_before_h: input.season_poll_opens_before_h ?? stored?.season_poll_opens_before_h ?? 96,
        closes_before_h: input.season_poll_closes_before_h ?? stored?.season_poll_closes_before_h ?? 3,
        tie_rule: input.season_tie_rule ?? stored?.season_tie_rule ?? 'admin',
        tie_fallback: input.season_tie_fallback ?? stored?.season_tie_fallback ?? 'random',
    };

    const isInt = (n: unknown) => typeof n === 'number' && Number.isInteger(n);
    if (!isInt(season.table_count) || season.table_count < 1 || season.table_count > 200) {
        throw new SeasonConfigError('SEASON_TABLE_COUNT', 'A season must have between 1 and 200 tables.');
    }
    if (!isInt(season.points_top) || season.points_top < 1 || season.points_top > 1000) {
        throw new SeasonConfigError('SEASON_POINTS_TOP', 'Points for 1st place must be between 1 and 1000.');
    }
    if (!isInt(season.closes_before_h) || season.closes_before_h < 1) {
        throw new SeasonConfigError('SEASON_POLL_CLOSE', 'The poll must close at least 1 hour before the rotation (Discord polls last at least 1 hour).');
    }
    if (!isInt(season.opens_before_h) || season.opens_before_h <= season.closes_before_h) {
        throw new SeasonConfigError('SEASON_POLL_OPEN', 'The poll must open earlier than it closes (opens-before hours must exceed closes-before hours).');
    }
    if (!SEASON_TIE_RULES.includes(season.tie_rule)) {
        throw new SeasonConfigError('SEASON_TIE_RULE', `Tie rule must be one of ${SEASON_TIE_RULES.join(', ')}.`);
    }
    if (!SEASON_TIE_FALLBACKS.includes(season.tie_fallback)) {
        throw new SeasonConfigError('SEASON_TIE_FALLBACK', `Tie fallback must be one of ${SEASON_TIE_FALLBACKS.join(', ')}.`);
    }
    if ((format ?? stored?.format ?? 'rotation') !== 'rotation') {
        throw new SeasonConfigError('SEASON_FORMAT', 'A season must be a rotation tournament.');
    }
    let cron: string | undefined;
    try { cron = (typeof cadence === 'string' ? JSON.parse(cadence) : cadence)?.cron; } catch { cron = undefined; }
    if (!cron) {
        throw new SeasonConfigError('SEASON_CADENCE', 'A season needs a rotation schedule (cron).');
    }
    return season;
}

export class TournamentService {
    /**
     * Returns all tournaments, optionally filtered by game room.
     *
     * `platform_rules` is re-serialised through `parseTournamentRules` so the
     * row always LEAVES here in ADR 0016 P2's two-axis shape, even when the
     * stored blob is still the pre-0016 flat one (~200 live rooms). The DB row
     * is untouched — this is the read-time shim, not a migration — but it means
     * the admin UI has exactly one shape to render and cannot re-save a legacy
     * blob it half-understood.
     */
    static async getAll(gameRoomId?: string): Promise<any[]> {
        const db = await getDatabase();
        const rows = gameRoomId
            ? await db.all('SELECT * FROM tournaments WHERE game_room_id = ?', gameRoomId)
            : await db.all('SELECT * FROM tournaments');
        return rows.map((row: any) => ({
            ...row,
            platform_rules: JSON.stringify(parseTournamentRules(row)),
        }));
    }

    /**
     * Creates a new tournament.
     */
    static async create(data: {
        id: string;
        name: string;
        type: string;
        mode?: string;
        cadence: any;
        platform_rules?: any;
        guild_id?: string;
        discord_channel_id?: string;
        discord_role_id?: string;
        is_active?: boolean;
        display_order?: number;
        max_active_games?: number;
        cleanup_rule?: any;
        game_room_id?: string;
        winner_picks?: boolean;
        auto_pick?: boolean;
        eligibility_days?: number;
        winner_pick_window_min?: number;
        runnerup_pick_window_min?: number;
        /** Next-win disposition (v2.9x) — default ON = today's behavior (a
         *  winner may win the same slot back-to-back). OFF blocks their
         *  'use-my-queue' path only; nominate/forfeit still honored. */
        allow_dynasty?: boolean;
        format?: string;
    } & SeasonInput): Promise<void> {
        const db = await getDatabase();
        const season = resolveSeason(data, null, data.format, data.cadence);
        // A season forces these (plan §3.1) — normalise, don't reject. The poll
        // is the only queue writer; with both pick flags off the engine's
        // existing empty-queue behaviour is "wait for admin". eligibility_days
        // is 0 because a community vote overrides cooldown — the fill loop's
        // cooldown check would otherwise hold the poll winner and stall the week.
        if (season) {
            data = { ...data, winner_picks: false, auto_pick: false, max_active_games: 1, eligibility_days: 0 };
        }
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, platform_rules, guild_id, discord_channel_id, discord_role_id, is_active, display_order, max_active_games, cleanup_rule, game_room_id, winner_picks, auto_pick, eligibility_days, winner_pick_window_min, runnerup_pick_window_min, allow_dynasty)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            data.id, data.name, data.type, data.mode || 'pinball',
            JSON.stringify(data.cadence),
            // ADR 0016 P2 §2 — every writer emits the two-axis shape. Normalising
            // here (not only in the Zod schema) covers non-HTTP callers too.
            JSON.stringify(normalizeTournamentRulesInput(data.platform_rules)),
            data.guild_id, data.discord_channel_id, data.discord_role_id,
            data.is_active ? 1 : 0, data.display_order ?? 0, data.max_active_games ?? 1,
            JSON.stringify(data.cleanup_rule || { mode: 'retain', count: 0 }),
            data.game_room_id || null,
            (data.winner_picks ?? true) ? 1 : 0,
            (data.auto_pick ?? true) ? 1 : 0,
            data.eligibility_days ?? 120,
            data.winner_pick_window_min ?? 60,
            data.runnerup_pick_window_min ?? 30,
            (data.allow_dynasty ?? true) ? 1 : 0
        );
        if (season) await this.applySeason(data.id, data.name, data.game_room_id ?? null, season, null);
        // v2.56.0: the room-scoped gate is now "any tournament in this room has
        // winner-picks on", so CREATE can flip it (a room's first winner-picks
        // tournament). Bust the room's cached entries the same way update() does.
        if (data.game_room_id) PickAwardGate.invalidate(data.game_room_id);
    }

    /**
     * Updates an existing tournament by ID.
     */
    static async update(id: string, data: {
        name: string;
        type: string;
        mode?: string;
        cadence: any;
        platform_rules?: any;
        guild_id?: string;
        discord_channel_id?: string;
        discord_role_id?: string;
        is_active?: boolean;
        display_order?: number;
        max_active_games?: number;
        cleanup_rule?: any;
        game_room_id?: string;
        winner_picks?: boolean;
        auto_pick?: boolean;
        eligibility_days?: number;
        winner_pick_window_min?: number;
        runnerup_pick_window_min?: number;
        allow_dynasty?: boolean;
        format?: string;
    } & SeasonInput): Promise<void> {
        const db = await getDatabase();
        const stored = await db.get('SELECT * FROM tournaments WHERE id = ?', id);
        const season = resolveSeason(data, stored ?? null, data.format, data.cadence);
        if (season) {
            data = { ...data, winner_picks: false, auto_pick: false, max_active_games: 1, eligibility_days: 0 };
        }
        await db.run(
            `UPDATE tournaments SET name = ?, type = ?, mode = ?, cadence = ?, platform_rules = ?, guild_id = ?, discord_channel_id = ?, discord_role_id = ?, is_active = ?, display_order = ?, max_active_games = ?, cleanup_rule = ?, game_room_id = ?, winner_picks = ?, auto_pick = ?, eligibility_days = ?, winner_pick_window_min = ?, runnerup_pick_window_min = ?, allow_dynasty = ?
             WHERE id = ?`,
            data.name, data.type, data.mode || 'pinball',
            JSON.stringify(data.cadence),
            // ADR 0016 P2 §2 — every writer emits the two-axis shape. Normalising
            // here (not only in the Zod schema) covers non-HTTP callers too.
            JSON.stringify(normalizeTournamentRulesInput(data.platform_rules)),
            data.guild_id, data.discord_channel_id, data.discord_role_id,
            data.is_active ? 1 : 0, data.display_order ?? 0, data.max_active_games ?? 1,
            JSON.stringify(data.cleanup_rule || { mode: 'retain', count: 0 }),
            data.game_room_id || null,
            (data.winner_picks ?? true) ? 1 : 0,
            (data.auto_pick ?? true) ? 1 : 0,
            data.eligibility_days ?? 120,
            data.winner_pick_window_min ?? 60,
            data.runnerup_pick_window_min ?? 30,
            (data.allow_dynasty ?? true) ? 1 : 0,
            id
        );
        if (season) {
            await this.applySeason(id, data.name, data.game_room_id ?? stored?.game_room_id ?? null, season, stored ?? null);
        } else if (data.season_table_count === null && stored?.season_table_count != null) {
            // Switched off. The standings group is kept (and stays linked) so
            // switching the season back on picks the same group up again.
            await db.run('UPDATE tournaments SET season_table_count = NULL WHERE id = ?', id);
        }
        // Sprint 13: winner_picks may have flipped — bust cached PickAwardGate
        // entries for this tournament's room so the next consumer hits fresh state.
        if (data.game_room_id) PickAwardGate.invalidate(data.game_room_id);
    }

    /**
     * Persist a validated season block and keep its standings group in step
     * (plan §4). Creates the group when the tournament has none (or the stored
     * id no longer resolves); otherwise propagates points_top/best_n and
     * invalidates the group's cache — a config change the data watermark does
     * not cover.
     */
    private static async applySeason(
        id: string,
        name: string,
        gameRoomId: string | null,
        season: ResolvedSeason,
        stored: any | null,
    ): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET season_table_count = ?, season_points_top = ?,
                    season_poll_opens_before_h = ?, season_poll_closes_before_h = ?,
                    season_tie_rule = ?, season_tie_fallback = ?
              WHERE id = ?`,
            season.table_count, season.points_top, season.opens_before_h, season.closes_before_h,
            season.tie_rule, season.tie_fallback, id,
        );

        const { RankingService } = await import('./RankingService.js');
        const existingGroupId: string | null = stored?.season_ranking_group_id ?? null;
        const existingGroup = existingGroupId
            ? await db.get('SELECT id, points_top, best_n FROM ranking_groups WHERE id = ?', existingGroupId)
            : null;

        if (!existingGroup) {
            const { randomUUID } = await import('crypto');
            const groupId = randomUUID();
            await RankingService.create({
                id: groupId,
                name: `${name} — Season`,
                rank_method: 'best_game_linear',
                best_n: season.table_count,
                min_games: 1,
                tournament_ids: [id],
                game_room_id: gameRoomId ?? undefined,
                points_top: season.points_top,
                include_archived: true,
            });
            await db.run('UPDATE tournaments SET season_ranking_group_id = ? WHERE id = ?', groupId, id);
            return;
        }

        if (existingGroup.points_top !== season.points_top || existingGroup.best_n !== season.table_count) {
            await db.run(
                'UPDATE ranking_groups SET points_top = ?, best_n = ? WHERE id = ?',
                season.points_top, season.table_count, existingGroup.id,
            );
            await RankingService.invalidate(existingGroup.id);
        }
    }

    /**
     * S7 — focused pause/resume toggle. Flips `is_active` only, avoiding the
     * full-row `update()` (which requires every column and would clobber a
     * concurrent config edit). Callers MUST follow with `Scheduler.reload()`
     * — that is what actually registers/removes the maintenance cron task.
     */
    static async setActive(id: string, isActive: boolean): Promise<void> {
        const db = await getDatabase();
        const row = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', id);
        await db.run('UPDATE tournaments SET is_active = ? WHERE id = ?', isActive ? 1 : 0, id);
        // winner_picks is unchanged here, but be consistent with update() and
        // bust the room's PickAwardGate cache so no consumer reads stale state.
        if (row?.game_room_id) PickAwardGate.invalidate(row.game_room_id);
    }

    /**
     * Deletes a tournament by ID.
     */
    static async delete(id: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get('SELECT game_room_id, season_ranking_group_id FROM tournaments WHERE id = ?', id);
        // FK enforcement (S3): games.tournament_id is NO ACTION, so the bare
        // tournament delete throws while any games row still references it (e.g.
        // COMPLETED games — the route's 409 guard only blocks ACTIVE/QUEUED).
        // Unlink each game's retained score rows (ADR 0005 — preserve history),
        // drop the games + caches, then the tournament. ranking_group_tournaments
        // self-cleans via ON DELETE CASCADE. One transaction for atomicity.
        await db.exec('BEGIN');
        try {
            const games = await db.all('SELECT id FROM games WHERE tournament_id = ?', id);
            for (const g of games) {
                await db.run('UPDATE submissions SET game_id = NULL WHERE game_id = ?', g.id);
                await db.run('UPDATE score_history SET game_id = NULL WHERE game_id = ?', g.id);
                await db.run('UPDATE global_scores SET origin_game_id = NULL WHERE origin_game_id = ?', g.id);
                await db.run('DELETE FROM scores WHERE game_id = ?', g.id);
                await db.run('DELETE FROM leaderboard_cache WHERE game_id = ?', g.id);
            }
            await db.run('DELETE FROM games WHERE tournament_id = ?', id);
            await db.run('DELETE FROM tournaments WHERE id = ?', id);
            // Season standings group (plan §4): the junction row cascades with
            // the tournament, the group row itself is ours to delete.
            if (row?.season_ranking_group_id) {
                await db.run('DELETE FROM ranking_groups WHERE id = ?', row.season_ranking_group_id);
            }
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
        if (row?.game_room_id) PickAwardGate.invalidate(row.game_room_id);
    }
}
