import { describe, it, expect, beforeEach } from 'vitest';
import { getDatabase } from '../database/database.js';
import { setupTestDb } from './helpers.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { backfillNormalizedNames } from '../database/migrations/normalizedNameBackfill.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';

/**
 * Migration 130 — `global_games.normalized_name` (igdb-import-hardening).
 *
 * The migration runs once at startup on a real deploy, so this is the only
 * chance to find out whether it does the right thing. It also has to prove the
 * part that matters more than the migration itself: that swapping step-4
 * dedup from a full scan to an index seek did not change WHICH rows it
 * matches. The equivalence test below re-implements the pre-change scan and
 * asserts the two agree over a fixture built from the exact name shapes that
 * broke earlier attempts at this (apostrophes, parentheticals, edition
 * suffixes, separator hyphens).
 */

let seq = 0;

/**
 * Inserts a row the way a pre-migration-130 writer would — no
 * `normalized_name`. Also how the two room-proposal routes in rooms.ts and
 * various test fixtures write, so this is not a purely historical shape.
 */
async function seedLegacyRow(name: string, opts: {
    type?: string;
    manufacturer?: string | null;
    year?: number | null;
} = {}): Promise<string> {
    const db = await getDatabase();
    const id = `legacy-${++seq}`;
    await db.run(
        `INSERT INTO global_games (id, name, type, manufacturer, year, platforms, status)
         VALUES (?, ?, ?, ?, ?, '[]', 'approved')`,
        id, name, opts.type ?? 'pinball', opts.manufacturer ?? null, opts.year ?? null,
    );
    return id;
}

/** The pre-change lookup, verbatim: scan everything, normalize in JS. */
async function legacyFindByNormalizedName(name: string): Promise<Array<{ id: string; name: string }>> {
    const db = await getDatabase();
    const normalized = normalizeGameName(name);
    if (!normalized) return [];
    const candidates = await db.all<Array<{ id: string; name: string }>>(`SELECT * FROM global_games`);
    return candidates.filter(g => normalizeGameName(g.name) === normalized);
}

const sortIds = (rows: Array<{ id: string }>) => rows.map(r => r.id).sort();

describe('migration 130 — normalized_name backfill', () => {
    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    it('adds the column and index on a database that predates them', async () => {
        const db = await getDatabase();
        const cols = await db.all<Array<{ name: string }>>(`PRAGMA table_info(global_games)`);
        expect(cols.some(c => c.name === 'normalized_name')).toBe(true);

        const indexes = await db.all<Array<{ name: string }>>(`PRAGMA index_list(global_games)`);
        expect(indexes.some(i => i.name === 'idx_global_games_normalized_name')).toBe(true);
    });

    it('backfills every row that has no key', async () => {
        await seedLegacyRow("Gilligan's Island");
        await seedLegacyRow('Attack From Mars (Williams, 1997)');
        await seedLegacyRow('The Addams Family');

        const db = await getDatabase();
        const before = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM global_games WHERE normalized_name IS NULL`,
        );
        expect(before!.n).toBe(3);

        await backfillNormalizedNames(db);

        const after = await db.all<Array<{ name: string; normalized_name: string }>>(
            `SELECT name, normalized_name FROM global_games ORDER BY name`,
        );
        // Ordered by `name`: "Attack From Mars (…)", "Gilligan's Island",
        // "The Addams Family" — note the third loses its leading article.
        expect(after.map(r => r.normalized_name)).toEqual([
            'attack from mars',
            'gilligans island',
            'addams family',
        ]);
    });

    it('is idempotent — a second run rewrites nothing', async () => {
        await seedLegacyRow('Medieval Madness');
        const db = await getDatabase();
        await backfillNormalizedNames(db);
        const first = await db.all(`SELECT id, normalized_name FROM global_games ORDER BY id`);

        await backfillNormalizedNames(db);
        const second = await db.all(`SELECT id, normalized_name FROM global_games ORDER BY id`);

        expect(second).toEqual(first);
        const nulls = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM global_games WHERE normalized_name IS NULL`,
        );
        expect(nulls!.n).toBe(0);
    });

    it('stores empty string, not NULL, for a name that normalizes to nothing', async () => {
        // Otherwise the row is rescanned by every subsequent backfill AND by
        // every findByNormalizedName call, forever.
        await seedLegacyRow('!!!');
        const db = await getDatabase();
        await backfillNormalizedNames(db);
        const row = await db.get(`SELECT normalized_name FROM global_games WHERE name = '!!!'`);
        expect(row.normalized_name).toBe('');
    });

    it('writes the key on insert through the service', async () => {
        const { id } = await GlobalGameService.upsert({
            name: 'The Machine: Bride of Pin-Bot', type: 'pinball', manufacturer: 'Williams', year: 1991,
        });
        const db = await getDatabase();
        const row = await db.get(`SELECT normalized_name FROM global_games WHERE id = ?`, id);
        expect(row.normalized_name).toBe(normalizeGameName('The Machine: Bride of Pin-Bot'));
    });

    it('moves the key when an admin renames a row', async () => {
        const { id } = await GlobalGameService.upsert({
            name: 'Old Name', type: 'pinball', manufacturer: 'Stern', year: 2010,
        });
        await GlobalGameService.update(id, { name: 'Brand New Name' });

        const db = await getDatabase();
        const row = await db.get(`SELECT normalized_name FROM global_games WHERE id = ?`, id);
        expect(row.normalized_name).toBe('brand new name');

        // And the row is findable under the new name, not the old one.
        expect(sortIds(await GlobalGameService.findByNormalizedName('Brand New Name'))).toEqual([id]);
        expect(await GlobalGameService.findByNormalizedName('Old Name')).toEqual([]);
    });
});

