import type { Database } from 'sqlite';
import { isReadmeEraWizardRow, isRetiredWizardExternalUrl, withoutRetiredDownloads } from '../../utils/wizardLegacy.js';

/**
 * Migration 219 (C14, v2.257.0): the Wizard repo's `external/` folder (the
 * README's manual-install list) is gone upstream, so every link into it is a
 * 404. Merges before C14 copied those links onto VPS rows (a `wizard` download
 * entry, sometimes the row's `external_url`): ~48 rows on 2026-11-21, the
 * owner's Getaway merge among them. This removes them.
 *
 * README-era rows themselves are LEFT ALONE: their link is the only record of
 * their Wizard folder, which the C14 merge tool pairs them by
 * (`wizardFolderSlugs`), and the merge drops it when the row is absorbed.
 *
 * Idempotent: a second run finds nothing to change. Returns the rows changed.
 */
export async function stripRetiredWizardLinks(db: Database): Promise<number> {
    const rows = await db.all<Array<{
        id: string;
        imported_from: string | null;
        vps_id: string | null;
        external_url: string | null;
        table_download_urls: string | null;
    }>>(
        `SELECT id, imported_from, vps_id, external_url, table_download_urls
           FROM global_games
          WHERE external_url LIKE '%/external/%' OR table_download_urls LIKE '%/external/%'`,
    );
    let changed = 0;
    for (const row of rows) {
        if (isReadmeEraWizardRow(row)) continue;
        const downloads = withoutRetiredDownloads(row.table_download_urls);
        const deadExternal = isRetiredWizardExternalUrl(row.external_url);
        if (!downloads.changed && !deadExternal) continue;
        await db.run(
            `UPDATE global_games SET table_download_urls = ?, external_url = ? WHERE id = ?`,
            downloads.value,
            deadExternal ? null : row.external_url,
            row.id,
        );
        changed++;
    }
    return changed;
}
