import { describe, it, expect } from 'vitest';
import { frontFormOf } from '../utils/sortFormName.js';

/**
 * W114 — Legends Unchained writes table names in library sort form; the
 * witness ingest tries the front form beside the name as written.
 */
describe('frontFormOf', () => {
    it('moves a trailing article to the front, keeping the maker/year parenthetical last', () => {
        expect(frontFormOf("Spider-Man, JP's (Original 2018)")).toBe("JP's Spider-Man (Original 2018)");
        expect(frontFormOf('Champion Pub, The (Bally 1998)')).toBe('The Champion Pub (Bally 1998)');
        expect(frontFormOf("Avengers, JP's The (Original 2019)")).toBe("JP's The Avengers (Original 2019)");
        expect(frontFormOf("Lord of the Rings, JP's The (Stern 2003)")).toBe("JP's The Lord of the Rings (Stern 2003)");
        expect(frontFormOf('Charlie Brown Christmas, A')).toBe('A Charlie Brown Christmas');
        expect(frontFormOf('Football, JPs')).toBe('JPs Football');
        expect(frontFormOf('Real Ghostbusters,The')).toBe('The Real Ghostbusters');
    });

    it('keeps a parenthetical that sits before the moved article where it was', () => {
        expect(frontFormOf('Walking Dead (Limited Edition), The (Stern 2014)'))
            .toBe('The Walking Dead (Limited Edition) (Stern 2014)');
        expect(frontFormOf('Avengers (Pro), The (Stern 2012)')).toBe('The Avengers (Pro) (Stern 2012)');
    });

    it('returns null for a name that is not in sort form', () => {
        expect(frontFormOf("JP's Spider-Man (Original 2018)")).toBeNull();
        expect(frontFormOf('Bad Cats (Williams 1989)')).toBeNull();
        expect(frontFormOf('X Files, The Hannibal Mod (Sega 1997)')).toBeNull();
        expect(frontFormOf("Space Cadet, JP's - Galaxy Edition (Original 2021)")).toBeNull();
        expect(frontFormOf('Scooby Doo, 2022')).toBeNull();
        expect(frontFormOf(', The')).toBeNull();
        expect(frontFormOf('')).toBeNull();
        expect(frontFormOf(null)).toBeNull();
    });
});
