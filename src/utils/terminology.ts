import dotenv from 'dotenv';
dotenv.config();

export type TerminologyMode = 'legacy' | 'generic';

export interface Terminology {
    game: string;
    games: string;
    tournament: string;
    tournaments: string;
    submission: string;
}

const TERMINOLOGY_CONFIG: Record<TerminologyMode, Terminology> = {
    legacy: {
        game: 'Table',
        games: 'Tables',
        tournament: 'Grind',
        tournaments: 'Grinds',
        submission: 'Score',
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
 * Gets the current terminology based on the TERMINOLOGY_MODE environment variable.
 * Defaults to 'generic' if not specified.
 */
export function getTerminology(): Terminology {
    const mode = (process.env.TERMINOLOGY_MODE?.toLowerCase() as TerminologyMode) || 'generic';
    return TERMINOLOGY_CONFIG[mode] || TERMINOLOGY_CONFIG.generic;
}

/**
 * Helper to capitalize a string.
 */
export function capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
}
