import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { SyncLogService } from '../services/SyncLogService.js';
import { WizardImportService, parseWizardManifest } from '../services/WizardImportService.js';

/**
 * Wizard importer on the Table Manager manifest (v2.195.0).
 *
 * On 2026-10-28 Legends Unchained removed the "Wizard Tables" / "Manual
 * Install Tables" sections from the repo README (it now links to
 * vpxtablemanager.com/catalog), so the README scrape found zero rows and every
 * sync ended `error`. The importer now reads the `manifest` branch's
 * manifest.json — the same file the catalog site and the cabinet's Table
 * Manager read — and keys each row on the VPS game id it carries.
 *
 * The fixture mirrors the live shape of 2026-10-28 (fields the importer reads
 * only).
 */
const MANIFEST = {
    'vpx-cactuscanyon': {
        name: 'Cactus Canyon (Bally 1998)',
        manufacturer: 'Bally',
        year: 1998,
        fps: 55,
        vpsdbId: 'vZDUDUii',
        tableVpsId: 'Z7qrllPW',
        romVpsId: 'Gobv2EXY',
        backglassVpsId: 'sA8BNXIhOL',
        players: 4,
        type: 'SS',
    },
    'vpx-spacecadet': {
        // A team-credited original: the manifest says "VPW Original", VPS says
        // "Original". The strip is what lets the two agree.
        name: 'Space Cadet (VPW Original 2023)',
        manufacturer: 'VPW Original',
        year: 2023,
        fps: 60,
        vpsdbId: 'spacecad',
        pupRequired: true,
        pupFileUrl: 'https://example.invalid/pup.zip',
        type: 'OG',
    },
    'vpx-notyet': {
        // `enabled: false` in table.yml — the Table Manager hides it.
        name: 'Not Yet (Stern 2001)',
        manufacturer: 'Stern',
        year: 2001,
        fps: 60,
        vpsdbId: 'notyet00',
        enabled: false,
    },
    'vpx-nameless': {
        fps: 60,
        vpsdbId: 'nameless',
    },
    'vpx-noid': {
        // No VPS id at all: falls back to the name walk, as every row did
        // before v2.195.0.
        name: 'Orphan Table (Williams 1980)',
        fps: 50,
    },
};

async function readByVps(vpsId: string) {
    const db = await getDatabase();
    const row = await db.get(
        'SELECT id, name, manufacturer, year, subtype, players, platforms, features, image_url, external_url, imported_from FROM global_games WHERE vps_id = ?',
        vpsId,
    );
    if (!row) return undefined;
    return { ...row, platforms: JSON.parse(row.platforms), features: JSON.parse(row.features) };
}

describe('parseWizardManifest', () => {
    it('flattens the slug-keyed object, skipping disabled and unnamed entries', () => {
        const { tables, disabled, skippedNoName } = parseWizardManifest(MANIFEST);
        expect(tables.map(t => t.slug)).toEqual(['vpx-cactuscanyon', 'vpx-spacecadet', 'vpx-noid']);
        expect(disabled).toBe(1);
        expect(skippedNoName).toBe(1);
    });

    it('reads identity from the entry fields and the parenthetical as fallback', () => {
        const { tables } = parseWizardManifest(MANIFEST);
        const cc = tables.find(t => t.slug === 'vpx-cactuscanyon')!;
        expect(cc).toMatchObject({
            name: 'Cactus Canyon', manufacturer: 'Bally', year: 1998, vpsId: 'vZDUDUii',
            subtype: 'SS', players: 4, fps: 55, hasBackglass: true, requiresRom: true, hasPuppack: false,
        });
        const sc = tables.find(t => t.slug === 'vpx-spacecadet')!;
        expect(sc).toMatchObject({ name: 'Space Cadet', manufacturer: 'Original', year: 2023, hasPuppack: true, requiresRom: false });
        const orphan = tables.find(t => t.slug === 'vpx-noid')!;
        expect(orphan).toMatchObject({ name: 'Orphan Table', manufacturer: 'Williams', year: 1980, vpsId: null });
    });

    it('returns nothing for a shape that is not the manifest object', () => {
        expect(parseWizardManifest([]).tables).toEqual([]);
        expect(parseWizardManifest(null).tables).toEqual([]);
        expect(parseWizardManifest('# README').tables).toEqual([]);
    });
});

