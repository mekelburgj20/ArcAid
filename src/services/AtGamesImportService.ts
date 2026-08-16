import { AtGamesApiClient, type AtGamesGame } from './AtGamesApiClient.js';
import { AtGamesEStoreClient, atgamesMatchKey, atgamesDedupName, seriesOf, brandOf } from './AtGamesEStoreClient.js';
import { buildOverrideIndex } from './atgamesStudioOverrides.js';
import { GlobalGameService } from './GlobalGameService.js';
import { SyncLogService } from './SyncLogService.js';
import { logInfo, logError, logWarn } from '../utils/logger.js';

/**
 * AtGames Legends Pinball catalogue importer.
 *
 * Two sources, each answering the question the other can't:
 *
 *  - `AtGamesApiClient` (atgames.net) — AtGames' own catalogue. Canonical
 *    names, cabinet availability, and a STABLE `game_id`. The id is why this
 *    service was rewritten: it moves AtGames dedup from hierarchy step 4
 *    (normalized name, which produced the 88 Zaccaria/AtGames duplicates
 *    repaired on prod 2026-08-16) to step 1 (external id).
 *
 *  - `AtGamesEStoreClient` (atgames.us) — the storefront, which files every
 *    table pack under its publisher. That's the studio.
 *
 * This REPLACES the community Google Sheet the service used to read. The API
 * is strictly more complete (283 pinball tables against the sheet's 260,
 * including `Locomotion Deluxe` and `Aerobatics Deluxe` which the sheet omits
 * entirely) and its names match the Zaccaria four-design taxonomy verbatim.
 *
 * Idempotent: re-running resolves every row by `atgames_id` and updates in
 * place.
 */

/**
 * Straightens the typographic quotes AtGames' API returns ("A Samurai's
 * Vengeance" comes back with a curly apostrophe). Without this the name
 * wouldn't match a catalogue row stored with a straight one and dedup would
 * fork. Carried over from the sheet-based importer, where it was load-bearing
 * for the same reason.
 */
