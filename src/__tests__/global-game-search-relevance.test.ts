import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

/**
 * Search-relevance work package (owner ask 2026-08-13) — SQL-side coverage
 * for `GlobalGameService.search`, seeded with the owner's own "Strike"
 * example set (also pinned at the tier level in `searchRank.test.ts`).
 */

const STRIKE_NAMES = [
    'Strike',
    'Strike Zone',
    'Strike Master',
    'Lucky Strike',
    'Triple Strike',
    'Striker',
    'Strikes and Spares',
    'Star Wars: Episode V The Empire Strikes Back',
    'Gold Strike',
    'Bowl A Strike',
];
const STRIKE_EXPECTED_ORDER = [
    'Strike',
    'Strike Master',
    'Strike Zone',
    'Bowl A Strike',
    'Gold Strike',
    'Lucky Strike',
    'Triple Strike',
    'Star Wars: Episode V The Empire Strikes Back',
    'Striker',
    'Strikes and Spares',
];

let seq = 0;

async function seedGame(name: string): Promise<void> {
    const db = await getDatabase();
    await db.run(
        `INSERT INTO global_games (id, name, type, status, platforms) VALUES (?, ?, 'pinball', 'approved', '[]')`,
        `strike-${++seq}`, name,
    );
}

describe('GlobalGameService.search — relevance ranking', () => {
    beforeEach(async () => {
        await setupTestDb();
        // A row that must NOT appear for the "strike" search, to prove the
        // WHERE clause (unchanged by this work package) still filters.
        await seedGame('Completely Unrelated Table');
        for (const name of STRIKE_NAMES) {
            await seedGame(name);
        }
    });

    it('ranks nearest-exact-match first for a name search', async () => {
        const result = await GlobalGameService.search('strike');
        expect(result.data.map(g => g.name)).toEqual(STRIKE_EXPECTED_ORDER);
    });

    it('excludes non-matching rows (WHERE clause is untouched by ranking)', async () => {
        const result = await GlobalGameService.search('strike');
        expect(result.data.map(g => g.name)).not.toContain('Completely Unrelated Table');
    });

    it('an empty query keeps the existing default order (insertion / id order), untouched', async () => {
        const result = await GlobalGameService.search('');
        // Insertion order was: Completely Unrelated Table, then the strike set
        // in the order above (all ids are sequential, ORDER BY id).
        expect(result.data[0].name).toBe('Completely Unrelated Table');
        expect(result.data.slice(1).map(g => g.name)).toEqual(STRIKE_NAMES);
    });
});
