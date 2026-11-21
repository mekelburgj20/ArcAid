import { getDatabase } from '../database/database.js';

/**
 * W110 (v2.255.0) - the Legends Unchained Wizard folder slug -> VPS game map
 * in `wizard_table_slugs` (migration 218).
 *
 * A cabinet play carries the table's install folder (`slug=vpx-jamesbond007`,
 * the folder under `/media/usb0/external/`), and the Wizard manifest is keyed
 * by exactly that folder name, with the VPS game id (`vpsdbId`) of every table
 * it ships. So for a Wizard-installed table the slug IS the table's identity,
 * and the play no longer has to be recognised by name ("Title, JP's" sort
 * forms, renamed catalogue rows, two machines of one name).
 *
 * - Written ONLY by `WizardImportService.importFromWizard` (`storeFromManifest`).
 * - Read ONLY by the witness ingest's identity tier (`gameForSlug`), which
 *   uses it for MATCHING: it is never Sanctioned-play evidence.
 * - Keyed on the slug, because one VPS game can ship as several folders (a
 *   stock table and its mod: 12 VPS games carry two or three slugs). The
 *   catalogue row is found at READ time through `global_games.vps_id`, so a
 *   merge or a rename of the row never leaves the map pointing at nothing.
 * - Empty (before the first Wizard sync after migration 218), or a folder the
 *   manifest never listed (a hand-installed table): `gameForSlug` is null and
 *   the ingest does exactly what it did before.
 */

/** Slugs compare trimmed and case-insensitively (the column is COLLATE NOCASE). */
export function normalizeSlug(slug: string | null | undefined): string | null {
    if (typeof slug !== 'string') return null;
    const s = slug.trim();
    return s ? s : null;
}

export class GlobalGameSlugService {
    /**
     * Record the manifest's slug -> VPS game id pairs. Upserts every listed
     * slug that carries a VPS id and deletes the row of a listed slug that no
     * longer carries one. A slug the manifest stops listing keeps its row: the
     * folder is still installed on the cabinets that have it, and the VPS game
     * LU named for it is still the best evidence of what it is.
     *
     * Row by row, no transaction: each write is idempotent, so a sync cut
     * short leaves a map that is right as far as it goes, and the next sync
     * completes it.
     */
    static async storeFromManifest(
        tables: Array<{ slug: string; vpsId: string | null; name?: string | null }>,
    ): Promise<{ stored: number; removed: number }> {
        const db = await getDatabase();
        let stored = 0;
        let removed = 0;
        for (const table of tables) {
            const slug = normalizeSlug(table.slug);
            if (!slug) continue;
            const vpsId = typeof table.vpsId === 'string' ? table.vpsId.trim() : '';
            if (!vpsId) {
                const res = await db.run(`DELETE FROM wizard_table_slugs WHERE slug = ?`, slug);
                removed += res.changes ?? 0;
                continue;
            }
            await db.run(
                `INSERT INTO wizard_table_slugs (slug, vps_id, name, seen_at)
                 VALUES (?, ?, ?, datetime('now'))
                 ON CONFLICT(slug) DO UPDATE SET vps_id = excluded.vps_id, name = excluded.name, seen_at = excluded.seen_at`,
                slug, vpsId, table.name ?? null,
            );
            stored++;
        }
        return { stored, removed };
    }

    /** How many slugs the map holds (0 = no Wizard sync has filled it yet). */
    static async count(): Promise<number> {
        const db = await getDatabase();
        const row = await db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM wizard_table_slugs`);
        return row?.n ?? 0;
    }

    /**
     * The ONE approved catalogue game a cabinet's folder slug names, or null
     * when the map does not know the slug, the catalogue has no approved row
     * for its VPS game, or has more than one (never a guess).
     */
    static async gameForSlug(slug: string | null | undefined): Promise<{ id: string; name: string; display_name: string | null } | null> {
        const key = normalizeSlug(slug);
        if (!key) return null;
        const db = await getDatabase();
        const rows = await db.all<Array<{ id: string; name: string; display_name: string | null }>>(
            `SELECT g.id, g.name, g.display_name
               FROM wizard_table_slugs s
               JOIN global_games g ON g.vps_id = s.vps_id
              WHERE s.slug = ? AND g.status = 'approved'
              LIMIT 2`,
            key,
        );
        return rows.length === 1 ? rows[0]! : null;
    }
}
