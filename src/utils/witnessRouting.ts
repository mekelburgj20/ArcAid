/**
 * Which tournament games a Witness device's score may land on, decided by the
 * device's target alone (W26, ADR 0032; owner rulings 2026-10-24 / 2026-10-25).
 *
 * - **Pinned to a tournament** (room + tournament): that tournament only.
 * - **Pointed at a room**: that room's games.
 * - **"Global Scoreboard only"** (no room): no room, rotation or room-event
 *   board — ADR 0032. Pre-v2.174.0 it still reached the rounds of any event the
 *   player was a participant of; the label said otherwise.
 * - **Throwdowns are the one exception, for every un-pinned device.** A
 *   Throwdown has no room, so no device can be pointed at one; joining it from
 *   its link is the deliberate act a designation would otherwise supply (owner
 *   ruling 2026-10-25). Before v2.174.0 a room-pointed device could not reach
 *   one at all (the room filter excluded room-less rounds).
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
}

export interface RoutableGame {
    /** The game's room; NULL for a Throwdown round (room-less event). */
    roomId: string | null;
    tournamentId: string | null;
    /** An event round (`games.round_no IS NOT NULL`). */
    isRound: boolean;
    /** The player is a participant of the game's tournament. */
    isParticipant: boolean;
}

export function deviceRoutesTo(target: WitnessTarget, game: RoutableGame): boolean {
    if (target.tournamentId) {
        return game.tournamentId === target.tournamentId && game.roomId === target.roomId;
    }
    if (game.roomId == null) {
        // A Throwdown round: reachable once joined, from any un-pinned device.
        return game.isRound && game.isParticipant;
    }
    return target.roomId != null && game.roomId === target.roomId;
}
