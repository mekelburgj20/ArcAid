import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { foldCataloguePlatforms } from '../utils/scoreProvenance.js';
import { VPS_FORMAT_MAP } from '../utils/platformMapping.js';

/**
 * ADR 0016 catalogue phase §5 — every importer emits the folded shape.
 *
 * This is the commit that makes migration 129 durable. `GlobalGameService.upsert`
 * union-merges platforms, so a migration that cleans the catalogue is UNDONE by
 * the next sync unless the importers write engines too (hazard H-F). The fold
 * therefore lives at the one place all seven converge on — `upsert` — with the
 * non-obvious emitters (Wizard's feature pair, AtGames' native engine) also
 * saying so at their own call site.
 *
 * The tests below assert the SHAPE THAT LANDS IN THE DATABASE, not the shape an
 * importer's helper returns. Two different importers could return the right
 * thing and still be re-polluted by a shared writer, and the row is what the
 * rules engine reads.
 */

async function read(name: string): Promise<{ platforms: string[]; features: string[] }> {
    const db = await getDatabase();
    const row = await db.get('SELECT platforms, features FROM global_games WHERE LOWER(name) = LOWER(?)', name);
    return { platforms: JSON.parse(row.platforms), features: JSON.parse(row.features) };
}

describe('the shared fold at GlobalGameService.upsert', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('folds inbound platforms and merges the derived features', async () => {
        await GlobalGameService.upsert({
            name: 'Folded', type: 'pinball',
            platforms: ['vpx', 'vpxs', 'atgames', 'pinball_fx_vr'],
            features: ['has_puppack'],
        });
        expect(await read('Folded')).toEqual({
            platforms: ['vpx', 'atgames_native', 'fx'],
            features: ['has_puppack', 'vpxs', 'atgames', 'vr'],
        });
    });

    it('keeps an unrecognised token on the engine axis', async () => {
        // VPS invents table formats before we learn them. Dropping the token
        // would leave a game whose ONLY format is new with no platforms at all.
        await GlobalGameService.upsert({
            name: 'Novel Format', type: 'pinball', platforms: ['some_new_format'],
        });
        expect((await read('Novel Format')).platforms).toEqual(['some_new_format']);
    });

    it('is idempotent across a re-import — the union cannot re-legacy the row', async () => {
        // The hazard H-F scenario, run end to end: import legacy, then import
        // legacy AGAIN, and confirm the row does not accumulate the old ids.
        await GlobalGameService.upsert({ name: 'Twice', type: 'pinball', platforms: ['vpxs'] });
        const first = await read('Twice');
        await GlobalGameService.upsert({ name: 'Twice', type: 'pinball', platforms: ['vpxs'] });
        expect(await read('Twice')).toEqual(first);
        expect(first.platforms).toEqual(['vpx']);
        expect(first.features).toEqual(['vpxs']);
    });

    it('unions ENGINE lists when a second source adds a platform', async () => {
        await GlobalGameService.upsert({ name: 'Multi', type: 'pinball', platforms: ['vpxs'] });
        await GlobalGameService.upsert({ name: 'Multi', type: 'pinball', platforms: ['pinball_fx'] });
        expect(await read('Multi')).toEqual({
            platforms: ['vpx', 'fx'], features: ['vpxs'],
        });
    });

    it('folds an admin PUT without wiping features it did not send', async () => {
        await GlobalGameService.upsert({
            name: 'Edited', type: 'pinball', platforms: ['atgames'], features: ['atgames_4k'],
        });
        const id = (await (await getDatabase())
            .get('SELECT id FROM global_games WHERE name = ?', 'Edited')).id;

        // Edit form posts legacy ids and no `features` key at all.
        await GlobalGameService.update(id, { platforms: ['atgames', 'vpxs'] });
        const after = await read('Edited');
        expect(after.platforms).toEqual(['atgames_native', 'vpx']);
        expect(after.features).toContain('atgames_4k');   // untouched
        expect(after.features).toContain('atgames');
        expect(after.features).toContain('vpxs');
    });

    it('leaves an update that does not mention platforms alone', async () => {
        await GlobalGameService.upsert({
            name: 'Untouched', type: 'pinball', platforms: ['vpxs'], features: ['has_dmd'],
        });
        const id = (await (await getDatabase())
            .get('SELECT id FROM global_games WHERE name = ?', 'Untouched')).id;
        await GlobalGameService.update(id, { manufacturer: 'Bally' });
        expect(await read('Untouched')).toEqual({ platforms: ['vpx'], features: ['has_dmd', 'vpxs'] });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Importer by importer — the shape each one emits
// ─────────────────────────────────────────────────────────────────────────────

describe('per-importer emitted shape', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('VPS — every VPS_FORMAT_MAP output folds to an engine', async () => {
        // The map is what the importer feeds the fold, so a new entry that
        // isn't foldable is caught here rather than in production data.
        for (const legacy of Object.values(VPS_FORMAT_MAP)) {
            const fold = foldCataloguePlatforms([legacy]);
            expect(fold.engines.length, legacy).toBeGreaterThan(0);
            expect(fold.dropped, legacy).toEqual([]);
        }
        // …and the two that carry a second axis land where they should.
        expect(foldCataloguePlatforms([VPS_FORMAT_MAP['BAM']]))
            .toEqual({ engines: ['fp'], features: ['bam'], dropped: [] });
        expect(foldCataloguePlatforms([VPS_FORMAT_MAP['FX3']]))
            .toEqual({ engines: ['fx_classic'], features: [], dropped: [] });
    });

    it('VPS — a BAM table becomes the fp engine with a bam feature', async () => {
        await GlobalGameService.upsert({
            name: 'BAM Table', type: 'pinball',
            platforms: ['fp', 'bam'], features: ['has_backglass'],
        });
        expect(await read('BAM Table')).toEqual({
            platforms: ['fp'], features: ['has_backglass', 'bam'],
        });
    });

    it('Wizard — auto section: vpx engine + vpxs feature', async () => {
        await GlobalGameService.upsert({
            name: 'Wizard Auto', type: 'pinball',
            platforms: ['vpx'], features: ['wizard_auto', 'vpxs'],
        });
        expect(await read('Wizard Auto')).toEqual({
            platforms: ['vpx'], features: ['wizard_auto', 'vpxs'],
        });
    });

    it('Wizard — manual section: vpx engine + vpxs_manual feature', async () => {
        await GlobalGameService.upsert({
            name: 'Wizard Manual', type: 'pinball',
            platforms: ['vpx'], features: ['wizard_manual', 'vpxs_manual'],
        });
        expect(await read('Wizard Manual')).toEqual({
            platforms: ['vpx'], features: ['wizard_manual', 'vpxs_manual'],
        });
    });

    it('OPDB — `real`, fold is identity', () => {
        expect(foldCataloguePlatforms(['real']))
            .toEqual({ engines: ['real'], features: [], dropped: [] });
    });

    it('IGDB — console ids are already engines, fold is identity', () => {
        for (const id of ['nes', 'snes', 'genesis', 'ps1', 'ps2', 'n64', 'arcade', 'pc', 'switch']) {
            expect(foldCataloguePlatforms([id]), id)
                .toEqual({ engines: [id], features: [], dropped: [] });
        }
    });

    it('Steam Pinball — curated legacy ids fold, VR twin becomes a feature', async () => {
        expect(foldCataloguePlatforms(['pinball_fx_classic']))
            .toEqual({ engines: ['fx_classic'], features: [], dropped: [] });
        await GlobalGameService.upsert({
            name: 'Zaccaria Table', type: 'pinball', platforms: ['zaccaria', 'zaccaria_vr'],
        });
        expect(await read('Zaccaria Table')).toEqual({
            platforms: ['zaccaria'], features: ['vr'],
        });
    });

    it('FX VR — fx engine + vr feature, never a `pinball_fx_vr` platform', async () => {
        await GlobalGameService.upsert({
            name: 'FXVR Table', type: 'pinball', platforms: ['fx'], features: ['vr'],
        });
        expect(await read('FXVR Table')).toEqual({ platforms: ['fx'], features: ['vr'] });
    });

    it('FX VR then FX — the VR edition does not fork a second engine', async () => {
        // Pre-fold these were two platform ids on one row, so a game on both
        // showed two chips for one engine. Now the flat game and its VR edition
        // agree on `fx` and differ only by the feature.
        await GlobalGameService.upsert({ name: 'Both', type: 'pinball', platforms: ['pinball_fx'] });
        await GlobalGameService.upsert({
            name: 'Both', type: 'pinball', platforms: ['fx'], features: ['vr'],
        });
        expect(await read('Both')).toEqual({ platforms: ['fx'], features: ['vr'] });
    });

    it('AtGames — atgames_native engine + atgames feature + cabinet variants', async () => {
        // FLAGGED PRODUCT CALL #1. The engine is what ends the Unspecified
        // auto-lock; the cabinet variants keep the home migration 101 gave them.
        await GlobalGameService.upsert({
            name: 'Sheet Game', type: 'pinball',
            platforms: ['atgames_native'], features: ['atgames', 'atgames_4k', 'atgames_hd'],
        });
        expect(await read('Sheet Game')).toEqual({
            platforms: ['atgames_native'],
            features: ['atgames', 'atgames_4k', 'atgames_hd'],
        });
    });

    it('AtGames — a legacy-shaped payload from an older build folds to the same row', async () => {
        await GlobalGameService.upsert({
            name: 'Sheet Game 2', type: 'pinball',
            platforms: ['atgames'], features: ['atgames_4k'],
        });
        expect(await read('Sheet Game 2')).toEqual({
            platforms: ['atgames_native'], features: ['atgames_4k', 'atgames'],
        });
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Wizard reconcile — the one importer that must REMOVE, not just add
// ─────────────────────────────────────────────────────────────────────────────

describe('reconcileWizardPlatformTags', () => {
    beforeEach(async () => { await setupTestDb(); });

    async function seed(platforms: string[], features: string[]): Promise<string> {
        const db = await getDatabase();
        await db.run(
            `INSERT INTO global_games (id, name, type, platforms, features, status)
             VALUES ('w1', 'Wizard Row', 'pinball', ?, ?, 'approved')`,
            JSON.stringify(platforms), JSON.stringify(features),
        );
        return 'w1';
    }

    it('moves a game from auto to manual when the README section changes', async () => {
        // `upsert` only ever ADDS, so without this pass a game that left the
        // auto section would keep claiming `vpxs` forever — the reason this
        // function exists, unchanged by the fold.
        const { reconcileWizardPlatformTags } = await import('../services/WizardImportService.js');
        const id = await seed(['vpx'], ['wizard_auto', 'vpxs', 'has_dmd']);
        await reconcileWizardPlatformTags(new Map([[id, { auto: false, manual: true }]]));
        const row = await read('Wizard Row');
        expect(row.features).not.toContain('vpxs');
        expect(row.features).toContain('vpxs_manual');
        expect(row.features).toContain('has_dmd');   // untouched
        expect(row.platforms).toEqual(['vpx']);
    });

    it('keeps both when the README lists the game in both sections', async () => {
        const { reconcileWizardPlatformTags } = await import('../services/WizardImportService.js');
        const id = await seed(['vpx'], []);
        await reconcileWizardPlatformTags(new Map([[id, { auto: true, manual: true }]]));
        expect((await read('Wizard Row')).features).toEqual(['vpxs', 'vpxs_manual']);
    });

    it('strips a stale `vpxs` still sitting in platforms', async () => {
        // A row written before migration 129, or by an older importer build.
        // It converges on the next sync rather than needing a second migration.
        const { reconcileWizardPlatformTags } = await import('../services/WizardImportService.js');
        const id = await seed(['vpx', 'vpxs', 'vpxs_manual', 'fp'], []);
        await reconcileWizardPlatformTags(new Map([[id, { auto: true, manual: false }]]));
        const row = await read('Wizard Row');
        expect(row.platforms).toEqual(['vpx', 'fp']);
        expect(row.features).toEqual(['vpxs']);
    });

    it('drops both tags when the game leaves the README entirely', async () => {
        const { reconcileWizardPlatformTags } = await import('../services/WizardImportService.js');
        const id = await seed(['vpx'], ['vpxs', 'wizard_auto']);
        await reconcileWizardPlatformTags(new Map([[id, { auto: false, manual: false }]]));
        expect((await read('Wizard Row')).features).toEqual(['wizard_auto']);
    });
});
