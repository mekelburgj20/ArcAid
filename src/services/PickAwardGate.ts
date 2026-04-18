import { getDatabase } from '../database/database.js';
import { GameRoomSettingsService } from './GameRoomSettingsService.js';

/**
 * Per-room setting key. Default "false" (opt-in per plan §17).
 */
export const ENABLE_GAME_PICK_AWARD = 'ENABLE_GAME_PICK_AWARD';

/**
 * Gate for the game-pick-award flow (winner-picks, picker timeouts, Mystery Award,
 * `/pick-game` Discord cluster, turn-to-pick DMs). When disabled:
 *   • No picker slots are created on tournament completion.
 *   • No timeouts are registered/boot.
 *   • No `turnToPick` DMs are dispatched.
 *   • Discord commands reply with the exact gating string.
 *   • Admin UI surfaces render in disabled states (tooltip-backed).
 *   • Mystery Award is suppressed entirely.
 *
 * Override semantics (plan Q5 → AND): both room and per-tournament `winner_picks`
 * must be truthy for the gate to be "on". Either side set to off disables the flow.
 * A room-level "off" cannot be re-enabled by a per-tournament override.
 */
export class PickAwardGate {
    private static cache = new Map<string, { value: boolean; ts: number }>();
    private static readonly TTL_MS = 5_000;

    /**
     * Resolve whether the pick-award flow is enabled for a given room and
     * (optionally) a specific tournament.
     *
     * @param roomId        The game_rooms.id (required). When falsy, returns false.
     * @param tournamentId  Optional tournament scope. When supplied, the gate
     *                      evaluates `room ∧ tournament.winner_picks`.
     */
    static async isEnabled(roomId: string | null | undefined, tournamentId?: string | null): Promise<boolean> {
        if (!roomId) return false;

        const cacheKey = `${roomId}:${tournamentId ?? ''}`;
        const now = Date.now();
        const hit = this.cache.get(cacheKey);
        if (hit && now - hit.ts < this.TTL_MS) return hit.value;

        const roomEnabled = await this.isRoomEnabled(roomId);
        let value = roomEnabled;
        if (value && tournamentId) {
            value = await this.isTournamentEnabled(tournamentId);
        }

        this.cache.set(cacheKey, { value, ts: now });
        return value;
    }

    private static async isRoomEnabled(roomId: string): Promise<boolean> {
        const raw = await GameRoomSettingsService.get(roomId, ENABLE_GAME_PICK_AWARD);
        return raw === 'true';
    }

    private static async isTournamentEnabled(tournamentId: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get('SELECT winner_picks FROM tournaments WHERE id = ?', tournamentId);
        if (!row) return false;
        // winner_picks is 0/1 integer — NULL treated as enabled (legacy default)
        return row.winner_picks === null || row.winner_picks === undefined || row.winner_picks !== 0;
    }

    /** Invalidate cache — call on setting change or tournament edit. */
    static invalidate(roomId?: string | null): void {
        if (!roomId) {
            this.cache.clear();
            return;
        }
        for (const key of this.cache.keys()) {
            if (key.startsWith(`${roomId}:`)) this.cache.delete(key);
        }
    }
}

/**
 * Exact reply string used by Discord command short-circuits (plan §8).
 */
export const PICK_AWARD_DISABLED_REPLY = '/pick-game is not available in this game room';
