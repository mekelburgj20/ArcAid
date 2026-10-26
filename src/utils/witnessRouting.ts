/**
 * Which tournament games a Witness device's score may land on, decided by the
 * device's target alone.
 *
 * v2.175.0 (W37, ADR 0033 — room membership is tournament entry; owner rulings
 * 2026-10-25/26): the DEFAULT is "All my rooms". Narrowing stays optional and is
 * never needed for a play to count.
 *
 * - **All my rooms** (default): every room the player is a member of, plus any
 *   tournament they were entered into directly (an admin-added or checked-in
 *   participant). Whether a play is ALLOWED IN a matched tournament (check-in,
 *   later the roster) is `entryAllowed` in `utils/tournamentEntry.ts`, applied
 *   after this.
 * - **One room**: that room's games.
 * - **One tournament**: that tournament only.
 * - **Global Scoreboard only**: no room, rotation or room-event board (ADR 0032,
 *   W26 v2.174.0).
 * - **Throwdowns, for every un-pinned device** (Global-only included): a
 *   Throwdown has no room, so no device can be pointed at one; joining it from
 *   its link is the act (owner ruling 2026-10-25, ADR 0032 amendment).
 *
 * Pure: `VpxScoreIngestService` (where a score lands) and `EventLobbyService`
 * (whether a device counts towards a player's check-in light) both call it, so
 * the lobby can never show green for a device whose scores go somewhere else.
 * `target` is the EFFECTIVE target — a pinned tournament that has finished
 * reads as absent (`WitnessService.getDeviceTarget`).
 */
export interface WitnessTarget {
    roomId: string | null;
    tournamentId: string | null;
    /** "Global Scoreboard only" — only meaningful with no room. Absent = false. */
    globalOnly?: boolean;
}

export interface RoutableGame {
    /** The game's room; NULL for a Throwdown round (room-less event). */
    roomId: string | null;
    tournamentId: string | null;
    /** An event round (`games.round_no IS NOT NULL`). */
    isRound: boolean;
    /** The player is a participant of the game's tournament. */
    isParticipant: boolean;
    /** The player is a member of the game's room. Absent = false. */
    isMember?: boolean;
}

export function deviceRoutesTo(target: WitnessTarget, game: RoutableGame): boolean {
    if (target.tournamentId) {
        return game.tournamentId === target.tournamentId && game.roomId === target.roomId;
    }
    if (game.roomId == null) {
        // A Throwdown round: reachable once joined, from any un-pinned device.
        return game.isRound && game.isParticipant;
    }
    if (target.roomId) return game.roomId === target.roomId;
    if (target.globalOnly) return false;
    // All my rooms: a room I belong to, or a tournament I was entered into.
    return !!game.isMember || game.isParticipant;
}

/** The three ways a device can be pointed, for display and the picker. */
export type WitnessTargetMode = 'all' | 'global' | 'room' | 'tournament';

export function targetMode(target: WitnessTarget): WitnessTargetMode {
    if (target.tournamentId) return 'tournament';
    if (target.roomId) return 'room';
    return target.globalOnly ? 'global' : 'all';
}
