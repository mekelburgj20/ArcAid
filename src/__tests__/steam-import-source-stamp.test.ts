import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from './helpers.js';
import { getDatabase } from '../database/database.js';
import { GlobalGameService } from '../services/GlobalGameService.js';
import { SteamPinballImportService, STEAM_PINBALL_PRODUCTS } from '../services/SteamPinballImportService.js';
import { SW_VR_SEED_TABLES } from '../services/steamPinballPackContents.js';

/**
 * C9 (v2.199.0): the Steam Pinball importer stamps `imported_from`.
 *
 * It was the only importer without a source stamp, so `GlobalGameService.upsert`
 * treated every Steam write onto a row another importer owned as a SAME-source
 * overwrite: `table_download_urls` / `tutorial_urls` / `rules_urls` were nulled
 * (Steam supplies none) and `merged_from_sources` never recorded Steam. Since
 * v2.195.0 the nightly runs Steam right after Wizard and the FX VR product put
 * most Wizard tables in Steam's path, so every Wizard download link vanished
 * overnight (prod "The Getaway - High Speed II", 2026-10-29).
 *
 * Star Wars Pinball VR (app 1530770) seeds from a built-in list and touches no
 * network, so it drives the real `upsertTable` path here.
 */
describe('C9: Steam Pinball importer is a cross-source writer', () => {
    const swVr = STEAM_PINBALL_PRODUCTS.find(p => p.appId === 1530770)!;
    const name = SW_VR_SEED_TABLES[0]!;
    const wizardUrl = 'https://github.com/LegendsUnchained/vpx-standalone-alp4k/tree/main/tables/vpx-mando';

    beforeEach(async () => {
        await setupTestDb();
    });

    async function readRow() {
        const db = await getDatabase();
        return db.get<{ imported_from: string | null; merged_from_sources: string | null; table_download_urls: string | null; external_url: string | null }>(
            'SELECT imported_from, merged_from_sources, table_download_urls, external_url FROM global_games WHERE vps_id = ?',
            'swvrtest',
        );
    }

    it('a Steam sync after a Wizard sync keeps the wizard download entry and records steam-pinball as a source', async () => {
        await GlobalGameService.upsert({
            name, type: 'pinball', platforms: ['vpx'], vps_id: 'swvrtest', imported_from: 'vps',
            external_url: 'https://virtualpinballspreadsheet.github.io/?game=swvrtest',
        });
        await GlobalGameService.upsert({
            name, type: 'pinball', platforms: ['vpx'], vps_id: 'swvrtest', imported_from: 'wizard',
            external_url: wizardUrl,
            table_download_urls: [{ format: 'wizard', url: wizardUrl }],
        });
        expect(JSON.parse((await readRow())!.table_download_urls!)).toEqual([{ format: 'wizard', url: wizardUrl }]);

        await SteamPinballImportService.importProduct(swVr);

        const row = (await readRow())!;
        expect(JSON.parse(row.table_download_urls!)).toEqual([{ format: 'wizard', url: wizardUrl }]);
        expect(JSON.parse(row.merged_from_sources!)).toContain('steam-pinball');
        // The owning source is untouched — Steam merged onto the row, it did not take it over.
        expect(row.imported_from).toBe('vps');
    });

    it('rows the Steam importer creates carry the steam-pinball stamp', async () => {
        await SteamPinballImportService.importProduct(swVr);
        const db = await getDatabase();
        const row = await db.get<{ imported_from: string | null }>(
            'SELECT imported_from FROM global_games WHERE name = ? AND type = ?', SW_VR_SEED_TABLES[1]!, 'pinball',
        );
        expect(row?.imported_from).toBe('steam-pinball');
    });

    it('the pre-C9 shape (no stamp) is what wiped the entries — locks the mechanism the fix relies on', async () => {
        await GlobalGameService.upsert({
            name: 'Mechanism Check', type: 'pinball', platforms: ['vpx'], vps_id: 'mechchk', imported_from: 'vps',
        });
        await GlobalGameService.upsert({
            name: 'Mechanism Check', type: 'pinball', platforms: ['vpx'], vps_id: 'mechchk', imported_from: 'wizard',
            table_download_urls: [{ format: 'wizard', url: wizardUrl }],
        });
        // An unstamped write is treated as the owner re-syncing: supplied-wins, nothing supplied → null.
        await GlobalGameService.upsert({ name: 'Mechanism Check', type: 'pinball', platforms: ['vpx'], vps_id: 'mechchk' });
        const db = await getDatabase();
        const row = await db.get<{ table_download_urls: string | null }>(
            'SELECT table_download_urls FROM global_games WHERE vps_id = ?', 'mechchk',
        );
        expect(row?.table_download_urls).toBeNull();
    });
});