describe('dedup lookup — index path matches the old full scan', () => {
    /**
     * Names chosen for the normalizer features that the SQL LIKE prefilter
     * removed in v2.4.12 could not handle, plus the tiers the hierarchy
     * depends on. If the index path and the scan ever disagree on these, the
     * dedup hierarchy has silently changed behaviour.
     */
    const FIXTURE = [
        "Gilligan's Island",
        'Gilligans Island',
        'Attack From Mars (Williams, 1997)',
        'Attack from Mars',
        'The Addams Family',
        'Addams Family',
        'Dr. Dude',
        'Dr Dude',
        'Ace Ventura - Pet Detective',
        'Ace Ventura Pet Detective',
        'Spider-Man',
        'Transformers (Pro)',
        'Transformers Pro',
        'Medieval Madness LE',
        'Medieval Madness',
        'Café Fantastique',
        'A Night to Remember',
        'An Evening Out',
    ];

    const PROBES = [
        "Gilligan's Island",
        'gilligans island',
        'Attack From Mars',
        'The Addams Family',
        'Dr. Dude',
        'Ace Ventura - Pet Detective',
        'Spider-Man',
        'Transformers Pro',
        'Medieval Madness',
        'Café Fantastique',
        'Night to Remember',
        'Evening Out',
        'Nothing Like This Exists',
    ];

    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    it('agrees with the scan for every probe, with keys populated', async () => {
        for (const name of FIXTURE) await seedLegacyRow(name);
        const db = await getDatabase();
        await backfillNormalizedNames(db);

        for (const probe of PROBES) {
            const fast = sortIds(await GlobalGameService.findByNormalizedName(probe));
            const slow = sortIds(await legacyFindByNormalizedName(probe));
            expect(fast, `probe "${probe}"`).toEqual(slow);
        }
    });

    it('agrees with the scan when NO row has a key (pre-backfill deploy)', async () => {
        for (const name of FIXTURE) await seedLegacyRow(name);

        for (const probe of PROBES) {
            const fast = sortIds(await GlobalGameService.findByNormalizedName(probe));
            const slow = sortIds(await legacyFindByNormalizedName(probe));
            expect(fast, `probe "${probe}"`).toEqual(slow);
        }
    });

    it('agrees with the scan on a mixed catalogue (some keyed, some not)', async () => {
        // The realistic mid-deploy state: the backfill has run, then a raw
        // INSERT (room proposal, fixture) adds an unkeyed row afterwards.
        for (const name of FIXTURE.slice(0, 9)) await seedLegacyRow(name);
        const db = await getDatabase();
        await backfillNormalizedNames(db);
        for (const name of FIXTURE.slice(9)) await seedLegacyRow(name);

        const keyed = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM global_games WHERE normalized_name IS NOT NULL`,
        );
        const unkeyed = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM global_games WHERE normalized_name IS NULL`,
        );
        expect(keyed!.n).toBeGreaterThan(0);
        expect(unkeyed!.n).toBeGreaterThan(0);

        for (const probe of PROBES) {
            const fast = sortIds(await GlobalGameService.findByNormalizedName(probe));
            const slow = sortIds(await legacyFindByNormalizedName(probe));
            expect(fast, `probe "${probe}"`).toEqual(slow);
        }
    });

    it('never returns a row twice when it is both keyed and matched', async () => {
        await seedLegacyRow('Medieval Madness');
        const db = await getDatabase();
        await backfillNormalizedNames(db);
        const rows = await GlobalGameService.findByNormalizedName('Medieval Madness');
        expect(rows.length).toBe(1);
    });

    it('dedups an unkeyed legacy row correctly through upsert', async () => {
        // The correctness guarantee: a row the backfill never reached must
        // still be found by step 4, or the import forks a duplicate.
        const legacyId = await seedLegacyRow('Cirqus Voltaire', { manufacturer: 'Bally', year: 1997 });

        const result = await GlobalGameService.upsert({
            name: 'Cirqus Voltaire', type: 'pinball', manufacturer: 'Bally', year: 1997,
            platforms: ['vpx'],
        });

        expect(result.action).toBe('updated');
        expect(result.id).toBe(legacyId);

        const db = await getDatabase();
        const count = await db.get<{ n: number }>(
            `SELECT COUNT(*) AS n FROM global_games WHERE LOWER(name) = 'cirqus voltaire'`,
        );
        expect(count!.n).toBe(1);
    });
});

