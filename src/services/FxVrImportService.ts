import { logInfo, logError } from '../utils/logger.js';
import { GlobalGameService } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { FX_VR_TABLES } from './fxVrPackContents.js';
import { FX_CLASSIC_VR_TABLES } from './fxClassicVrPackContents.js';

/**
 * Pinball FX VR (+ FX Classic VR, ADR 0019) catalogue tagger + auto-creator.
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
 *
 * ADR 0019 — `features` now carries BOTH the generic `vr` (informational —
 * "a VR room/edition exists") AND the per-table evidence feature `fx_vr`
 * that `vrHeadsetMatchesGame` actually reads for the `fx` engine (a
 * `per_table` engine in `ENGINE_VR_AVAILABILITY`). This is the "one owner
 * click of Sync FX VR" the ADR calls out to stamp evidence onto the existing
 * 42 tables post-deploy.
 *
 * ADR 0019 also adds a SECOND, sibling loop over `FX_CLASSIC_VR_TABLES` —
 * Pinball FX Classic VR (formerly "FX2 VR") is a separate Zen product with
 * its own curated table list and its own evidence feature (`fx_classic_vr`,
 * for the `fx_classic` engine). It runs under the SAME "Sync FX VR" click so
 * there is one sync button, not two, for one importer file. Every FX Classic
 * VR entry stamps `manufacturer: 'Zen Studios'` — several of its titles
 * ("Back to the Future", "Jaws", "E.T.", "The Walking Dead") collide by name
 * with real machines or VPX recreations, and the non-null manufacturer
 * mismatch is what stops `GlobalGameService.upsert`'s step-4 dedup from
 * loose-merging onto them (`manufacturerYearAgree` — see
 * `vr-availability-import.test.ts`). Never import an FX Classic VR table
 * without it.
 */

interface ApplyTagsResult {
    created: number;  // brand-new catalogue rows (Zen originals not in VPS/etc.)
    updated: number;  // existing rows touched (tag merged in if absent)
    classicCreated: number;  // same, for the FX Classic VR loop
    classicUpdated: number;
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
        let classicCreated = 0;
        let classicUpdated = 0;
        const errors: string[] = [];

        try {
            for (const rawName of FX_VR_TABLES) {
                const name = cleanTableName(rawName);
                try {
                    const result = await GlobalGameService.upsert({
                        name,
                        type: 'pinball',
                        // ADR 0016 catalogue phase §5: the engine is FX; "a VR
                        // edition exists" is an availability fact, not a
                        // different engine (the ADR dissolves the `*_vr` ids).
                        platforms: ['fx'],
                        // ADR 0019: `vr` stays (informational — "a VR
                        // room/edition exists"); `fx_vr` is the per-table
                        // EVIDENCE feature `vrHeadsetMatchesGame` reads for
                        // the `fx` engine (a `per_table` entry in
                        // `ENGINE_VR_AVAILABILITY`).
                        features: ['vr', 'fx_vr'],
                        status: 'approved',
                        imported_from: 'fx-vr',
                    });
                    if (result.action === 'inserted') created++;
                    else updated++;
                } catch (err) {
                    errors.push(`fx-vr: ${name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            // ADR 0019 — Pinball FX Classic VR, a separate Zen product with its
            // own curated table list and its own per-table evidence feature.
            // Runs under the same sync click/log as FX VR (one importer file,
            // one admin button).
            for (const rawName of FX_CLASSIC_VR_TABLES) {
                const name = cleanTableName(rawName);
                try {
                    const result = await GlobalGameService.upsert({
                        name,
                        type: 'pinball',
                        platforms: ['fx_classic'],
                        features: ['vr', 'fx_classic_vr'],
                        status: 'approved',
                        imported_from: 'fx-classic-vr',
                        // CRITICAL — several FX Classic VR titles collide by
                        // NAME with real machines or VPX recreations (e.g.
                        // "Back to the Future" is a Data East 1990 machine;
                        // "Jaws", "E.T.", "The Walking Dead" have real/VPX
                        // namesakes too). A non-null, non-matching
                        // manufacturer is what stops
                        // `GlobalGameService.upsert`'s step-4 dedup from
                        // loose-merging onto one of those rows
                        // (`manufacturerYearAgree` requires BOTH sides null
                        // OR equal — see `vr-availability-import.test.ts`).
                        // Never drop this field from an FX Classic VR entry.
                        manufacturer: 'Zen Studios',
                    });
                    if (result.action === 'inserted') classicCreated++;
                    else classicUpdated++;
                } catch (err) {
                    errors.push(`fx-classic-vr: ${name}: ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            const status = errors.length === 0 ? 'success' : 'partial';
            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: created + classicCreated,
                records_updated: updated + classicUpdated,
                records_skipped: 0,
                errors: errors.length > 0 ? errors : undefined,
            });

            logInfo(
                `FX VR Import: ${created} created, ${updated} updated (FX VR); ` +
                `${classicCreated} created, ${classicUpdated} updated (FX Classic VR); ` +
                `${errors.length} errored`,
            );
            return { created, updated, classicCreated, classicUpdated };
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
