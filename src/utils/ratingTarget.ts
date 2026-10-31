import { isCanonicalEngine, normalizeProvenanceToken } from './scoreProvenance.js';

/**
 * C3 (ratings half) - which store a room game's rating lives in.
 *
 * A room game whose NAME denotes exactly one approved catalogue row is rated
 * in `global_game_ratings` (the one store - "a star is a star"); every other
 * name (no catalogue row, or an ambiguous one) keeps the legacy room-scoped
 * `game_ratings` store. Migration 205 folds existing rows by the SAME rule in
 * set form, so the two can never disagree about where a rating belongs.
 */

type Db = {
    all<T>(sql: string, ...params: unknown[]): Promise<T>;
};

/** The catalogue row a room game's NAME denotes for ratings: exactly one approved row, case-insensitive. */
export async function catalogueIdForName(db: Db, gameName: string): Promise<string | null> {
    if (!gameName) return null;
    const rows = await db.all<Array<{ id: string }>>(
        `SELECT id FROM global_games WHERE LOWER(name) = LOWER(?) AND status = 'approved' LIMIT 2`,
        gameName,
    );
    // Zero rows, or an ambiguous name (ADR 0004 lets same-name tables from
    // different manufacturers coexist) - never guess between them.
    return rows.length === 1 ? (rows[0]?.id ?? null) : null;
}

/** '' / undefined / null -> ''. A canonical engine id (trimmed, lowercased) -> itself. Anything else -> null. */
export function normalizeRatingPlatform(input: unknown): string | null {
    if (input === undefined || input === null) return '';
    if (typeof input !== 'string') return null;
    const key = normalizeProvenanceToken(input);
    if (key === '') return '';
    return isCanonicalEngine(key) ? key : null;
}

export class PlatformInvalidError extends Error {
    code = 'PLATFORM_INVALID';
    constructor(message = 'Platform must be a canonical engine id') {
        super(message);
        this.name = 'PlatformInvalidError';
    }
}

/** A platform rating on a room-only game (one with no single catalogue row). */
export class PlatformUnsupportedError extends Error {
    code = 'PLATFORM_UNSUPPORTED';
    constructor(message = 'Platform ratings need a catalogue game') {
        super(message);
        this.name = 'PlatformUnsupportedError';
    }
}
