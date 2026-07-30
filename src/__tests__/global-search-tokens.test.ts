import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalLeaderboardService } from '../services/GlobalLeaderboardService.js';

/**
 * v2.51.0 (A3) — catalogue search token matching, the server half of the ⌘K
 * palette. Two things are new: AND-combination across whitespace-separated
 * tokens, and year-token awareness. Manufacturer matching is NOT new (it has
 * always been in the 3-way LIKE) but is asserted here because "stern 1995"
 * depends on it.
 *
 * Bootstrap follows global-scoreboard-hasscores.test.ts: global.ts declares its
 * routes with a bare `/global/...` path, so the router mounts at '/api'.
 */
async function createTestApp() {
    await setupTestDb();

    const app = express();
    app.use(express.json());

    const { default: globalRouter } = await import('../api/routes/global.js');
    app.use('/api', globalRouter);

    return app;
}

interface SeedGame {
    name: string;
    manufacturer: string | null;
    year: number | null;
}

const SEED: SeedGame[] = [
    // The single-token litmus from the contract.
    { name: 'Haunted House', manufacturer: 'Gottlieb', year: 1982 },
    // "stern 1995" must land on exactly this row...
    { name: 'Stern Era Table', manufacturer: 'Stern', year: 1995 },
    // ...not on same-manufacturer-wrong-year...
    { name: 'Harley-Davidson', manufacturer: 'Stern', year: 1999 },
    // ...and not on right-year-wrong-manufacturer.
    { name: 'Batman Forever', manufacturer: 'Sega', year: 1995 },
    // A 4-digit token that is NOT a year: it appears in a title, and a
    // (nonsense) row carries it as an actual year value. The word reading must
    // win, so the title matches and the year row does not.
    { name: 'Pinball 3000', manufacturer: 'Williams', year: 1999 },
    { name: 'Far Future Table', manufacturer: 'Williams', year: 3000 },
    // Year-in-title guard: the year token OR's against the text columns, so a
    // title containing the number stays findable even when `year` differs.
    { name: 'Pinball 2000 Revenge', manufacturer: 'Williams', year: 1999 },
];

async function seedCatalogue(): Promise<Map<string, string>> {
    const db = await getDatabase();
    const ids = new Map<string, string>();
    for (const g of SEED) {
        const id = crypto.randomUUID();
        ids.set(g.name, id);
        await db.run(
            `INSERT INTO global_games (id, name, type, status, manufacturer, year)
             VALUES (?, ?, 'pinball', 'approved', ?, ?)`,
            id, g.name, g.manufacturer, g.year,
        );
    }
    return ids;
}

async function searchNames(search: string): Promise<string[]> {
    const result = await GlobalLeaderboardService.getTopGames({ scope: 'global', search });
    return result.data.map(g => g.name).sort();
}

describe('GlobalLeaderboardService.getTopGames — search tokens (v2.51.0 A3)', () => {
    it('(a) "stern 1995" ANDs manufacturer and year', async () => {
        await setupTestDb();
        await seedCatalogue();

        expect(await searchNames('stern 1995')).toEqual(['Stern Era Table']);
    });

    it('(b) "haunt" still matches by name (single-token path unchanged)', async () => {
        await setupTestDb();
        await seedCatalogue();

        expect(await searchNames('haunt')).toEqual(['Haunted House']);
        // Manufacturer matching is pre-existing, not new — assert it survived.
        expect(await searchNames('gottlieb')).toEqual(['Haunted House']);
    });

    it('(c) a 4-digit token outside 1900-2099 is treated as a word, not a year', async () => {
        await setupTestDb();
        await seedCatalogue();

        const names = await searchNames('williams 3000');
        expect(names).toEqual(['Pinball 3000']);
        // The row whose `year` column literally is 3000 must NOT be pulled in.
        expect(names).not.toContain('Far Future Table');
    });

    it('(d) a year token also matches the number in a title, not only gg.year', async () => {
        await setupTestDb();
        await seedCatalogue();

        // 'Pinball 2000 Revenge' has year 1999 — it matches on the title text.
        expect(await searchNames('pinball 2000')).toEqual(['Pinball 2000 Revenge']);
    });

    it('(e) multi-token queries do not SQL-error and `total` reflects the filtered set', async () => {
        await setupTestDb();
        await seedCatalogue();

        const all = await GlobalLeaderboardService.getTopGames({ scope: 'global' });
        expect(all.total).toBe(SEED.length);

        const filtered = await GlobalLeaderboardService.getTopGames({ scope: 'global', search: 'stern 1995' });
        expect(filtered.total).toBe(1);
        expect(filtered.data).toHaveLength(1);

        // Three tokens, punctuation, and a no-match combination all execute.
        const three = await GlobalLeaderboardService.getTopGames({ scope: 'global', search: 'stern 1995 table' });
        expect(three.total).toBe(1);

        const none = await GlobalLeaderboardService.getTopGames({ scope: 'global', search: 'stern 1982' });
        expect(none.total).toBe(0);
        expect(none.data).toHaveLength(0);

        // A quote-heavy query is bound as a parameter, never interpolated.
        const injected = await GlobalLeaderboardService.getTopGames({ scope: 'global', search: `stern' OR 1=1 --` });
        expect(injected.total).toBe(0);
    });
});

describe('GET /api/global/scoreboard — search tokens (v2.51.0 A3)', () => {
    it('(f) the route ANDs tokens end-to-end and reports the filtered total', async () => {
        const app = await createTestApp();
        await seedCatalogue();

        const res = await request(app).get('/api/global/scoreboard?scope=global&search=stern%201995');
        expect(res.status).toBe(200);
        expect(res.body.data.map((g: any) => g.name)).toEqual(['Stern Era Table']);
        expect(res.body.total).toBe(1);
    });
});