describe('dedup short-circuit — external-id match skips the name walk', () => {
    beforeEach(async () => {
        await setupTestDb();
        seq = 0;
    });

    it('resolves to the external-id row, not a same-name row', async () => {
        // Two rows that normalize identically. The incoming input carries the
        // vps_id of the second one, so step 1 must win outright — skipping the
        // walk cannot change that.
        await GlobalGameService.upsert({
            name: 'Twilight Zone', type: 'pinball', manufacturer: 'Bally', year: 1993,
        });
        const target = await GlobalGameService.upsert({
            name: 'Twilight Zone', type: 'pinball', manufacturer: 'Stern', year: 2015, vps_id: 'vps-tz-2015',
        });

        const result = await GlobalGameService.upsert({
            name: 'Twilight Zone', type: 'pinball', manufacturer: 'Stern', year: 2015,
            vps_id: 'vps-tz-2015', platforms: ['vpx'],
        });

        expect(result.action).toBe('updated');
        expect(result.id).toBe(target.id);
    });

    it('findCandidates still returns the possible-match list', async () => {
        // findCandidates opts back INTO the walk — the "did you mean?" list is
        // its entire job, and the short-circuit must not have emptied it.
        const a = await GlobalGameService.upsert({
            name: 'Star Trek', type: 'pinball', manufacturer: 'Bally', year: 1979,
        });
        const b = await GlobalGameService.upsert({
            name: 'Star Trek', type: 'pinball', manufacturer: 'Stern', year: 2013, vps_id: 'vps-st-2013',
        });

        const candidates = await GlobalGameService.findCandidates({
            name: 'Star Trek', type: 'pinball', manufacturer: 'Stern', year: 2013, vps_id: 'vps-st-2013',
        });

        expect(candidates.exact?.id).toBe(b.id);
        expect(candidates.possible.map(p => p.id)).toContain(a.id);
    });
});
