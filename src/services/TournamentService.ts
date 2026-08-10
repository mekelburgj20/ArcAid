import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { PickAwardGate } from './PickAwardGate.js';
import { parseTournamentRules, normalizeTournamentRulesInput } from '../utils/platformRules.js';

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
    }): Promise<void> {
        const db = await getDatabase();
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
    }): Promise<void> {
        const db = await getDatabase();
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
        // Sprint 13: winner_picks may have flipped — bust cached PickAwardGate
        // entries for this tournament's room so the next consumer hits fresh state.
        if (data.game_room_id) PickAwardGate.invalidate(data.game_room_id);
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
        const row = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', id);
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
            await db.exec('COMMIT');
        } catch (err) {
            await db.exec('ROLLBACK');
            throw err;
        }
        if (row?.game_room_id) PickAwardGate.invalidate(row.game_room_id);
    }
}
