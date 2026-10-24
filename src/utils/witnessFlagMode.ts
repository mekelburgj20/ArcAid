/**
 * v2.169.0 (W20, owner ruling 2026-10-23) - what an event does with a score whose
 * Arcaid Witness verdict is `flagged` (the game started before the round opened).
 * 'prevent' (the default, and what any unknown or missing value means): the score
 * does not count and the player's best unflagged score ranks instead.
 * 'flag': it counts and wears the badge (ADR 0020's badge-never-gate).
 */
export type WitnessFlagMode = 'prevent' | 'flag';

export function normalizeWitnessFlagMode(value: unknown): WitnessFlagMode {
    return value === 'flag' ? 'flag' : 'prevent';
}
