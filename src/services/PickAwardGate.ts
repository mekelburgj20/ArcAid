import { getDatabase } from '../database/database.js';

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
 * Resolution (v2.56.0): **per-tournament only** — `tournaments.winner_picks`.
 *
 * There used to be a second, room-level leg (`ENABLE_GAME_PICK_AWARD` in
 * `game_room_settings`, ANDed with the tournament flag). It was removed because
 * it was a silent trap: the key defaulted to absent → `false`, `TournamentForm`
 * never referenced it, and so a tournament configured with "Winner picks next
 * game" ✓ plus winner/runner-up windows would auto-pick immediately with no
 * indication anywhere in the UI that a room switch had disabled it. Migration
 * 126 deletes the orphaned rows. Do not reintroduce a room-level override
 * without also surfacing it on the tournament form.
 *
 * Room-scoped callers (no tournament id — the Picks tab, Mystery Award, admin
 * disabled states) ask "is this flow live for this room at all?". That resolves
 * to "any tournament in this room has winner-picks on", NOT a blanket true: a
 * room whose every tournament has winner-picks off still renders disabled.
 */
export class PickAwardGate {
    private static cache = new Map<string, { value: boolean; ts: number }>();
    private static readonly TTL_MS = 5_000;

    /**
     * Resolve whether the pick-award flow is enabled for a given room and
     * (optionally) a specific tournament.
     *
     * @param roomId        The game_rooms.id (required). When falsy, returns false.
     * @param tournamentId  Optional tournament scope. When supplied, the gate is
     *                      exactly `tournament.winner_picks`. When omitted, it is
     *                      "any tournament in this room has winner-picks on".
     */
    static async isEnabled(roomId: string | null | undefined, tournamentId?: string | null): Promise<boolean> {
        if (!roomId) return false;

        const cacheKey = `${roomId}:${tournamentId ?? ''}`;
        const now = Date.now();
        const hit = this.cache.get(cacheKey);
        if (hit && now - hit.ts < this.TTL_MS) return hit.value;

        const value = tournamentId
            ? await this.isTournamentEnabled(tournamentId)
            : await this.isAnyTournamentEnabled(roomId);

        this.cache.set(cacheKey, { value, ts: now });
        return value;
    }

    private static async isTournamentEnabled(tournamentId: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get('SELECT winner_picks FROM tournaments WHERE id = ?', tournamentId);
        if (!row) return false;
        // winner_picks is 0/1 integer — NULL treated as enabled (legacy default)
        return row.winner_picks === null || row.winner_picks === undefined || row.winner_picks !== 0;
    }

    /**
     * Room-scoped resolution: true when at least one tournament in the room has
     * winner-picks on. NULL is enabled here for the same legacy-default reason
     * as {@link isTournamentEnabled}.
     */
    private static async isAnyTournamentEnabled(roomId: string): Promise<boolean> {
        const db = await getDatabase();
        const row = await db.get(
            `SELECT 1 AS hit FROM tournaments
             WHERE game_room_id = ? AND (winner_picks IS NULL OR winner_picks != 0)
             LIMIT 1`,
            roomId
        );
        return !!row;
    }

    /** Invalidate cache — call on tournament create/update/delete. */
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
 *
 * v2.56.0 — reworded from "…in this game room" now that the gate is
 * per-tournament: the room no longer has a switch, so naming the room sent
 * admins hunting through room settings for a toggle that doesn't exist.
 */
export const PICK_AWARD_DISABLED_REPLY =
    '/pick-game is not available — winner picks is turned off for this tournament';
