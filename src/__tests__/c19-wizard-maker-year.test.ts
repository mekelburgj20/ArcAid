import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { WizardImportService } from '../services/WizardImportService.js';
import { normalizeGameName } from '../utils/catalogueUtils.js';

/**
 * C19 — the Wizard sync keeps VPS's maker and year, and the Old Wizard Rows
 * page marks the games LU's Wizard installs.
 *
 * LU ships JP's Attack from Mars as two Table Manager folders on the ONE VPS
 * game (9Paf7-CL, Bally 1995), the "LE" folder labelled Chicago Gaming Company
 * 2017. The Wizard sync runs after VPS and maker/year were supplied-wins, so
 * the last folder relabelled the game every night (prod, 2026-11-21).
 */

const AFM_VPS = '9Paf7-CL';
const AFM_FOLDERS = {
    'vpx-jpattackfrommars': {
        name: "Attack from Mars, JP's (Bally 1995)", manufacturer: 'Bally', year: 1995, vpsdbId: AFM_VPS,
    },
    'vpx-jpattackfrommarsle': {
        name: "Attack from Mars LE, JP's (Chicago Gaming Company 2017)", manufacturer: 'Chicago Gaming Company', year: 2017, vpsdbId: AFM_VPS,
    },
};

async function reset() {
    await setupTestDb();
    const db = await getDatabase();
    for (const t of ['global_game_tables', 'wizard_table_slugs', 'games', 'global_games']) {
        await db.run(`DELETE FROM ${t}`);
    }
}

async function makerYear(id: string) {
    const db = await getDatabase();
    const r = await db.get<{ manufacturer: string | null; year: number | null; field_sources: string | null }>(
        'SELECT manufacturer, year, field_sources FROM global_games WHERE id = ?', id,
    );
    return { manufacturer: r!.manufacturer, year: r!.year, sources: JSON.parse(r!.field_sources || '{}') };
}

describe('GlobalGameService.upsert — maker_year_fill_only', () => {
    beforeEach(reset);

    it('keeps the maker and year a row already has, and leaves their source stamp alone', async () => {
        const vps = await GlobalGameService.upsert({
            name: 'Attack from Mars', manufacturer: 'Bally', year: 1995, type: 'pinball',
            platforms: ['vpx'], vps_id: AFM_VPS, imported_from: 'vps',
        });
        const res = await GlobalGameService.upsert({
            name: 'Attack from Mars LE', manufacturer: 'Chicago Gaming Company', year: 2017, type: 'pinball',
            platforms: ['vpx'], vps_id: AFM_VPS, imported_from: 'wizard', maker_year_fill_only: true,
        });
        expect(res).toEqual({ id: vps.id, action: 'updated' });
        const after = await makerYear(vps.id);
        expect(after).toMatchObject({ manufacturer: 'Bally', year: 1995 });
        expect(after.sources).toMatchObject({ manufacturer: 'vps', year: 'vps' });
    });

    it('fills a maker or year the row is missing', async () => {
        const vps = await GlobalGameService.upsert({
            name: 'Blank Machine', type: 'pinball', platforms: ['vpx'], vps_id: 'vps-blank', imported_from: 'vps',
        });
        await GlobalGameService.upsert({
            name: 'Blank Machine', manufacturer: 'Gottlieb', year: 1979, type: 'pinball',
            platforms: ['vpx'], vps_id: 'vps-blank', imported_from: 'wizard', maker_year_fill_only: true,
        });
        const after = await makerYear(vps.id);
        expect(after).toMatchObject({ manufacturer: 'Gottlieb', year: 1979 });
        expect(after.sources).toMatchObject({ manufacturer: 'wizard', year: 'wizard' });
    });

    it('writes them on an insert', async () => {
        const res = await GlobalGameService.upsert({
            name: 'Wizard First', manufacturer: 'Stern', year: 2005, type: 'pinball',
            platforms: ['vpx'], vps_id: 'vps-first', imported_from: 'wizard', maker_year_fill_only: true,
        });
        expect(res.action).toBe('inserted');
        expect(await makerYear(res.id)).toMatchObject({ manufacturer: 'Stern', year: 2005 });
    });

    it('an ordinary source still replaces them, so the next VPS sync relabels a row a folder relabelled', async () => {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        // The prod state before C19: the LE folder's label on the VPS game.
        await db.run(
            `INSERT INTO global_games (id, name, normalized_name, type, manufacturer, year, status, imported_from, vps_id, platforms, features)
             VALUES (?, 'Attack from Mars', ?, 'pinball', 'Chicago Gaming Company', 2017, 'approved', 'vps', ?, '["vpx"]', '[]')`,
            id, normalizeGameName('Attack from Mars'), AFM_VPS,
        );
        await GlobalGameService.upsert({
            name: 'Attack from Mars', manufacturer: 'Bally', year: 1995, type: 'pinball',
            platforms: ['vpx'], vps_id: AFM_VPS, imported_from: 'vps',
        });
        expect(await makerYear(id)).toMatchObject({ manufacturer: 'Bally', year: 1995 });
    });
});

