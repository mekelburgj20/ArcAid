import dotenv from 'dotenv';
dotenv.config();

export type TerminologyMode = 'pinball' | 'videogame' | 'legacy' | 'generic';

export interface Terminology {
    game: string;
    games: string;
    tournament: string;
    tournaments: string;
    submission: string;
}

const TERMINOLOGY_CONFIG: Record<string, Terminology> = {
    pinball: {
        game: 'Table',
        games: 'Tables',
        tournament: 'Grind',
        tournaments: 'Grinds',
        submission: 'Score',
    },
    legacy: {
        game: 'Table',
        games: 'Tables',
        tournament: 'Grind',
        tournaments: 'Grinds',
        submission: 'Score',
    },
    videogame: {
        game: 'Game',
        games: 'Games',
        tournament: 'Tournament',
        tournaments: 'Tournaments',
        submission: 'Result',
    },
    generic: {
        game: 'Game',
        games: 'Games',
        tournament: 'Tournament',
        tournaments: 'Tournaments',
        submission: 'Result',
    }
};

/**
 * Gets terminology based on the provided mode, or falls back to generic.
 * When called with a tournament mode ('pinball' or 'videogame'), returns
 * the appropriate terminology for that tournament's context.
 */
export function getTerminology(mode?: string | null): Terminology {
    if (mode) {
        return TERMINOLOGY_CONFIG[mode.toLowerCase()] ?? TERMINOLOGY_CONFIG.generic!;
    }
    return TERMINOLOGY_CONFIG.generic!;
}

/**
 * Helper to capitalize a string.
 */
export function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
