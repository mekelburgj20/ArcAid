import { getDatabase } from '../database/database.js';
import { logInfo, logError } from '../utils/logger.js';
import { SyncLogService } from './SyncLogService.js';
import { FX_VR_TABLES } from './fxVrPackContents.js';

/**
 * Pinball FX VR catalogue tagger.
 *
 * Walks the curated `FX_VR_TABLES` list and applies the `pinball_fx_vr`
 * platform to matching `global_games` rows. Idempotent — skips rows that
 * already carry the tag, reports unmatched names so admins know what's
 * missing from the catalogue.
 *
 * Pinball FX VR is a Meta Quest standalone product. There's no Steam DLC
 * API exposing its catalogue, so the table list is hand-maintained in
 * `tmp/fx-vr-tables-draft.md` (regenerable via `tmp/emit-fx-vr-data-ts.js`).
 *
 * Mirrors the SyncLogService lifecycle used by the other importers so the
 * Catalogue Sync admin page can poll completion the same way.
 */

interface ApplyTagsResult {
    matched: number;        // newly tagged
    alreadyTagged: number;  // already had pinball_fx_vr
    unmatched: string[];    // table name not found in catalogue
}

/** Strip TM/®/©/℠ + collapse whitespace. Mirrors the Steam Pinball helper. */
function cleanTableName(s: string): string {
    return s.replace(/[™®©℠]/g, '').replace(/\s+/g, ' ').trim();
}

export class FxVrImportService {
    /**
     * Tags `global_games` rows whose name matches one of the curated FX VR
     * tables. Match precedence:
     *   1. Exact case-insensitive name match (pinball type, approved status).
     *   2. Suffix-variant fallback ("X" ↔ "X Pinball") — covers e.g.
     *      "Battlestar Galactica" vs "Battlestar Galactica Pinball".
     * Multiple variants of the same name (different mfg/year) — first match
     * wins. The admin can move the tag manually for the rare case where the
     * "wrong" variant gets tagged.
     */
    static async applyTags(): Promise<ApplyTagsResult> {
        const syncLogId = await SyncLogService.start('fx-vr');
        const db = await getDatabase();
        let matched = 0;
        let alreadyTagged = 0;
        const unmatched: string[] = [];

        try {
            for (const rawName of FX_VR_TABLES) {
                const name = cleanTableName(rawName);

                // Pass 1: exact name match.
                let row = await db.get(
                    `SELECT id, platforms FROM global_games
                     WHERE LOWER(name) = LOWER(?) AND status = 'approved' AND type = 'pinball'
                     LIMIT 1`,
                    name,
                ) as { id: string; platforms: string | null } | undefined;

                // Pass 2: suffix-variant fallback.
                if (!row) {
                    const altName = /\s+Pinball$/i.test(name)
                        ? name.replace(/\s+Pinball$/i, '').trim()
                        : `${name} Pinball`;
                    if (altName && altName.toLowerCase() !== name.toLowerCase()) {
                        row = await db.get(
                            `SELECT id, platforms FROM global_games
                             WHERE LOWER(name) = LOWER(?) AND status = 'approved' AND type = 'pinball'
                             LIMIT 1`,
                            altName,
                        ) as typeof row;
                    }
                }

                if (!row) {
                    unmatched.push(name);
                    continue;
                }

                let platforms: string[] = [];
                try {
                    const parsed = JSON.parse(row.platforms || '[]');
                    if (Array.isArray(parsed)) platforms = parsed.filter((x: any) => typeof x === 'string');
                } catch { /* malformed JSON — start fresh */ }

                if (platforms.includes('pinball_fx_vr')) {
                    alreadyTagged++;
                    continue;
                }
                platforms.push('pinball_fx_vr');
                await db.run(
                    `UPDATE global_games SET platforms = ? WHERE id = ?`,
                    JSON.stringify(platforms), row.id,
                );
                matched++;
            }

            const status: 'success' | 'partial' = unmatched.length === 0 ? 'success' : 'partial';
            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: matched,
                records_updated: alreadyTagged,
                records_skipped: unmatched.length,
                errors: unmatched.length > 0 ? unmatched.map(n => `Unmatched: ${n}`) : undefined,
            });

            logInfo(`FX VR Import: ${matched} tagged, ${alreadyTagged} already, ${unmatched.length} unmatched`);
            return { matched, alreadyTagged, unmatched };
        } catch (err) {
            logError('FX VR Import failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [String(err)],
            });
            throw err;
        }
    }
}