describe('Wizard sync keeps VPS\'s maker and year', () => {
    beforeEach(async () => {
        await reset();
        vi.stubGlobal('fetch', async (url: string) => {
            if (String(url) === WizardImportService.MANIFEST_URL) {
                return { ok: true, status: 200, json: async () => AFM_FOLDERS, text: async () => JSON.stringify(AFM_FOLDERS) };
            }
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('two folders labelled differently on one VPS game never relabel it', async () => {
        const vps = await GlobalGameService.upsert({
            name: 'Attack from Mars', manufacturer: 'Bally', year: 1995, type: 'pinball',
            platforms: ['vpx'], vps_id: AFM_VPS, imported_from: 'vps',
        });

        await WizardImportService.importFromWizard();

        const db = await getDatabase();
        const rows = await db.all<Array<{ id: string }>>('SELECT id FROM global_games WHERE vps_id = ?', AFM_VPS);
        expect(rows.map(r => r.id)).toEqual([vps.id]);
        expect(await makerYear(vps.id)).toMatchObject({ manufacturer: 'Bally', year: 1995 });
        // Both folders still resolve to the game (W110).
        const slugs = await db.all<Array<{ slug: string }>>('SELECT slug FROM wizard_table_slugs WHERE vps_id = ? ORDER BY slug', AFM_VPS);
        expect(slugs.map(s => s.slug)).toEqual(['vpx-jpattackfrommars', 'vpx-jpattackfrommarsle']);
    });
});

describe('Old Wizard Rows — On the Wizard', () => {
    beforeEach(reset);

    async function insertGame(r: { name: string; manufacturer?: string; year?: number; vps_id?: string | null; imported_from: string; external_url?: string }) {
        const db = await getDatabase();
        const id = crypto.randomUUID();
        await db.run(
            `INSERT INTO global_games (id, name, normalized_name, type, manufacturer, year, status, imported_from, vps_id, external_url, platforms, features)
             VALUES (?, ?, ?, 'pinball', ?, ?, 'approved', ?, ?, ?, '["vpx"]', '[]')`,
            id, r.name, normalizeGameName(r.name), r.manufacturer ?? null, r.year ?? null, r.imported_from,
            r.vps_id ?? null, r.external_url ?? null,
        );
        return id;
    }

    it('every candidate game carries the Wizard folders that install it', async () => {
        const db = await getDatabase();
        const { WizardLegacyMergeService } = await import('../services/WizardLegacyMergeService.js');
        const afm = await insertGame({ name: 'Attack from Mars', manufacturer: 'Bally', year: 1995, vps_id: AFM_VPS, imported_from: 'vps' });
        await db.run(`INSERT INTO wizard_table_slugs (slug, vps_id) VALUES ('vpx-jpattackfrommarsle', ?), ('vpx-jpattackfrommars', ?)`, AFM_VPS, AFM_VPS);
        // Two VPS games of one name, neither on the Wizard: the page lists both.
        await insertGame({ name: 'Medusa', manufacturer: 'Bally', year: 1981, vps_id: 'vps-medusa-a', imported_from: 'vps' });
        await insertGame({ name: 'Medusa', manufacturer: 'Bally Midway', year: 1981, vps_id: 'vps-medusa-b', imported_from: 'vps' });

        const oldAfm = await insertGame({
            name: "Attack from Mars, JP's", manufacturer: 'Bally', year: 1995, imported_from: 'wizard',
            external_url: 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/external/vpx-jpattackfrommars',
        });
        const oldMedusa = await insertGame({
            name: 'Medusa', imported_from: 'wizard',
            external_url: 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/external/vpx-medusa',
        });

        const { rows } = await WizardLegacyMergeService.preview();
        const by = new Map(rows.map(r => [r.id, r]));
        expect(by.get(oldAfm)!.suggestion!.target).toMatchObject({
            id: afm, wizardFolders: ['vpx-jpattackfrommars', 'vpx-jpattackfrommarsle'],
        });
        const alternatives = by.get(oldMedusa)!.alternatives;
        expect(alternatives).toHaveLength(2);
        expect(alternatives.every(a => a.wizardFolders.length === 0)).toBe(true);

        const hits = await WizardLegacyMergeService.searchTargets('attack');
        expect(hits).toEqual([expect.objectContaining({ id: afm, wizardFolders: ['vpx-jpattackfrommars', 'vpx-jpattackfrommarsle'] })]);
    });
});
