import { getDatabase } from '../database/database.js';
import { logError } from '../utils/logger.js';
import { PickAwardGate } from './PickAwardGate.js';

export class TournamentService {
    /**
     * Returns all tournaments, optionally filtered by game room.
     */
    static async getAll(gameRoomId?: string): Promise<any[]> {
        const db = await getDatabase();
        if (gameRoomId) {
            return db.all('SELECT * FROM tournaments WHERE game_room_id = ?', gameRoomId);
        }
        return db.all('SELECT * FROM tournaments');
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
    }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO tournaments (id, name, type, mode, cadence, platform_rules, guild_id, discord_channel_id, discord_role_id, is_active, display_order, max_active_games, cleanup_rule, game_room_id, winner_picks, auto_pick, eligibility_days, winner_pick_window_min, runnerup_pick_window_min)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            data.id, data.name, data.type, data.mode || 'pinball',
            JSON.stringify(data.cadence), JSON.stringify(data.platform_rules || {}),
            data.guild_id, data.discord_channel_id, data.discord_role_id,
            data.is_active ? 1 : 0, data.display_order ?? 0, data.max_active_games ?? 1,
            JSON.stringify(data.cleanup_rule || { mode: 'retain', count: 0 }),
            data.game_room_id || null,
            (data.winner_picks ?? true) ? 1 : 0,
            (data.auto_pick ?? true) ? 1 : 0,
            data.eligibility_days ?? 120,
            data.winner_pick_window_min ?? 60,
            data.runnerup_pick_window_min ?? 30
        );
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
    }): Promise<void> {
        const db = await getDatabase();
        await db.run(
            `UPDATE tournaments SET name = ?, type = ?, mode = ?, cadence = ?, platform_rules = ?, guild_id = ?, discord_channel_id = ?, discord_role_id = ?, is_active = ?, display_order = ?, max_active_games = ?, cleanup_rule = ?, game_room_id = ?, winner_picks = ?, auto_pick = ?, eligibility_days = ?, winner_pick_window_min = ?, runnerup_pick_window_min = ?
             WHERE id = ?`,
            data.name, data.type, data.mode || 'pinball',
            JSON.stringify(data.cadence), JSON.stringify(data.platform_rules || {}),
            data.guild_id, data.discord_channel_id, data.discord_role_id,
            data.is_active ? 1 : 0, data.display_order ?? 0, data.max_active_games ?? 1,
            JSON.stringify(data.cleanup_rule || { mode: 'retain', count: 0 }),
            data.game_room_id || null,
            (data.winner_picks ?? true) ? 1 : 0,
            (data.auto_pick ?? true) ? 1 : 0,
            data.eligibility_days ?? 120,
            data.winner_pick_window_min ?? 60,
            data.runnerup_pick_window_min ?? 30,
            id
        );
        // Sprint 13: winner_picks may have flipped — bust cached PickAwardGate
        // entries for this tournament's room so the next consumer hits fresh state.
        if (data.game_room_id) PickAwardGate.invalidate(data.game_room_id);
    }

    /**
     * Deletes a tournament by ID.
     */
    static async delete(id: string): Promise<void> {
        const db = await getDatabase();
        const row = await db.get('SELECT game_room_id FROM tournaments WHERE id = ?', id);
        await db.run('DELETE FROM tournaments WHERE id = ?', id);
        if (row?.game_room_id) PickAwardGate.invalidate(row.game_room_id);
    }
}
