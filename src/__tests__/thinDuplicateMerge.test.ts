import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import {
    mergeThinCatalogueDuplicates,
    mergeThinCatalogueDuplicatesV2,
} from '../database/migrations/catalogueUnification.js';

/**
 * v2.4.6 — migration 078 backfill cleanup.
 *
 * Validates the narrow "merge thin `<base> (<mfg>, <year>)` rows into their
 * rich counterparts" behaviour so we don't accidentally merge unrelated
 * games.
 */
describe('mergeThinCatalogueDuplicates (migration 078)', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('merges a thin duplicate into its rich counterpart', async () => {
        const db = await getDatabase();
        // Rich counterpart — separate name/mfg/year columns, has an image.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, image_url, status)
             VALUES (?, ?, 'pinball', ?, ?, ?, 'approved')`,
            'rich-nostromo', 'Alien Nostromo', 'Original', 2022, 'https://example/img.png',
        );
        // Thin row — backfill-style, combined name in a single field.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, ?, 'pinball', NULL, NULL, 'approved')`,
            'thin-nostromo', 'Alien Nostromo (Original, 2022)',
        );

        await mergeThinCatalogueDuplicates(db);

        // Thin row is gone.
        const gone = await db.get(`SELECT id FROM global_games WHERE id = 'thin-nostromo'`);
        expect(gone).toBeUndefined();
    });

    it('does not merge when manufacturer differs', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Tron', 'pinball', 'Bally', 2011, 'approved')`,
            'rich-tron-bally',
        );
        // Thin row claims a different manufacturer — NOT a merge candidate.
        await db.run(
            `INSERT INTO global_games (id, name, type, status)
             VALUES (?, 'Tron (Williams, 1981)', 'pinball', 'approved')`,
            'thin-tron-williams',
        );

        await mergeThinCatalogueDuplicates(db);

        const thin = await db.get(`SELECT id FROM global_games WHERE id = 'thin-tron-williams'`);
        expect(thin).toBeDefined(); // untouched
    });

    it('leaves thin rows with no catalogue counterpart in place', async () => {
        const db = await getDatabase();
        // Only a thin row exists; no rich counterpart to merge into.
        await db.run(
            `INSERT INTO global_games (id, name, type, status)
             VALUES (?, 'Some Obscure Homebrew (RandomGuy, 2019)', 'pinball', 'approved')`,
            'lonely-thin',
        );

        await mergeThinCatalogueDuplicates(db);

        const survived = await db.get(`SELECT id FROM global_games WHERE id = 'lonely-thin'`);
        expect(survived).toBeDefined();
    });

    it('v2 pattern handles no-comma separator (e.g. "Name (Mfg YYYY)")', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, image_url, status)
             VALUES (?, 'Asteroid Annie and the Aliens', 'pinball', 'Gottlieb', 1980, 'https://ex/img.png', 'approved')`,
            'rich-asteroid',
        );
        // No-comma format — v1 regex skips, v2 catches.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Asteroid Annie and the Aliens (Gottlieb 1980)', 'pinball', NULL, NULL, 'approved')`,
            'thin-asteroid',
        );

        // v1 should NOT merge this.
        await mergeThinCatalogueDuplicates(db);
        const stillThere = await db.get(`SELECT id FROM global_games WHERE id = 'thin-asteroid'`);
        expect(stillThere).toBeDefined();

        // v2 should merge it.
        await mergeThinCatalogueDuplicatesV2(db);
        const gone = await db.get(`SELECT id FROM global_games WHERE id = 'thin-asteroid'`);
        expect(gone).toBeUndefined();
    });

    it('skips rows with any image source (they are legitimate thin-but-usable catalogue entries)', async () => {
        const db = await getDatabase();
        // Thin-named row but has image_url — our filter excludes it from the cleanup set.
        await db.run(
            `INSERT INTO global_games (id, name, type, image_url, status)
             VALUES (?, 'Foo (Bar, 2001)', 'pinball', 'https://example/img.png', 'approved')`,
            'thin-but-imaged',
        );

        await mergeThinCatalogueDuplicates(db);

        const row = await db.get(`SELECT id FROM global_games WHERE id = 'thin-but-imaged'`);
        expect(row).toBeDefined();
    });
});
