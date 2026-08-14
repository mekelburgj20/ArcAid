import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

/**
 * v2.108.1 — exact-literal-name precedence in the step-4 dedup walk.
 *
 * `normalizeGameName` strips leading articles, so "The Aliens" and "Aliens"
 * share a normalized key. Pre-fix, a name-only import of "The Aliens" (the
 * AtGames sheet) fell to the loose tier where the populatedness tie-break
 * preferred the VPX "Aliens (Original, 2020)" row over the Zaccaria
 * "The Aliens" (year NULL) row — every "Sync AtGames" click re-polluted the
 * wrong game (prod incident 2026-08-14). An exact literal name match must
 * restrict the walk to the exactly-named candidates.
 */
describe('catalogue exact-name precedence (the Aliens / The Aliens pair)', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function seedAliensPair() {
        // The VPX original — richer metadata (mfg + year), the pre-fix tie-break winner.
        const vpx = await GlobalGameService.upsert({
            name: 'Aliens', type: 'pinball', manufacturer: 'Original', year: 2020,
            platforms: ['vpx'], status: 'approved',
        });
        // The Zaccaria table — literal "The Aliens", no year.
        const zac = await GlobalGameService.upsert({
            name: 'The Aliens', type: 'pinball', manufacturer: 'Zaccaria',
            platforms: ['zaccaria'], status: 'approved',
        });
        expect(vpx.id).not.toBe(zac.id);
        return { vpx, zac };
    }

    it('a name-only "The Aliens" import lands on the literally-named row, not the richer article-less cousin', async () => {
        const { vpx, zac } = await seedAliensPair();
        const result = await GlobalGameService.upsert({
            name: 'The Aliens', type: 'pinball', platforms: ['atgames_native'], status: 'approved',
        });
        expect(result.id).toBe(zac.id);
        expect(result.id).not.toBe(vpx.id);
    });

    it('a name-only "Aliens" import still lands on the exact "Aliens" row', async () => {
        const { vpx } = await seedAliensPair();
        const result = await GlobalGameService.upsert({
            name: 'Aliens', type: 'pinball', platforms: ['vpxs_manual'], status: 'approved',
        });
        expect(result.id).toBe(vpx.id);
    });

    it('article-stripping still matches when NO literal row exists ("Addams Family" → "The Addams Family")', async () => {
        const rich = await GlobalGameService.upsert({
            name: 'The Addams Family', type: 'pinball', manufacturer: 'Bally', year: 1992,
            platforms: ['real'], status: 'approved',
        });
        const result = await GlobalGameService.upsert({
            name: 'Addams Family', type: 'pinball', platforms: ['vpx'], status: 'approved',
        });
        expect(result.id).toBe(rich.id);
    });

    it('several rows sharing the literal name still disambiguate by concrete mfg/year within them', async () => {
        const williams = await GlobalGameService.upsert({
            name: 'Strike Zone', type: 'pinball', manufacturer: 'Williams', year: 1984,
            platforms: ['vpx'], status: 'approved',
        });
        const older = await GlobalGameService.upsert({
            name: 'Strike Zone', type: 'pinball', manufacturer: 'Williams', year: 1970,
            platforms: ['real'], status: 'approved',
        });
        expect(williams.id).not.toBe(older.id);

        const result = await GlobalGameService.upsert({
            name: 'Strike Zone', type: 'pinball', manufacturer: 'Williams', year: 1984,
            platforms: ['fp'], status: 'approved',
        });
        expect(result.id).toBe(williams.id);
    });
});
