import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { FxVrImportService } from '../services/FxVrImportService.js';
import { FX_CLASSIC_VR_TABLES } from '../services/fxClassicVrPackContents.js';

/**
 * ADR 0019 — the FX Classic VR importer's manufacturer-mismatch dedup safety.
 *
 * Several FX Classic VR titles collide by NAME with real machines or VPX
 * recreations: "Back to the Future" is a Data East 1990 machine; "Jaws",
 * "E.T." and "The Walking Dead" have real/VPX namesakes too. Every entry the
 * importer upserts carries `manufacturer: 'Zen Studios'` specifically so
 * `GlobalGameService.upsert`'s step-4 dedup — `manufacturerYearAgree`,
 * required by BOTH the concrete and loose tiers — refuses to merge onto a
 * differently-manufactured lookalike row rather than clobbering it.
 */
describe('ADR 0019 — FX Classic VR importer does not merge onto real-machine lookalikes', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('does not merge "Back to the Future Pinball" onto the Data East 1990 "Back to the Future" row', async () => {
        const dataEast = await GlobalGameService.upsert({
            name: 'Back to the Future', type: 'pinball', manufacturer: 'Data East', year: 1990,
            platforms: ['vpx', 'real'], status: 'approved',
        });

        const zen = await GlobalGameService.upsert({
            name: 'Back to the Future Pinball', type: 'pinball', manufacturer: 'Zen Studios',
            platforms: ['fx_classic'], features: ['vr', 'fx_classic_vr'], status: 'approved',
            imported_from: 'fx-classic-vr',
        });

        expect(zen.id).not.toBe(dataEast.id);
        expect(zen.action).toBe('inserted');

        // The Data East row is untouched — still real-manufacturer, still no
        // FX Classic platform/feature bleed.
        const dataEastRow = await GlobalGameService.getById(dataEast.id);
        expect(dataEastRow?.manufacturer).toBe('Data East');
        expect(JSON.parse(dataEastRow?.platforms || '[]')).toEqual(['vpx', 'real']);
    });

    it('does not merge onto a lookalike even when the NAME matches exactly ("The Walking Dead")', async () => {
        // The riskiest case: unlike "Back to the Future Pinball", the curated
        // entry "The Walking Dead" carries no differentiating suffix, so it
        // DOES land in the step-4 normalized-name candidate set alongside a
        // real Stern machine of the same name. The manufacturer mismatch —
        // not the name — is what has to stop the merge here.
        const stern = await GlobalGameService.upsert({
            name: 'The Walking Dead', type: 'pinball', manufacturer: 'Stern', year: 2014,
            platforms: ['vpx', 'real'], status: 'approved',
        });

        const zen = await GlobalGameService.upsert({
            name: 'The Walking Dead', type: 'pinball', manufacturer: 'Zen Studios',
            platforms: ['fx_classic'], features: ['vr', 'fx_classic_vr'], status: 'approved',
            imported_from: 'fx-classic-vr',
        });

        expect(zen.id).not.toBe(stern.id);
        expect(zen.action).toBe('inserted');

        const sternRow = await GlobalGameService.getById(stern.id);
        expect(sternRow?.manufacturer).toBe('Stern');
        expect(JSON.parse(sternRow?.platforms || '[]')).toEqual(['vpx', 'real']);
    });

    it('idempotent re-upsert of the SAME Zen row merges onto itself, not the lookalike', async () => {
        await GlobalGameService.upsert({
            name: 'Jaws Pinball', type: 'pinball', manufacturer: 'Stern', year: 2019,
            platforms: ['vpx', 'real'], status: 'approved',
        });
        const first = await GlobalGameService.upsert({
            name: 'Jaws Pinball', type: 'pinball', manufacturer: 'Zen Studios',
            platforms: ['fx_classic'], features: ['vr', 'fx_classic_vr'], status: 'approved',
            imported_from: 'fx-classic-vr',
        });
        const second = await GlobalGameService.upsert({
            name: 'Jaws Pinball', type: 'pinball', manufacturer: 'Zen Studios',
            platforms: ['fx_classic'], features: ['vr', 'fx_classic_vr'], status: 'approved',
            imported_from: 'fx-classic-vr',
        });
        expect(second.id).toBe(first.id);
        expect(second.action).toBe('updated');
    });
});

describe('ADR 0019 — FxVrImportService.applyTags covers both lists', () => {
    beforeEach(async () => { await setupTestDb(); });

    it('stamps `fx_vr` on FX VR tables and `fx_classic_vr` + manufacturer on FX Classic VR tables, and counts both', async () => {
        const result = await FxVrImportService.applyTags();

        expect(result.created + result.updated).toBeGreaterThan(0);
        expect(result.classicCreated + result.classicUpdated).toBe(FX_CLASSIC_VR_TABLES.length);

        const btf = await GlobalGameService.search('Back to the Future Pinball');
        const btfRow = btf.data.find(g => g.name === 'Back to the Future Pinball');
        expect(btfRow, 'FX Classic VR row for Back to the Future Pinball should exist').toBeTruthy();
        expect(btfRow?.manufacturer).toBe('Zen Studios');
        expect(JSON.parse(btfRow?.platforms || '[]')).toEqual(['fx_classic']);
        expect(JSON.parse(btfRow?.features || '[]')).toEqual(expect.arrayContaining(['vr', 'fx_classic_vr']));

        const diner = await GlobalGameService.search('Diner');
        const dinerRow = diner.data.find(g => g.name.toLowerCase() === 'diner');
        expect(dinerRow, 'FX VR row for Diner should exist').toBeTruthy();
        expect(JSON.parse(dinerRow?.features || '[]')).toEqual(expect.arrayContaining(['vr', 'fx_vr']));
    });

    it('re-running is idempotent (no duplicate rows, counts move to "updated")', async () => {
        await FxVrImportService.applyTags();
        const second = await FxVrImportService.applyTags();
        expect(second.classicCreated).toBe(0);
        expect(second.classicUpdated).toBe(FX_CLASSIC_VR_TABLES.length);
    });
});
