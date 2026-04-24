import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import { mergeThinCatalogueDuplicates } from '../database/migrations/catalogueUnification.js';

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

    it('merges a thin duplicate into its rich counterpart and repoints game_library', async () => {
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
        // A library row whose FK points at the thin duplicate (typical post-069 state).
        await db.run(
            `INSERT INTO game_library (name, mode, global_game_id) VALUES (?, 'pinball', ?)`,
            'Alien Nostromo (Original, 2022)', 'thin-nostromo',
        );

        await mergeThinCatalogueDuplicates(db);

        // Thin row is gone.
        const gone = await db.get(`SELECT id FROM global_games WHERE id = 'thin-nostromo'`);
        expect(gone).toBeUndefined();

        // Library FK now points at the rich row.
        const lib = await db.get(`SELECT global_game_id FROM game_library WHERE name = 'Alien Nostromo (Original, 2022)'`);
        expect(lib?.global_game_id).toBe('rich-nostromo');
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
