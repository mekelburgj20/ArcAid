import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import { GlobalGameService } from '../services/GlobalGameService.js';

/**
 * v2.4.8 — the composite UNIQUE INDEX on
 * (LOWER(name), type, LOWER(COALESCE(manufacturer,'')), COALESCE(year,0))
 * allows real-world same-name pinball variants to coexist while still
 * rejecting thin duplicates.
 */
describe('global_games identity index + upsert disambiguation', () => {
    beforeEach(async () => {
        await setupTestDb();
    });

    it('allows two pinballs named the same with different manufacturers', async () => {
        const db = await getDatabase();
        const a = await GlobalGameService.upsert({
            name: 'Batman', type: 'pinball', manufacturer: 'Stern', year: 2008, status: 'approved',
        });
        const b = await GlobalGameService.upsert({
            name: 'Batman', type: 'pinball', manufacturer: 'Data East', year: 1991, status: 'approved',
        });
        expect(a.action).toBe('inserted');
        expect(b.action).toBe('inserted');
        expect(a.id).not.toBe(b.id);

        const rows = await db.all(`SELECT manufacturer, year FROM global_games WHERE LOWER(name) = 'batman' ORDER BY year`);
        expect(rows.length).toBe(2);
    });

    it('upsert matches the right variant when multiple exist (Wizard re-import case)', async () => {
        // Seed: "Playboy" (Bally, 1978) exists.
        await GlobalGameService.upsert({
            name: 'Playboy', type: 'pinball', manufacturer: 'Bally', year: 1978,
            platforms: ['vpx'], status: 'approved',
        });
        // Seed: "Playboy" (Stern, 2002) exists.
        const sternId = (await GlobalGameService.upsert({
            name: 'Playboy', type: 'pinball', manufacturer: 'Stern', year: 2002,
            platforms: ['vpx'], status: 'approved',
        })).id;

        // Wizard re-imports the Stern 2002 variant — should UPDATE (merge), not INSERT.
        const result = await GlobalGameService.upsert({
            name: 'Playboy', type: 'pinball', manufacturer: 'Stern', year: 2002,
            platforms: ['vpxs'], status: 'approved',
        });
        expect(result.action).toBe('updated');
        expect(result.id).toBe(sternId);

        const db = await getDatabase();
        const row = await db.get(`SELECT platforms FROM global_games WHERE id = ?`, sternId);
        const platforms = JSON.parse(row!.platforms);
        expect(platforms.sort()).toEqual(['vpx', 'vpxs']);
    });

    it('blocks inserting a second row with identical (name, type, mfg, year) — thin duplicate protection intact', async () => {
        const db = await getDatabase();
        await GlobalGameService.upsert({
            name: 'Medieval Madness', type: 'pinball', manufacturer: 'Williams', year: 1997, status: 'approved',
        });
        // Bypass upsert's dedup and attempt a raw INSERT of the exact same identity.
        await expect(
            db.run(
                `INSERT INTO global_games (id, name, type, manufacturer, year, status)
                 VALUES ('dup', 'Medieval Madness', 'pinball', 'Williams', 1997, 'approved')`,
            ),
        ).rejects.toThrow(/UNIQUE constraint failed/i);
    });

    it('step 4: concrete (mfg, year) match wins over null-tolerant thin-row shadows', async () => {
        const db = await getDatabase();
        // Seed: the rich counterpart + two thin rows with the same normalized name.
        // `normalizeGameName` collapses these to the same key via its
        // LE-stripping + paren-stripping rules.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Attack from Mars, JP''s', 'pinball', 'Bally', 1995, 'approved')`,
            'rich-bally',
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Attack from Mars, JP''s (Bally 1995)', 'pinball', NULL, NULL, 'approved')`,
            'thin-bally-paren',
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Attack from Mars LE, JP''s (Chicago Gaming Company 2017)', 'pinball', NULL, NULL, 'approved')`,
            'thin-cgc-paren',
        );

        // Wizard re-import of the Bally 1995 variant. With v2.4.10 step 4,
        // concrete mfg+year match picks rich-bally, ignoring the thin rows
        // that would otherwise shadow it.
        const result = await GlobalGameService.upsert({
            name: "Attack from Mars, JP's", type: 'pinball',
            manufacturer: 'Bally', year: 1995, platforms: ['vpxs'], status: 'approved',
        });
        expect(result.action).toBe('updated');
        expect(result.id).toBe('rich-bally');
    });

    it('step 4: exact year match disambiguates when both 2021 and 2022 rows exist', async () => {
        const db = await getDatabase();
        // Prod scenario: VPS imported 2021, a prior Wizard run created 2022,
        // today's Wizard re-imports 2022. Pre-v2.4.11, concrete filter used
        // ±1 tolerance so BOTH matched → concrete.length=2 → INSERT → collision.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Breaking Bad', 'pinball', 'Original', 2021, 'approved')`,
            'bb-2021',
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Breaking Bad', 'pinball', 'Original', 2022, 'approved')`,
            'bb-2022',
        );

        const result = await GlobalGameService.upsert({
            name: 'Breaking Bad', type: 'pinball', manufacturer: 'Original', year: 2022,
            platforms: ['vpxs'], status: 'approved',
        });
        expect(result.action).toBe('updated');
        expect(result.id).toBe('bb-2022'); // exact year match picks the right one

        // Neither row deleted or duplicated.
        const rows = await db.all(`SELECT year FROM global_games WHERE LOWER(name) = 'breaking bad' ORDER BY year`);
        expect(rows.map((r: any) => r.year)).toEqual([2021, 2022]);
    });

    it('step 4: concrete.length > 1 picks the richest row (more external IDs / older) and updates it', async () => {
        const db = await getDatabase();
        // Two rows, both Stern 2011 Transformers Pro, different source-names.
        // VPS row has a vps_id (rich), Wizard row has no externals.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, vps_id, created_at, status)
             VALUES (?, 'Transformers (Pro)', 'pinball', 'Stern', 2011, 'vps-xyz', '2025-01-01', 'approved')`,
            'vps-row',
        );
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, created_at, status)
             VALUES (?, 'Transformers Pro', 'pinball', 'Stern', 2011, '2025-06-01', 'approved')`,
            'wizard-row',
        );

        const result = await GlobalGameService.upsert({
            name: 'Transformers Pro', type: 'pinball', manufacturer: 'Stern', year: 2011,
            platforms: ['vpxs'], status: 'approved',
        });
        expect(result.action).toBe('updated');
        expect(result.id).toBe('vps-row'); // richest wins
    });

    it('step 4: finds catalogue rows whose raw names contain apostrophes / punctuation', async () => {
        const db = await getDatabase();
        // Seed a rich Wizard-style row with an apostrophe in the name.
        // Before v2.4.12, the SQL prefilter used `LIKE '%<firstword>%'`
        // where <firstword> was the NORMALIZED (punctuation-stripped)
        // first word — so "gilligans" never matched "Gilligan's" in the
        // stored name. The row was invisible to step-4 dedup and upsert
        // fell through to INSERT, causing a UNIQUE violation.
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES (?, 'Gilligan''s Island', 'pinball', 'Bally', 1991, 'approved')`,
            'rich-gilligans',
        );

        const result = await GlobalGameService.upsert({
            name: "Gilligan's Island", type: 'pinball', manufacturer: 'Bally', year: 1991,
            platforms: ['vpxs'], status: 'approved',
        });
        expect(result.action).toBe('updated');
        expect(result.id).toBe('rich-gilligans');
    });

    it('blocks two rows where both have NULL manufacturer and NULL year (coalesce collapses NULLs)', async () => {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, manufacturer, year, status)
             VALUES ('a', 'Homebrew Thing', 'pinball', NULL, NULL, 'approved')`,
        );
        await expect(
            db.run(
                `INSERT INTO global_games (id, name, type, manufacturer, year, status)
                 VALUES ('b', 'Homebrew Thing', 'pinball', NULL, NULL, 'approved')`,
            ),
        ).rejects.toThrow(/UNIQUE constraint failed/i);
    });
});