describe('WizardImportService.importFromWizard', () => {
    let manifestBody: unknown = MANIFEST;
    let manifestStatus = 200;
    const fetched: string[] = [];

    beforeEach(async () => {
        await setupTestDb();
        manifestBody = MANIFEST;
        manifestStatus = 200;
        fetched.length = 0;
        vi.stubGlobal('fetch', async (url: string) => {
            fetched.push(String(url));
            if (String(url) === WizardImportService.MANIFEST_URL) {
                return { ok: manifestStatus === 200, status: manifestStatus, json: async () => manifestBody, text: async () => JSON.stringify(manifestBody) };
            }
            // box-art downloads from the background pass: not found.
            return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
        });
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('imports every enabled table keyed on its VPS id, as the vpx engine + the vpxs feature', async () => {
        const result = await WizardImportService.importFromWizard();
        expect(result).toMatchObject({ imported: 3, updated: 0, skipped: 0, total: 3, manualCount: 0 });

        const cc = await readByVps('vZDUDUii');
        expect(cc).toMatchObject({
            name: 'Cactus Canyon', manufacturer: 'Bally', year: 1998, subtype: 'SS', players: 4,
            platforms: ['vpx'], imported_from: 'wizard',
            // v2.201.0 (C12): box art from the manifest branch's WebP mirror,
            // the catalog site's per-table page as the link, the repo folder
            // kept as the download entry.
            image_url: 'https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/manifest/boxart/vpx-cactuscanyon.webp',
            external_url: 'https://vpxtablemanager.com/catalog/#table=vpx-cactuscanyon',
        });
        {
            const db = await getDatabase();
            const dl = await db.get<{ table_download_urls: string }>('SELECT table_download_urls FROM global_games WHERE vps_id = ?', 'vZDUDUii');
            expect(JSON.parse(dl!.table_download_urls)).toEqual([
                { format: 'wizard', url: 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/tables/vpx-cactuscanyon' },
            ]);
        }
        expect(cc!.features).toEqual(expect.arrayContaining(['wizard_auto', 'has_backglass', 'requires_rom', 'fps_55', 'vpxs']));
        expect(cc!.features).not.toContain('vpxs_manual');

        // The disabled entry never reaches the catalogue.
        expect(await readByVps('notyet00')).toBeUndefined();

        const [log] = await SyncLogService.getBySource('wizard', 1);
        expect(log).toMatchObject({ status: 'success', records_imported: 3, records_updated: 0, records_fetched: 3 });
    });

    it('lands on the row VPS already created for that id — a step-1 match, not a name walk', async () => {
        // VPS imported the game first under VPS's own display name; the
        // manifest's longer name must not fork a second row.
        const vps = await GlobalGameService.upsert({
            name: 'Cactus Canyon', manufacturer: 'Bally', year: 1998, type: 'pinball',
            platforms: ['vpx'], vps_id: 'vZDUDUii', imported_from: 'vps',
        });
        manifestBody = {
            'vpx-cactuscanyon': { ...MANIFEST['vpx-cactuscanyon'], name: 'Cactus Canyon Continued (Bally 1998)' },
        };

        const result = await WizardImportService.importFromWizard();
        expect(result).toMatchObject({ imported: 0, updated: 1 });

        const db = await getDatabase();
        const rows = await db.all(`SELECT id, name FROM global_games WHERE LOWER(name) LIKE 'cactus canyon%'`);
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(vps.id);
        const row = await readByVps('vZDUDUii');
        expect(row!.features).toContain('vpxs');
    });

    it('strips a stale vpxs_manual from a row the manifest now lists', async () => {
        // Before the manifest, the README's "Manual Install" section stamped
        // `vpxs_manual`; every table in the manifest installs through the
        // Table Manager now, so the touched row converges on `vpxs` alone.
        await GlobalGameService.upsert({
            name: 'Cactus Canyon', manufacturer: 'Bally', year: 1998, type: 'pinball',
            platforms: ['vpx'], features: ['wizard_manual', 'vpxs_manual', 'has_dmd'], vps_id: 'vZDUDUii',
        });

        await WizardImportService.importFromWizard();

        const row = await readByVps('vZDUDUii');
        expect(row!.features).toContain('vpxs');
        expect(row!.features).not.toContain('vpxs_manual');
        // Unrelated tags are left alone (has_dmd has no manifest source any more).
        expect(row!.features).toContain('has_dmd');
    });

    it('fails the sync log, not silently, when the manifest is empty or unreachable', async () => {
        manifestBody = {};
        await expect(WizardImportService.importFromWizard()).rejects.toThrow(/No tables found in manifest/);
        let [log] = await SyncLogService.getBySource('wizard', 1);
        expect(log.status).toBe('error');

        manifestStatus = 503;
        await expect(WizardImportService.importFromWizard()).rejects.toThrow(/GitHub returned 503/);
        [log] = await SyncLogService.getBySource('wizard', 1);
        expect(log.status).toBe('error');
    });

    it('reads the manifest branch, not the README, and never calls the GitHub REST API', async () => {
        await WizardImportService.importFromWizard();
        expect(fetched[0]).toBe('https://raw.githubusercontent.com/LegendsUnchained/vpx-standalone-alp4k/refs/heads/manifest/manifest.json');
        expect(fetched.some(u => u.includes('api.github.com'))).toBe(false);
        expect(fetched.some(u => u.endsWith('/README.md'))).toBe(false);
    });
});