function normalizeName(s: string): string {
    return s
        .replace(/[‘’]/g, "'")
        .replace(/[“”]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Rows AtGames leaves in its own live catalogue that are not games.
 *
 * The feed currently carries "ZZZ Test 2", "ZZZ Test 3", "ZZZ Test 4" and
 * "ZZZ Test 8" — internal fixtures, classified as pinball by the cabinet
 * check because they are provisioned onto pinball hardware. They would import
 * as four junk catalogue rows that an admin then has to find and delete.
 *
 * Kept to the observed marker only — a broader "anything ending in Test"
 * rule would be guessing at names no one has seen.
 */
const EXCLUDED_NAME_PATTERNS: RegExp[] = [
    /^zzz\b/i,
];

function isExcludedName(name: string): boolean {
    return EXCLUDED_NAME_PATTERNS.some(re => re.test(name.trim()));
}

export interface AtGamesSyncResult {
    created: number;
    updated: number;
    skipped: number;
    total: number;
    /** Pinball rows the cabinet classifier accepted, out of the whole feed. */
    pinball: number;
    arcadeSkipped: number;
    /** How many imported rows got a studio, and from where. */
    studioFromPack: number;
    studioFromSeries: number;
    studioFromPrefix: number;
    studioFromBrand: number;
    studioFromOverride: number;
    studioMissing: number;
    /** Non-game rows the exclusion list dropped (AtGames' own test fixtures). */
    excluded: number;
    manufacturerFilled: number;
}

export class AtGamesImportService {
    static async applyTags(): Promise<AtGamesSyncResult> {
        const syncLogId = await SyncLogService.start('atgames');
        let created = 0;
        let updated = 0;
        let skipped = 0;
        let studioFromPack = 0;
        let studioFromSeries = 0;
        let studioFromPrefix = 0;
        let studioFromBrand = 0;
        let studioFromOverride = 0;
        let studioMissing = 0;
        /** Names nothing could attribute — logged so a new unenumerated pack is visible. */
        const unattributed: string[] = [];
        const overrides = buildOverrideIndex(atgamesMatchKey);
        let excluded = 0;
        let manufacturerFilled = 0;
        const errors: string[] = [];

        try {
            // Diagnostic only — logs a warning if AtGames has shipped a cabinet
            // this codebase doesn't know how to tag.
            await AtGamesApiClient.fetchHardwareModels();

            // Studio attribution is best-effort. If the storefront is
            // unreachable the catalogue import still runs; those rows keep a
            // null studio and pick one up on the next successful sync.
            let studioMap: Awaited<ReturnType<typeof AtGamesEStoreClient.buildStudioMap>> | null = null;
            try {
                studioMap = await AtGamesEStoreClient.buildStudioMap();
            } catch (err) {
                logWarn(`AtGames sync: eStore studio map unavailable (${err instanceof Error ? err.message : String(err)}) — importing without studio attribution`);
            }

            const allGames = await AtGamesApiClient.fetchAllGames();
            const pinballGames = allGames.filter(g => AtGamesApiClient.isPinball(g));
            const arcadeSkipped = allGames.length - pinballGames.length;
            logInfo(`AtGames sync: ${pinballGames.length} pinball tables (${arcadeSkipped} arcade rows skipped) of ${allGames.length}`);

            for (const game of pinballGames) {
                try {
                    const name = normalizeName(game.name);
                    if (!name) { skipped++; continue; }
                    if (isExcludedName(name)) { excluded++; continue; }

                    // Attribution runs strongest-evidence-first and stops at
                    // the first hit: a pack that NAMES the table beats a
                    // series rule, which beats a pack-title prefix.
                    let attribution = studioMap?.byKey.get(atgamesMatchKey(name)) ?? null;
                    let studio = attribution?.studio ?? null;
                    if (studio) {
                        studioFromPack++;
                    } else {
                        // Series: packs like Dr. Seuss and Natural History
                        // don't publish their contents, but the API stamps the
                        // series onto the table's own name and each series has
                        // exactly one publisher.
                        const series = seriesOf(game.name);
                        const seriesStudio = series ? studioMap?.bySeries.get(series) ?? null : null;
                        if (seriesStudio) {
                            studio = seriesStudio;
                            studioFromSeries++;
                        } else if (studioMap) {
                            // Prefix: AtGames names mini-pack tables after
                            // their pack ("Star Trek™ Pinball: Discovery" under
                            // "Star Trek™ Pinball Legends Mini Pack").
                            const byPrefix = AtGamesEStoreClient.matchByPrefix(studioMap.byPrefix, name);
                            // Brand: the name announces its licensed brand
                            // ("Williams™ Pinball: FunHouse™") and the store
                            // says who publishes that brand's packs.
                            const brand = brandOf(name);
                            const byBrand = brand ? studioMap.byBrand.get(brand) ?? null : null;
                            const fallback = byPrefix ?? byBrand;
                            if (fallback) {
                                attribution = fallback;
                                studio = fallback.studio;
                                if (byPrefix) studioFromPrefix++; else studioFromBrand++;
                            }
                        }
                    }

                    // Curated overrides come LAST, so the store always wins.
                    // The moment AtGames adds a contents list to one of the
                    // packs behind these entries, a derived tier resolves it
                    // first and the override goes inert on its own.
                    if (!studio) {
                        const override = overrides.get(atgamesMatchKey(name));
                        if (override) { studio = override.studio; studioFromOverride++; }
                        else { studioMissing++; unattributed.push(name); }
                    }

                    const result = await GlobalGameService.upsert({
                        name,
                        type: 'pinball',
                        // The AtGames machine runs its own software, so the
                        // engine is `atgames_native`; giving it a real engine
                        // is what stops its submissions locking to Unspecified.
                        // "Available on AtGames" and the cabinet variants are
                        // availability facts and belong in `features`.
                        platforms: ['atgames_native'],
                        features: ['atgames', ...AtGamesApiClient.cabinetFeatures(game)],
                        atgames_id: game.game_id,
                        studio,
                        // Dedup against the undecorated name; the row is still
                        // STORED under AtGames' own name.
                        dedup_name: atgamesDedupName(name),
                        // A licensed brand in the pack title is what marks a
                        // recreation of a physical machine (Zen's Williams
                        // ports, FarSight's Gottlieb, Magic Pixel's Zaccaria).
                        // Without one this is an ORIGINAL digital table and
                        // must not merge onto a real machine that happens to
                        // share its name — AtGames' own "Teenage Mutant Ninja
                        // Turtles" is not Data East's 1991 machine, and
                        // "Space Invaders (Pinball)" is not Bally's 1980 one.
                        original_work: !attribution?.manufacturer,
                        // `manufacturer` is deliberately ABSENT from this input
                        // — see the fillMissingManufacturer call below.
                        status: 'approved',
                        imported_from: 'atgames',
                    });

                    if (result.action === 'inserted') created++;
                    else if (result.action === 'updated') updated++;
                    else skipped++;

                    // Manufacturer lands out-of-band, and only into a gap. In
                    // the upsert input it would participate in dedup matching
                    // and change which row existing tables resolve to; here it
                    // cannot affect matching at all.
                    if (attribution?.manufacturer) {
                        const filled = await GlobalGameService.fillMissingManufacturer(
                            result.id, attribution.manufacturer, 'atgames',
                        );
                        if (filled) manufacturerFilled++;
                    }
                } catch (err) {
                    errors.push(`${game.name} (#${game.game_id}): ${err instanceof Error ? err.message : String(err)}`);
                }
            }

            // The curated override map is a snapshot and cannot know about a
            // table AtGames adds next month. Naming the residue is what stops
            // that being a silent permanent blank: this line is the
            // maintenance trigger for `atgamesStudioOverrides.ts`.
            //
            // Expect this to fire mainly for ANNOUNCED-BUT-UNRELEASED tables.
            // AtGames provisions a table into the catalogue feed before it
            // goes on sale, so for a few weeks it has no store listing to be
            // attributed from. It resolves itself on release — the listing
            // appears, a derived tier picks it up — so the useful response is
            // usually to check AtGames' Originals release schedule and add an
            // interim entry, not to go hunting the storefront.
            if (unattributed.length > 0) {
                logWarn(
                    `AtGames sync: ${unattributed.length} table(s) have NO studio — ` +
                    `if these aren't the known pair, AtGames likely shipped a pack with no contents list; ` +
                    `add them to atgamesStudioOverrides.ts:\n  ${unattributed.join('\n  ')}`,
                );
            }

            const status = errors.length === 0 ? 'success' : 'partial';
            await SyncLogService.complete(syncLogId, {
                status,
                records_imported: created,
                records_updated: updated,
                records_skipped: skipped,
                errors: errors.length > 0 ? errors : undefined,
            });

            logInfo(
                `AtGames Import: ${created} created, ${updated} updated, ${skipped} skipped, ` +
                `${excluded} excluded, ${errors.length} errored · ` +
                `studio: ${studioFromPack} from packs, ${studioFromSeries} from series, ` +
                `${studioFromPrefix} from prefix, ${studioFromBrand} from brand, ${studioFromOverride} from overrides, `
                + `${studioMissing} unattributed · ` +
                `manufacturer filled: ${manufacturerFilled}`,
            );

            return {
                created, updated, skipped,
                total: pinballGames.length,
                pinball: pinballGames.length,
                arcadeSkipped,
                studioFromPack, studioFromSeries, studioFromPrefix, studioFromBrand, studioFromOverride, studioMissing,
                excluded,
                manufacturerFilled,
            };
        } catch (err) {
            logError('AtGames Import failed:', err);
            await SyncLogService.complete(syncLogId, {
                status: 'error',
                errors: [String(err)],
            });
            throw err;
        }
    }
}

export type { AtGamesGame };
