import { logInfo, logError } from '../utils/logger.js';
import { GlobalGameService } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { FX_VR_TABLES } from './fxVrPackContents.js';

/**
 * Pinball FX VR catalogue tagger + auto-creator.
 *
 * Walks the curated `FX_VR_TABLES` list and for each table calls
 * `GlobalGameService.upsert(...)`. The 4-step dedup hierarchy in upsert:
 *   - matches an existing catalogue row (Williams/Bally/etc. real machine
 *     re-creations like Theatre of Magic) and MERGES `pinball_fx_vr` into
 *     its platforms array — `COALESCE` protects manufacturer/year/etc.
 *     from being clobbered.
 *   - creates a fresh row for Zen originals that don't exist anywhere else
 *     (Sky Pirates: Treasures of the Clouds, Pinball Noir base FX VR
 *     tables) with `imported_from='fx-vr'`, type=pinball, status=approved.
 *
 * Pinball FX VR is a Meta Quest standalone product — no Steam DLC API
 * exposes its catalogue, hence the hand-curated source-of-truth. Re-emit
 * `src/services/fxVrPackContents.ts` from `tmp/fx-vr-tables-draft.md`
 * whenever Zen ships a new pack, then click "Sync FX VR" on the admin
 * Catalogue page. Idempotent — re-running merges platforms via union, so
 * re-applying an existing tag is a no-op.
 */

interface ApplyTagsResult {
    created: number;  // brand-new catalogue rows (Zen originals not in VPS/etc.)
    updated: number;  // existing rows touched (tag merged in if absent)
}

/** Strip TM/®/©/℠ + collapse whitespace. */
function cleanTableName(s: string): string {
    return s.replace(/[™®©℠]/g, '').replace(/\s+/g, ' ').trim();
}

export class FxVrImportService {
    static async applyTags(): Promise<ApplyTagsResult> {
        const syncLogId = await SyncLogService.start('fx-vr');
        let created = 0;
        let updated = 0;
        const errors: string[] = [];

        try {
            for (const rawName of FX_VR_TABLES) {
                const name = cleanTableName(rawName);
                try {
                    const result = await GlobalGameService.upsert({
                        name,
                        type: 'pinball',
                        platforms: ['pinball_fx_vr'],
                        status: 'approved',
                        imported_from: 'fx-vr',
                    });
                    if (result.action === 'inserted') created++;
                    else updated++;
                } catch (err) {
                    errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const status = errors.length === 0 ? 'success' : 'partial';
            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: created,
                records_updated: updated,
                records_skipped: 0,
                errors: errors.length > 0 ? errors : undefined,
            });

            logInfo(`FX VR Import: ${created} created, ${updated} updated, ${errors.length} errored`);
            return { created, updated };
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
